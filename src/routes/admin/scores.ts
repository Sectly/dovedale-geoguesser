import { Hono } from "hono";
import type { Context } from "hono";
import { db, type User } from "../../db";
import { GAME } from "../../config";
import { requireStaff } from "../../auth/guards";
import { auditLog } from "../../lib/audit";
import { fail, idParam, readJson } from "../../lib/http";
import { achievementsFor, award, clearAchievements, isAchievement, revoke } from "../../achievements";
import { ratingOf, resetRating, unrateDuel } from "../../game/duels/rating";
import { requireReason } from "../../moderation";
import { notifyUser } from "../../notifications";

/**
 * Routes at /api/admin/scores: view, correct or wipe one player's scores.
 * Every change needs a reason, is logged, and the player is told.
 */
export const adminScoreRoutes = new Hono();

const MAX_STREAK = 5000;

function target(c: Context): User {
	return (
		db.query<User, [number]>("SELECT * FROM users WHERE id = ?").get(idParam(c, "userId")) ??
		fail(404, "User not found")
	);
}

/** A whole number within [min, max], or a 400 naming the field. */
function wholeNumber(value: unknown, what: string, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
		fail(400, `${what} must be a whole number from ${min} to ${max}`);
	return value;
}

function record(actor: User, user: User, action: string, details: string, reason: string, told: string) {
	auditLog(actor, action, {
		targetType: "user",
		targetId: user.id,
		targetUsername: user.username,
		details: `${details}. Reason: ${reason}`.slice(0, 300),
	});
	notifyUser(user.id, "moderation", {
		title: told,
		body: `Reason: ${reason}`,
		link: "/settings#moderation",
	});
}

adminScoreRoutes.get("/:userId", (c) => {
	requireStaff(c, "operator");
	const user = target(c);
	const all = (sql: string) => db.query(sql).all(user.id);
	return c.json({
		user: { id: user.id, username: user.username, display_name: user.display_name },
		streak: {
			current: user.current_streak ?? 0,
			longest: user.longest_streak ?? 0,
			last_played_date: user.last_played_date,
		},
		rating: { value: ratingOf(user), games: user.duel_rated_games ?? 0 },
		achievements: achievementsFor(user.id),
		solo: all(
			"SELECT id, total_score, max_possible, rounds, time_limit, created_at FROM solo_scores WHERE user_id = ? ORDER BY id DESC LIMIT 200"
		),
		daily: all(
			"SELECT id, date, score, ROUND(distance) AS distance, time_taken, hints_used FROM daily_scores WHERE user_id = ? ORDER BY date DESC LIMIT 200"
		),
		duels: all(
			`SELECT dg.id, dg.room_code, dg.rounds, dg.quickplay, dg.status, dg.finished_at, dg.created_at, dp.total_score AS score,
				CASE WHEN dg.winner_id = dp.user_id THEN 'win' WHEN dg.winner_id IS NULL THEN 'tie' ELSE 'loss' END AS result,
				o.total_score AS opponent_score, ou.username AS opponent_username
			FROM duel_participants dp
			JOIN duel_games dg ON dg.id = dp.game_id
			LEFT JOIN duel_participants o ON o.game_id = dg.id AND o.user_id != dp.user_id
			LEFT JOIN users ou ON ou.id = o.user_id
			WHERE dp.user_id = ? AND dg.status != 'waiting'
			ORDER BY dg.id DESC LIMIT 200`
		),
	});
});

/* ---- Single entries ---- */

adminScoreRoutes.post("/:userId/solo/:id", async (c) => {
	const actor = requireStaff(c, "operator");
	const user = target(c);
	const body = await readJson<{ total_score: number; reason: string }>(c);
	const reason = requireReason(body.reason);
	const row =
		db
			.query<{ total_score: number; max_possible: number }, [number, number]>(
				"SELECT total_score, max_possible FROM solo_scores WHERE id = ? AND user_id = ?"
			)
			.get(idParam(c), user.id) ?? fail(404, "Score not found");
	const score = wholeNumber(body.total_score, "The score", 0, row.max_possible);
	db.run("UPDATE solo_scores SET total_score = ? WHERE id = ?", [score, idParam(c)]);
	record(
		actor,
		user,
		"score_edit",
		`Solo score #${idParam(c)}: ${row.total_score} to ${score}`,
		reason,
		"A solo score of yours was corrected by staff"
	);
	return c.json({ success: true });
});

