import { SITE_URL } from "./config";
import { db, type User } from "./db";
import { fail } from "./lib/http";
import { DAY, nowSec } from "./lib/time";
import { notifyUser } from "./notifications";

/** Announcements: one message to many accounts (or one), optionally pinned as a banner on every page. */

/** "player" is a message to one account, named when it is sent. */
export const ANNOUNCEMENT_AUDIENCES = [
	"everyone",
	"active",
	"new",
	"inactive",
	"contributors",
	"helpers",
	"staff",
	"player",
] as const;
export type Audience = (typeof ANNOUNCEMENT_AUDIENCES)[number];
/** Audiences made of players at large, which may carry a banner and appear on the news page. */
const PUBLIC_AUDIENCES: Audience[] = ["everyone", "active", "new", "inactive", "contributors"];
/** How long a banner may stay up, in hours. 0 means no banner. */
export const BANNER_HOURS = [0, 1, 6, 24, 72, 168];
export const BANNER_STYLES = ["info", "success", "warning"] as const;
export type BannerStyle = (typeof BANNER_STYLES)[number];
/** How long after sending an announcement can still be corrected or taken back. */
export const RECALL_HOURS = 24;
/** How far ahead an announcement may be scheduled. */
export const SCHEDULE_DAYS = 30;
/** After how many days a notification may be set to leave inboxes by itself. 0 means it stays. */
export const EXPIRE_DAYS = [0, 1, 3, 7, 30];
export const REPEATS = ["", "weekly", "monthly"] as const;
export type Repeat = (typeof REPEATS)[number];
/** How old an announcement must be before it can be removed from the history. */
export const HISTORY_KEEP_DAYS = 7;
/** "Active": played in this many days. "New": an account at most this many days old. */
const ACTIVE_DAYS = 30;
const NEW_DAYS = 7;

const AUDIENCE_FILTER: Record<Exclude<Audience, "player">, string> = {
	everyone: "",
	active: `AND last_played_date >= date('now', '-${ACTIVE_DAYS} days')`,
	new: `AND created_at > unixepoch() - ${NEW_DAYS * DAY}`,
	inactive: `AND (last_played_date IS NULL OR last_played_date < date('now', '-${ACTIVE_DAYS} days'))`,
	contributors: "AND id IN (SELECT submitted_by FROM submissions WHERE status = 'approved')",
	helpers: "AND role = 'helper' AND staff_locked = 0",
	/** Helpers are left out: staff news can be about things they have no access to. */
	staff: "AND role IS NOT NULL AND role != 'helper' AND staff_locked = 0",
};

export type Announcement = {
	id: number;
	title: string;
	body: string;
	link: string | null;
	audience: Audience;
	sent_to: number;
	banner_until: number | null;
	created_by: string | null;
	created_at: number;
	recalled_at: number | null;
	/** Set while it is waiting to go out. */
	send_at: number | null;
	banner_hours: number | null;
	target_user_id: number | null;
	target_username: string | null;
	style: BannerStyle | null;
	/** A banner only: nothing goes to any inbox. */
	silent: number;
	/** Written but not sent. */
	draft: number;
	repeat: Repeat | null;
	/** How many times its link was followed from a notification or the banner. */
	clicks: number;
	/** Shown as a dialog the reader has to dismiss. */
	must_ack: number;
	/** When its notifications leave inboxes by themselves. */
	expires_at: number | null;
	expire_days: number | null;
	/** Inbox only: nobody's phone or desktop is buzzed. */
	no_push: number;
};

function recipients(audience: Audience, targetId: number | null = null): number[] {
	if (audience === "player") return targetId ? [targetId] : [];
	return db
		.query<{ id: number }, []>(
			`SELECT id FROM users WHERE username != '[deleted]' AND is_banned = 0 ${AUDIENCE_FILTER[audience]}`
		)
		.all()
		.map((user) => user.id);
}

