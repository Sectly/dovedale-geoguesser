import { hasRole, isFullStaff, roleRank } from "../auth/guards";
import { db, type Role, type User } from "../db";
import { sendEachWatcher, sendToWatchers } from "../events";
import { auditLog } from "../lib/audit";
import { fail } from "../lib/http";
import { checkRateLimit, checkUserRateLimit } from "../lib/rate-limit";
import { DAY, HOUR, nowSec } from "../lib/time";
import { activeChatLimit, issueAction } from "../moderation";
import { notifyUser } from "../notifications";
import { features } from "../system/features";
import { CHAT_EMOTES, checkMessage, flattenPhrase, giveawayWords } from "./chat-filter";
import { duelRooms, onTournamentRoundChange } from "./duels/rooms";
import { chatRole, chatTournament, liveLocationLabels, onTournamentChanged } from "./tournaments";

/** Tournament spectator chat: access rules, delayed delivery and moderation. */

/** Stops fresh accounts getting round a ban. */
export const CHAT_MIN_ACCOUNT_HOURS = 24;
const HISTORY = 50;
const STAFF_HISTORY = 150;
export const CHAT_RETENTION_DAYS = 30;
/** Random extra delay, so the exact delay can't be timed. */
const JITTER_MS = 300;
/** Messages due together go out as one event. */
const FLUSH_MS = 250;
/** Minutes. */
export const TIMEOUT_MINUTES = [5, 60, 1440];
/** How long an account read is reused across open pages. */
const PERSON_TTL_MS = 5000;

export type Access = {
	read: boolean;
	write: boolean;
	/** Shown in place of chat or the message box; null when nothing is in the way. */
	why: string | null;
	slow_seconds: number;
	staff_only: boolean;
};

type Info = NonNullable<ReturnType<typeof chatTournament>>;

const closed = (why: string): Access => ({ read: false, write: false, why, slow_seconds: 0, staff_only: false });

/** Moderators skip slow mode and staff-only mode. */
const runsChat = (user: User | null) => hasRole(user, "moderator");

function untilText(at: number) {
	const mins = Math.max(1, Math.ceil((at - nowSec()) / 60));
	return mins < 60
		? `${mins} minute${mins === 1 ? "" : "s"}`
		: `${Math.ceil(mins / 60)} hour${mins <= 60 ? "" : "s"}`;
}

export function chatAccess(user: User | null, info: Info): Access {
	if (!features().tournament_chat || !info.open || !info.settings.chat) return closed("Chat is off.");
	if (!user) return closed("Sign in to see chat.");
	if (user.is_banned) return closed("You can't use chat.");
	const limit = activeChatLimit(user.id);
	if (limit)
		return closed(
			limit.expires_at ? `You can use chat again in ${untilText(limit.expires_at)}.` : "You can't use chat."
		);
	if (!isFullStaff(user) && nowSec() - user.created_at < CHAT_MIN_ACCOUNT_HOURS * HOUR)
		return closed("Chat opens once your account is a day old.");

	const { settings } = info;
	const base = { slow_seconds: settings.chatSlowSeconds, staff_only: settings.chatStaffOnly };
	const { role, code } = chatRole(info.id, user.id);
	if (role === "playing") {
		const room = code ? duelRooms.get(code) : undefined;
		const guessing = !!room && room.status === "in_progress" && !!room.round && !room.outcomes.has(user.id);
		if (guessing) return { ...closed("Chat opens after your guess."), ...base };
		return { read: true, write: false, why: "You can write once your matches are over.", ...base };
	}
	if (role === "waiting")
		return { read: true, write: false, why: "You can write once your matches are over.", ...base };
	if (settings.chatStaffOnly && !runsChat(user))
		return { read: true, write: false, why: "Only staff can write right now.", ...base };
	return { read: true, write: true, why: null, ...base };
}

/* ---- People, cached for checks across every open page ---- */

const people = new Map<number, { at: number; user: User | null }>();

