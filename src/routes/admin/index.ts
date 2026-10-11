import { Hono } from "hono";
import { db } from "../../db";
import { requireStaff } from "../../auth/guards";
import { duelRooms } from "../../game/duels/rooms";
import { activeSoloGames } from "../../game/solo";
import { auditLog } from "../../lib/audit";
import { fail, intQuery, readJson, text } from "../../lib/http";
import { announce } from "../../notifications";
import { DAY, nowSec } from "../../lib/time";
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

adminRoutes.get("/stats", (c) => {
	requireStaff(c);
	const count = (sql: string, ...params: number[]) => db.query<{ n: number }, number[]>(sql).get(...params)?.n ?? 0;
	const weekAgo = nowSec() - 7 * DAY;
	return c.json({
		users: {
			total: count("SELECT COUNT(*) AS n FROM users"),
			last_7d: count("SELECT COUNT(*) AS n FROM users WHERE created_at > ?", weekAgo),
			banned: count("SELECT COUNT(*) AS n FROM users WHERE is_banned = 1"),
		},
		locations: {
			total: count("SELECT COUNT(*) AS n FROM locations"),
			active: count("SELECT COUNT(*) AS n FROM locations WHERE is_active = 1"),
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
			active_rooms: duelRooms.size,
		},
		daily: {
			total_plays: count("SELECT COUNT(*) AS n FROM daily_scores"),
			last_7d: count("SELECT COUNT(*) AS n FROM daily_scores WHERE created_at > ?", weekAgo),
		},
	});
});

/** Operators can message every account at once. */
adminRoutes.post("/announcements", async (c) => {
	const staff = requireStaff(c, "operator");
	const body = await readJson<{ title: string; body: string }>(c);
	const title = text(body.title, 120);
	const message = text(body.body, 400);
	if (title.length < 5) fail(400, "Give the announcement a title of at least 5 characters");
	if (message.length < 10) fail(400, "Write a message of at least 10 characters");
	const sent = announce(title, message);
	auditLog(staff, "announcement", { details: `${title} (sent to ${sent})` });
	return c.json({ success: true, sent });
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
