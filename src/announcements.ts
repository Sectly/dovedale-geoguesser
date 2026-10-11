import { db, type User } from "./db";
import { fail } from "./lib/http";
import { nowSec } from "./lib/time";
import { notifyUser } from "./notifications";

/**
 * Announcements: a message from the operators to many accounts at once. Each one lands in
 * the inbox of everyone it is for and, when asked, is also pinned as a banner on every
 * page for a while, where even logged-out visitors see it. A record is kept of each.
 */

export const ANNOUNCEMENT_AUDIENCES = ["everyone", "active", "staff"] as const;
export type Audience = (typeof ANNOUNCEMENT_AUDIENCES)[number];
/** How long a banner may stay up, in hours. 0 means no banner. */
export const BANNER_HOURS = [0, 1, 6, 24, 72];
/** "Active" means played at least once in this many days. */
const ACTIVE_DAYS = 30;

const AUDIENCE_FILTER: Record<Audience, string> = {
	everyone: "",
	active: `AND last_played_date >= date('now', '-${ACTIVE_DAYS} days')`,
	staff: "AND role IS NOT NULL",
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
};

function recipients(audience: Audience): number[] {
	return db
		.query<{ id: number }, []>(
			`SELECT id FROM users WHERE username != '[deleted]' AND is_banned = 0 ${AUDIENCE_FILTER[audience]}`
		)
		.all()
		.map((user) => user.id);
}

/** How many accounts an announcement to this audience would reach right now. */
export function audienceSizes(): Record<Audience, number> {
	return {
		everyone: recipients("everyone").length,
		active: recipients("active").length,
		staff: recipients("staff").length,
	};
}

/** A link may only point somewhere on this site: a path, never another address. */
export function cleanLink(value: unknown): string | null {
	const link = typeof value === "string" ? value.trim() : "";
	if (!link) return null;
	if (!/^\/(?!\/)[\w\-./?=&#%~+]*$/.test(link) || link.length > 200)
		fail(400, "The link must be a page on this site, starting with a single / (for example /daily)");
	return link;
}

type Draft = { title: string; body: string; link: string | null; audience: Audience; bannerHours: number };

/** Sends an announcement to its audience and records it. */
export function sendAnnouncement(draft: Draft, sender: User, senderName: string): Announcement {
	const ids = recipients(draft.audience);
	for (const id of ids)
		notifyUser(id, "announcements", { title: draft.title, body: draft.body, link: draft.link ?? undefined });
	const bannerUntil = draft.bannerHours > 0 ? nowSec() + draft.bannerHours * 3600 : null;
	const id = Number(
		db.run(
			`INSERT INTO announcements (title, body, link, audience, sent_to, banner_until, created_by_id, created_by)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[draft.title, draft.body, draft.link, draft.audience, ids.length, bannerUntil, sender.id, senderName]
		).lastInsertRowid
	);
	return db.query<Announcement, [number]>("SELECT * FROM announcements WHERE id = ?").get(id)!;
}

/** Sends the draft to the sender alone, so they can see exactly what everyone would get. */
export function previewAnnouncement(draft: Pick<Draft, "title" | "body" | "link">, sender: User) {
	notifyUser(sender.id, "announcements", {
		title: `[Test] ${draft.title}`.slice(0, 120),
		body: draft.body,
		link: draft.link ?? undefined,
	});
}

export function recentAnnouncements(limit = 20): (Announcement & { banner_live: boolean })[] {
	const now = nowSec();
	const live = currentBanner()?.id;
	return db
		.query<Announcement, [number]>(
			"SELECT id, title, body, link, audience, sent_to, banner_until, created_by, created_at FROM announcements ORDER BY id DESC LIMIT ?"
		)
		.all(limit)
		.map((a) => ({ ...a, banner_live: a.id === live && (a.banner_until ?? 0) > now }));
}

/**
 * The banner showing on the site right now, if any: the newest announcement whose banner
 * has not run out. A staff-only announcement is never shown to the public this way.
 */
export function currentBanner(): Pick<Announcement, "id" | "title" | "body" | "link"> | null {
	return (
		db
			.query<Pick<Announcement, "id" | "title" | "body" | "link">, [number]>(
				`SELECT id, title, body, link FROM announcements
				WHERE banner_until > ? AND audience != 'staff' ORDER BY id DESC LIMIT 1`
			)
			.get(nowSec()) ?? null
	);
}

/** Takes a banner down before its time. The notifications already sent stay in people's inboxes. */
export function endBanner(id: number): boolean {
	return (
		db.run("UPDATE announcements SET banner_until = ? WHERE id = ? AND banner_until > ?", [nowSec(), id, nowSec()])
			.changes > 0
	);
}
