import { db, type User } from "./db";
import { randomBytes } from "crypto";
import type { Context } from "hono";

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;

const SESSION_DURATION = 30 * 24 * 60 * 60; // 30 days

const oauthStates = new Map<string, number>();
setInterval(() => {
	const now = Date.now();
	for (const [state, expiry] of oauthStates) {
		if (expiry < now) oauthStates.delete(state);
	}
}, 60_000);

export function getOperatorIds(): string[] {
	return (process.env.OPERATOR_IDS || "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

export function getModeratorIds(): string[] {
	return (process.env.MODERATOR_IDS || "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

export function generateAuthUrl(redirectBack?: string): string {
	if (!DISCORD_CLIENT_ID || !DISCORD_REDIRECT_URI) {
		throw new Error("Discord OAuth not configured");
	}
	const state = randomBytes(16).toString("hex");
	oauthStates.set(state, Date.now() + 10 * 60 * 1000);
	const params = new URLSearchParams({
		client_id: DISCORD_CLIENT_ID,
		redirect_uri: DISCORD_REDIRECT_URI,
		response_type: "code",
		scope: "identify",
		state,
	});
	if (redirectBack) params.set("prompt", "none");
	return `https://discord.com/oauth2/authorize?${params}`;
}

export function validateState(state: string): boolean {
	if (!oauthStates.has(state)) return false;
	oauthStates.delete(state);
	return true;
}

export async function exchangeCode(code: string): Promise<{
	discord_id: string;
	username: string;
	display_name: string;
	avatar_url: string;
}> {
	if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !DISCORD_REDIRECT_URI) {
		throw new Error("Discord OAuth not configured");
	}

	const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: DISCORD_REDIRECT_URI,
			client_id: DISCORD_CLIENT_ID,
			client_secret: DISCORD_CLIENT_SECRET,
		}),
	});
	if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`);
	const tokens = (await tokenRes.json()) as { access_token: string };

	const userRes = await fetch("https://discord.com/api/users/@me", {
		headers: { Authorization: `Bearer ${tokens.access_token}` },
	});
	if (!userRes.ok) throw new Error(`User info failed: ${userRes.status}`);
	const info = (await userRes.json()) as {
		id: string;
		username: string;
		global_name: string | null;
		avatar: string | null;
	};

	const avatarUrl = info.avatar
		? `https://cdn.discordapp.com/avatars/${info.id}/${info.avatar}.png?size=256`
		: `https://cdn.discordapp.com/embed/avatars/${(BigInt(info.id) >> 22n) % 6n}.png`;

	return {
		discord_id: info.id,
		username: info.username,
		display_name: info.global_name || info.username,
		avatar_url: avatarUrl,
	};
}

function sanitizeDisplayName(name: string): string {
	return (
		name
			.replace(
				/[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028-\u2029\u2060-\u2064\u2066-\u2069\uFEFF\uFFF9-\uFFFC]/g,
				""
			)
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 32)
	);
}

export function upsertUser(data: {
	discord_id: string;
	username: string;
	display_name: string;
	avatar_url: string;
	role?: string;
}): { id: number; isNew: boolean } {
	data = { ...data, display_name: sanitizeDisplayName(data.display_name) || data.username };
	const existing = db
		.query<{ id: number; role: string | null }, [string]>("SELECT id, role FROM users WHERE discord_id = ?")
		.get(data.discord_id);

	const operatorIds = getOperatorIds();
	const moderatorIds = getModeratorIds();
	let envRole: string | null = data.role ?? null;
	if (!envRole) {
		if (operatorIds.includes(data.discord_id)) envRole = "operator";
		else if (moderatorIds.includes(data.discord_id)) envRole = "moderator";
	}

	if (existing) {
		db.run(
			"UPDATE users SET username = ?, display_name = ?, avatar_url = ?, role = CASE WHEN ? IS NOT NULL THEN ? ELSE role END WHERE discord_id = ?",
			[data.username, data.display_name, data.avatar_url, envRole, envRole, data.discord_id]
		);
		return { id: existing.id, isNew: false };
	}

	const result = db.run(
		"INSERT INTO users (discord_id, username, display_name, avatar_url, role) VALUES (?, ?, ?, ?, ?)",
		[data.discord_id, data.username, data.display_name, data.avatar_url, envRole]
	);
	return { id: result.lastInsertRowid as number, isNew: true };
}

export function createSession(userId: number): string {
	const sessionId = randomBytes(32).toString("hex");
	const expiresAt = Math.floor(Date.now() / 1000) + SESSION_DURATION;
	db.run("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)", [sessionId, userId, expiresAt]);
	return sessionId;
}

export function deleteSession(sessionId: string) {
	db.run("DELETE FROM sessions WHERE id = ?", [sessionId]);
}

export function getUserFromContext(c: Context): User | null {
	const cookie = getCookie(c, "session");
	if (!cookie) return null;

	const session = db
		.query<{ user_id: number; expires_at: number }, [string]>(
			"SELECT user_id, expires_at FROM sessions WHERE id = ?"
		)
		.get(cookie);
	if (!session) return null;

	if (session.expires_at < Math.floor(Date.now() / 1000)) {
		db.run("DELETE FROM sessions WHERE id = ?", [cookie]);
		return null;
	}

	const user = db.query<User, [number]>("SELECT * FROM users WHERE id = ?").get(session.user_id);
	if (!user) return null;

	const now = Math.floor(Date.now() / 1000);
	if (user.is_banned && user.ban_type === "temp" && user.ban_expires_at && user.ban_expires_at < now) {
		db.run("UPDATE users SET is_banned = 0, ban_type = NULL, ban_expires_at = NULL WHERE id = ?", [user.id]);
		user.is_banned = 0;
		user.ban_type = null;
		user.ban_expires_at = null;
	}
	if (user.upload_limited && user.upload_limit_expires_at && user.upload_limit_expires_at < now) {
		db.run("UPDATE users SET upload_limited = 0, upload_limit_expires_at = NULL WHERE id = ?", [user.id]);
		user.upload_limited = 0;
	}
	if (user.duel_limited && user.duel_limit_expires_at && user.duel_limit_expires_at < now) {
		db.run("UPDATE users SET duel_limited = 0, duel_limit_expires_at = NULL WHERE id = ?", [user.id]);
		user.duel_limited = 0;
	}

	return user;
}

function getCookie(c: Context, name: string): string | null {
	const cookieHeader = c.req.header("Cookie");
	if (!cookieHeader) return null;
	const match = cookieHeader
		.split(";")
		.map((s) => s.trim())
		.find((s) => s.startsWith(`${name}=`));
	return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

const SECURE = process.env.NODE_ENV === "production" || !!process.env.SITE_URL;
const SECURE_FLAG = SECURE ? "; Secure" : "";

export function sessionCookieHeader(sessionId: string): string {
	return `session=${encodeURIComponent(sessionId)}; HttpOnly; Path=/; Max-Age=${SESSION_DURATION}; SameSite=Lax${SECURE_FLAG}`;
}

export function setSessionCookie(c: Context, sessionId: string) {
	c.res.headers.set("Set-Cookie", sessionCookieHeader(sessionId));
}

export function clearSessionCookie(c: Context) {
	c.res.headers.set("Set-Cookie", `session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${SECURE_FLAG}`);
}

export function isBanned(user: User): boolean {
	if (!user.is_banned) return false;
	if (user.ban_type === "temp" && user.ban_expires_at && user.ban_expires_at < Math.floor(Date.now() / 1000))
		return false;
	return true;
}
