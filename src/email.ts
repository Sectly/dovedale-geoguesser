import { randomBytes } from "crypto";
import nodemailer from "nodemailer";
import { SITE_URL } from "./config";
import { db, type User } from "./db";
import { fail } from "./lib/http";
import { DAY, HOUR, nowSec } from "./lib/time";
import { features } from "./system/features";

/** Email summaries of unread notifications. Needs a saved mail server, and each player opts in. Never one email per notification. */

export const DIGEST_FREQUENCIES = ["off", "hourly", "daily", "weekly", "monthly"] as const;
export type DigestFrequency = (typeof DIGEST_FREQUENCIES)[number];

const PERIOD: Record<Exclude<DigestFrequency, "off">, number> = {
	hourly: HOUR,
	daily: DAY,
	weekly: 7 * DAY,
	monthly: 30 * DAY,
};
/** A confirmation link works for this long. */
const CONFIRM_TTL = 2 * DAY;
/** The most notifications listed in one email; the rest are counted. */
const DIGEST_MAX = 20;
/** Emails per run. Providers cut off bursts (Purelymail: about 300 at once). */
const BATCH = 100;
/** Emails per day, kept under the provider's allowance (Purelymail: about 3,000). */
export const DAILY_MAX = 2000;

type Mail = { to: string; subject: string; text: string; html: string; headers?: Record<string, string> };
type Sender = (mail: Mail) => Promise<unknown>;

let sender: Sender | null = null;

export type SmtpSettings = { host: string; port: number; user: string; pass: string; from: string };

const SETTINGS_KEY = "smtp";
const STATS_KEY = "email_stats";
const stored = <T>(key: string): T | null => {
	try {
		const row = db.query<{ value: string }, [string]>("SELECT value FROM app_settings WHERE key = ?").get(key);
		return row ? (JSON.parse(row.value) as T) : null;
	} catch {
		return null;
	}
};
const store = (key: string, value: unknown) =>
	db.run(
		"INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		[key, JSON.stringify(value)]
	);

const NO_SMTP: SmtpSettings = { host: "", port: 465, user: "", pass: "", from: "" };

/** The mail server saved from the staff panel, or blanks. */
export function smtpSettings(): SmtpSettings {
	const saved = stored<SmtpSettings>(SETTINGS_KEY);
	return saved?.host ? { ...NO_SMTP, ...saved } : NO_SMTP;
}

/** Saves mail server details from the staff panel. A blank password keeps the one already saved. */
export function saveSmtpSettings(next: SmtpSettings) {
	store(SETTINGS_KEY, { ...next, pass: next.pass || smtpSettings().pass });
	sender = null;
}

/** Forgets the mail server, which switches email off. */
export function clearSmtpSettings() {
	db.run("DELETE FROM app_settings WHERE key = ?", [SETTINGS_KEY]);
	sender = null;
}

type Stats = {
	day: string;
	today: number;
	total: number;
	last_sent_at: number | null;
	last_error: string | null;
	last_error_at: number | null;
};

export function emailStats(): Stats {
	const stats = stored<Stats>(STATS_KEY) ?? {
		day: "",
		today: 0,
		total: 0,
		last_sent_at: null,
		last_error: null,
		last_error_at: null,
	};
	const day = new Date().toISOString().slice(0, 10);
	return stats.day === day ? stats : { ...stats, day, today: 0 };
}

/** Whether another email may go out today. */
const underDailyCap = () => emailStats().today < DAILY_MAX;

/** Whether the mail server details are all there. */
export function smtpReady(): boolean {
	const smtp = smtpSettings();
	return !!(smtp.host && smtp.user && smtp.pass && smtp.from);
}

/** Whether email can be sent to players: a mail server, and a public address for links. */
export function emailConfigured(): boolean {
	return smtpReady() && !!SITE_URL;
}

/** Whether email could be switched on: there is something to send it with. */
export function emailReady(): boolean {
	return emailConfigured() || !!testSender;
}

/** Whether email is on right now: there is a mail server, and an operator has switched it on. */
export function emailAvailable(): boolean {
	return emailReady() && features().email_digests;
}

