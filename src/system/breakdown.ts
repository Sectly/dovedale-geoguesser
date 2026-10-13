import { listBackups } from "../backups";
import { DEV_MODE, DISCORD, PUSH, SITE_URL } from "../config";
import { db, freeSpaceShare } from "../db";
import { emailConfigured } from "../email";
import { difficultyCounts } from "../game/locations";
import { SUPERVISED } from "../lib/lifecycle";
import { DAY, HOUR, nowSec } from "../lib/time";
import { upcomingEvent } from "../specials";
import { features } from "./features";
import { maintenance } from "./maintenance";
import { restartIn } from "./restart";
import { updateStatus } from "./updater";

/** The state of the site in one list. Repeated log lines fold into one entry with a count. */

export type Finding = {
	/** "problem" needs fixing; "warning" is worth a look; the rest is for knowing. */
	level: "problem" | "warning" | "upcoming" | "info";
	title: string;
	detail?: string;
	/** How many times it happened, for log lines. */
	count?: number;
	/** When it last happened, in seconds. */
	at?: number;
	/** The staff panel tab that deals with it. */
	tab?: string;
};

const ORDER = { problem: 0, warning: 1, upcoming: 2, info: 3 };
/** How far back the server log is read. */
const LOG_DAYS = 7;
const LOG_MAX = 12;

const count = (sql: string, ...params: number[]) => db.query<{ n: number }, number[]>(sql).get(...params)?.n ?? 0;

const FEATURE_NAMES: Record<string, string> = {
	duel_emotes: "Duel reactions",
	submissions: "Submissions",
	suggestions: "Suggestions",
	new_duels: "New duels",
	signups: "New accounts",
	email_digests: "Email summaries",
};

