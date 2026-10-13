import { Hono, type Context } from "hono";
import {
	ANNOUNCEMENT_AUDIENCES,
	BANNER_HOURS,
	BANNER_STYLES,
	EXPIRE_DAYS,
	HISTORY_KEEP_DAYS,
	RECALL_HOURS,
	REPEATS,
	SCHEDULE_DAYS,
	audienceSizes,
	cleanLink,
	addChangelogEntry,
	changelog,
	correctAnnouncement,
	deleteAnnouncement,
	deleteChangelogEntry,
	editChangelogEntry,
	previewAnnouncement,
	recallAnnouncement,
	recentAnnouncements,
	sendAnnouncement,
	setBanner,
	unreadStaff,
	type Audience,
	type BannerStyle,
	type Repeat,
} from "../../announcements";
import { requireStaff } from "../../auth/guards";
import { db } from "../../db";
import { auditLog } from "../../lib/audit";
import { fail, idParam, intQuery, readJson, text } from "../../lib/http";
import { DAY, nowSec } from "../../lib/time";
import { displayName } from "../../lib/webhook";

/** Routes mounted at /api/admin/announcements. Administrators and operators. */
export const adminAnnouncementRoutes = new Hono();

adminAnnouncementRoutes.get("/", (c) => {
	requireStaff(c, "admin");
	return c.json({
		history: recentAnnouncements(intQuery(c, "limit", 20, 1, 200)),
		audiences: audienceSizes(),
		banner_hours: BANNER_HOURS,
		banner_styles: BANNER_STYLES,
		expire_days: EXPIRE_DAYS,
		recall_hours: RECALL_HOURS,
		schedule_days: SCHEDULE_DAYS,
		keep_days: HISTORY_KEEP_DAYS,
	});
});

/* ---- Changelog ---- */

/** A changelog entry as typed in the panel: a title, the changes one per line, and the day it shipped. */
async function readEntry(c: Context) {
	const body = await readJson<{ title: string; body: string; released_at: number }>(c);
	const title = text(body.title, 120);
	const changes = text(body.body, 4000);
	if (title.length < 3) fail(400, "Give the entry a title, e.g. a version or a date");
	if (changes.length < 5) fail(400, "List what changed, one change per line");
	const releasedAt = Math.floor(Number(body.released_at));
	if (!Number.isFinite(releasedAt) || releasedAt <= 0 || releasedAt > nowSec() + 366 * DAY)
		fail(400, "Pick the date it shipped");
	return { title, body: changes, releasedAt };
}

adminAnnouncementRoutes.get("/changelog", (c) => {
	requireStaff(c, "admin");
	return c.json(changelog());
});

adminAnnouncementRoutes.post("/changelog", async (c) => {
	const staff = requireStaff(c, "admin");
	const entry = await readEntry(c);
	const id = addChangelogEntry(entry, displayName(staff));
	auditLog(staff, "changelog_add", { details: entry.title });
	return c.json({ success: true, id });
});

adminAnnouncementRoutes.post("/changelog/:id", async (c) => {
	const staff = requireStaff(c, "admin");
	const entry = await readEntry(c);
	editChangelogEntry(idParam(c), entry);
	auditLog(staff, "changelog_edit", { details: entry.title });
	return c.json({ success: true });
});

adminAnnouncementRoutes.delete("/changelog/:id", (c) => {
	const staff = requireStaff(c, "admin");
	auditLog(staff, "changelog_delete", { details: deleteChangelogEntry(idParam(c)) });
	return c.json({ success: true });
});

/* ---- Announcements ---- */

type Body = {
	title: string;
	body: string;
	link: string;
	audience: Audience;
	banner_hours: number;
	style: BannerStyle;
	test: boolean;
	/** For the "player" audience: who it is for. */
	username: string;
	/** Seconds since 1970 to send it at. Left out, it goes now. */
	send_at: number;
	repeat: Repeat;
	/** A banner and nothing in any inbox. */
	silent: boolean;
	must_ack: boolean;
	expire_days: number;
	/** Save it without sending. */
	draft: boolean;
	/** The draft this was written from, which is removed once it is sent. */
	from_draft: number;
	/** Inbox only, without a push notification. */
	no_push: boolean;
};

/**
 * Sends an announcement, schedules it, or saves it as a draft. `test: true` sends it to the sender alone.
 */
