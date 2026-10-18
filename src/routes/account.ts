import { Hono, type Context } from "hono";
import { takeUnseen } from "../achievements";
import { hashIdentity } from "../evasion";
import { db, type User } from "../db";
import { confirmEmail, removeEmail, requestEmail, setDigestFrequency, unsubscribe } from "../email";
import { requireUser } from "../auth/guards";
import { clearedSessionCookie } from "../auth/sessions";
import { removeFromDuels } from "../game/duels/rooms";
import { dropSoloGames } from "../game/solo";
import { removeFromTeamRooms } from "../game/teams";
import { auditLog } from "../lib/audit";
import { fail, readJson, text } from "../lib/http";
import { checkUserRateLimit } from "../lib/rate-limit";
import { DAY } from "../lib/time";
import { deleteUpload } from "../lib/uploads";
import { ownHistory } from "../moderation";
import { parsePreferences, publicPreferences, updatePreferences } from "../notifications";
import { clearLeaderboardCache } from "./leaderboard";

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

accountRoutes.post("/settings/email", async (c) => {
	const user = requireUser(c);
	if (!checkUserRateLimit(user, "email-confirm", 3, DAY * 1000))
		fail(429, "Too many confirmation emails today. Try again tomorrow.");
	await requestEmail(user, text((await readJson<{ email: string }>(c)).email, 254));
	return c.json({ success: true });
});

accountRoutes.post("/settings/email/frequency", async (c) => {
	setDigestFrequency(requireUser(c), String((await readJson<{ frequency: string }>(c)).frequency));
	return c.json({ success: true });
});

/** Unlinks and deletes the address. Works with email off, and for banned accounts. */
accountRoutes.delete("/settings/email", (c) => {
	removeEmail(requireUser(c).id);
	return c.json({ success: true });
});

/** A bare page for links opened from a mail app, where nobody may be logged in. */
const mailPage = (c: Context, title: string, message: string, status: 200 | 410 = 200) =>
	c.html(
		`<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="robots" content="noindex" /><title>${title} | Dovedale GeoGuesser</title></head>
		<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#09090b;color:#e4e4e7;font-family:system-ui,sans-serif;text-align:center;padding:24px">
		<div><h1 style="font-size:22px">${title}</h1><p style="color:#a1a1aa">${message}</p><p><a href="/settings" style="color:#60a5fa">Open Settings</a></p></div></body></html>`,
		status
	);

accountRoutes.get("/email/confirm", (c) =>
	confirmEmail(c.req.query("token") ?? "")
		? mailPage(
				c,
				"Email confirmed",
				"You will get a daily summary of unread notifications. Change how often in Settings."
			)
		: mailPage(c, "That link has expired", "Ask for a new confirmation email from Settings.", 410)
);

/** The link at the foot of every summary, and what mail apps call for their own Unsubscribe button. */
const stopEmails = (c: Context) =>
	unsubscribe(c.req.query("token") ?? "")
		? mailPage(
				c,
				"Email summaries stopped",
				"You won't get any more. To delete your address as well, remove it in Settings."
			)
		: mailPage(c, "That link no longer works", "Change this in Settings instead.", 410);
accountRoutes.get("/email/unsubscribe", stopEmails);
accountRoutes.post("/email/unsubscribe", stopEmails);