let testSender: Sender | null = null;
/** Tests swap the mail server for a function that collects what would have been sent. */
export function setTestSender(fn: Sender | null) {
	testSender = fn;
}

/** Said at the foot of every email: nobody reads what is sent back. */
const NO_REPLY =
	"This is an automated email from an address nobody reads, so please don't reply to it. For help, open a ticket in Settings on the site.";

/** Sends one email and keeps count. Throws what the mail server said when it refuses. */
async function send(message: Mail) {
	const mail: Mail = {
		...message,
		text: `${message.text}

${NO_REPLY}`,
		/** Marks it as automatic, so out-of-office replies and the like are not sent back. */
		headers: { "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All", ...message.headers },
	};
	if (!underDailyCap()) throw new Error(`Today's limit of ${DAILY_MAX} emails has been reached`);
	try {
		if (testSender) await testSender(mail);
		else {
			sender ??= (() => {
				const smtp = smtpSettings();
				const transport = nodemailer.createTransport({
					host: smtp.host,
					port: smtp.port,
					/** 465 speaks TLS from the first byte; 587 upgrades with STARTTLS. */
					secure: smtp.port === 465,
					auth: { user: smtp.user, pass: smtp.pass },
					connectionTimeout: 15_000,
					socketTimeout: 20_000,
				});
				return (message: Mail) => transport.sendMail({ from: smtp.from, ...message });
			})();
			await sender(mail);
		}
		const stats = emailStats();
		store(STATS_KEY, { ...stats, today: stats.today + 1, total: stats.total + 1, last_sent_at: nowSec() });
	} catch (err) {
		store(STATS_KEY, {
			...emailStats(),
			last_error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
			last_error_at: nowSec(),
		});
		throw err;
	}
}

/** Sends a short email to prove the mail server details work. For the staff panel. */
export function sendTestEmail(to: string) {
	return send({
		to,
		subject: "Test email from Dovedale GeoGuesser",
		text: "This is a test email from the staff panel. If you can read it, the mail server is set up correctly.",
		html: page(
			"It works",
			"<p>This is a test email from the staff panel. If you can read it, the mail server is set up correctly.</p>",
			"Sent because an operator pressed Send test in the staff panel."
		),
	});
}

/** Who has email set up, for the staff panel. Counts only: no addresses. */
export function emailAudience() {
	const rows = db
		.query<{ state: string; n: number }, []>(
			`SELECT CASE WHEN email_verified = 1 THEN COALESCE(email_digest, 'off') ELSE 'waiting' END AS state, COUNT(*) AS n
			FROM users WHERE email IS NOT NULL GROUP BY state`
		)
		.all();
	return Object.fromEntries(rows.map((row) => [row.state, row.n])) as Record<string, number>;
}

const escapeHtml = (value: string) =>
	value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const origin = () => SITE_URL || "http://localhost";
const token = () => randomBytes(24).toString("hex");

