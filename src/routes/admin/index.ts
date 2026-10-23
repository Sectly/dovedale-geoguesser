import { Hono } from "hono";
import { db } from "../../db";
import { hasRole, requireStaff } from "../../auth/guards";
import { duelRooms, duelsInProgress } from "../../game/duels/rooms";
import { difficultyCounts } from "../../game/locations";
import { activeSoloGames } from "../../game/solo";
import { teamGamesInProgress } from "../../game/teams";
import { auditLog } from "../../lib/audit";
import { CLAIM_KINDS, liveClaims, releaseClaim, setClaim, type ClaimKind } from "../../lib/claims";
import { fail, idParam, intQuery, readJson, text } from "../../lib/http";
import { DAY, nowSec, utcDate } from "../../lib/time";
import { displayName } from "../../lib/webhook";
import { staffQueue } from "../../notifications";
import { maintenance } from "../../system/maintenance";
import { restartIn } from "../../system/restart";
import { adminAnnouncementRoutes } from "./announcements";
import { adminChatRoutes } from "./chat";
import { adminDuelRoutes } from "./duels";
import { adminLocationRoutes } from "./locations";
import { adminSubmissionRoutes } from "./submissions";
import { adminSuggestionRoutes } from "./suggestions";
import { adminSupportRoutes } from "./support";
import { adminScoreRoutes } from "./scores";
import { adminTournamentRoutes } from "./tournaments";
import { adminSystemRoutes } from "./system";
import { adminModerationRoutes, adminUserRoutes } from "./users";
import { adminWordFilterRoutes } from "./word-filter";

export const adminRoutes = new Hono();

adminRoutes.route("/submissions", adminSubmissionRoutes);
adminRoutes.route("/locations", adminLocationRoutes);
adminRoutes.route("/suggestions", adminSuggestionRoutes);
adminRoutes.route("/users", adminUserRoutes);
adminRoutes.route("/moderation", adminModerationRoutes);
adminRoutes.route("/support", adminSupportRoutes);
adminRoutes.route("/system", adminSystemRoutes);
adminRoutes.route("/scores", adminScoreRoutes);
adminRoutes.route("/duels", adminDuelRoutes);
adminRoutes.route("/tournaments", adminTournamentRoutes);
adminRoutes.route("/announcements", adminAnnouncementRoutes);
adminRoutes.route("/word-filter", adminWordFilterRoutes);
adminRoutes.route("/chat", adminChatRoutes);

const SERIES_DAYS = 14;

function activitySeries() {
	const since = utcDate(-(SERIES_DAYS - 1));
	const byDay = (sql: string) =>
		new Map(
			db
				.query<{ day: string; n: number }, [string]>(sql)
				.all(since)
				.map((row) => [row.day, row.n])
		);
	const perDay = (table: string, column: string, extra = "") =>
		byDay(
			`SELECT date(${column}, 'unixepoch') AS day, COUNT(*) AS n FROM ${table}
			WHERE date(${column}, 'unixepoch') >= ? ${extra} GROUP BY day`
		);
	const newUsers = perDay("users", "created_at", "AND username != '[deleted]'");
	const solo = perDay("solo_scores", "created_at");
	const duels = perDay("duel_games", "finished_at", "AND status = 'finished'");
	const daily = byDay("SELECT date AS day, COUNT(*) AS n FROM daily_scores WHERE date >= ? GROUP BY date");
	return Array.from({ length: SERIES_DAYS }, (_, i) => {
		const date = utcDate(i - (SERIES_DAYS - 1));
		return {
			date,
			new_users: newUsers.get(date) ?? 0,
			solo: solo.get(date) ?? 0,
			daily: daily.get(date) ?? 0,
			duels: duels.get(date) ?? 0,
		};
	});
}

const liveCounts = () => ({
	duels: duelsInProgress(),
	spectators: [...duelRooms.values()].reduce((sum, room) => sum + room.spectators.size, 0),
	team_games: teamGamesInProgress(),
	solo_games: activeSoloGames(),
});

