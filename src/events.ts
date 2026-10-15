import type { Context } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { currentBanner } from "./announcements";
import { hasRole } from "./auth/guards";
import { sessionIdFromCookies, userFromSessionId } from "./auth/sessions";
import { db, type User } from "./db";
import { clientIp, fail } from "./lib/http";
import { STAFF_CHAT_ROLE, attentionFor, onNotified } from "./notifications";
import { justRestarted, onRestartChanged, restartIn } from "./system/restart";

/** Server-sent events: one stream per open page in place of polling. A periodic re-check catches anything not pushed. */

/** How often each stream's counts and the banner are re-checked. */
const REFRESH_MS = 60_000;
/** Keep-alive interval, under Bun's 60-second idle timeout and Cloudflare's 100 seconds. */
const KEEPALIVE_MS = 30_000;
/** Count changes within this window are sent as one update. */
const ATTENTION_DELAY_MS = 2000;
/** Per account, or per address when logged out. Beyond this, pages fall back to polling. */
const MAX_PER_KEY = 8;

type Client = {
	stream: SSEStreamingApi;
	sessionId: string | null;
	userId: number | null;
	key: string;
	/** Which pings to send. The data itself is permission-checked when fetched. */
	may: { chat: boolean; tickets: boolean };
	/** Last value per event, so unchanged values are not resent. */
	sent: Map<string, string>;
	attentionTimer: ReturnType<typeof setTimeout> | null;
};

const clients = new Set<Client>();

export const liveStreamCount = () => clients.size;

async function send(client: Client, event: string, data: unknown, { always = false } = {}) {
	const json = JSON.stringify(data);
	if (!always && client.sent.get(event) === json) return false;
	client.sent.set(event, json);
	try {
		await client.stream.writeSSE({ event, data: json });
		return true;
	} catch {
		forget(client);
		return false;
	}
}

function forget(client: Client) {
	if (client.attentionTimer) clearTimeout(client.attentionTimer);
	clients.delete(client);
}

/** Null once logged out, banned or deleted. */
function viewer(client: Client): User | null {
	const user = client.sessionId ? userFromSessionId(client.sessionId) : null;
	client.userId = user?.id ?? null;
	client.may = { chat: hasRole(user, STAFF_CHAT_ROLE), tickets: hasRole(user, "moderator") };
	return user;
}

async function sendAttention(client: Client): Promise<boolean> {
	const user = viewer(client);
	return user ? send(client, "attention", attentionFor(user)) : false;
}

function queueAttention(client: Client) {
	if (client.userId === null || client.attentionTimer) return;
	client.attentionTimer = setTimeout(() => {
		client.attentionTimer = null;
		if (clients.has(client)) void sendAttention(client);
	}, ATTENTION_DELAY_MS);
}

/** The same for every page, so cached briefly and shared. */
let bannerCache: { at: number; value: ReturnType<typeof currentBanner> } | null = null;
function banner() {
	if (!bannerCache || Date.now() - bannerCache.at > 10_000) bannerCache = { at: Date.now(), value: currentBanner() };
	return bannerCache.value;
}

/** Returns true if anything was sent. */
async function refresh(client: Client): Promise<boolean> {
	const bannerSent = await send(client, "banner", banner());
	const attentionSent = client.sessionId !== null && (await sendAttention(client));
	return bannerSent || attentionSent;
}

/** GET /api/events. Sends the current state on connect, then only changes. */
export function eventStream(c: Context) {
	const sessionId = sessionIdFromCookies(c.req.header("Cookie"));
	const user = sessionId ? userFromSessionId(sessionId) : null;
	const key = user ? `user:${user.id}` : `ip:${clientIp(c)}`;
	if ([...clients].filter((client) => client.key === key).length >= MAX_PER_KEY)
		fail(429, "Too many open pages. Close a few and reload.");
	/** Stops proxies from buffering the stream. */
	c.header("X-Accel-Buffering", "no");

	return streamSSE(c, async (stream) => {
		const client: Client = {
			stream,
			sessionId: user ? sessionId : null,
			userId: user?.id ?? null,
			key,
			may: { chat: hasRole(user, STAFF_CHAT_ROLE), tickets: hasRole(user, "moderator") },
			sent: new Map(),
			attentionTimer: null,
		};
		clients.add(client);
		stream.onAbort(() => forget(client));

		await stream.writeSSE({ retry: 5000, event: "hello", data: JSON.stringify(restartState()) });
		await refresh(client);
		let quietFor = 0;
		while (!stream.aborted && !stream.closed && clients.has(client)) {
			await stream.sleep(KEEPALIVE_MS);
			if (stream.aborted || !clients.has(client)) break;
			quietFor += KEEPALIVE_MS;
			const sent = quietFor >= REFRESH_MS && (await refresh(client));
			if (quietFor >= REFRESH_MS) quietFor = 0;
			if (!sent) await stream.write(": still here\n\n").catch(() => forget(client));
		}
		forget(client);
	});
}

const restartState = () => ({ restart_in: restartIn(), restarted: justRestarted() });

/* ---- Pushes: called where things change ---- */

export function nudgeUser(userId: number) {
	for (const client of clients) if (client.userId === userId) queueAttention(client);
}

export function nudgeBanner() {
	bannerCache = null;
	const value = banner();
	for (const client of clients) void send(client, "banner", value);
}

/** The ping has no content; pages fetch the chat themselves. */
export function nudgeStaffChat() {
	for (const client of clients) {
		if (!client.may.chat) continue;
		void send(client, "staff_chat", {}, { always: true });
		queueAttention(client);
	}
}

/** Tells the ticket's owner and moderators which ticket. `ownerId` is null when unknown. */
export function nudgeTicket(ticketId: number | null, ownerId: number | null) {
	for (const client of clients) {
		const isOwner = client.userId !== null && client.userId === ownerId;
		if (!isOwner && !client.may.tickets) continue;
		void send(client, "ticket", { id: ticketId }, { always: true });
		if (!isOwner) queueAttention(client);
	}
}

export function ticketOwner(ticketId: number): number | null {
	return (
		db.query<{ user_id: number }, [number]>("SELECT user_id FROM support_tickets WHERE id = ?").get(ticketId)
			?.user_id ?? null
	);
}

onNotified(nudgeUser);
onRestartChanged(() => {
	const state = restartState();
	for (const client of clients) void send(client, "restart", state, { always: true });
});