/** The frame every email shares. Tables and inline styles only: all that mail apps reliably draw. */
function page(title: string, body: string, footer: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="color-scheme" content="light" /></head>
	<body style="margin:0;padding:0;background:#f4f4f5">
	<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px">
		<tr><td align="center">
			<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;font-family:Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#18181b">
				<tr><td style="background:#09090b;border-radius:16px 16px 0 0;padding:18px 24px">
					<table role="presentation" cellpadding="0" cellspacing="0"><tr>
						<td style="width:28px;height:28px;border-radius:14px;background:#2563eb;color:#ffffff;font-size:16px;line-height:28px;text-align:center">&#10146;</td>
						<td style="padding-left:10px;color:#ffffff;font-size:15px;font-weight:700"><a href="${origin()}" style="color:#ffffff;text-decoration:none">Dovedale GeoGuesser</a></td>
					</tr></table>
				</td></tr>
				<tr><td style="background:#ffffff;padding:24px;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7">
					<h1 style="font-size:20px;line-height:1.3;margin:0 0 14px;color:#09090b">${escapeHtml(title)}</h1>
					<div style="font-size:15px;line-height:1.55;color:#3f3f46">${body}</div>
				</td></tr>
				<tr><td style="background:#fafafa;border:1px solid #e4e4e7;border-top:0;border-radius:0 0 16px 16px;padding:14px 24px;font-size:12px;line-height:1.5;color:#71717a">${footer}<br /><br />${NO_REPLY.replace("open a ticket in Settings", `<a href="${origin()}/settings" style="color:#52525b">open a ticket in Settings</a>`)}</td></tr>
			</table>
		</td></tr>
	</table>
	</body></html>`;
}

const button = (href: string, label: string) =>
	`<a href="${href}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:11px 20px;border-radius:999px;text-decoration:none;font-weight:600;font-size:14px">${label}</a>`;

export type EmailState = {
	/** False hides the whole setting. */
	available: boolean;
	address: string | null;
	verified: boolean;
	frequency: DigestFrequency;
};

export function emailState(user: User): EmailState {
	return {
		available: emailAvailable(),
		address: user.email ?? null,
		verified: !!user.email_verified,
		frequency: (DIGEST_FREQUENCIES as readonly string[]).includes(user.email_digest ?? "")
			? (user.email_digest as DigestFrequency)
			: "off",
	};
}

/** Saves an address as unconfirmed and emails a confirmation link. */
export async function requestEmail(user: User, address: string) {
	if (!emailAvailable()) fail(503, "Email isn't available right now.");
	const email = address.trim().toLowerCase();
	if (email.length > 254 || !/^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(email))
		fail(400, "That doesn't look like an email address.");
	const code = token();
	db.run("UPDATE users SET email = ?, email_verified = 0, email_token = ?, email_token_at = ? WHERE id = ?", [
		email,
		code,
		nowSec(),
		user.id,
	]);
	const link = `${origin()}/api/email/confirm?token=${code}`;
	try {
		await send({
			to: email,
			subject: "Confirm your email for Dovedale GeoGuesser",
			text: `Someone asked for Dovedale GeoGuesser notification summaries to be sent to this address.\n\nIf that was you, confirm it here:\n${link}\n\nIf it wasn't, ignore this email and nothing more will be sent.`,
			html: page(
				"Confirm your email",
				`<p>Someone asked for Dovedale GeoGuesser notification summaries to be sent to this address.</p>
				<p style="margin:18px 0 4px">${button(link, "Confirm this address")}</p>`,
				"If that wasn't you, ignore this email and nothing more will be sent."
			),
		});
	} catch (err) {
		console.error("[email] confirmation failed:", err instanceof Error ? err.message : err);
		db.run("UPDATE users SET email = NULL, email_token = NULL, email_token_at = NULL WHERE id = ?", [user.id]);
		fail(502, "We couldn't send the confirmation email. Check the address and try again.");
	}
}

/** Confirms the address a link was sent to. The link then lives on as that address's unsubscribe link. */
export function confirmEmail(code: string): boolean {
	if (!/^[0-9a-f]{48}$/.test(code)) return false;
	return (
		db.run(
			`UPDATE users SET email_verified = 1, email_digest = COALESCE(email_digest, 'daily'), email_digest_at = ?,
				email_digest_upto = (SELECT COALESCE(MAX(id), 0) FROM notifications WHERE user_id = users.id)
			WHERE email_token = ? AND email_verified = 0 AND email_token_at > ?`,
			[nowSec(), code, nowSec() - CONFIRM_TTL]
		).changes > 0
	);
}

export function setDigestFrequency(user: User, frequency: string) {
	if (!(DIGEST_FREQUENCIES as readonly string[]).includes(frequency))
		fail(400, "Choose how often to send the summary.");
	if (!user.email_verified) fail(409, "Confirm your email address first.");
	db.run("UPDATE users SET email_digest = ?, email_digest_at = ? WHERE id = ?", [frequency, nowSec(), user.id]);
}

/** Forgets a player's address altogether. */
export function removeEmail(userId: number) {
	db.run(
		"UPDATE users SET email = NULL, email_verified = 0, email_token = NULL, email_token_at = NULL, email_digest = NULL, email_digest_at = NULL, email_digest_upto = NULL WHERE id = ?",
		[userId]
	);
}