adminScoreRoutes.delete("/:userId/solo/:id", async (c) => {
	const actor = requireStaff(c, "operator");
	const user = target(c);
	const reason = requireReason((await readJson<{ reason: string }>(c)).reason);
	const row =
		db
			.query<{ total_score: number }, [number, number]>(
				"SELECT total_score FROM solo_scores WHERE id = ? AND user_id = ?"
			)
			.get(idParam(c), user.id) ?? fail(404, "Score not found");
	db.run("DELETE FROM solo_scores WHERE id = ?", [idParam(c)]);
	record(
		actor,
		user,
		"score_delete",
		`Solo score #${idParam(c)} (${row.total_score}) removed`,
		reason,
		"A solo score of yours was removed by staff"
	);
	return c.json({ success: true });
});

adminScoreRoutes.post("/:userId/daily/:id", async (c) => {
	const actor = requireStaff(c, "operator");
	const user = target(c);
	const body = await readJson<{ score: number; reason: string }>(c);
	const reason = requireReason(body.reason);
	const row =
		db
			.query<{ score: number; date: string }, [number, number]>(
				"SELECT score, date FROM daily_scores WHERE id = ? AND user_id = ?"
			)
			.get(idParam(c), user.id) ?? fail(404, "Score not found");
	const score = wholeNumber(body.score, "The score", 0, GAME.maxRoundScore);
	db.run("UPDATE daily_scores SET score = ? WHERE id = ?", [score, idParam(c)]);
	record(
		actor,
		user,
		"score_edit",
		`Daily score for ${row.date}: ${row.score} to ${score}`,
		reason,
		`Your daily score for ${row.date} was corrected by staff`
	);
	return c.json({ success: true });
});

adminScoreRoutes.delete("/:userId/daily/:id", async (c) => {
	const actor = requireStaff(c, "operator");
	const user = target(c);
	const reason = requireReason((await readJson<{ reason: string }>(c)).reason);
	const row =
		db
			.query<{ score: number; date: string }, [number, number]>(
				"SELECT score, date FROM daily_scores WHERE id = ? AND user_id = ?"
			)
			.get(idParam(c), user.id) ?? fail(404, "Score not found");
	db.run("DELETE FROM daily_scores WHERE id = ?", [idParam(c)]);
	record(
		actor,
		user,
		"score_delete",
		`Daily score for ${row.date} (${row.score}) removed`,
		reason,
		`Your daily score for ${row.date} was removed by staff`
	);
	return c.json({ success: true });
});

/** Voids a duel for both players. */
adminScoreRoutes.delete("/:userId/duels/:id", async (c) => {
	const actor = requireStaff(c, "operator");
	const user = target(c);
	const reason = requireReason((await readJson<{ reason: string }>(c)).reason);
	const game =
		db
			.query<{ id: number; room_code: string }, [number, number]>(
				`SELECT dg.id, dg.room_code FROM duel_games dg JOIN duel_participants dp ON dp.game_id = dg.id
				WHERE dg.id = ? AND dp.user_id = ? AND dg.status IN ('finished', 'abandoned')`
			)
			.get(idParam(c), user.id) ?? fail(404, "Duel not found, or it is still being played");
	db.transaction(() => {
		/** Both players get back whatever rating the duel moved. */
		unrateDuel(game.id);
		db.run("DELETE FROM duel_games WHERE id = ?", [game.id]);
	})();
	record(
		actor,
		user,
		"score_delete",
		`Duel ${game.room_code} (#${game.id}) voided for both players`,
		reason,
		"One of your duels was voided by staff"
	);
	return c.json({ success: true });
});

adminScoreRoutes.post("/:userId/streak", async (c) => {
	const actor = requireStaff(c, "operator");
	const user = target(c);
	const body = await readJson<{ current: number; longest: number; reason: string }>(c);
	const reason = requireReason(body.reason);
	const current = wholeNumber(body.current, "The current streak", 0, MAX_STREAK);
	const longest = wholeNumber(body.longest, "The longest streak", 0, MAX_STREAK);
	if (longest < current) fail(400, "The longest streak cannot be shorter than the current one");
	db.run("UPDATE users SET current_streak = ?, longest_streak = ? WHERE id = ?", [current, longest, user.id]);
	record(
		actor,
		user,
		"score_edit",
		`Streak: ${user.current_streak ?? 0} (best ${user.longest_streak ?? 0}) to ${current} (best ${longest})`,
		reason,
		"Your streak was changed by staff"
	);
	return c.json({ success: true });
});