accountRoutes.get("/me/moderation", (c) => {
	const user = requireUser(c);
	return c.json({ actions: ownHistory(user.id) });
});

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
			email: user.email ?? null,
			email_confirmed: !!user.email_verified,
			email_summary: user.email_digest ?? null,
			last_played_date: user.last_played_date,
			duel_rating: user.duel_rating,
			duel_rated_games: user.duel_rated_games ?? 0,
			suggestions_agreed: !!user.suggestions_agreed,
			suggestions_agreed_at: user.suggestions_agreed_at,
			staff_locked: !!user.staff_locked,
		},
		solo_scores: all(
			"SELECT id, total_score, max_possible, rounds, time_limit, created_at FROM solo_scores WHERE user_id = ?"
		),
		daily_scores: all(
			"SELECT id, score, date, guessed_x, guessed_y, distance, time_taken, hints_used, created_at FROM daily_scores WHERE user_id = ?"
		),
		duel_games: all(
			"SELECT dp.game_id, dp.total_score, dp.rating_change, dg.room_code, dg.quickplay, dg.status, dg.winner_id, dg.created_at FROM duel_participants dp JOIN duel_games dg ON dg.id = dp.game_id WHERE dp.user_id = ?"
		),
		achievements: all("SELECT key, earned_at, seen_at FROM user_achievements WHERE user_id = ? ORDER BY earned_at"),
		duel_round_scores: all(
			"SELECT game_id, round_number, guessed_x, guessed_y, distance, score, created_at FROM duel_round_scores WHERE user_id = ?"
		),
		submissions: all(
			"SELECT id, image_path, world_x, world_y, label, hints, status, deny_reason, reviewed_at, created_at FROM submissions WHERE submitted_by = ?"
		),
		suggestions: all(
			"SELECT id, location_id, type, content, image_path, status, deny_reason, reviewed_at, created_at FROM location_suggestions WHERE user_id = ?"
		),
		support_tickets: all(
			"SELECT id, subject, message, category, status, close_requested, created_at FROM support_tickets WHERE user_id = ?"
		),
		ticket_replies: all(
			"SELECT tr.id, tr.ticket_id, tr.body, tr.type, tr.created_at FROM ticket_replies tr JOIN support_tickets st ON st.id = tr.ticket_id WHERE st.user_id = ?"
		),
		ticket_replies_written: all(
			"SELECT tr.id, tr.ticket_id, tr.body, tr.created_at FROM ticket_replies tr JOIN support_tickets st ON st.id = tr.ticket_id WHERE tr.author_id = ?1 AND st.user_id != ?1"
		),
		moderation: all(
			"SELECT id, type, reason, created_at, expires_at, revoked_at, revoke_reason FROM moderation_actions WHERE user_id = ?"
		),
		/** "device" rows are a hash of the device cookie, "browser" rows a hash of browser details. */
		fingerprints: all("SELECT kind, fp_hash, first_seen, last_seen FROM fingerprints WHERE user_id = ?"),
		/** Times staff were asked to look at this account for ban evasion (the other account is not included). */
		evasion_reviews: all(
			"SELECT signal, created_at, CASE WHEN dismissed_at IS NULL THEN 'open' ELSE 'dismissed' END AS status, dismissed_at FROM evasion_flags WHERE user_id = ?"
		),
		/** Your most recent guesses, kept to check for cheating, and any times that check asked staff to look. */
		recent_guesses: all(
			"SELECT mode, location_id, distance, time_taken, points, created_at FROM guess_log WHERE user_id = ?"
		),
		fairplay_reviews: all(
			"SELECT signal, evidence, created_at, CASE WHEN dismissed_at IS NULL THEN 'open' ELSE 'dismissed' END AS status, dismissed_at FROM fairplay_flags WHERE user_id = ?"
		),
		staff_notes: all("SELECT body, created_at FROM staff_notes WHERE user_id = ?"),
		staff_chat_messages: all("SELECT body, created_at FROM staff_chat WHERE author_id = ?"),
		sessions: all("SELECT created_at, expires_at FROM sessions WHERE user_id = ?"),
		daily_attempts: all("SELECT date, started_at, hints_revealed FROM daily_attempts WHERE user_id = ?"),
		push_subscriptions: all("SELECT endpoint, created_at FROM push_subscriptions WHERE user_id = ?"),
		activity_log: all(
			"SELECT action, target_type, target_id, created_at FROM audit_log WHERE actor_id = ?1 OR (actor_id IS NULL AND target_type = 'user' AND target_id = ?1) ORDER BY id"
		),
		notifications: all("SELECT category, title, body, read_at, created_at FROM notifications WHERE user_id = ?"),
		/** Messages staff sent to this account alone. They are kept after the notification itself has expired. */
		messages_from_staff: all(
			"SELECT title, body, link, created_at FROM announcements WHERE target_user_id = ? AND draft = 0 AND send_at IS NULL"
		),
		preferences: parsePreferences(user.prefs),
		exported_at: new Date().toISOString(),
		export_version: 13,
	};
}

/** Achievements earned since the page last asked, for the unlock animation. Asking marks them shown. */
accountRoutes.get("/achievements/unseen", (c) => c.json(takeUnseen(requireUser(c).id)));

accountRoutes.get("/gdpr/export", (c) => {
	const user = requireUser(c);
	if (!checkUserRateLimit(user, "gdpr", 3, DAY * 1000))
		fail(429, "Too many export requests today. Try again tomorrow.");
	auditLog(user, "gdpr_export", { targetType: "user", targetId: user.id, targetUsername: user.username });
	return c.json(exportUserData(user));
});