adminAnnouncementRoutes.post("/", async (c) => {
	const staff = requireStaff(c, "admin");
	const body = await readJson<Body>(c);
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
	const mayBanner = !["staff", "helpers", "player"].includes(audience);
	if (bannerHours > 0 && !mayBanner)
		fail(400, "Only an announcement to players at large can be shown as a site banner");
	const style = body.style ?? "info";
	if (!BANNER_STYLES.includes(style)) fail(400, "Choose a banner style");
	const silent = body.silent === true;
	if (silent && !bannerHours) fail(400, "A banner-only announcement needs a banner");
	const expireDays = body.expire_days ?? 0;
	if (!EXPIRE_DAYS.includes(expireDays)) fail(400, "Choose when it leaves inboxes");
	const repeat = body.repeat ?? "";
	if (!REPEATS.includes(repeat)) fail(400, "Choose how often it repeats");

	let target: { id: number; username: string } | null = null;
	if (audience === "player") {
		const name = text(body.username, 40).replace(/^@/, "");
		target =
			db
				.query<{ id: number; username: string }, [string]>(
					"SELECT id, username FROM users WHERE username = ? COLLATE NOCASE AND username != '[deleted]'"
				)
				.get(name) ?? fail(404, "No player has that username");
	}

	let sendAt: number | null = null;
	if (body.send_at !== undefined && body.send_at !== null) {
		sendAt = Math.floor(Number(body.send_at));
		if (!Number.isFinite(sendAt) || sendAt < nowSec() + 60) fail(400, "Pick a time at least a minute from now");
		if (sendAt > nowSec() + SCHEDULE_DAYS * DAY)
			fail(400, `An announcement can be scheduled up to ${SCHEDULE_DAYS} days ahead`);
	}
	if (repeat && !sendAt) fail(400, "A repeating announcement needs a first time to go out");
	const draft = body.draft === true;

	const sent = sendAnnouncement(
		{
			title,
			body: message,
			link,
			audience,
			bannerHours,
			style,
			target,
			sendAt,
			repeat,
			silent,
			mustAck: body.must_ack === true,
			expireDays,
			draft,
			noPush: body.no_push === true,
		},
		staff,
		displayName(staff)
	);
	/** A draft that has now been sent, scheduled or saved again has done its job. */
	if (typeof body.from_draft === "number" && Number.isInteger(body.from_draft))
		db.run("DELETE FROM announcements WHERE id = ? AND draft = 1", [body.from_draft]);

	const who = target ? `@${target.username}` : audience;
	auditLog(staff, draft ? "announcement_draft" : sendAt ? "announcement_schedule" : "announcement", {
		details: draft
			? title
			: sendAt
				? `${title} (${who}, for ${new Date(sendAt * 1000).toISOString()}${repeat ? `, ${repeat}` : ""})`
				: `${title} (${who}, ${silent ? "banner only" : `sent to ${sent.sent_to}`}${bannerHours ? `, banner for ${bannerHours}h` : ""})`,
	});
	return c.json({ success: true, sent: sent.sent_to, id: sent.id, scheduled: !!sendAt, draft });
});

/** Puts a banner up, extends it, shortens it or takes it down. */
adminAnnouncementRoutes.post("/:id/banner", async (c) => {
	const staff = requireStaff(c, "admin");
	const hours = Number((await readJson<{ hours: number }>(c)).hours);
	if (!BANNER_HOURS.includes(hours)) fail(400, "Choose how long the banner stays up");
	const a = setBanner(idParam(c), hours);
	auditLog(staff, hours ? "announcement_banner" : "announcement_banner_end", {
		details: hours ? `${a.title} (for ${hours}h)` : a.title,
	});
	return c.json({ success: true });
});

/** Takes an announcement back within its first day, or calls off a waiting one. */
adminAnnouncementRoutes.post("/:id/recall", (c) => {
	const staff = requireStaff(c, "admin");
	const { title, removed } = recallAnnouncement(idParam(c));
	auditLog(staff, "announcement_recall", { details: `${title} (removed from ${removed} inboxes)` });
	return c.json({ success: true, removed });
});

/** Fixes an announcement's wording in place, within its first day. */
adminAnnouncementRoutes.post("/:id/correct", async (c) => {
	const staff = requireStaff(c, "admin");
	const body = await readJson<{ title: string; body: string; link: string }>(c);
	const title = text(body.title, 120);
	const message = text(body.body, 400);
	if (title.length < 5) fail(400, "Give the announcement a title of at least 5 characters");
	if (message.length < 10) fail(400, "Write a message of at least 10 characters");
	const updated = correctAnnouncement(idParam(c), { title, body: message, link: cleanLink(body.link) });
	auditLog(staff, "announcement_correct", { details: `${title} (updated in ${updated} inboxes)` });
	return c.json({ success: true, updated });
});

/** Which staff have not read a staff announcement yet. */
adminAnnouncementRoutes.get("/:id/unread", (c) => {
	requireStaff(c, "admin");
	return c.json(unreadStaff(idParam(c)));
});

/** Removes an old announcement from the history. */
adminAnnouncementRoutes.delete("/:id", (c) => {
	const staff = requireStaff(c, "admin");
	const title = deleteAnnouncement(idParam(c));
	auditLog(staff, "announcement_delete", { details: title });
	return c.json({ success: true });
});