adminScoreRoutes.post("/:userId/rating", async (c) => {
	const actor = requireStaff(c, "operator");
	const user = target(c);
	const body = await readJson<{ rating: number; reason: string }>(c);
	const reason = requireReason(body.reason);
	const rating = wholeNumber(body.rating, "The rating", GAME.rating.floor, 4000);
	db.run("UPDATE users SET duel_rating = ? WHERE id = ?", [rating, user.id]);
	record(
		actor,
		user,
		"score_edit",
		`Duel rating: ${ratingOf(user)} to ${rating}`,
		reason,
		"Your duel rating was changed by staff"
	);
	return c.json({ success: true });
});

/** Gives or takes away one achievement. */
adminScoreRoutes.post("/:userId/achievements/:key", async (c) => {
	const actor = requireStaff(c, "operator");
	const user = target(c);
	const key = c.req.param("key");
	if (!isAchievement(key)) fail(404, "No such achievement");
	const body = await readJson<{ earned: boolean; reason: string }>(c);
	const reason = requireReason(body.reason);
	if (typeof body.earned !== "boolean") fail(400, "Say whether the achievement should be given or removed");
	const changed = body.earned ? award(user.id, key, { quiet: true }) : revoke(user.id, key);
	if (!changed) fail(409, body.earned ? "They already have that achievement" : "They do not have that achievement");
	record(
		actor,
		user,
		"score_edit",
		`Achievement "${key}" ${body.earned ? "given" : "removed"}`,
		reason,
		body.earned ? "Staff gave you an achievement" : "An achievement was removed by staff"
	);
	return c.json({ success: true });
});

/* ---- Resets ---- */

const SCOPES = ["solo", "daily", "duels", "streak", "achievements", "all"] as const;
type Scope = (typeof SCOPES)[number];

const RESET_NOTICE: Record<Scope, string> = {
	solo: "Your solo scores were reset by staff",
	daily: "Your daily scores were reset by staff",
	duels: "Your duels were voided by staff",
	streak: "Your streak was reset by staff",
	achievements: "Your achievements were reset by staff",
	all: "Your scores and history were reset by staff",
};

adminScoreRoutes.post("/:userId/reset", async (c) => {
	const actor = requireStaff(c, "operator");
	const user = target(c);
	const body = await readJson<{ scope: Scope; reason: string }>(c);
	const reason = requireReason(body.reason);
	const scope = SCOPES.includes(body.scope!) ? body.scope! : fail(400, "Choose what to reset");
	const wants = (part: Scope) => scope === part || scope === "all";

	const removed: string[] = [];
	db.transaction(() => {
		if (wants("solo"))
			removed.push(`${db.run("DELETE FROM solo_scores WHERE user_id = ?", [user.id]).changes} solo scores`);
		if (wants("daily")) {
			db.run("DELETE FROM daily_attempts WHERE user_id = ?", [user.id]);
			removed.push(`${db.run("DELETE FROM daily_scores WHERE user_id = ?", [user.id]).changes} daily scores`);
		}
		if (wants("duels")) {
			/** Finished and abandoned games only: one being played right now is left to end by itself. */
			const voided = db.run(
				`DELETE FROM duel_games WHERE status IN ('finished', 'abandoned')
					AND id IN (SELECT game_id FROM duel_participants WHERE user_id = ?)`,
				[user.id]
			).changes;
			removed.push(`${voided} duels voided`);
			/** With no duels left there is nothing for a rating to rest on. */
			resetRating(user.id);
			removed.push("duel rating reset");
		}
		if (wants("achievements")) removed.push(`${clearAchievements(user.id)} achievements removed`);
		if (wants("streak")) {
			db.run("UPDATE users SET current_streak = 0, longest_streak = 0, last_played_date = NULL WHERE id = ?", [
				user.id,
			]);
			removed.push("streak cleared");
		}
	})();

	record(actor, user, "score_reset", `Reset ${scope}: ${removed.join(", ")}`, reason, RESET_NOTICE[scope]);
	return c.json({ success: true, removed });
});
