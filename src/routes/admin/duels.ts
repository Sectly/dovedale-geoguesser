import { Hono } from "hono";
import { requireStaff } from "../../auth/guards";
import { db } from "../../db";
import { allOpenDuels, closeDuelByStaff, duelRooms, duelsInProgress } from "../../game/duels/rooms";
import { auditLog } from "../../lib/audit";
import { requireReason } from "../../moderation";
import { fail, intQuery, readJson, text } from "../../lib/http";
import { DAY, nowSec } from "../../lib/time";

export const adminDuelRoutes = new Hono();

const PAGE = 30;

type DuelRow = {
	id: number;
	room_code: string;
	rounds: number;
	status: string;
	quickplay: number;
	winner_id: number | null;
	created_at: number;
	finished_at: number | null;
};

adminDuelRoutes.get("/stats", (c) => {
	requireStaff(c);
	const one = <T>(sql: string, ...params: number[]) => db.query<T, number[]>(sql).get(...params)!;
	const monthAgo = nowSec() - 30 * DAY;
	const finished = one<{
		total: number;
		ranked: number;
		draws: number;
		last_day: number;
		last_week: number;
		avg_seconds: number | null;
		avg_rounds: number | null;
	}>(
		`SELECT COUNT(*) AS total, COALESCE(SUM(quickplay), 0) AS ranked, COALESCE(SUM(winner_id IS NULL), 0) AS draws,
			COALESCE(SUM(finished_at > ?), 0) AS last_day, COALESCE(SUM(finished_at > ?), 0) AS last_week,
			ROUND(AVG(finished_at - created_at)) AS avg_seconds, ROUND(AVG(rounds), 1) AS avg_rounds
		FROM duel_games WHERE status = 'finished'`,
		nowSec() - DAY,
		nowSec() - 7 * DAY
	);
	return c.json({
		finished,
		abandoned: one<{ n: number }>("SELECT COUNT(*) AS n FROM duel_games WHERE status = 'abandoned'").n,
		live: {
			playing: duelsInProgress(),
			waiting: [...duelRooms.values()].filter((room) => room.status === "waiting").length,
		},
		rating: one<{ players: number; average: number | null; highest: number | null }>(
			`SELECT COUNT(*) AS players, ROUND(AVG(duel_rating)) AS average, MAX(duel_rating) AS highest
			FROM users WHERE duel_rated_games > 0 AND username != '[deleted]'`
		),
		top_rated: db
			.query(
				`SELECT id, username, display_name, duel_rating, duel_rated_games FROM users
				WHERE duel_rated_games > 0 AND username != '[deleted]' ORDER BY duel_rating DESC LIMIT 5`
			)
			.all(),
		most_active: db
			.query(
				`SELECT u.id, u.username, u.display_name, COUNT(*) AS games, COALESCE(SUM(g.winner_id = u.id), 0) AS wins
				FROM duel_participants p
				JOIN duel_games g ON g.id = p.game_id AND g.status = 'finished' AND g.finished_at > ?
				JOIN users u ON u.id = p.user_id
				WHERE u.username != '[deleted]'
				GROUP BY u.id ORDER BY games DESC LIMIT 5`
			)
			.all(monthAgo),
		/** The same two players meeting again and again is what boosting looks like. */
		repeat_pairs: db
			.query(
				`SELECT a.user_id AS first_id, ua.username AS first, b.user_id AS second_id, ub.username AS second,
					COUNT(*) AS games, COALESCE(SUM(g.quickplay), 0) AS ranked
				FROM duel_participants a
				JOIN duel_participants b ON b.game_id = a.game_id AND b.user_id > a.user_id
				JOIN duel_games g ON g.id = a.game_id AND g.status = 'finished' AND g.finished_at > ?
				JOIN users ua ON ua.id = a.user_id
				JOIN users ub ON ub.id = b.user_id
				GROUP BY a.user_id, b.user_id HAVING COUNT(*) >= 5 ORDER BY games DESC LIMIT 5`
			)
			.all(monthAgo),
	});
});

adminDuelRoutes.get("/live", (c) => {
	requireStaff(c, "admin");
	return c.json(allOpenDuels());
});

/** Closes a room that is open or being played. Nobody's score, rating or record changes. */
adminDuelRoutes.post("/live/:code/close", async (c) => {
	const staff = requireStaff(c, "admin");
	const reason = requireReason((await readJson<{ reason: string }>(c)).reason);
	const room =
		closeDuelByStaff(text(c.req.param("code"), 12).toUpperCase()) ?? fail(404, "That duel is no longer open");
	auditLog(staff, "duel_force_close", {
		targetType: "duel",
		targetId: room.dbId,
		details: `${room.code}: ${room.players.map((p) => p.username).join(" vs ") || "empty room"}. ${reason}`,
	});
	return c.json({ success: true });
});

/** Past duels, newest first. `kind` is quickplay or private, `q` a player's username. */
adminDuelRoutes.get("/", (c) => {
	requireStaff(c);
	const offset = intQuery(c, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
	const clauses = ["g.status IN ('finished', 'abandoned')"];
	const params: (string | number)[] = [];
	const kind = c.req.query("kind");
	if (kind === "quickplay" || kind === "private") clauses.push(`g.quickplay = ${kind === "quickplay" ? 1 : 0}`);
	if (c.req.query("status") === "finished") clauses.push("g.status = 'finished'");
	const search = text(c.req.query("q"), 40).replace(/^@/, "");
	if (search) {
		clauses.push(
			`(g.room_code LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM duel_participants p JOIN users u ON u.id = p.user_id
				WHERE p.game_id = g.id AND u.username LIKE ? ESCAPE '\\'))`
		);
		const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
		params.push(pattern, pattern);
	}
	const games = db
		.query<DuelRow, (string | number)[]>(
			`SELECT g.id, g.room_code, g.rounds, g.status, g.quickplay, g.winner_id, g.created_at, g.finished_at
			FROM duel_games g WHERE ${clauses.join(" AND ")} ORDER BY g.id DESC LIMIT ? OFFSET ?`
		)
		.all(...params, PAGE + 1, offset);
	const page = games.slice(0, PAGE);
	const players = page.length
		? db
				.query<{ game_id: number }, number[]>(
					`SELECT p.game_id, p.user_id, u.username, u.display_name, p.total_score, p.rating_change
					FROM duel_participants p JOIN users u ON u.id = p.user_id
					WHERE p.game_id IN (${page.map(() => "?").join(",")}) ORDER BY p.total_score DESC`
				)
				.all(...page.map((game) => game.id))
		: [];
	return c.json({
		games: page.map((game) => ({ ...game, players: players.filter((player) => player.game_id === game.id) })),
		more: games.length > PAGE,
		offset,
	});
});
