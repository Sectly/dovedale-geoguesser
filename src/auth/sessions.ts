import { randomBytes } from "crypto";
import type { Context } from "hono";
import { db, type User } from "../db";
import { DEV_DISCORD_ID, DEV_MODE, MODERATOR_IDS, OPERATOR_IDS, SECURE_COOKIES } from "../config";
import { getCookie } from "../lib/http";
import { DAY, nowSec } from "../lib/time";
import { hashIdentity } from "../evasion";
import { syncUser } from "../moderation";

const SESSION_DURATION = 30 * DAY;
const SECURE_FLAG = SECURE_COOKIES ? "; Secure" : "";
const USER_CACHE_KEY = "currentUser";

export type DiscordProfile = {
	discord_id: string;
	username: string;
	display_name: string;
	avatar_url: string;
};

function sanitizeDisplayName(name: string): string {
	return name
		.replace(
			/[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028-\u2029\u2060-\u2064\u2066-\u2069\uFEFF\uFFF9-\uFFFC]/g,
			""
		)
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 32);
}

/** Creates or refreshes a user from their Discord profile. Roles listed in the environment always win. */
export function upsertUser(profile: DiscordProfile, forcedRole?: string): { id: number; isNew: boolean } {
	const displayName = sanitizeDisplayName(profile.display_name) || profile.username;
	const envRole =
		forcedRole ??
		(OPERATOR_IDS.includes(profile.discord_id)
			? "operator"
			: MODERATOR_IDS.includes(profile.discord_id)
				? "moderator"
				: null);

	const existing = db
		.query<{ id: number }, [string]>("SELECT id FROM users WHERE discord_id = ?")
		.get(profile.discord_id);
	if (existing) {
		db.run(
			"UPDATE users SET username = ?, display_name = ?, avatar_url = ?, role = COALESCE(?, role) WHERE id = ?",
			[profile.username, displayName, profile.avatar_url, envRole, existing.id]
		);
		return { id: existing.id, isNew: false };
	}

	const result = db.run(
		"INSERT INTO users (discord_id, username, display_name, avatar_url, role) VALUES (?, ?, ?, ?, ?)",
		[profile.discord_id, profile.username, displayName, profile.avatar_url, envRole]
	);
	const id = Number(result.lastInsertRowid);
	restoreModerationHistory(id, profile.discord_id);
	return { id, isNew: true };
}

/**
 * A player who deleted their account and came back gets their moderation history
 * back with them, so a ban or a string of warnings cannot be shed by deleting.
 */
function restoreModerationHistory(userId: number, discordId: string) {
	const identity = hashIdentity(`discord:${discordId}`);
	const old = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE deleted_identity = ?").all(identity);
	if (!old.length) return;
	db.transaction(() => {
		for (const row of old) {
			db.run("UPDATE moderation_actions SET user_id = ? WHERE user_id = ?", [userId, row.id]);
			db.run("UPDATE users SET deleted_identity = NULL WHERE id = ?", [row.id]);
			syncUser(row.id);
		}
	})();
	syncUser(userId);
}

export function upsertDevUser(): number {
	return upsertUser(
		{ discord_id: DEV_DISCORD_ID, username: "DevUser", display_name: "Dev User", avatar_url: "" },
		"operator"
	).id;
}

export function createSession(userId: number): string {
	const sessionId = randomBytes(32).toString("hex");
	db.run("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)", [
		sessionId,
		userId,
		nowSec() + SESSION_DURATION,
	]);
	return sessionId;
}

export function deleteSession(sessionId: string) {
	db.run("DELETE FROM sessions WHERE id = ?", [sessionId]);
}

export function sessionIdFromCookies(cookieHeader: string | null | undefined): string | null {
	return getCookie(cookieHeader, "session");
}

/** Resolves a session id to its user, lifting any ban or limit that has run out. */
export function userFromSessionId(sessionId: string | null): User | null {
	if (!sessionId) return null;
	const user = db
		.query<User, [string, number]>(
			"SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?"
		)
		.get(sessionId, nowSec());
	if (!user) return null;
	// The dev account only exists while AUTH_DEV is on.
	if (user.discord_id === DEV_DISCORD_ID && !DEV_MODE) return null;

	/** Bans and limits lapse on their own; refresh the flags the moment one has run out. */
	const now = nowSec();
	const lapsed = (flag: number, expiresAt: number | null) => !!flag && !!expiresAt && expiresAt <= now;
	if (
		lapsed(user.is_banned, user.ban_expires_at) ||
		lapsed(user.upload_limited, user.upload_limit_expires_at) ||
		lapsed(user.duel_limited, user.duel_limit_expires_at)
	) {
		syncUser(user.id);
		return db.query<User, [number]>("SELECT * FROM users WHERE id = ?").get(user.id);
	}
	return user;
}

/** The logged-in user for this request, or null. Looked up once per request. */
export function currentUser(c: Context): User | null {
	const cached = c.get(USER_CACHE_KEY) as User | null | undefined;
	if (cached !== undefined) return cached;
	const user = userFromSessionId(sessionIdFromCookies(c.req.header("Cookie")));
	c.set(USER_CACHE_KEY, user);
	return user;
}

export function sessionCookie(sessionId: string): string {
	return `session=${encodeURIComponent(sessionId)}; HttpOnly; Path=/; Max-Age=${SESSION_DURATION}; SameSite=Lax${SECURE_FLAG}`;
}

export function clearedSessionCookie(): string {
	return `session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${SECURE_FLAG}`;
}

/** A one-minute, script-readable note for the next page so it can greet the player. */
export function welcomeCookie(kind: "new" | "back"): string {
	return `welcome=${kind}; Path=/; Max-Age=60; SameSite=Lax${SECURE_FLAG}`;
}

export function redirectCookie(target: string | null): string {
	return target
		? `oauth_redirect=${encodeURIComponent(target)}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax${SECURE_FLAG}`
		: `oauth_redirect=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${SECURE_FLAG}`;
}

/** Clears bans and limits that ran out for users who have not been back since, so leaderboards stop hiding them. */
export function liftExpiredRestrictions() {
	const now = nowSec();
	const lapsed = db
		.query<{ id: number }, [number, number, number]>(
			`SELECT id FROM users WHERE (is_banned = 1 AND ban_expires_at <= ?)
				OR (upload_limited = 1 AND upload_limit_expires_at <= ?)
				OR (duel_limited = 1 AND duel_limit_expires_at <= ?)`
		)
		.all(now, now, now);
	for (const user of lapsed) syncUser(user.id);
}
