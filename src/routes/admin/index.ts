import { Hono } from "hono";
import { db } from "../../db";
import { requireStaff } from "../../auth/guards";
import {
	ANNOUNCEMENT_AUDIENCES,
	BANNER_HOURS,
	audienceSizes,
	cleanLink,
	endBanner,
	previewAnnouncement,
	recentAnnouncements,
	sendAnnouncement,
	type Audience,
} from "../../announcements";
import { duelRooms, duelsInProgress } from "../../game/duels/rooms";
import { difficultyCounts } from "../../game/locations";
import { activeSoloGames } from "../../game/solo";
import { teamGamesInProgress } from "../../game/teams";
import { auditLog } from "../../lib/audit";
import { fail, idParam, intQuery, readJson, text } from "../../lib/http";
import { DAY, nowSec, utcDate } from "../../lib/time";
import { displayName } from "../../lib/webhook";
import { staffQueue } from "../../notifications";
import { adminLocationRoutes } from "./locations";
import { adminSubmissionRoutes } from "./submissions";
import { adminSuggestionRoutes } from "./suggestions";
import { adminSupportRoutes } from "./support";
import { adminScoreRoutes } from "./scores";
import { adminSystemRoutes } from "./system";
import { adminModerationRoutes, adminUserRoutes } from "./users";

export const adminRoutes = new Hono();

adminRoutes.route("/submissions", adminSubmissionRoutes);
adminRoutes.route("/locations", adminLocationRoutes);
adminRoutes.route("/suggestions", adminSuggestionRoutes);
adminRoutes.route("/users", adminUserRoutes);
adminRoutes.route("/moderation", adminModerationRoutes);
adminRoutes.route("/support", adminSupportRoutes);
adminRoutes.route("/system", adminSystemRoutes);
adminRoutes.route("/scores", adminScoreRoutes);

/** How many days the activity chart covers. */
const SERIES_DAYS = 14;

/** One row per UTC day for the last two weeks: who arrived and what was played. */
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

adminRoutes.get("/stats", (c) => {
	requireStaff(c);
	const count = (sql: string, ...params: (number | string)[]) =>
		db.query<{ n: number }, (number | string)[]>(sql).get(...params)?.n ?? 0;
	const weekAgo = nowSec() - 7 * DAY;
	const graded = difficultyCounts();
	const activeLocations = count("SELECT COUNT(*) AS n FROM locations WHERE is_active = 1");
	return c.json({
		/** What is happening this minute. */
		live: {
			duels: duelsInProgress(),
			duel_rooms_waiting: [...duelRooms.values()].filter((room) => room.status === "waiting").length,
			spectators: [...duelRooms.values()].reduce((sum, room) => sum + room.spectators.size, 0),
			team_games: teamGamesInProgress(),
			solo_games: activeSoloGames(),
		},
		/** What is waiting for staff. */
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

/* ---- Announcements (operators) ---- */

adminRoutes.get("/announcements", (c) => {
	requireStaff(c, "operator");
	return c.json({ history: recentAnnouncements(), audiences: audienceSizes(), banner_hours: BANNER_HOURS });
});

/**
 * Sends a message to many accounts at once, optionally pinning it as a banner on every page.
 * With `test: true` it goes to the sender alone and nothing is recorded.
 */
adminRoutes.post("/announcements", async (c) => {
	const staff = requireStaff(c, "operator");
	const body = await readJson<{
		title: string;
		body: string;
		link: string;
		audience: Audience;
		banner_hours: number;
		test: boolean;
	}>(c);
	const title = text(body.title, 120);
	const message = text(body.body, 400);
	if (title.length < 5) fail(400, "Give the announcement a title of at least 5 characters");
	if (message.length < 10) fail(400, "Write a message of at least 10 characters");
	const link = cleanLink(body.link);

	if (body.test === true) {
		previewAnnouncement({ title, body: message, link }, staff);
		return c.json({ success: true, sent: 1, test: true });
	}

	const audience = body.audience === undefined ? "everyone" : body.audience;
	if (!ANNOUNCEMENT_AUDIENCES.includes(audience)) fail(400, "Choose who the announcement is for");
	const bannerHours = body.banner_hours ?? 0;
	if (!BANNER_HOURS.includes(bannerHours)) fail(400, "Choose how long the banner stays up");
	if (bannerHours > 0 && audience === "staff")
		fail(400, "A staff-only announcement cannot be shown as a site banner");

	const sent = sendAnnouncement({ title, body: message, link, audience, bannerHours }, staff, displayName(staff));
	auditLog(staff, "announcement", {
		details: `${title} (${audience}, sent to ${sent.sent_to}${bannerHours ? `, banner for ${bannerHours}h` : ""})`,
	});
	return c.json({ success: true, sent: sent.sent_to, id: sent.id });
});

adminRoutes.post("/announcements/:id/end-banner", (c) => {
	const staff = requireStaff(c, "operator");
	const id = idParam(c);
	if (!endBanner(id)) fail(409, "That announcement has no banner showing");
	auditLog(staff, "announcement_banner_end", { details: `Announcement #${id}` });
	return c.json({ success: true });
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
