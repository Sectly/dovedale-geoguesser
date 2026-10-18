import { createHash, randomBytes } from "crypto";
import { db, type User } from "./db";
import { SECURE_COOKIES } from "./config";
import { isFullStaff } from "./auth/guards";
import { DAY, nowSec } from "./lib/time";
import { auditLog } from "./lib/audit";

export type Signal = "device" | "browser";

const DEVICE_COOKIE = "device";
const DEVICE_COOKIE_AGE = 365 * DAY;
const HASH = /^[0-9a-f]{32}$/;

export function hashIdentity(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/** The device id from the request's cookie, or a fresh one when it has none (or a malformed one). */
export function deviceId(existing: string | null): { id: string; isNew: boolean } {
	if (existing && HASH.test(existing)) return { id: existing, isNew: false };
	return { id: randomBytes(16).toString("hex"), isNew: true };
}

export function deviceCookie(id: string): string {
	return `${DEVICE_COOKIE}=${id}; HttpOnly; Path=/; Max-Age=${DEVICE_COOKIE_AGE}; SameSite=Lax${SECURE_COOKIES ? "; Secure" : ""}`;
}

export { DEVICE_COOKIE };

export function recordSignal(userId: number, kind: Signal, hash: string) {
	db.run(
		`INSERT INTO fingerprints (fp_hash, user_id, kind) VALUES (?, ?, ?)
		ON CONFLICT(fp_hash, user_id) DO UPDATE SET last_seen = unixepoch(), kind = excluded.kind`,
		[hash, userId, kind]
	);
}

type LinkedAccount = {
	id: number;
	username: string;
	display_name: string | null;
	role: string | null;
	is_banned: number;
	ban_type: string | null;
	ban_expires_at: number | null;
	signal: Signal;
};

export function linkedAccounts(userId: number): LinkedAccount[] {
	return db
		.query<LinkedAccount, [number]>(
			`SELECT u.id, u.username, u.display_name, u.role, u.is_banned, u.ban_type, u.ban_expires_at,
				CASE WHEN MAX(mine.kind = 'device') THEN 'device' ELSE 'browser' END AS signal
			FROM fingerprints mine
			JOIN fingerprints other ON other.fp_hash = mine.fp_hash AND other.kind = mine.kind AND other.user_id != mine.user_id
			JOIN users u ON u.id = other.user_id
			WHERE mine.user_id = ? AND u.username != '[deleted]'
			GROUP BY u.id ORDER BY signal DESC, u.id DESC LIMIT 20`
		)
		.all(userId);
}

function isBannedNow(user: { is_banned: number; ban_type: string | null; ban_expires_at: number | null }): boolean {
	return !!user.is_banned && (user.ban_type === "perm" || (user.ban_expires_at ?? 0) > nowSec());
}

/** Flags each linked pair where one account is banned and the other is not. Staff are never flagged. */
export function checkForEvasion(userId: number) {
	const user = db.query<User, [number]>("SELECT * FROM users WHERE id = ?").get(userId);
	if (!user || user.username === "[deleted]") return;

	for (const other of linkedAccounts(userId)) {
		const [banned, suspect] = isBannedNow(user) ? [user, other] : [other, user];
		if (!isBannedNow(banned) || isBannedNow(suspect) || isFullStaff(suspect as User)) continue;

		const known = db
			.query<{ id: number; signal: Signal }, [number, number]>(
				"SELECT id, signal FROM evasion_flags WHERE user_id = ? AND matched_user_id = ?"
			)
			.get(suspect.id, banned.id);
		if (known) {
			if (known.signal === "browser" && other.signal === "device")
				db.run("UPDATE evasion_flags SET signal = 'device', dismissed_at = NULL WHERE id = ?", [known.id]);
			continue;
		}
		db.run("INSERT INTO evasion_flags (user_id, matched_user_id, signal) VALUES (?, ?, ?)", [
			suspect.id,
			banned.id,
			other.signal,
		]);
		auditLog(null, "evasion_flag", {
			targetType: "user",
			targetId: suspect.id,
			targetUsername: suspect.username,
			details: `${other.signal === "device" ? "Used the same browser as" : "Has a similar device to"} banned user @${banned.username}. Needs a staff decision.`,
		});
	}
}

const OPEN_FLAGS = `FROM evasion_flags f
	JOIN users u ON u.id = f.user_id
	JOIN users b ON b.id = f.matched_user_id
	WHERE f.dismissed_at IS NULL AND u.is_banned = 0 AND u.role IS NULL AND u.username != '[deleted]'
		AND b.is_banned = 1 AND (b.ban_type = 'perm' OR b.ban_expires_at > unixepoch())`;

export function openEvasionFlags() {
	return db
		.query(
			`SELECT f.id, f.signal, f.created_at,
				u.id AS user_id, u.username, u.display_name, u.avatar_url, u.created_at AS user_created_at,
				b.id AS banned_id, b.username AS banned_username, b.display_name AS banned_display_name, b.ban_type, b.ban_expires_at,
				(SELECT m.reason FROM moderation_actions m WHERE m.user_id = b.id AND m.type IN ('ban_perm', 'ban_temp')
					AND m.revoked_at IS NULL ORDER BY m.id DESC LIMIT 1) AS ban_reason,
				(SELECT m.created_at FROM moderation_actions m WHERE m.user_id = b.id AND m.type IN ('ban_perm', 'ban_temp')
					AND m.revoked_at IS NULL ORDER BY m.id DESC LIMIT 1) AS banned_at
			${OPEN_FLAGS}
			ORDER BY (f.signal = 'device') DESC, f.created_at DESC LIMIT 100`
		)
		.all();
}

export function countEvasionFlags(): number {
	return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n ${OPEN_FLAGS}`).get()?.n ?? 0;
}

export function dismissEvasionFlag(id: number, staff: User): { user_id: number; matched_user_id: number } | null {
	const flag = db
		.query<{ user_id: number; matched_user_id: number }, [number]>(
			"SELECT user_id, matched_user_id FROM evasion_flags WHERE id = ? AND dismissed_at IS NULL"
		)
		.get(id);
	if (!flag) return null;
	db.run("UPDATE evasion_flags SET dismissed_at = unixepoch(), dismissed_by = ? WHERE id = ?", [staff.id, id]);
	return flag;
}