/** The panel's home tab. Each role gets only what its own tabs would show. */
adminRoutes.get("/overview", (c) => {
	const staff = requireStaff(c, "helper");
	const moderator = hasRole(staff, "moderator");
	const senior = hasRole(staff, "supervisor");
	const oldest = (sql: string) => db.query<{ at: number | null }, []>(sql).get()?.at ?? null;
	const queue = staffQueue();
	const waiting = [
		{
			tab: "submissions",
			label: "Submissions",
			count: queue.submissions,
			oldest: oldest("SELECT MIN(created_at) AS at FROM submissions WHERE status = 'pending'"),
		},
		{
			tab: "suggestions",
			label: "Suggestions",
			count: queue.suggestions,
			oldest: oldest("SELECT MIN(created_at) AS at FROM location_suggestions WHERE status = 'pending'"),
		},
	];
	if (moderator)
		waiting.push(
			{
				tab: "tickets",
				label: "Tickets",
				count: queue.tickets,
				oldest: oldest(
					`SELECT MIN(COALESCE(t.user_replied_at, t.created_at)) AS at FROM support_tickets t WHERE t.status = 'open' AND (
						t.awaiting_staff = 1 OR NOT EXISTS (SELECT 1 FROM ticket_replies r WHERE r.ticket_id = t.id AND r.type = 'staff'))`
				),
			},
			{ tab: "users", label: "Evasion flags", count: queue.users, oldest: null }
		);
	const actions = (where: string, ...params: number[]) =>
		db
			.query(
				`SELECT id, actor_username, action, target_type, target_id, target_username, details, created_at
				FROM audit_log WHERE ${where} ORDER BY id DESC LIMIT 8`
			)
			.all(...params);
	return c.json({
		waiting,
		flagged: moderator
			? db
					.query(
						`SELECT u.id, u.username, u.display_name, u.avatar_url, COUNT(*) AS flags, MIN(f.created_at) AS since
						FROM fairplay_flags f JOIN users u ON u.id = f.user_id
						WHERE f.dismissed_at IS NULL GROUP BY u.id ORDER BY since LIMIT 8`
					)
					.all()
			: [],
		live: liveCounts(),
		notices: {
			maintenance: maintenance().enabled,
			restart_in: restartIn(),
		},
		mine: actions("actor_id = ?", staff.id),
		/** Other staff's actions belong to the audit log, which starts at supervisor. */
		recent: senior ? actions("actor_id IS NOT NULL AND actor_id != ?", staff.id) : [],
	});
});

adminRoutes.post("/claims", async (c) => {
	const staff = requireStaff(c, "helper");
	const body = await readJson<{ kind: ClaimKind; id: number }>(c);
	const { kind, id } = body;
	const mayClaim = kind === "submission" || hasRole(staff, "moderator");
	if (kind && CLAIM_KINDS.includes(kind) && typeof id === "number" && Number.isInteger(id) && id > 0 && mayClaim)
		setClaim(staff, kind, id);
	else releaseClaim(staff.id);
	return c.json(
		liveClaims().filter(
			(claim) => claim.staff_id !== staff.id && (claim.kind === "submission" || hasRole(staff, "moderator"))
		)
	);
});

