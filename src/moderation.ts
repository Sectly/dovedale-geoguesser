import { db, type User } from "./db";
import { hasRole } from "./auth/guards";
import { fail } from "./lib/http";
import { nowSec } from "./lib/time";
import { checkForEvasion } from "./evasion";

/** One row per moderation action. The flags on the users table are derived from these by `syncUser`. */

export type ActionType = "warning" | "limit_upload" | "limit_duel" | "limit_chat" | "ban_temp" | "ban_perm";

export type ModerationAction = {
	id: number;
	user_id: number;
	type: ActionType;
	reason: string;
	issued_by: number | null;
	issued_by_username: string | null;
	expires_at: number | null;
	revoked_at: number | null;
	revoked_by: number | null;
	revoked_by_username: string | null;
	revoke_reason: string | null;
	created_at: number;
};

export const ACTION_LABELS: Record<ActionType, string> = {
	warning: "Warning",
	limit_upload: "Upload limit",
	limit_duel: "Duel limit",
	limit_chat: "Chat limit",
	ban_temp: "Temporary ban",
	ban_perm: "Permanent ban",
};

export const REASON_MIN = 5;
export const REASON_MAX = 500;
const NO_REASON = "(no reason was recorded)";

export function requireReason(value: unknown, what = "A reason"): string {
	const reason = typeof value === "string" ? value.trim().slice(0, REASON_MAX) : "";
	if (reason.length < REASON_MIN) fail(400, `${what} is required (at least ${REASON_MIN} characters)`);
	return reason;
}

export function actionStatus(action: ModerationAction, now = nowSec()): "active" | "expired" | "overturned" {
	if (action.revoked_at) return "overturned";
	if (action.expires_at && action.expires_at <= now) return "expired";
	return "active";
}

/** Supervisors may overturn warnings, limits and temporary bans; permanent bans need an admin. */
export function canOverturn(staff: User, action: ModerationAction): boolean {
	return hasRole(staff, action.type === "ban_perm" ? "admin" : "supervisor");
}

/** Only operators may erase an action from a user's history. */
export function canDelete(staff: User): boolean {
	return hasRole(staff, "operator");
}

const ACTIVE = "revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)";

function activeAction(userId: number, types: ActionType[], now: number): ModerationAction | null {
	return db
		.query<ModerationAction, (string | number)[]>(
			`SELECT * FROM moderation_actions
			WHERE user_id = ? AND type IN (${types.map(() => "?").join(",")}) AND ${ACTIVE}
			ORDER BY (expires_at IS NULL) DESC, expires_at DESC LIMIT 1`
		)
		.get(userId, ...types, now);
}

export function activeBanReason(userId: number): string | null {
	return activeAction(userId, ["ban_perm", "ban_temp"], nowSec())?.reason ?? null;
}

/** Not mirrored on the users table; chat checks it directly. */
export function activeChatLimit(userId: number): ModerationAction | null {
	return activeAction(userId, ["limit_chat"], nowSec());
}

export function syncUser(userId: number) {
	const now = nowSec();
	const ban = activeAction(userId, ["ban_perm", "ban_temp"], now);
	const upload = activeAction(userId, ["limit_upload"], now);
	const duel = activeAction(userId, ["limit_duel"], now);
	db.run(
		`UPDATE users SET is_banned = ?, ban_type = ?, ban_expires_at = ?,
			upload_limited = ?, upload_limit_expires_at = ?, duel_limited = ?, duel_limit_expires_at = ?
		WHERE id = ?`,
		[
			ban ? 1 : 0,
			ban ? (ban.type === "ban_perm" ? "perm" : "temp") : null,
			ban?.expires_at ?? null,
			upload ? 1 : 0,
			upload?.expires_at ?? null,
			duel ? 1 : 0,
			duel?.expires_at ?? null,
			userId,
		]
	);
}

