import { Hono, type Context } from "hono";
import { db } from "../db";
import { GAME } from "../config";
import { currentStreakSql } from "../game/streaks";
import { currentUser } from "../auth/sessions";
import { clientIp, fail, intQuery } from "../lib/http";
import { checkRateLimit } from "../lib/rate-limit";
import { utcDate } from "../lib/time";

export const leaderboardRoutes = new Hono();

const PLAYER_COLUMNS = "u.id AS user_id, u.username, u.display_name, u.avatar_url";

/** No board is served deeper than this, however many players are on it. */
const MAX_ENTRIES = 500;
const MAX_PER_PAGE = 100;

/** `limit` rows starting `offset` rows down, both held inside the cap: past it a request gets nothing. */
function pageQuery(c: Context): { limit: number; offset: number } {
	const offset = intQuery(c, "offset", 0, 0, MAX_ENTRIES);
	return { limit: Math.min(intQuery(c, "limit", 50, 1, MAX_PER_PAGE), MAX_ENTRIES - offset), offset };
}

/**
 * Boards are the same for everyone, so each answer is reused for a few seconds. A new score can take that long to
 * appear.
 */
const CACHE_MS = 10_000;
const MAX_CACHED = 500;
const boardCache = new Map<string, { at: number; rows: unknown[] }>();

function cached(key: string, compute: () => unknown[]): unknown[] {
	const now = Date.now();
	const hit = boardCache.get(key);
	if (hit && now - hit.at < CACHE_MS) return hit.rows;
	if (boardCache.size >= MAX_CACHED) pruneLeaderboardCache(now);
	if (boardCache.size >= MAX_CACHED) boardCache.clear();
	const rows = compute();
	boardCache.set(key, { at: now, rows });
	return rows;
}

export function pruneLeaderboardCache(now = Date.now()) {
	for (const [key, entry] of boardCache) {
		if (now - entry.at >= CACHE_MS) boardCache.delete(key);
	}
}

/** Drops every cached board, for when the scores behind them were changed directly. */
export function clearLeaderboardCache() {
	boardCache.clear();
}

/** The boards are public and each is a heavy query. */
leaderboardRoutes.use("*", async (c, next) => {
	const user = currentUser(c);
	const key = user ? `leaderboard:u${user.id}` : `leaderboard:ip:${clientIp(c)}`;
	if (!checkRateLimit(key, 60, 60 * 1000))
		fail(429, "You're loading the leaderboard too quickly. Try again shortly.");
	await next();
});

/** Each player's single best solo game under the chosen filters. */
leaderboardRoutes.get("/solo", (c) => {
	const { limit, offset } = pageQuery(c);
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

	const rows = cached(`solo:${limit}:${offset}:${byAverage}:${params.join(",")}:${filters.join(" ")}`, () =>
		db
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
			LIMIT ? OFFSET ?`
			)
			.all(...params, ...params, limit, offset)
	);
	return c.json(rows);
});

/** Every board breaks ties on account id, so pages never repeat or skip a player. */
leaderboardRoutes.get("/duels", (c) => {
	const { limit, offset } = pageQuery(c);
	const sort = c.req.query("sort");
	const mode = c.req.query("mode");
	const modeFilter = mode === "quickplay" ? "AND dg.quickplay = 1" : mode === "room" ? "AND dg.quickplay = 0" : "";
	const orderBy =
		sort === "rating"
			? "rating DESC, wins DESC"
			: sort === "score"
				? "total_score DESC, wins DESC"
				: sort === "avg"
					? "avg_per_round DESC, wins DESC"
					: "wins DESC, total_score DESC";

	const rows = cached(`duels:${limit}:${offset}:${orderBy}:${modeFilter}`, () =>
		db
			.query(
				`SELECT ${PLAYER_COLUMNS},
				COALESCE(u.duel_rating, ${GAME.rating.start}) AS rating,
				COALESCE(u.duel_rated_games, 0) AS rated_games,
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
			${sort === "rating" ? "HAVING rated_games > 0" : ""}
			ORDER BY ${orderBy}, u.id ASC
			LIMIT ? OFFSET ?`
			)
			.all(limit, offset)
	);
	return c.json(rows);
});

leaderboardRoutes.get("/daily", (c) => {
	const requested = c.req.query("date") ?? "";
	const date = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : utcDate();
	const { limit, offset } = pageQuery(c);
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

	const rows = cached(`daily:${limit}:${offset}:${date}:${orderBy}`, () =>
		db
			.query(
				`SELECT ${PLAYER_COLUMNS},
				ds.score, ROUND(ds.distance) AS distance, ds.hints_used, ROUND(ds.time_taken, 1) AS time_taken, ds.date,
				${currentStreakSql()} AS current_streak
			FROM daily_scores ds
			JOIN users u ON u.id = ds.user_id
			WHERE ds.date = ? AND u.is_banned = 0
			ORDER BY ${orderBy}, u.id ASC
			LIMIT ? OFFSET ?`
			)
			.all(date, limit, offset)
	);
	return c.json(rows);
});