adminRoutes.get("/stats", (c) => {
	requireStaff(c);
	const count = (sql: string, ...params: (number | string)[]) =>
		db.query<{ n: number }, (number | string)[]>(sql).get(...params)?.n ?? 0;
	const weekAgo = nowSec() - 7 * DAY;
	const graded = difficultyCounts();
	const activeLocations = count("SELECT COUNT(*) AS n FROM locations WHERE is_active = 1");
	return c.json({
		live: {
			...liveCounts(),
			duel_rooms_waiting: [...duelRooms.values()].filter((room) => room.status === "waiting").length,
		},
		queues: staffQueue(),
		users: {
			total: count("SELECT COUNT(*) AS n FROM users WHERE username != '[deleted]'"),
			last_7d: count("SELECT COUNT(*) AS n FROM users WHERE created_at > ? AND username != '[deleted]'", weekAgo),
			banned: count("SELECT COUNT(*) AS n FROM users WHERE is_banned = 1"),
			active_today: count("SELECT COUNT(*) AS n FROM users WHERE last_played_date = ?", utcDate()),
			active_7d: count("SELECT COUNT(*) AS n FROM users WHERE last_played_date >= ?", utcDate(-6)),
			active_30d: count("SELECT COUNT(*) AS n FROM users WHERE last_played_date >= ?", utcDate(-29)),
		},
		locations: {
			total: count("SELECT COUNT(*) AS n FROM locations"),
			active: activeLocations,
			...graded,
			ungraded: Math.max(0, activeLocations - graded.easy - graded.medium - graded.hard),
		},
		submissions: {
			total: count("SELECT COUNT(*) AS n FROM submissions"),
			pending: count("SELECT COUNT(*) AS n FROM submissions WHERE status = 'pending'"),
		},
		scores: {
			total_games: count("SELECT COUNT(*) AS n FROM solo_scores"),
			last_7d: count("SELECT COUNT(*) AS n FROM solo_scores WHERE created_at > ?", weekAgo),
			in_progress: activeSoloGames(),
		},
		duels: {
			total_rooms: count("SELECT COUNT(*) AS n FROM duel_games"),
			finished: count("SELECT COUNT(*) AS n FROM duel_games WHERE status = 'finished'"),
			ranked: count("SELECT COUNT(*) AS n FROM duel_games WHERE status = 'finished' AND quickplay = 1"),
			last_7d: count(
				"SELECT COUNT(*) AS n FROM duel_games WHERE status = 'finished' AND finished_at > ?",
				weekAgo
			),
			active_rooms: duelRooms.size,
		},
		daily: {
			total_plays: count("SELECT COUNT(*) AS n FROM daily_scores"),
			last_7d: count("SELECT COUNT(*) AS n FROM daily_scores WHERE created_at > ?", weekAgo),
			today: count("SELECT COUNT(*) AS n FROM daily_scores WHERE date = ?", utcDate()),
		},
		achievements: { earned: count("SELECT COUNT(*) AS n FROM user_achievements") },
		series: activitySeries(),
	});
});

const AUDIT_SEARCH_COLUMNS = [
	"CAST(a.id AS TEXT)",
	"CAST(a.actor_id AS TEXT)",
	"a.actor_username",
	"a.action",
	"a.target_type",
	"CAST(a.target_id AS TEXT)",
	"a.target_username",
	"a.details",
];

adminRoutes.get("/audit", (c) => {
	requireStaff(c, "supervisor");
	const limit = intQuery(c, "limit", 100, 1, 200);
	const offset = intQuery(c, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
	const clauses: string[] = [];
	const params: (string | number)[] = [];
	const where = (clause: string, ...values: (string | number)[]) => {
		clauses.push(clause);
		params.push(...values);
	};

	const actions = (c.req.query("action") || c.req.query("actions") || "")
		.split(",")
		.map((a) => a.trim())
		.filter(Boolean)
		.slice(0, 20);
	if (actions.length) where(`a.action IN (${actions.map(() => "?").join(",")})`, ...actions);

	const actorId = parseInt(c.req.query("actor") ?? "", 10);
	if (Number.isFinite(actorId)) where("a.actor_id = ?", actorId);
	const targetType = c.req.query("target_type");
	if (targetType) where("a.target_type = ?", targetType);
	const targetId = parseInt(c.req.query("target_id") ?? "", 10);
	if (Number.isFinite(targetId)) where("a.target_id = ?", targetId);

	const from = Math.floor(new Date(c.req.query("from") || "").getTime() / 1000);
	if (Number.isFinite(from)) where("a.created_at >= ?", from);
	const to = Math.floor(new Date(c.req.query("to") || "").getTime() / 1000);
	if (Number.isFinite(to)) where("a.created_at <= ?", to);

	const search = (c.req.query("q") || "").trim().replace(/#/g, "").slice(0, 100);
	if (search) {
		const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
		where(
			`(${AUDIT_SEARCH_COLUMNS.map((col) => `${col} LIKE ? ESCAPE '\\'`).join(" OR ")})`,
			...AUDIT_SEARCH_COLUMNS.map(() => pattern)
		);
	}

	const filter = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
	const rows = db
		.query(`SELECT a.* FROM audit_log a ${filter} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`)
		.all(...params, limit, offset);
	const total =
		db.query<{ n: number }, (string | number)[]>(`SELECT COUNT(*) AS n FROM audit_log a ${filter}`).get(...params)
			?.n ?? 0;
	return c.json({ rows, total, limit, offset });
});