export function issueAction(
	target: { id: number },
	type: ActionType,
	reason: string,
	staff: User | null,
	expiresAt: number | null = null
): ModerationAction {
	const id = Number(
		db.run(
			"INSERT INTO moderation_actions (user_id, type, reason, issued_by, issued_by_username, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
			[
				target.id,
				type,
				reason,
				staff?.id ?? null,
				staff ? staff.display_name || staff.username : "system",
				expiresAt,
			]
		).lastInsertRowid
	);
	syncUser(target.id);
	/** Anyone already seen on this player's device is now worth a look. */
	if (type === "ban_perm" || type === "ban_temp") checkForEvasion(target.id);
	return getAction(id);
}

export function getAction(id: number): ModerationAction {
	return (
		db.query<ModerationAction, [number]>("SELECT * FROM moderation_actions WHERE id = ?").get(id) ??
		fail(404, "Moderation action not found")
	);
}

/** Overturns an action: it stays in the history, marked with who lifted it and why. */
export function overturnAction(action: ModerationAction, reason: string, staff: User) {
	if (actionStatus(action) !== "active") fail(400, "This action is no longer active");
	db.run(
		"UPDATE moderation_actions SET revoked_at = unixepoch(), revoked_by = ?, revoked_by_username = ?, revoke_reason = ? WHERE id = ?",
		[staff.id, staff.display_name || staff.username, reason, action.id]
	);
	syncUser(action.user_id);
}

export function deleteAction(action: ModerationAction) {
	db.run("DELETE FROM moderation_actions WHERE id = ?", [action.id]);
	syncUser(action.user_id);
}

export function userHistory(userId: number, viewer: User | null = null) {
	const now = nowSec();
	return db
		.query<ModerationAction, [number]>(
			"SELECT * FROM moderation_actions WHERE user_id = ? ORDER BY created_at DESC, id DESC"
		)
		.all(userId)
		.map((action) => ({
			...action,
			label: ACTION_LABELS[action.type] ?? action.type,
			status: actionStatus(action, now),
			can_overturn: !!viewer && actionStatus(action, now) === "active" && canOverturn(viewer, action),
			can_delete: !!viewer && canDelete(viewer),
		}));
}

/** The same history as the user themselves may see it: no staff names. */
export function ownHistory(userId: number) {
	return userHistory(userId).map((a) => ({
		id: a.id,
		type: a.type,
		label: a.label,
		reason: a.reason,
		status: a.status,
		created_at: a.created_at,
		expires_at: a.expires_at,
		revoked_at: a.revoked_at,
		revoke_reason: a.revoke_reason,
	}));
}

/** One-off, repeat-safe import of records that predate this table. */
export function migrateLegacyModeration() {
	/** Warnings used to live in their own table. Copy them across, then retire it. */
	const hasOldTable = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_warnings'").get();
	if (hasOldTable) {
		db.transaction(() => {
			db.run(
				`INSERT OR IGNORE INTO moderation_actions (user_id, type, reason, issued_by, issued_by_username, created_at, legacy_warning_id)
				SELECT user_id, 'warning', reason, issued_by, issued_by_username, created_at, id FROM user_warnings`
			);
			db.run("DROP TABLE user_warnings");
		})();
	}
	const now = nowSec();
	const backfill = (type: string, where: string, expires: string) =>
		db.run(
			`INSERT INTO moderation_actions (user_id, type, reason, issued_by_username, expires_at)
			SELECT u.id, '${type}', ?, 'unknown', ${expires} FROM users u
			WHERE ${where} AND NOT EXISTS (
				SELECT 1 FROM moderation_actions m WHERE m.user_id = u.id AND m.type = '${type}' AND m.${ACTIVE}
			)`,
			[NO_REASON, now]
		);
	backfill("ban_perm", "u.is_banned = 1 AND u.ban_type = 'perm'", "NULL");
	backfill("ban_temp", `u.is_banned = 1 AND u.ban_type = 'temp' AND u.ban_expires_at > ${now}`, "u.ban_expires_at");
	backfill(
		"limit_upload",
		`u.upload_limited = 1 AND u.upload_limit_expires_at > ${now}`,
		"u.upload_limit_expires_at"
	);
	backfill("limit_duel", `u.duel_limited = 1 AND u.duel_limit_expires_at > ${now}`, "u.duel_limit_expires_at");
}
