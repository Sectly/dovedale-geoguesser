import { Hono } from "hono";
import { hashIdentity } from "../evasion";
import { db, type User } from "../db";
import { requireUser } from "../auth/guards";
import { clearedSessionCookie } from "../auth/sessions";
import { auditLog } from "../lib/audit";
import { fail, readJson } from "../lib/http";
import { checkUserRateLimit } from "../lib/rate-limit";
import { DAY } from "../lib/time";
import { deleteUpload } from "../lib/uploads";
import { ownHistory } from "../moderation";
import { parsePreferences, publicPreferences, updatePreferences } from "../notifications";

/** Routes mounted at /api: a user's own settings, data export and account deletion. */
export const accountRoutes = new Hono();

accountRoutes.post("/settings", async (c) => {
	const user = requireUser(c);
	const body = await readJson<{ profile_private: boolean; prefs: unknown }>(c);
	if (typeof body.profile_private === "boolean") {
		db.run("UPDATE users SET profile_private = ? WHERE id = ?", [body.profile_private ? 1 : 0, user.id]);
	}
	if (body.prefs !== undefined) user.prefs = JSON.stringify(updatePreferences(user, body.prefs));
	return c.json({ success: true, prefs: publicPreferences(user) });
});

accountRoutes.get("/me/moderation", (c) => {
	const user = requireUser(c);
	return c.json({ actions: ownHistory(user.id) });
});

/** Everything stored about a user, in the shape handed out for data requests. */
export function exportUserData(user: User) {
	const all = (sql: string) => db.query(sql).all(user.id);
	return {
		account: {
			id: user.id,
			discord_id: user.discord_id,
			username: user.username,
			display_name: user.display_name,
			avatar_url: user.avatar_url,
			created_at: user.created_at,
			role: user.role,
			profile_private: !!user.profile_private,
			is_banned: !!user.is_banned,
			ban_type: user.ban_type,
			ban_expires_at: user.ban_expires_at,
			upload_limited: !!user.upload_limited,
			upload_limit_expires_at: user.upload_limit_expires_at,
			duel_limited: !!user.duel_limited,
			duel_limit_expires_at: user.duel_limit_expires_at,
			current_streak: user.current_streak,
			longest_streak: user.longest_streak,
			last_played_date: user.last_played_date,
			suggestions_agreed: !!user.suggestions_agreed,
			suggestions_agreed_at: user.suggestions_agreed_at,
		},
		solo_scores: all(
			"SELECT id, total_score, max_possible, rounds, time_limit, created_at FROM solo_scores WHERE user_id = ?"
		),
		daily_scores: all(
			"SELECT id, score, date, guessed_x, guessed_y, distance, time_taken, hints_used, created_at FROM daily_scores WHERE user_id = ?"
		),
		duel_games: all(
			"SELECT dp.game_id, dp.total_score, dg.room_code, dg.status, dg.winner_id, dg.created_at FROM duel_participants dp JOIN duel_games dg ON dg.id = dp.game_id WHERE dp.user_id = ?"
		),
		duel_round_scores: all(
			"SELECT game_id, round_number, guessed_x, guessed_y, distance, score, created_at FROM duel_round_scores WHERE user_id = ?"
		),
		submissions: all(
			"SELECT id, image_path, world_x, world_y, label, status, deny_reason, reviewed_at, created_at FROM submissions WHERE submitted_by = ?"
		),
		suggestions: all(
			"SELECT id, location_id, type, content, status, deny_reason, reviewed_at, created_at FROM location_suggestions WHERE user_id = ?"
		),
		support_tickets: all(
			"SELECT id, subject, message, category, status, close_requested, created_at FROM support_tickets WHERE user_id = ?"
		),
		ticket_replies: all(
			"SELECT tr.id, tr.ticket_id, tr.body, tr.type, tr.created_at FROM ticket_replies tr JOIN support_tickets st ON st.id = tr.ticket_id WHERE st.user_id = ?"
		),
		moderation: all(
			"SELECT id, type, reason, created_at, expires_at, revoked_at, revoke_reason FROM moderation_actions WHERE user_id = ?"
		),
		// "device" rows are a hash of the device cookie, "browser" rows a hash of browser details.
		fingerprints: all("SELECT kind, fp_hash, first_seen, last_seen FROM fingerprints WHERE user_id = ?"),
		// Times staff were asked to look at this account for ban evasion (the other account is not included).
		evasion_reviews: all(
			"SELECT signal, created_at, CASE WHEN dismissed_at IS NULL THEN 'open' ELSE 'dismissed' END AS status, dismissed_at FROM evasion_flags WHERE user_id = ?"
		),
		sessions: all("SELECT created_at, expires_at FROM sessions WHERE user_id = ?"),
		daily_attempts: all("SELECT date, started_at, hints_revealed FROM daily_attempts WHERE user_id = ?"),
		push_subscriptions: all("SELECT endpoint, created_at FROM push_subscriptions WHERE user_id = ?"),
		// Things you did yourself; what staff did about you is under "moderation".
		activity_log: all(
			"SELECT action, target_type, target_id, created_at FROM audit_log WHERE actor_id = ?1 OR (actor_id IS NULL AND target_type = 'user' AND target_id = ?1) ORDER BY id"
		),
		notifications: all("SELECT category, title, body, read_at, created_at FROM notifications WHERE user_id = ?"),
		preferences: parsePreferences(user.prefs),
		exported_at: new Date().toISOString(),
		export_version: 7,
	};
}

