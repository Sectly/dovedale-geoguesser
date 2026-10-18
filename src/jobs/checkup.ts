import { existsSync } from "fs";
import { join } from "path";
import { db, freeSpaceShare } from "../db";
import { listBackups } from "../backups";
import { UPLOADS_DIR } from "../config";
import { countEvasionFlags } from "../evasion";
import { duelRooms } from "../game/duels/rooms";
import { logInfo } from "../lib/logs";
import { DAY, HOUR } from "../lib/time";
import { notify } from "../lib/webhook";
import { maintenance } from "../system/maintenance";
import { UPDATES_ENABLED, updateStatus } from "../system/updater";

type Finding = {
	/** Stable name for this kind of finding, used to tell a new problem from one already reported. */
	key: string;
	text: string;
	/** Serious findings go to the staff channel; the rest only to the log. */
	serious?: boolean;
	fixed?: boolean;
};

/** How long something may sit before the check-up mentions it, in seconds. */
const OVERDUE = {
	review: 7 * DAY,
	ticket: 3 * DAY,
	maintenance: 1 * DAY,
	backup: 2 * DAY,
};
/** Fewer active locations than this and the same ones come round too often. */
const MIN_LOCATIONS = 20;
/** PM2 restarts the server at 1 GB (pm2.config.js); this is the warning before that. */
const MEMORY_WARN_BYTES = 750 * 1024 * 1024;
/** A serious finding that is still true is sent again after this long. */
const REMIND_AFTER = 7 * DAY;
const LAST_RUN_KEY = "checkup_last_run";
const REPORTED_KEY = "checkup_reported";

const count = (sql: string, ...params: (string | number)[]) =>
	db.query<{ n: number }, (string | number)[]>(sql).get(...params)?.n ?? 0;
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

export async function checkUp(
	now = Math.floor(Date.now() / 1000),
	{ updates = UPDATES_ENABLED } = {}
): Promise<Finding[]> {
	const found: Finding[] = [];
	const add = (key: string, text: string, flags: Pick<Finding, "serious" | "fixed"> = {}) =>
		found.push({ key, text, ...flags });

	const live = new Set([...duelRooms.values()].map((room) => room.dbId));
	const stuck = db
		.query<{ id: number; status: string }, [number]>(
			"SELECT id, status FROM duel_games WHERE status IN ('waiting', 'in_progress') AND created_at < ?"
		)
		.all(now - HOUR)
		.filter((game) => !live.has(game.id));
	for (const game of stuck) {
		if (game.status === "waiting") db.run("DELETE FROM duel_games WHERE id = ?", [game.id]);
		else db.run("UPDATE duel_games SET status = 'abandoned' WHERE id = ?", [game.id]);
	}
	if (stuck.length)
		add("stuck_duels", `Closed ${plural(stuck.length, "duel")} left open with no room behind it`, { fixed: true });

	const missing = db
		.query<{ id: number; image_path: string }, []>("SELECT id, image_path FROM locations WHERE is_active = 1")
		.all()
		.filter((location) => !existsSync(join(UPLOADS_DIR, location.image_path)));
	if (missing.length)
		add(
			"missing_screenshots",
			`${plural(missing.length, "active location")} with no screenshot on disk (ids ${missing
				.slice(0, 10)
				.map((location) => location.id)
				.join(", ")}${missing.length > 10 ? ", ..." : ""})`,
			{ serious: true }
		);
	const state = maintenance();
	if (state.enabled && state.since && now - state.since > OVERDUE.maintenance)
		add("maintenance_on", "Maintenance mode has been on for over a day: players are locked out", { serious: true });
	const newest = listBackups()[0];
	if (!newest) add("no_backups", "There are no database backups", { serious: true });
	else if (now - newest.created_at > OVERDUE.backup)
		add("old_backup", "The newest database backup is over two days old", { serious: true });
	if (process.memoryUsage().rss > MEMORY_WARN_BYTES)
		add("memory", `The server is using ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB of memory`, {
			serious: true,
		});

	const submissions = count(
		"SELECT COUNT(*) AS n FROM submissions WHERE status = 'pending' AND created_at < ?",
		now - OVERDUE.review
	);
	if (submissions) add("old_submissions", `${plural(submissions, "submission")} waiting for review for over a week`);
	const suggestions = count(
		"SELECT COUNT(*) AS n FROM location_suggestions WHERE status = 'pending' AND created_at < ?",
		now - OVERDUE.review
	);
	if (suggestions) add("old_suggestions", `${plural(suggestions, "suggestion")} waiting for review for over a week`);
	const tickets = count(
		`SELECT COUNT(*) AS n FROM support_tickets t WHERE t.status = 'open'
			AND COALESCE(t.user_replied_at, t.created_at) < ?
			AND (t.awaiting_staff = 1 OR NOT EXISTS (SELECT 1 FROM ticket_replies r WHERE r.ticket_id = t.id AND r.type = 'staff'))`,
		now - OVERDUE.ticket
	);
	if (tickets) add("old_tickets", `${plural(tickets, "ticket")} unanswered for over three days`);
	const flags = countEvasionFlags();
	if (flags) add("evasion_flags", `${plural(flags, "possible ban-evasion flag")} waiting for a decision`);
	const locations = count("SELECT COUNT(*) AS n FROM locations WHERE is_active = 1");
	if (locations < MIN_LOCATIONS)
		add("few_locations", `Only ${plural(locations, "active location")}: games will repeat`);
	if (freeSpaceShare() > 0.5)
		add("free_space", "Over half the database file is free space; it is rewritten at the next quiet moment");

	if (updates) {
		const update = await updateStatus(true).catch(() => null);
		if (update?.available) {
			if (update.job.state === "failed")
				add("update_failed", "The last update failed part-way", { serious: true });
			if (update.pending.length)
				add("updates_waiting", `${plural(update.pending.length, "update")} waiting to be installed`);
			if (update.job.state === "needs_restart")
				add("needs_restart", "An update is installed but the server has not restarted into it");
			if (update.local_changes)
				add(
					"local_changes",
					`${plural(update.local_changes, "file")} changed on the server itself, which blocks updates`
				);
		}
	}
	return found;
}

