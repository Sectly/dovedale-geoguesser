import { Hono } from "hono";
import { db, type User } from "../db";
import { DEV_DISCORD_ID, DEV_MODE } from "../config";
import { hasRole } from "../auth/guards";
import { currentUser } from "../auth/sessions";
import { achievementsFor } from "../achievements";
import { ratingOf } from "../game/duels/rating";
import { getStreak } from "../game/streaks";
import { fail } from "../lib/http";
import { DAY, nowSec } from "../lib/time";

export const profileRoutes = new Hono();

export function findProfile(username: string): User | null {
	const user = db.query<User, [string]>("SELECT * FROM users WHERE username = ?").get(username);
	if (!user || user.is_banned || user.username === "[deleted]") return null;
	if (user.discord_id === DEV_DISCORD_ID && !DEV_MODE) return null;
	return user;
}

export function profileStats(userId: number) {
	const one = <T>(sql: string, ...params: number[]) => db.query<T, number[]>(sql).get(...params)!;
	return {
		solo: one<{ best_score: number | null; total_games: number; avg_score: number | null }>(
			"SELECT MAX(total_score) AS best_score, COUNT(*) AS total_games, ROUND(AVG(total_score)) AS avg_score FROM solo_scores WHERE user_id = ?",
			userId
		),
		duels: one<{ wins: number; games: number; total_score: number }>(
			`SELECT COALESCE(SUM(CASE WHEN dg.winner_id = dp.user_id THEN 1 ELSE 0 END), 0) AS wins,
				COUNT(*) AS games,
				COALESCE(SUM(dp.total_score), 0) AS total_score
			FROM duel_participants dp
			JOIN duel_games dg ON dg.id = dp.game_id
			WHERE dp.user_id = ? AND dg.status = 'finished'`,
			userId
		),
		submissions: one<{ total: number; approved: number }>(
			`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END), 0) AS approved
			FROM submissions
			WHERE submitted_by = ? AND NOT (status = 'denied' AND reviewed_at < ?)`,
			userId,
			nowSec() - 30 * DAY
		),
		daily: one<{
			best: number | null;
			played: number;
			avg: number | null;
			avg_distance: number | null;
			avg_time: number | null;
			no_hints: number;
		}>(
			`SELECT MAX(score) AS best, COUNT(*) AS played, ROUND(AVG(score)) AS avg, ROUND(AVG(distance)) AS avg_distance,
				ROUND(AVG(time_taken), 1) AS avg_time, COALESCE(SUM(hints_used = 0), 0) AS no_hints
			FROM daily_scores WHERE user_id = ?`,
			userId
		),
		/** Per-round numbers, which the totals hide. Duel rounds only go back as far as their details are kept. */
		rounds: one<{ solo_avg: number | null; duel_avg: number | null; duel_avg_time: number | null }>(
			`SELECT
				(SELECT ROUND(CAST(SUM(total_score) AS REAL) / SUM(rounds)) FROM solo_scores WHERE user_id = ?) AS solo_avg,
				(SELECT ROUND(AVG(score)) FROM duel_round_scores WHERE user_id = ?) AS duel_avg,
				(SELECT ROUND(AVG(time_taken), 1) FROM duel_round_scores WHERE user_id = ? AND guessed_x IS NOT NULL) AS duel_avg_time`,
			userId,
			userId,
			userId
		),
	};
}

export function recentGames(userId: number) {
	return {
		solo: db
			.query(
				"SELECT total_score, max_possible, rounds, time_limit, created_at FROM solo_scores WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 10"
			)
			.all(userId),
		daily: db
			.query(
				"SELECT date, score, ROUND(distance) AS distance, hints_used FROM daily_scores WHERE user_id = ? ORDER BY date DESC LIMIT 14"
			)
			.all(userId),
		duels: db
			.query(
				`SELECT dg.id, dg.rounds, dg.quickplay, dg.finished_at, dp.total_score AS score,
					CASE WHEN dg.winner_id = dp.user_id THEN 'win' WHEN dg.winner_id IS NULL THEN 'tie' ELSE 'loss' END AS result,
					o.total_score AS opponent_score, ou.username AS opponent_username, ou.display_name AS opponent_display_name
				FROM duel_participants dp
				JOIN duel_games dg ON dg.id = dp.game_id
				LEFT JOIN duel_participants o ON o.game_id = dg.id AND o.user_id != dp.user_id
				LEFT JOIN users ou ON ou.id = o.user_id
				WHERE dp.user_id = ? AND dg.status = 'finished'
				ORDER BY dg.finished_at DESC LIMIT 10`
			)
			.all(userId),
	};
}

profileRoutes.get("/:username", (c) => {
	const me = currentUser(c);
	const subject = findProfile(c.req.param("username"));
	if (!subject) fail(404, "Not found");
	if (subject.profile_private && me?.id !== subject.id && !hasRole(me, "moderator")) fail(403, "Profile is private");

	return c.json({
		id: subject.id,
		username: subject.username,
		display_name: subject.display_name,
		avatar_url: subject.avatar_url,
		created_at: subject.created_at,
		role: subject.role,
		profile_private: !!subject.profile_private,
		...getStreak(subject.id),
		...profileStats(subject.id),
		rating: { value: ratingOf(subject), games: subject.duel_rated_games ?? 0 },
		achievements: achievementsFor(subject.id),
		recent: recentGames(subject.id),
	});
});