/** How many accounts an announcement to each audience would reach right now. */
export function audienceSizes(): Record<string, number> {
	return Object.fromEntries(
		ANNOUNCEMENT_AUDIENCES.filter((audience) => audience !== "player").map((audience) => [
			audience,
			recipients(audience).length,
		])
	);
}

/** True for a link to another site, rather than a page on this one. */
export const isExternalLink = (link: string | null | undefined): link is string => /^https:\/\//i.test(link ?? "");

/** A link to another site goes by way of the page that warns about leaving. */
export const linkHref = (link: string) => (isExternalLink(link) ? `/leaving?to=${encodeURIComponent(link)}` : link);

/** A link is a page on this site (a path) or an https address on another one. */
export function cleanLink(value: unknown): string | null {
	const link = typeof value === "string" ? value.trim() : "";
	if (!link) return null;
	if (link.length > 200) fail(400, "The link is too long");
	const isPage = (path: string) => /^\/(?!\/)[\w\-./?=&#%~+]*$/.test(path);
	if (isPage(link)) return link;
	const url = isExternalLink(link) && !/\s/.test(link) && URL.canParse(link) ? new URL(link) : null;
	if (!url || url.username || url.password)
		fail(400, "The link must be a page on this site (for example /daily) or an address starting with https://");
	/** This site's own address is kept as the page, so following it is not treated as leaving. */
	const page = url.pathname + url.search + url.hash;
	if (SITE_URL && URL.canParse(SITE_URL) && url.origin === new URL(SITE_URL).origin && isPage(page)) return page;
	return link;
}

export type Draft = {
	title: string;
	body: string;
	link: string | null;
	audience: Audience;
	bannerHours: number;
	style?: BannerStyle;
	/** For the "player" audience. */
	target?: { id: number; username: string } | null;
	/** When to send it, in seconds. Left out, it goes now. */
	sendAt?: number | null;
	repeat?: Repeat;
	silent?: boolean;
	mustAck?: boolean;
	expireDays?: number;
	/** Save it without sending. */
	draft?: boolean;
	noPush?: boolean;
};

const byId = (id: number) => db.query<Announcement, [number]>("SELECT * FROM announcements WHERE id = ?").get(id);

/** Where a notification or banner links to: the click counter, when there is a link. */
const trackedLink = (a: Pick<Announcement, "id" | "link">) => (a.link ? `/api/announcement/${a.id}/go` : undefined);

function record(draft: Draft, sender: { id: number | null; name: string | null }): number {
	return Number(
		db.run(
			`INSERT INTO announcements
				(title, body, link, audience, sent_to, banner_hours, send_at, target_user_id, target_username, style, silent, draft,
				repeat, must_ack, expire_days, no_push, created_by_id, created_by)
			VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				draft.title,
				draft.body,
				draft.link,
				draft.audience,
				draft.bannerHours || null,
				draft.sendAt ?? null,
				draft.target?.id ?? null,
				draft.target?.username ?? null,
				draft.style ?? "info",
				draft.silent ? 1 : 0,
				draft.draft ? 1 : 0,
				draft.repeat || null,
				draft.mustAck ? 1 : 0,
				draft.expireDays || null,
				draft.noPush ? 1 : 0,
				sender.id,
				sender.name,
			]
		).lastInsertRowid
	);
}

/** Puts a recorded announcement into its audience's inboxes and starts its banner. */
function deliver(a: Announcement): Announcement {
	const ids = a.silent ? [] : recipients(a.audience, a.target_user_id);
	const now = nowSec();
	db.run(
		"UPDATE announcements SET sent_to = ?, banner_until = ?, created_at = ?, send_at = NULL, expires_at = ? WHERE id = ?",
		[
			ids.length,
			a.banner_hours ? now + a.banner_hours * 3600 : null,
			now,
			a.expire_days ? now + a.expire_days * DAY : null,
			a.id,
		]
	);
	for (const userId of ids)
		notifyUser(userId, "announcements", {
			title: a.title,
			body: a.body,
			link: trackedLink(a),
			announcementId: a.id,
			noPush: !!a.no_push,
		});
	return byId(a.id)!;
}

/** Records an announcement, then sends, schedules or keeps it as a draft. */
export function sendAnnouncement(draft: Draft, sender: User, senderName: string): Announcement {
	const a = byId(record(draft, { id: sender.id, name: senderName }))!;
	return draft.sendAt || draft.draft ? a : deliver(a);
}

/** When a repeating announcement goes out next after `from`. */
function nextRepeat(from: number, repeat: Repeat): number {
	if (repeat === "weekly") return from + 7 * DAY;
	const date = new Date(from * 1000);
	date.setUTCMonth(date.getUTCMonth() + 1);
	return Math.floor(date.getTime() / 1000);
}

/** Once a minute: sends due scheduled announcements, queues the next of a repeating one, clears expired ones from inboxes. */
export function sendScheduledAnnouncements(now = nowSec()): number {
	const due = db
		.query<Announcement, [number]>(
			"SELECT * FROM announcements WHERE send_at <= ? AND recalled_at IS NULL AND draft = 0"
		)
		.all(now);
	for (const a of due) {
		const sendAt = a.send_at!;
		deliver(a);
		if (a.repeat)
			record(
				{
					title: a.title,
					body: a.body,
					link: a.link,
					audience: a.audience,
					bannerHours: a.banner_hours ?? 0,
					style: a.style ?? "info",
					target: a.target_user_id ? { id: a.target_user_id, username: a.target_username ?? "" } : null,
					sendAt: nextRepeat(sendAt, a.repeat),
					repeat: a.repeat,
					silent: !!a.silent,
					mustAck: !!a.must_ack,
					expireDays: a.expire_days ?? 0,
					noPush: !!a.no_push,
				},
				{ id: null, name: a.created_by }
			);
	}
	db.run(
		`DELETE FROM notifications WHERE announcement_id IN
			(SELECT id FROM announcements WHERE expires_at IS NOT NULL AND expires_at <= ?)`,
		[now]
	);
	return due.length;
}

/** Sends the draft to the sender alone, so they can see exactly what everyone would get. */
export function previewAnnouncement(draft: Pick<Draft, "title" | "body" | "link">, sender: User) {
	notifyUser(sender.id, "announcements", {
		title: `[Test] ${draft.title}`.slice(0, 120),
		body: draft.body,
		link: draft.link ? linkHref(draft.link) : undefined,
	});
}

/** A scheduled one or a draft can be called off at any time; a sent one only while it is new. */
const canRecall = (a: Pick<Announcement, "created_at" | "recalled_at" | "send_at" | "draft">) =>
	!a.recalled_at && !a.draft && (!!a.send_at || a.created_at > nowSec() - RECALL_HOURS * 3600);

type Listed = Announcement & {
	banner_live: boolean;
	can_recall: boolean;
	/** Old enough and no longer doing anything, so it may be removed from the history. */
	can_delete: boolean;
	/** Copies still in inboxes, and how many of those have been read. */
	in_inboxes: number;
	read: number;
};

export function recentAnnouncements(limit = 20): Listed[] {
	const now = nowSec();
	const live = currentBanner()?.id;
	return db
		.query<Announcement & { in_inboxes: number; read: number }, [number]>(
			`SELECT a.*,
				(SELECT COUNT(*) FROM notifications n WHERE n.announcement_id = a.id) AS in_inboxes,
				(SELECT COUNT(*) FROM notifications n WHERE n.announcement_id = a.id AND n.read_at IS NOT NULL) AS read
			FROM announcements a ORDER BY a.draft DESC, (a.send_at IS NULL), a.id DESC LIMIT ?`
		)
		.all(limit)
		.map((a) => {
			const banner_live = a.id === live && (a.banner_until ?? 0) > now;
			return { ...a, banner_live, can_recall: canRecall(a), can_delete: canDelete(a, banner_live) };
		});
}

/** The banner showing now, if any. Staff-only and one-player announcements never show publicly. */
export function currentBanner():
	(Pick<Announcement, "id" | "title" | "body" | "style"> & { link: string | null; external: boolean }) | null {
	const a = db
		.query<Announcement, [number]>(
			`SELECT * FROM announcements
			WHERE banner_until > ? AND audience NOT IN ('staff', 'helpers', 'player') AND recalled_at IS NULL AND draft = 0
			ORDER BY id DESC LIMIT 1`
		)
		.get(nowSec());
	return a
		? {
				id: a.id,
				title: a.title,
				body: a.body,
				style: a.style ?? "info",
				link: trackedLink(a) ?? null,
				external: isExternalLink(a.link),
			}
		: null;
}

/** Puts a banner up, extends it, shortens it or takes it down: `hours` from now, 0 for down. */
export function setBanner(id: number, hours: number): Announcement {
	const a = byId(id) ?? fail(404, "Announcement not found");
	if (a.recalled_at || a.draft || a.send_at) fail(409, "Only an announcement that has gone out can carry a banner");
	if (!PUBLIC_AUDIENCES.includes(a.audience))
		fail(400, "Only an announcement to players at large can be shown as a site banner");
	db.run("UPDATE announcements SET banner_until = ?, banner_hours = ? WHERE id = ?", [
		hours > 0 ? nowSec() + hours * 3600 : nowSec(),
		hours || null,
		id,
	]);
	return byId(id)!;
}

/** Says where an announcement's link leads, and counts the visit unless told not to. */
export function followLink(id: number, count = true): string {
	const a = byId(id);
	if (!a?.link || a.draft) return "/";
	if (count) db.run("UPDATE announcements SET clicks = clicks + 1 WHERE id = ?", [id]);
	return linkHref(a.link);
}

/** An announcement that may still be corrected or taken back, or a refusal saying why not. */
function recallable(id: number): Announcement {
	const a = byId(id) ?? fail(404, "Announcement not found");
	if (a.recalled_at) fail(409, "That announcement was already taken back");
	if (!canRecall(a) && !a.draft) fail(409, `An announcement can only be changed in its first ${RECALL_HOURS} hours`);
	return a;
}

/** Takes an announcement back from every inbox and ends its banner. Pushes already shown cannot be pulled back. */
export function recallAnnouncement(id: number): { title: string; removed: number } {
	const a = recallable(id);
	const removed = db.run("DELETE FROM notifications WHERE announcement_id = ?", [id]).changes;
	db.run("UPDATE announcements SET recalled_at = ?, banner_until = MIN(COALESCE(banner_until, 0), ?) WHERE id = ?", [
		nowSec(),
		nowSec(),
		id,
	]);
	return { title: a.title, removed };
}

/** Fixes an announcement's wording in inboxes and on the banner. Nobody is told again. */
export function correctAnnouncement(id: number, text: Pick<Draft, "title" | "body" | "link">): number {
	recallable(id);
	db.run("UPDATE announcements SET title = ?, body = ?, link = ? WHERE id = ?", [
		text.title,
		text.body,
		text.link,
		id,
	]);
	return db.run("UPDATE notifications SET title = ?, body = ?, link = ? WHERE announcement_id = ?", [
		text.title,
		text.body,
		text.link ? `/api/announcement/${id}/go` : "/settings#notifications",
		id,
	]).changes;
}

/** Drafts and called-off ones can go at once; sent ones must be old with no banner showing. */
function canDelete(a: Announcement, bannerLive: boolean): boolean {
	if (a.draft || (a.recalled_at && a.send_at)) return true;
	if (bannerLive || (a.send_at && !a.recalled_at)) return false;
	return a.created_at < nowSec() - HISTORY_KEEP_DAYS * DAY;
}

/** Removes an announcement from the history. Copies in inboxes stay. */
export function deleteAnnouncement(id: number): string {
	const a = byId(id) ?? fail(404, "Announcement not found");
	const bannerLive = currentBanner()?.id === id;
	if (!canDelete(a, bannerLive))
		fail(
			409,
			bannerLive || a.send_at
				? "Take its banner down or call it off first"
				: `An announcement can be removed once it is ${HISTORY_KEEP_DAYS} days old`
		);
	db.run("UPDATE notifications SET announcement_id = NULL WHERE announcement_id = ?", [id]);
	db.run("DELETE FROM announcements WHERE id = ?", [id]);
	return a.title;
}

/** Who has not read a staff announcement yet. Staff audiences only. */
export function unreadStaff(id: number): string[] {
	const a = byId(id) ?? fail(404, "Announcement not found");
	if (a.audience !== "staff" && a.audience !== "helpers")
		fail(400, "Only shown for announcements to staff or helpers");
	return db
		.query<{ username: string }, [number]>(
			`SELECT u.username FROM notifications n JOIN users u ON u.id = n.user_id
			WHERE n.announcement_id = ? AND n.read_at IS NULL ORDER BY u.username`
		)
		.all(id)
		.map((row) => row.username);
}

/** The oldest announcement this player must acknowledge, if any. */
export function pendingAcknowledgement(userId: number) {
	const pending = db
		.query<
			{ notification_id: number; title: string; body: string; link: string | null; target: string | null },
			[number]
		>(
			`SELECT n.id AS notification_id, a.title, a.body, n.link, a.link AS target FROM notifications n
				JOIN announcements a ON a.id = n.announcement_id
				WHERE n.user_id = ? AND n.read_at IS NULL AND a.must_ack = 1 AND a.recalled_at IS NULL
				ORDER BY n.id LIMIT 1`
		)
		.get(userId);
	if (!pending) return null;
	const { target, ...shown } = pending;
	return { ...shown, external: isExternalLink(target) };
}

/* ---- Changelog: what changed in each update, written by staff ---- */

export type ChangelogEntry = {
	id: number;
	title: string;
	body: string;
	released_at: number;
	created_by: string | null;
};

export function changelog(limit = 100): ChangelogEntry[] {
	return db
		.query<ChangelogEntry, [number]>(
			"SELECT id, title, body, released_at, created_by FROM changelog ORDER BY released_at DESC, id DESC LIMIT ?"
		)
		.all(limit);
}

type EntryText = { title: string; body: string; releasedAt: number };

export function addChangelogEntry(entry: EntryText, author: string): number {
	return Number(
		db.run("INSERT INTO changelog (title, body, released_at, created_by) VALUES (?, ?, ?, ?)", [
			entry.title,
			entry.body,
			entry.releasedAt,
			author,
		]).lastInsertRowid
	);
}

export function editChangelogEntry(id: number, entry: EntryText) {
	const changed = db.run("UPDATE changelog SET title = ?, body = ?, released_at = ? WHERE id = ?", [
		entry.title,
		entry.body,
		entry.releasedAt,
		id,
	]).changes;
	if (!changed) fail(404, "Changelog entry not found");
}

export function deleteChangelogEntry(id: number): string {
	const entry = db.query<{ title: string }, [number]>("SELECT title FROM changelog WHERE id = ?").get(id);
	if (!entry) fail(404, "Changelog entry not found");
	db.run("DELETE FROM changelog WHERE id = ?", [id]);
	return entry.title;
}

/** The news page: public announcements and changelog entries, newest first. */
export function publicNews(limit = 40) {
	const announced = db
		.query<{ id: number; title: string; body: string; link: string | null; at: number }, [number]>(
			`SELECT id, title, body, link, created_at AS at FROM announcements
			WHERE audience IN ('everyone', 'active') AND recalled_at IS NULL AND draft = 0 AND send_at IS NULL AND silent = 0
			ORDER BY created_at DESC LIMIT ?`
		)
		.all(limit)
		.map((a) => ({ kind: "announcement" as const, ...a }));
	const changes = changelog(limit).map((entry) => ({
		kind: "update" as const,
		id: entry.id,
		title: entry.title,
		body: entry.body,
		link: null,
		at: entry.released_at,
	}));
	return [...announced, ...changes].sort((a, b) => b.at - a.at).slice(0, limit);
}