accountRoutes.get("/gdpr/export", (c) => {
	const user = requireUser(c);
	if (!checkUserRateLimit(user, "gdpr", 3, DAY * 1000))
		fail(429, "Too many export requests today. Try again tomorrow.");
	auditLog(user, "gdpr_export", { targetType: "user", targetId: user.id, targetUsername: user.username });
	return c.json(exportUserData(user));
});

/**
 * Erases a user's personal data. The row itself stays, anonymised, because approved
 * locations and finished duels still point at it; moderation records stay with it,
 * as the privacy policy says they do.
 */
export async function deleteUserAccount(userId: number) {
	const pendingImages = db
		.query<{ image_path: string | null }, [number, number]>(
			`SELECT image_path FROM submissions WHERE submitted_by = ? AND status != 'approved'
			UNION ALL
			SELECT image_path FROM location_suggestions WHERE user_id = ? AND status != 'approved'`
		)
		.all(userId, userId);

	/**
	 * Deleting an account must not wipe the slate clean. When there is a moderation history,
	 * a one-way hash of the Discord id stays behind so it follows the player if they return.
	 */
	const account = db.query<{ discord_id: string }, [number]>("SELECT discord_id FROM users WHERE id = ?").get(userId);
	const hasHistory = !!db.query("SELECT 1 FROM moderation_actions WHERE user_id = ? LIMIT 1").get(userId);

	db.transaction(() => {
		db.run(
			`UPDATE users SET username = '[deleted]', display_name = NULL, avatar_url = NULL,
				discord_id = '[deleted:' || id || ']', role = NULL, profile_private = 1,
				current_streak = 0, longest_streak = 0, last_played_date = NULL, prefs = NULL,
				deleted_identity = ?
			WHERE id = ?`,
			[hasHistory && account ? hashIdentity(`discord:${account.discord_id}`) : null, userId]
		);
		for (const table of [
			"sessions",
			"solo_scores",
			"daily_scores",
			"daily_attempts",
			"duel_round_scores",
			"duel_participants",
			"fingerprints",
			"evasion_flags",
			"support_tickets",
			"location_suggestions",
			"push_subscriptions",
			"notifications",
		]) {
			db.run(`DELETE FROM ${table} WHERE user_id = ?`, [userId]);
		}
		db.run("DELETE FROM submissions WHERE submitted_by = ? AND status != 'approved'", [userId]);
		// Their name was copied into a few records about other things; blank it there too.
		db.run("UPDATE audit_log SET actor_username = '[deleted]' WHERE actor_id = ?", [userId]);
		db.run("UPDATE audit_log SET target_username = '[deleted]' WHERE target_type = 'user' AND target_id = ?", [
			userId,
		]);
		db.run("UPDATE ticket_replies SET author_username = '[deleted]' WHERE author_id = ?", [userId]);
		db.run("UPDATE moderation_actions SET issued_by_username = '[deleted]' WHERE issued_by = ?", [userId]);
		db.run("UPDATE moderation_actions SET revoked_by_username = '[deleted]' WHERE revoked_by = ?", [userId]);
	})();

	for (const row of pendingImages) await deleteUpload(row.image_path);
}

accountRoutes.delete("/account", async (c) => {
	const user = requireUser(c);
	const body = await readJson<{ confirm: boolean }>(c);
	if (body.confirm !== true) fail(400, "Confirmation required");
	await deleteUserAccount(user.id);
	auditLog(null, "user_delete", { targetType: "user", targetId: user.id });
	c.header("Set-Cookie", clearedSessionCookie());
	return c.json({ success: true });
});