function person(userId: number | null): User | null {
	if (userId === null) return null;
	const cached = people.get(userId);
	if (cached && Date.now() - cached.at < PERSON_TTL_MS) return cached.user;
	const user = db.query<User, [number]>("SELECT * FROM users WHERE id = ?").get(userId);
	if (people.size > 5000) people.clear();
	people.set(userId, { at: Date.now(), user });
	return user;
}

/** `userIds` limits it to those viewers. */
export function pushAccess(tournamentId: number, userIds?: Iterable<number>) {
	const info = chatTournament(tournamentId);
	if (!info) return;
	sendEachWatcher(
		tournamentId,
		"chat_access",
		(userId) => chatAccess(person(userId), info),
		userIds ? new Set(userIds) : undefined
	);
}

onTournamentChanged((id) => pushAccess(id));
onTournamentRoundChange((room, userIds) => {
	if (room.tournament) pushAccess(room.tournament.id, userIds);
});

/* ---- Messages ---- */

type Row = {
	id: number;
	tournament_id: number;
	user_id: number | null;
	username: string | null;
	body: string;
	status: "shown" | "held" | "blocked" | "deleted";
	reason: string | null;
	reports: number;
	handled_by_username: string | null;
	sent_ms: number;
	display_name: string | null;
	avatar_url: string | null;
	role: Role | null;
	staff_locked: number | null;
};

const SELECT = `SELECT c.*, u.display_name, u.avatar_url, u.role, u.staff_locked FROM tournament_chat c
	LEFT JOIN users u ON u.id = c.user_id`;

export type ChatMessage = {
	id: number;
	user_id: number | null;
	username: string | null;
	name: string;
	avatar_url: string | null;
	/** Staff only, for the name badge. */
	role: Role | null;
	body: string;
	at: number;
};

function view(row: Row): ChatMessage {
	const staff = row.role && !row.staff_locked && roleRank(row.role) >= roleRank("curator") ? row.role : null;
	return {
		id: row.id,
		user_id: row.user_id,
		username: row.username,
		name: row.display_name || row.username || "Deleted user",
		avatar_url: row.avatar_url,
		role: staff,
		body: row.body,
		at: row.sent_ms,
	};
}

const findRow = (id: number) => db.query<Row, [number]>(`${SELECT} WHERE c.id = ?`).get(id);

const outbox = new Map<number, ChatMessage[]>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flush() {
	flushTimer = null;
	for (const [tournamentId, messages] of outbox) {
		const info = chatTournament(tournamentId);
		if (!info) continue;
		const readers = new Map<number | null, boolean>();
		const mayRead = (userId: number | null) => {
			if (!readers.has(userId)) readers.set(userId, chatAccess(person(userId), info).read);
			return readers.get(userId)!;
		};
		sendToWatchers(tournamentId, "chat", { messages }, mayRead);
	}
	outbox.clear();
}

/** Sent after the delay to everyone allowed to read it, unless removed meanwhile. */
function deliver(messageId: number, delayMs: number) {
	setTimeout(
		() => {
			const row = findRow(messageId);
			if (!row || row.status !== "shown") return;
			const queue = outbox.get(row.tournament_id) ?? [];
			queue.push(view(row));
			outbox.set(row.tournament_id, queue);
			flushTimer ??= setTimeout(flush, FLUSH_MS);
		},
		delayMs + Math.floor(Math.random() * JITTER_MS)
	);
}

function requireChat(id: number): Info {
	return chatTournament(id) ?? fail(404, "Tournament not found");
}

/** Access plus the latest messages the viewer may see. */
export function chatHistory(user: User | null, id: number) {
	const info = requireChat(id);
	const access = chatAccess(user, info);
	const messages = access.read
		? db
				.query<Row, [number, number, number]>(
					`${SELECT} WHERE c.tournament_id = ? AND c.status = 'shown' AND (c.sent_ms <= ? OR c.user_id = ?)
						ORDER BY c.id DESC LIMIT ${HISTORY}`
				)
				.all(id, Date.now() - info.settings.chatDelayMs, user?.id ?? 0)
				.reverse()
				.map(view)
		: [];
	return { access, messages, emotes: CHAT_EMOTES };
}

/** Each person's last few messages, to refuse repeats. */
const recent = new Map<number, string[]>();

