import { Hono } from "hono";
import { readdirSync, statSync } from "fs";
import { join } from "path";
import { requireStaff } from "../../auth/guards";
import { BACKUP_DIR, BACKUP_LIMITS, backupPath, createBackup, deleteBackup, listBackups } from "../../backups";
import { DATA_DIR, SITE_URL, UPLOADS_DIR } from "../../config";
import { db } from "../../db";
import {
	DAILY_MAX,
	clearSmtpSettings,
	emailAudience,
	emailAvailable,
	emailConfigured,
	emailReady,
	emailStats,
	removeAllEmails,
	saveSmtpSettings,
	sendDueDigests,
	sendTestEmail,
	smtpReady,
	smtpSettings,
} from "../../email";
import { duelRooms } from "../../game/duels/rooms";
import { soloGamesHeld } from "../../game/solo";
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
import { backfillAchievements } from "../../achievements";
import { systemBreakdown } from "../../system/breakdown";
import { features, isFeature, setFeature } from "../../system/features";
import { cancelPendingRestart, restartServer, runUpdate, updateStatus } from "../../system/updater";

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
			solo_games: soloGamesHeld(),
			rate_limit_keys: rateLimitKeys(),
		},
		logs: logCounts(),
		maintenance: maintenance(),
	});
});

/* ---- Email ---- */

/** How email is going. Mail server details only with `reveal`; the password never. */
adminSystemRoutes.get("/email", (c) => {
	requireStaff(c, "operator");
	const smtp = smtpSettings();
	const revealed = c.req.query("reveal") === "1";
	return c.json({
		configured: emailConfigured(),
		smtp_ready: smtpReady(),
		/** On only counts when there is a mail server to send with. */
		enabled: emailAvailable(),
		saved: !!smtp.host,
		revealed,
		...(revealed ? { host: smtp.host, port: smtp.port, user: smtp.user, from: smtp.from } : {}),
		has_password: !!smtp.pass,
		site_url: !!SITE_URL,
		daily_max: DAILY_MAX,
		stats: emailStats(),
		audience: emailAudience(),
	});
});

adminSystemRoutes.post("/email/settings", async (c) => {
	const actor = requireStaff(c, "operator");
	const body = await readJson<{ host: string; port: number; user: string; pass: string; from: string }>(c);
	const host = text(body.host, 200);
	const port = Math.floor(Number(body.port));
	const user = text(body.user, 200);
	const from = text(body.from, 200);
	if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host))
		fail(400, "Enter the mail server's host name, e.g. smtp.purelymail.com");
	if (![25, 465, 587, 2525].includes(port)) fail(400, "The port is usually 465 (TLS) or 587 (STARTTLS)");
	if (!user) fail(400, "Enter the username the mail server expects, usually the full email address");
	if (!/@/.test(from)) fail(400, "Enter a From line, e.g. Dovedale GeoGuesser <notifications@example.com>");
	saveSmtpSettings({ host, port, user, pass: typeof body.pass === "string" ? body.pass.slice(0, 500) : "", from });
	/** The details are a secret, so the record says only that they changed and where they point. */
	auditLog(actor, "email_settings", { details: `${host}:${port} as ${user}` });
	return c.json({ success: true });
});

adminSystemRoutes.delete("/email/settings", (c) => {
	const actor = requireStaff(c, "operator");
	clearSmtpSettings();
	/** Nothing to send with any more, so email goes off with it. */
	setFeature("email_digests", false);
	auditLog(actor, "email_settings", { details: "Mail server removed, email switched off" });
	return c.json({ success: true });
});

adminSystemRoutes.post("/email/test", async (c) => {
	const actor = requireStaff(c, "operator");
	if (!checkUserRateLimit(actor, "email-test", 5, 10 * 60 * 1000))
		fail(429, "A few tests were just sent. Try again shortly.");
	const to = text((await readJson<{ to: string }>(c)).to, 254);
	if (!/^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(to)) fail(400, "Enter the address to send the test to");
	if (!smtpReady()) fail(409, "Fill in and save the mail server details first");
	try {
		await sendTestEmail(to);
	} catch (err) {
		fail(502, `The mail server refused: ${err instanceof Error ? err.message : err}`);
	}
	auditLog(actor, "email_test", { details: "Test email sent" });
	return c.json({ success: true });
});

adminSystemRoutes.post("/email/clear", async (c) => {
	const actor = requireStaff(c, "operator");
	if ((await readJson<{ confirm: boolean }>(c)).confirm !== true) fail(400, "Confirmation required");
	const removed = removeAllEmails();
	auditLog(actor, "email_clear", { details: `${removed} addresses deleted` });
	return c.json({ success: true, removed });
});

adminSystemRoutes.post("/email/run", async (c) => {
	const actor = requireStaff(c, "operator");
	if (!checkUserRateLimit(actor, "email-run", 4, 10 * 60 * 1000)) fail(429, "That was just run. Try again shortly.");
	const sent = await sendDueDigests();
	auditLog(actor, "email_run", { details: `${sent} summaries sent` });
	return c.json({ success: true, sent });
});

adminSystemRoutes.get("/breakdown", async (c) => {
	requireStaff(c, "operator");
	return c.json(await systemBreakdown());
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
	/** A backup holds every account, so taking a copy off the server is always on record. */
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

adminSystemRoutes.post("/restart/cancel", (c) => {
	const actor = requireStaff(c, "operator");
	const problem = cancelPendingRestart(displayName(actor));
	if (problem) fail(409, problem);
	auditLog(actor, "server_restart_cancel", { details: "Restart called off from the staff panel" });
	return c.json({ success: true });
});

/* ---- Feature switches ---- */

adminSystemRoutes.get("/features", (c) => {
	requireStaff(c, "operator");
	return c.json(features());
});

adminSystemRoutes.post("/features", async (c) => {
	const actor = requireStaff(c, "operator");
	const body = await readJson<{ feature: string; enabled: boolean }>(c);
	if (!isFeature(body.feature) || typeof body.enabled !== "boolean") fail(400, "Unknown feature");
	if (body.feature === "email_digests" && body.enabled && !emailReady())
		fail(409, "Save a mail server on the Email tab before switching email on");
	const state = setFeature(body.feature, body.enabled);
	auditLog(actor, "feature_toggle", { details: `${body.feature} switched ${body.enabled ? "on" : "off"}` });
	return c.json(state);
});

adminSystemRoutes.post("/achievements/backfill", (c) => {
	const actor = requireStaff(c, "operator");
	if (!checkUserRateLimit(actor, "achievement-backfill", 3, 10 * 60 * 1000))
		fail(429, "That was run moments ago. Try again shortly.");
	const given = backfillAchievements();
	auditLog(actor, "achievements_backfill", { details: `${given} achievements given from history` });
	return c.json({ success: true, given });
});
