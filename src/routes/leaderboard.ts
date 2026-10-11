import { Hono } from "hono";
import { db } from "../db";
import { GAME } from "../config";
import { currentStreakSql } from "../game/streaks";
import { intQuery } from "../lib/http";
import { utcDate } from "../lib/time";

export const leaderboardRoutes = new Hono();

const PLAYER_COLUMNS = "u.id AS user_id, u.username, u.display_name, u.avatar_url";

/** Each player's single best solo game under the chosen filters. */
leaderboardRoutes.get("/solo", (c) => {
	const limit = intQuery(c, "limit", 50, 1, 100);
	const byAverage = c.req.query("sort") === "avg";
	const rounds = intQuery(c, "rounds", 0, 0, 100);
	const timeLimit = intQuery(c, "time_limit", -1, -1, 3600);

	const filters: string[] = [];
	const params: number[] = [];
	if (rounds > 0) {
		filters.push("AND s.rounds = ?");
		params.push(rounds);
	}
	if (timeLimit >= 0 && GAME.solo.timeLimits.includes(timeLimit)) {
		filters.push("AND s.time_limit = ?");
		params.push(timeLimit);
	}
	const filter = (alias: string) => filters.join(" ").replaceAll("s.", `${alias}.`);
	const ranking = (alias: string) =>
		byAverage ? `CAST(${alias}.total_score AS REAL) / ${alias}.rounds` : `${alias}.total_score`;

	const rows = db
		.query(
			`SELECT ${PLAYER_COLUMNS},
				ss.total_score, ss.rounds, ss.max_possible, ss.time_limit,
				ROUND(CAST(ss.total_score AS REAL) / ss.rounds) AS avg_per_round
			FROM solo_scores ss
			JOIN users u ON u.id = ss.user_id
			WHERE u.is_banned = 0 ${filter("ss")}
			AND ss.id = (
				SELECT s2.id FROM solo_scores s2
				WHERE s2.user_id = ss.user_id ${filter("s2")}
				ORDER BY ${ranking("s2")} DESC, s2.id ASC
				LIMIT 1
			)
			ORDER BY ${ranking("ss")} DESC, ss.id ASC
			LIMIT ?`
		)
		.all(...params, ...params, limit);
	return c.json(rows);
});

leaderboardRoutes.get("/duels", (c) => {
	const limit = intQuery(c, "limit", 50, 1, 100);
	const sort = c.req.query("sort");
	const mode = c.req.query("mode");
	const modeFilter = mode === "quickplay" ? "AND dg.quickplay = 1" : mode === "room" ? "AND dg.quickplay = 0" : "";
	const orderBy =
		sort === "score"
			? "total_score DESC, wins DESC"
			: sort === "avg"
				? "avg_per_round DESC, wins DESC"
				: "wins DESC, total_score DESC";

	const rows = db
		.query(
			`SELECT ${PLAYER_COLUMNS},
				SUM(dp.total_score) AS total_score,
				COUNT(*) AS games_played,
				SUM(CASE WHEN dg.winner_id = u.id THEN 1 ELSE 0 END) AS wins,
				SUM(CASE WHEN dg.quickplay = 1 THEN 1 ELSE 0 END) AS quickplay_games,
				SUM(CASE WHEN dg.quickplay = 0 THEN 1 ELSE 0 END) AS room_games,
				CAST(SUM(dp.total_score) AS REAL) / NULLIF(SUM(dg.rounds), 0) AS avg_per_round
			FROM duel_participants dp
			JOIN users u ON u.id = dp.user_id
			JOIN duel_games dg ON dg.id = dp.game_id
			WHERE dg.status = 'finished' AND u.is_banned = 0 ${modeFilter}
			GROUP BY dp.user_id
			ORDER BY ${orderBy}
			LIMIT ?`
		)
		.all(limit);
	return c.json(rows);
});

leaderboardRoutes.get("/daily", (c) => {
	const requested = c.req.query("date") ?? "";
	const date = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : utcDate();
	const limit = intQuery(c, "limit", 50, 1, 100);
	const sort = c.req.query("sort");
	/** Players who never placed a pin have no distance; keep them at the bottom of that view. */
	const orderBy =
		sort === "distance"
			? "ds.distance IS NULL, ds.distance ASC"
			: sort === "time"
				? "ds.time_taken ASC, ds.score DESC"
				: sort === "hints"
					? "ds.hints_used ASC, ds.score DESC"
					: "ds.score DESC, ds.time_taken ASC";

	const rows = db
		.query(
			`SELECT ${PLAYER_COLUMNS},
				ds.score, ROUND(ds.distance) AS distance, ds.hints_used, ROUND(ds.time_taken, 1) AS time_taken, ds.date,
				${currentStreakSql()} AS current_streak
			FROM daily_scores ds
			JOIN users u ON u.id = ds.user_id
			WHERE ds.date = ? AND u.is_banned = 0
			ORDER BY ${orderBy}
			LIMIT ?`
		)
		.all(date, limit);
	return c.json(rows);
});