export function sendChat(user: User, id: number, text: unknown): { message: ChatMessage; held: boolean } {
	const info = requireChat(id);
	const access = chatAccess(user, info);
	if (!access.write) fail(403, access.why ?? "You can't write in chat right now.");
	if (!checkUserRateLimit(user, "chat", 1, 2000) || !checkUserRateLimit(user, "chat_burst", 5, 15_000))
		fail(429, "Slow down a little.");
	const slow = info.settings.chatSlowSeconds;
	if (slow && !runsChat(user) && !checkRateLimit(`chat_slow:${id}:${user.id}`, 1, slow * 1000))
		fail(429, `Slow mode is on: one message every ${slow} seconds.`);

	const places = liveLocationLabels(id).flatMap(giveawayWords);
	const verdict = checkMessage(typeof text === "string" ? text : "", places);
	if (!verdict.ok) {
		/** Kept only when the filter caught it, for tuning the lists. */
		const caught = verdict.hits.length || /Links|Places/.test(verdict.reason);
		if (caught && typeof text === "string")
			db.run(
				"INSERT INTO tournament_chat (tournament_id, user_id, username, body, status, reason, sent_ms) VALUES (?, ?, ?, ?, 'blocked', ?, ?)",
				[
					id,
					user.id,
					user.username,
					text.slice(0, 300),
					verdict.hits.map((h) => `${h.word} (${h.source})`).join(", ") || verdict.reason,
					Date.now(),
				]
			);
		fail(400, verdict.reason);
	}
	const flat = flattenPhrase(verdict.body);
	const mine = recent.get(user.id) ?? [];
	if (mine.includes(flat)) fail(400, "You just sent that.");
	recent.set(user.id, [...mine.slice(-2), flat]);
	if (recent.size > 5000) recent.clear();

	const status = verdict.held ? "held" : "shown";
	const reason = verdict.held ? verdict.hits.map((h) => `${h.word} (${h.source})`).join(", ") : null;
	const messageId = Number(
		db.run(
			"INSERT INTO tournament_chat (tournament_id, user_id, username, body, status, reason, sent_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[id, user.id, user.username, verdict.body, status, reason, Date.now()]
		).lastInsertRowid
	);
	if (!verdict.held) deliver(messageId, info.settings.chatDelayMs);
	return { message: view(findRow(messageId)!), held: verdict.held };
}

export function reportChat(user: User, id: number, messageId: number) {
	const info = requireChat(id);
	if (!chatAccess(user, info).read) fail(403, "You can't use chat right now.");
	const row = findRow(messageId);
	if (!row || row.tournament_id !== id || row.status !== "shown") fail(404, "That message isn't there any more.");
	if (row.user_id === user.id) fail(400, "You can't report your own message.");
	if (!checkUserRateLimit(user, "chat_report", 10, 10 * 60_000))
		fail(429, "You've sent a lot of reports. Try again later.");
	const added = db.run("INSERT OR IGNORE INTO tournament_chat_reports (message_id, user_id) VALUES (?, ?)", [
		messageId,
		user.id,
	]).changes;
	if (added) db.run("UPDATE tournament_chat SET reports = reports + 1 WHERE id = ?", [messageId]);
}

/* ---- Staff ---- */

export type StaffChatMessage = ChatMessage & {
	status: Row["status"];
	reason: string | null;
	reports: number;
	handled_by: string | null;
};

/** Recent messages of every status. */
export function staffChat(id: number) {
	const info = requireChat(id);
	const rows = db
		.query<Row, [number]>(`${SELECT} WHERE c.tournament_id = ? ORDER BY c.id DESC LIMIT ${STAFF_HISTORY}`)
		.all(id);
	return {
		on: info.settings.chat,
		open: info.open,
		feature: features().tournament_chat,
		delay_ms: info.settings.chatDelayMs,
		slow_seconds: info.settings.chatSlowSeconds,
		staff_only: info.settings.chatStaffOnly,
		timeouts: TIMEOUT_MINUTES,
		messages: rows.map((row): StaffChatMessage => ({
			...view(row),
			status: row.status,
			reason: row.reason,
			reports: row.reports,
			handled_by: row.handled_by_username,
		})),
	};
}

