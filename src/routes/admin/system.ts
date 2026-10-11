import { Hono } from "hono";
import { readdirSync, statSync } from "fs";
import { join } from "path";
import { requireStaff } from "../../auth/guards";
import { BACKUP_DIR, BACKUP_LIMITS, backupPath, createBackup, deleteBackup, listBackups } from "../../backups";
import { DATA_DIR, UPLOADS_DIR } from "../../config";
import { db } from "../../db";
import { duelRooms } from "../../game/duels/rooms";
import { activeSoloGames } from "../../game/solo";
import { teamRoomCount } from "../../game/teams";
import { auditLog } from "../../lib/audit";
import { fail, intQuery, readJson, text } from "../../lib/http";
import { SUPERVISED } from "../../lib/lifecycle";
import { clearLogs, logCounts, readLogs } from "../../lib/logs";
import { checkUserRateLimit, rateLimitKeys } from "../../lib/rate-limit";
import { displayName } from "../../lib/webhook";
import {
	DEFAULT_MAINTENANCE_MESSAGE,
	MAINTENANCE_MESSAGE_MAX,
	maintenance,
	setMaintenance,
} from "../../system/maintenance";
import { restartServer, runUpdate, updateStatus } from "../../system/updater";

/** Routes mounted at /api/admin/system: backups, logs, updates and restarts. Operators only. */
export const adminSystemRoutes = new Hono();

const startedAt = Date.now();

function folderSize(dir: string): { files: number; bytes: number } {
	let files = 0;
	let bytes = 0;
	try {
		for (const name of readdirSync(dir)) {
			const stat = statSync(join(dir, name));
			if (!stat.isFile()) continue;
			files++;
			bytes += stat.size;
		}
	} catch {}
	return { files, bytes };
}

adminSystemRoutes.get("/info", (c) => {
	requireStaff(c, "operator");
	const size = (name: string) => {
		try {
			return statSync(join(DATA_DIR, name)).size;
		} catch {
			return 0;
		}
	};
	return c.json({
		uptime: Math.floor((Date.now() - startedAt) / 1000),
		supervised: SUPERVISED,
		runtime: `Bun ${Bun.version}`,
		memory: process.memoryUsage().rss,
		database: size("geoguesser.sqlite") + size("geoguesser.sqlite-wal"),
		uploads: folderSize(UPLOADS_DIR),
		backups: folderSize(BACKUP_DIR),
		live: {
			duel_rooms: duelRooms.size,
			team_rooms: teamRoomCount(),
			solo_games: activeSoloGames(),
			rate_limit_keys: rateLimitKeys(),
		},
		logs: logCounts(),
		maintenance: maintenance(),
	});
});

/* ---- Maintenance mode ---- */

adminSystemRoutes.get("/maintenance", (c) => {
	requireStaff(c, "operator");
	return c.json({ ...maintenance(), default_message: DEFAULT_MAINTENANCE_MESSAGE });
});

adminSystemRoutes.post("/maintenance", async (c) => {
	const actor = requireStaff(c, "operator");
	const body = await readJson<{ enabled: boolean; message: string }>(c);
	if (typeof body.enabled !== "boolean") fail(400, "Say whether maintenance mode should be on or off");
	const state = setMaintenance(body.enabled, text(body.message, MAINTENANCE_MESSAGE_MAX), displayName(actor));
	auditLog(actor, state.enabled ? "maintenance_on" : "maintenance_off", { details: state.message || null });
	return c.json(state);
});

/* ---- Backups ---- */

adminSystemRoutes.get("/backups", (c) => {
	requireStaff(c, "operator");
	return c.json({ backups: listBackups(), limits: BACKUP_LIMITS });
});

adminSystemRoutes.post("/backups", (c) => {
	const actor = requireStaff(c, "operator");
	if (!checkUserRateLimit(actor, "backup", 2, 10 * 60 * 1000))
		fail(429, "A backup was made moments ago. Try again shortly.");
	const name = createBackup(db, "manual");
	auditLog(actor, "backup_create", { details: name });
	return c.json({ success: true, name });
});

adminSystemRoutes.get("/backups/:name/download", (c) => {
	const actor = requireStaff(c, "operator");
	const name = c.req.param("name");
	const path = backupPath(name) ?? fail(404, "Backup not found");
	// A backup holds every account, so taking a copy off the server is always on record.
	auditLog(actor, "backup_download", { details: name });
	return c.body(Bun.file(path).stream(), 200, {
		"Content-Type": "application/vnd.sqlite3",
		"Content-Disposition": `attachment; filename="${name}"`,
		"Content-Length": String(statSync(path).size),
	});
});

adminSystemRoutes.delete("/backups/:name", (c) => {
	const actor = requireStaff(c, "operator");
	const name = c.req.param("name");
	if (!deleteBackup(name)) fail(404, "Backup not found");
	auditLog(actor, "backup_delete", { details: name });
	return c.json({ success: true });
});

/* ---- Logs ---- */

adminSystemRoutes.get("/logs", (c) => {
	requireStaff(c, "operator");
	return c.json({
		logs: readLogs({
			level: c.req.query("level"),
			search: text(c.req.query("q"), 100),
			before: intQuery(c, "before", 0, 0, Number.MAX_SAFE_INTEGER) || undefined,
			limit: intQuery(c, "limit", 100, 1, 200),
		}),
		counts: logCounts(),
	});
});

adminSystemRoutes.delete("/logs", (c) => {
	const actor = requireStaff(c, "operator");
	const removed = clearLogs();
	auditLog(actor, "logs_clear", { details: `${removed} entries removed` });
	return c.json({ success: true, removed });
});

/* ---- Updates and restarts ---- */

adminSystemRoutes.get("/update", async (c) => {
	requireStaff(c, "operator");
	return c.json(await updateStatus(c.req.query("refresh") === "1"));
});

adminSystemRoutes.post("/update", async (c) => {
	const actor = requireStaff(c, "operator");
	if ((await readJson<{ confirm: boolean }>(c)).confirm !== true) fail(400, "Confirmation required");
	const problem = await runUpdate(displayName(actor));
	if (problem) fail(409, problem);
	auditLog(actor, "server_update", { details: "Update and restart started from the staff panel" });
	return c.json({ success: true });
});

adminSystemRoutes.post("/restart", async (c) => {
	const actor = requireStaff(c, "operator");
	if ((await readJson<{ confirm: boolean }>(c)).confirm !== true) fail(400, "Confirmation required");
	const problem = restartServer(displayName(actor));
	if (problem) fail(409, problem);
	auditLog(actor, "server_restart", { details: "Restart requested from the staff panel" });
	return c.json({ success: true });
});