/** Unlinks every player's address at once and deletes them all. Returns how many there were. */
export function removeAllEmails(): number {
	return db.run(
		`UPDATE users SET email = NULL, email_verified = 0, email_token = NULL, email_token_at = NULL, email_digest = NULL,
			email_digest_at = NULL, email_digest_upto = NULL WHERE email IS NOT NULL`
	).changes;
}

/** One click from an email: stops the summaries without logging in. The address is kept. */
export function unsubscribe(code: string): boolean {
	if (!/^[0-9a-f]{48}$/.test(code)) return false;
	return (
		db.run("UPDATE users SET email_digest = 'off' WHERE email_token = ? AND email_verified = 1", [code]).changes > 0
	);
}

type Due = {
	id: number;
	email: string;
	email_token: string;
	email_digest: Exclude<DigestFrequency, "off">;
	email_digest_at: number | null;
	email_digest_upto: number | null;
};
type Unread = { id: number; title: string; body: string | null; link: string | null; created_at: number };

/** Sends each due player one email with everything unread since the last. Nothing unread, no email. */
export async function sendDueDigests(now = nowSec()): Promise<number> {
	if (!emailAvailable()) return 0;
	const due = db
		.query<Due, []>(
			`SELECT id, email, email_token, email_digest, email_digest_at, email_digest_upto FROM users
			WHERE email_verified = 1 AND email IS NOT NULL AND is_banned = 0
				AND email_digest IN ('hourly', 'daily', 'weekly', 'monthly')`
		)
		.all()
		.filter((user) => now - (user.email_digest_at ?? 0) >= PERIOD[user.email_digest])
		.slice(0, Math.max(0, Math.min(BATCH, DAILY_MAX - emailStats().today)));

	let sent = 0;
	for (const user of due) {
		/** By id, not the clock, so nothing sent in the same second is missed or repeated. */
		const unread = db
			.query<Unread, [number, number]>(
				"SELECT id, title, body, link, created_at FROM notifications WHERE user_id = ? AND read_at IS NULL AND id > ? ORDER BY id DESC"
			)
			.all(user.id, user.email_digest_upto ?? 0);
		if (!unread.length) continue;

		const shown = unread.slice(0, DIGEST_MAX);
		const more = unread.length - shown.length;
		const stop = `${origin()}/api/email/unsubscribe?token=${user.email_token}`;
		const count = `${unread.length} new notification${unread.length === 1 ? "" : "s"}`;
		try {
			await send({
				to: user.email,
				subject: `${count} on Dovedale GeoGuesser`,
				text:
					shown.map((n) => `- ${n.title}${n.body ? `\n  ${n.body}` : ""}`).join("\n") +
					(more ? `\n\nand ${more} more.` : "") +
					`\n\nSee them all: ${origin()}/settings#notifications\n\nStop these emails: ${stop}`,
				html: page(
					count,
					shown
						.map(
							(n) =>
								`<div style="padding:12px 0;border-bottom:1px solid #f4f4f5"><div style="font-weight:600;color:#09090b">${escapeHtml(n.title)}</div>${n.body ? `<div style="font-size:14px;color:#52525b;margin-top:2px">${escapeHtml(n.body)}</div>` : ""}</div>`
						)
						.join("") +
						(more ? `<p style="font-size:14px;color:#52525b">and ${more} more.</p>` : "") +
						`<p style="margin:20px 0 4px">${button(`${origin()}/settings#notifications`, "Open notifications")}</p>`,
					`You get this ${user.email_digest} summary because you turned it on in Settings. <a href="${stop}">Stop these emails</a>.`
				),
				headers: { "List-Unsubscribe": `<${stop}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
			});
			db.run("UPDATE users SET email_digest_at = ?, email_digest_upto = ? WHERE id = ?", [
				now,
				unread[0].id,
				user.id,
			]);
			sent++;
		} catch (err) {
			console.error("[email] summary failed:", err instanceof Error ? err.message : err);
			/** A mail server that is down fails for everyone: stop and try the whole batch next time. */
			break;
		}
	}
	return sent;
}