/** The serious findings staff have not been told about, or not for a week. Remembers what it returns. */
function unreported(found: Finding[], now: number): Finding[] {
	let reported: Record<string, number> = {};
	try {
		const row = db
			.query<{ value: string }, [string]>("SELECT value FROM app_settings WHERE key = ?")
			.get(REPORTED_KEY);
		reported = JSON.parse(row?.value || "{}");
	} catch {}
	const serious = found.filter((finding) => finding.serious);
	const due = serious.filter((finding) => now - (reported[finding.key] ?? 0) > REMIND_AFTER);
	const next = Object.fromEntries(serious.map((finding) => [finding.key, reported[finding.key] ?? now]));
	for (const finding of due) next[finding.key] = now;
	db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)", [REPORTED_KEY, JSON.stringify(next)]);
	return due;
}

export async function dailyCheckUp(
	today = new Date().toISOString().slice(0, 10),
	options: { updates?: boolean } = {}
): Promise<Finding[]> {
	const last = db
		.query<{ value: string }, [string]>("SELECT value FROM app_settings WHERE key = ?")
		.get(LAST_RUN_KEY);
	if (last?.value === today) return [];
	db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)", [LAST_RUN_KEY, today]);

	const now = Math.floor(Date.now() / 1000);
	const found = await checkUp(now, options);
	if (!found.length) return [];
	const line = (finding: Finding) =>
		`- ${finding.fixed ? "Fixed: " : finding.serious ? "Serious: " : ""}${finding.text}`;
	logInfo(`[checkup] Daily check-up: ${found.length} thing(s) noted`, found.map(line).join("\n"));

	const send = unreported(found, now);
	if (send.length)
		notify(
			"system",
			`**Daily check-up**\n${send.map((finding) => `- ${finding.text}`).join("\n")}`,
			"/admin#system"
		);
	return send;
}