/** Erases a user's personal data. The anonymised row stays: locations, duels and moderation records point at it. */
export async function deleteUserAccount(userId: number) {
	const pendingImages = db
		.query<{ image_path: string | null }, [number, number]>(
			`SELECT image_path FROM submissions WHERE submitted_by = ? AND status != 'approved'
			UNION ALL
			SELECT image_path FROM location_suggestions WHERE user_id = ? AND status != 'approved'`
		)
		.all(userId, userId);

	const account = db
		.query<{ discord_id: string; username: string }, [number]>(
			"SELECT discord_id, username FROM users WHERE id = ?"
		)
		.get(userId);
	const hasHistory = !!db.query("SELECT 1 FROM moderation_actions WHERE user_id = ? LIMIT 1").get(userId);

	const player = db.query<User, [number]>("SELECT * FROM users WHERE id = ?").get(userId);
	removeFromDuels(userId);
	if (player) removeFromTeamRooms(player);
	dropSoloGames(userId);

	db.transaction(() => {
		db.run(
			`UPDATE users SET username = '[deleted]', display_name = NULL, avatar_url = NULL,
				discord_id = '[deleted:' || id || ']', role = NULL, profile_private = 1,
				current_streak = 0, longest_streak = 0, last_played_date = NULL, prefs = NULL,
				duel_rating = 1000, duel_rated_games = 0,
				staff_locked = 0, staff_lock_reason = NULL, staff_chat_read = 0, suggestions_agreed = 0, suggestions_agreed_at = NULL,
				email = NULL, email_verified = 0, email_token = NULL, email_token_at = NULL, email_digest = NULL,
				email_digest_at = NULL, email_digest_upto = NULL,
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
			"guess_log",
			"fairplay_flags",
			"support_tickets",
			"location_suggestions",
			"push_subscriptions",
			"notifications",
			"user_achievements",
		]) {
			db.run(`DELETE FROM ${table} WHERE user_id = ?`, [userId]);
		}
		db.run("DELETE FROM evasion_flags WHERE matched_user_id = ?", [userId]);
		db.run("DELETE FROM submissions WHERE submitted_by = ? AND status != 'approved'", [userId]);
		db.run("UPDATE audit_log SET actor_username = '[deleted]' WHERE actor_id = ?", [userId]);
		db.run("UPDATE audit_log SET target_username = '[deleted]' WHERE target_type = 'user' AND target_id = ?", [
			userId,
		]);
		db.run("UPDATE ticket_replies SET author_username = '[deleted]' WHERE author_id = ?", [userId]);
		db.run("UPDATE moderation_actions SET issued_by_username = '[deleted]' WHERE issued_by = ?", [userId]);
		db.run("UPDATE moderation_actions SET revoked_by_username = '[deleted]' WHERE revoked_by = ?", [userId]);
		db.run("UPDATE announcements SET created_by = '[deleted]' WHERE created_by_id = ?", [userId]);
		db.run("DELETE FROM announcements WHERE target_user_id = ?", [userId]);
		db.run("UPDATE staff_notes SET author_username = '[deleted]' WHERE author_id = ?", [userId]);
		db.run("UPDATE staff_chat SET author_username = '[deleted]' WHERE author_id = ?", [userId]);
		db.run("UPDATE staff_chat SET pinned_by_username = '[deleted]' WHERE pinned_by = ?", [userId]);
		if (account)
			db.run("UPDATE changelog SET created_by = '[deleted]' WHERE created_by IN (?, ?)", [
				account.username,
				player?.display_name ?? account.username,
			]);
		if (account) scrubAuditDetails(account.username);
	})();
	clearLeaderboardCache();

	for (const row of pendingImages) await deleteUpload(row.image_path);
}

/** Takes one player's name out of audit text like "alice vs bob". Whole names only. */
function scrubAuditDetails(username: string) {
	const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	/** A dot may end a sentence; the name only goes on when a letter follows. */
	const name = new RegExp(`(?<!\\w)(?<!\\w\\.)@?${escaped}(?!\\w|\\.\\w)`, "g");
	const rows = db
		.query<{ id: number; details: string }, [string]>(
			"SELECT id, details FROM audit_log WHERE details LIKE '%' || ? || '%'"
		)
		.all(username);
	for (const row of rows) {
		const scrubbed = row.details.replace(name, "[deleted]");
		if (scrubbed !== row.details) db.run("UPDATE audit_log SET details = ? WHERE id = ?", [scrubbed, row.id]);
	}
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