function staffRow(id: number, messageId: number): Row {
	requireChat(id);
	const row = findRow(messageId);
	if (!row || row.tournament_id !== id) fail(404, "That message isn't there any more.");
	return row;
}

export function deleteChat(staff: User, id: number, messageId: number) {
	const row = staffRow(id, messageId);
	if (row.status === "deleted") return;
	db.run("UPDATE tournament_chat SET status = 'deleted', handled_by_username = ? WHERE id = ?", [
		staff.username,
		messageId,
	]);
	sendToWatchers(id, "chat_remove", { ids: [messageId] });
	auditLog(staff, "tournament_chat_delete", {
		targetType: "tournament",
		targetId: id,
		targetUsername: row.username,
		details: row.body.slice(0, 200),
	});
}

/** Sent out after the usual delay. */
export function approveChat(staff: User, id: number, messageId: number) {
	const row = staffRow(id, messageId);
	if (row.status !== "held") fail(409, "That message isn't waiting for approval.");
	db.run("UPDATE tournament_chat SET status = 'shown', sent_ms = ?, handled_by_username = ? WHERE id = ?", [
		Date.now(),
		staff.username,
		messageId,
	]);
	deliver(messageId, requireChat(id).settings.chatDelayMs);
	auditLog(staff, "tournament_chat_approve", {
		targetType: "tournament",
		targetId: id,
		targetUsername: row.username,
		details: row.body.slice(0, 200),
	});
}

export function dismissReports(staff: User, id: number, messageId: number) {
	staffRow(id, messageId);
	db.run("UPDATE tournament_chat SET reports = 0, handled_by_username = ? WHERE id = ?", [staff.username, messageId]);
	db.run("DELETE FROM tournament_chat_reports WHERE message_id = ?", [messageId]);
}

export function clearChat(staff: User, id: number) {
	requireChat(id);
	const cleared = db.run(
		"UPDATE tournament_chat SET status = 'deleted', handled_by_username = ? WHERE tournament_id = ? AND status IN ('shown', 'held')",
		[staff.username, id]
	).changes;
	sendToWatchers(id, "chat_remove", { all: true });
	auditLog(staff, "tournament_chat_clear", {
		targetType: "tournament",
		targetId: id,
		details: `${cleared} messages`,
	});
}

/** A chat limit on the sender, recorded like any other limit. Also deletes the message. */
export function timeOutSender(staff: User, id: number, messageId: number, minutes: unknown) {
	const row = staffRow(id, messageId);
	if (typeof minutes !== "number" || !TIMEOUT_MINUTES.includes(minutes)) fail(400, "Pick how long.");
	const target =
		row.user_id === null ? null : db.query<User, [number]>("SELECT * FROM users WHERE id = ?").get(row.user_id);
	if (!target) fail(404, "That account is gone.");
	if (target.id === staff.id || roleRank(target.role) >= roleRank(staff.role))
		fail(403, "You can't time out yourself or staff of equal or higher rank.");
	const reason = `Tournament chat: "${row.body}"`.slice(0, 500);
	const hours = minutes / 60;
	issueAction(target, "limit_chat", reason, staff, nowSec() + minutes * 60);
	people.delete(target.id);
	deleteChat(staff, id, messageId);
	notifyUser(target.id, "moderation", {
		title: "Chat limit applied to your account",
		body: `For ${minutes < 60 ? `${minutes} minutes` : `${hours} hour${hours === 1 ? "" : "s"}`}. Reason: ${reason}`,
		link: "/settings#moderation",
	});
	auditLog(staff, "user_limit_chat", {
		targetType: "user",
		targetId: target.id,
		targetUsername: target.username,
		details: `${minutes < 60 ? `${minutes}m` : `${hours}h`}: ${reason}`.slice(0, 200),
	});
	pushAccess(id, [target.id]);
}

/** Nightly. */
export function pruneTournamentChat() {
	db.run("DELETE FROM tournament_chat WHERE sent_ms < ?", [Date.now() - CHAT_RETENTION_DAYS * DAY * 1000]);
}