export async function systemBreakdown(): Promise<Finding[]> {
	const now = nowSec();
	const found: Finding[] = [];
	const add = (level: Finding["level"], title: string, rest: Omit<Finding, "level" | "title"> = {}) =>
		found.push({ level, title, ...rest });

	/* ---- Set up wrongly ---- */
	if (DEV_MODE && SITE_URL)
		add("problem", "The development login is on", {
			detail: "AUTH_DEV=true lets anyone in as an operator without Discord. Switch it off on a public server.",
		});
	if (!SITE_URL)
		add("warning", "SITE_URL is not set", {
			detail: "Share cards, push links and emails need the site's public address.",
		});
	if (!SUPERVISED)
		add("info", "No process manager", {
			detail: "The panel cannot restart the server, and a crash will not bring it back.",
		});
	if (!PUSH.publicKey)
		add("info", "Push notifications are not set up", { detail: "Generate keys with `bun run vapid`." });
	if (!emailConfigured())
		add("info", "Email summaries are not set up", {
			detail: "Add a mail server on the Email tab to turn them on.",
			tab: "email",
		});
	if (!DISCORD.webhookUrl)
		add("info", "No Discord webhook", { detail: "Staff get no Discord message for new submissions or tickets." });

	/* ---- Switched off on purpose, but easy to forget ---- */
	const state = maintenance();
	if (state.enabled)
		add("warning", "Maintenance mode is on", { detail: "Players are locked out until it is switched off." });
	for (const [name, on] of Object.entries(features()))
		/** Email with no mail server is not "switched off", it is not set up, which is said above. */
		if (!on && (name !== "email_digests" || emailConfigured()))
			add("warning", `${FEATURE_NAMES[name] ?? name} switched off`, {
				detail: "Switch it back on under Features when ready.",
			});

	/* ---- Backups and storage ---- */
	const daily = listBackups().find((backup) => backup.kind === "daily");
	if (!daily) add("problem", "No daily backup yet", { detail: "One is made within an hour of the server starting." });
	else if (now - daily.created_at > 36 * HOUR)
		add("problem", "The daily backup is overdue", {
			detail: "The last one is more than a day and a half old.",
			at: daily.created_at,
		});
	if (freeSpaceShare() > 0.4)
		add("info", "The database has a lot of free space inside it", {
			detail: "It shrinks by itself at a quiet moment.",
		});
	const memory = process.memoryUsage().rss;
	if (memory > 800 * 1024 * 1024)
		add("warning", "Memory use is high", {
			detail: `${Math.round(memory / 1024 / 1024)} MB. PM2 restarts the server at 1 GB.`,
		});

	/* ---- Waiting too long ---- */
	const oldestSubmission = count("SELECT MIN(created_at) AS n FROM submissions WHERE status = 'pending'");
	if (oldestSubmission && now - oldestSubmission > 7 * DAY)
		add("warning", "A submission has waited over a week", { at: oldestSubmission, tab: "submissions" });
	const oldestTicket = count(
		`SELECT MIN(COALESCE(t.user_replied_at, t.created_at)) AS n FROM support_tickets t WHERE t.status = 'open' AND (
			t.awaiting_staff = 1 OR NOT EXISTS (SELECT 1 FROM ticket_replies r WHERE r.ticket_id = t.id AND r.type = 'staff'))`
	);
	if (oldestTicket && now - oldestTicket > 3 * DAY)
		add("warning", "A ticket has waited over three days", { at: oldestTicket, tab: "tickets" });
	const flags = count("SELECT COUNT(DISTINCT user_id) AS n FROM fairplay_flags WHERE dismissed_at IS NULL");
	if (flags) add("info", `${flags} player${flags === 1 ? " has" : "s have"} open fair-play flags`, { tab: "users" });

	/* ---- The game itself ---- */
	const active = count("SELECT COUNT(*) AS n FROM locations WHERE is_active = 1");
	if (active < 10)
		add("problem", "Very few locations in play", {
			detail: `${active} active. Games repeat quickly.`,
			tab: "locations",
		});
	const graded = difficultyCounts();
	for (const level of ["easy", "medium", "hard"] as const)
		if (active >= 10 && !graded[level])
			add("info", `No ${level} locations yet`, {
				detail: "That practice difficulty cannot be picked.",
				tab: "locations",
			});

	/* ---- Coming up ---- */
	const restart = restartIn();
	if (restart !== null)
		add("upcoming", "A restart is counting down", { detail: `In about ${Math.ceil(restart / 60)} min.` });
	const scheduled = db
		.query<{ title: string; send_at: number }, []>(
			"SELECT title, send_at FROM announcements WHERE send_at IS NOT NULL AND recalled_at IS NULL ORDER BY send_at LIMIT 3"
		)
		.all();
	for (const a of scheduled)
		add("upcoming", `Announcement scheduled: ${a.title}`, { at: a.send_at, tab: "announcements" });
	const event = upcomingEvent();
	if (event) add("upcoming", `${event.title} starts in ${event.days} day${event.days === 1 ? "" : "s"}`);
	try {
		const update = await updateStatus(false);
		if (update.available) {
			if (update.pending.length)
				add(
					"upcoming",
					`${update.pending.length} update${update.pending.length === 1 ? "" : "s"} waiting to be installed`
				);
			if (update.local_changes)
				add("warning", "Files on the server were edited by hand", {
					detail: `${update.local_changes} changed. An update will refuse to install over them.`,
				});
		}
	} catch {}

	/* ---- What the server log says, each distinct line once ---- */
	const lines = db
		.query<{ level: string; message: string; n: number; last: number }, [number, number]>(
			`SELECT level, message, COUNT(*) AS n, MAX(created_at) AS last FROM server_logs
			WHERE created_at > ? AND level IN ('error', 'warn') GROUP BY level, message ORDER BY last DESC LIMIT ?`
		)
		.all(now - LOG_DAYS * DAY, LOG_MAX);
	for (const line of lines)
		add(line.level === "error" ? "problem" : "warning", line.message.slice(0, 160), {
			count: line.n,
			at: line.last,
		});

	return found.sort((a, b) => ORDER[a.level] - ORDER[b.level]);
}
