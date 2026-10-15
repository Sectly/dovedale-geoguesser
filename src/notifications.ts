import { db, type Role, type User } from "./db";
import { countEvasionFlags } from "./evasion";
import { hasRole, isStaff } from "./auth/guards";
import { DAY, utcDate } from "./lib/time";
import { sendPush } from "./push";

export const NOTIFICATION_CATEGORIES = [
	"submissions",
	"suggestions",
	"tickets",
	"reminders",
	"achievements",
	"moderation",
] as const;
/** Not switched off under "notify": things a user needs to know, and staff chat, which has its own setting. */
const ALWAYS_SENT = ["moderation", "announcements", "staff_chat"];
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number] | "announcements" | "staff_chat";

/** Helpers are players trusted with the review queues, not staff, so the staff chat starts one role up. */
export const STAFF_CHAT_ROLE: Role = "curator";
export const STAFF_CHAT_ALERTS = ["none", "badge", "notify"] as const;
export type StaffChatAlert = (typeof STAFF_CHAT_ALERTS)[number];

export type Preferences = {
	sounds: boolean;
	toasts: boolean;
	/** Browser notifications, delivered by push even when the site is closed where supported. */
	desktop: boolean;
	staff_badges: boolean;
	staff_alerts: boolean;
	/** For staff: nothing, a count and a sound, or an inbox entry with a push notification. */
	staff_chat: StaffChatAlert;
	notify: Record<(typeof NOTIFICATION_CATEGORIES)[number], boolean>;
};

export const DEFAULT_PREFERENCES: Preferences = {
	sounds: true,
	toasts: true,
	desktop: false,
	staff_badges: true,
	staff_alerts: true,
	staff_chat: "badge",
	notify: {
		submissions: true,
		suggestions: true,
		tickets: true,
		reminders: true,
		achievements: true,
		moderation: true,
	},
};

const RETENTION = 90 * DAY;
const INBOX_SIZE = 50;
/** The most kept for one player, newest first; the inbox shows the first INBOX_SIZE of them. */
const MAX_PER_USER = 200;

/** Reads stored preferences, filling in defaults for anything missing or malformed. */
export function parsePreferences(raw: string | null | undefined): Preferences {
	let stored: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(raw || "{}");
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed;
	} catch {}
	const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
	const notify = (stored.notify && typeof stored.notify === "object" ? stored.notify : {}) as Record<string, unknown>;
	return {
		sounds: flag(stored.sounds, DEFAULT_PREFERENCES.sounds),
		toasts: flag(stored.toasts, DEFAULT_PREFERENCES.toasts),
		desktop: flag(stored.desktop, DEFAULT_PREFERENCES.desktop),
		staff_badges: flag(stored.staff_badges, DEFAULT_PREFERENCES.staff_badges),
		staff_alerts: flag(stored.staff_alerts, DEFAULT_PREFERENCES.staff_alerts),
		staff_chat: STAFF_CHAT_ALERTS.includes(stored.staff_chat as StaffChatAlert)
			? (stored.staff_chat as StaffChatAlert)
			: DEFAULT_PREFERENCES.staff_chat,
		notify: Object.fromEntries(
			NOTIFICATION_CATEGORIES.map((category) => [
				category,
				flag(notify[category], DEFAULT_PREFERENCES.notify[category]),
			])
		) as Preferences["notify"],
	};
}

/** Preferences as sent to the browser. Players are not told about staff-only options. */
export function publicPreferences(user: User): Partial<Preferences> {
	const { staff_badges, staff_alerts, staff_chat, ...shared } = parsePreferences(user.prefs);
	return isStaff(user) ? { ...shared, staff_badges, staff_alerts, staff_chat } : shared;
}

export function updatePreferences(user: User, changes: unknown): Preferences {
	const current = parsePreferences(user.prefs);
	const input = (changes && typeof changes === "object" ? changes : {}) as Record<string, unknown>;
	const next = parsePreferences(
		JSON.stringify({
			...current,
			...input,
			notify: { ...current.notify, ...(input.notify && typeof input.notify === "object" ? input.notify : {}) },
		})
	);
	db.run("UPDATE users SET prefs = ? WHERE id = ?", [JSON.stringify(next), user.id]);
	return next;
}

type NewNotification = {
	title: string;
	body?: string | null;
	link?: string;
	/** Set on an announcement's copies, so they can be corrected or taken back together. */
	announcementId?: number;
	/** Put it in the inbox only: no push notification to the player's devices. */
	noPush?: boolean;
};

let afterNotify: ((userId: number) => void) | null = null;
export function onNotified(fn: (userId: number) => void) {
	afterNotify = fn;
}

/** Tells a user something happened. Respects their preferences; moderation notices always go through. */
export function notifyUser(userId: number | null | undefined, category: NotificationCategory, n: NewNotification) {
	if (!userId) return;
	try {
		const user = db.query<{ prefs: string | null }, [number]>("SELECT prefs FROM users WHERE id = ?").get(userId);
		if (!user) return;
		const prefs = parsePreferences(user.prefs);
		if (!ALWAYS_SENT.includes(category) && !prefs.notify[category as keyof Preferences["notify"]]) return;
		const title = n.title.slice(0, 120);
		const body = n.body ? n.body.slice(0, 400) : null;
		const link = n.link ?? "/settings#notifications";
		db.run(
			"INSERT INTO notifications (user_id, category, title, body, link, announcement_id) VALUES (?, ?, ?, ?, ?, ?)",
			[userId, category, title, body, link, n.announcementId ?? null]
		);
		if (prefs.desktop && !n.noPush) sendPush(userId, { title, body: body ?? "", link });
		afterNotify?.(userId);
	} catch (err) {
		console.error("[notifications] write failed:", err);
	}
}

export function listNotifications(userId: number) {
	return db
		.query(
			"SELECT id, category, title, body, link, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?"
		)
		.all(userId, INBOX_SIZE);
}

export function countNotifications(userId: number): number {
	return count("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?", userId);
}

export function markRead(userId: number, ids: number[] | null) {
	if (ids?.length) {
		db.run(
			`UPDATE notifications SET read_at = unixepoch() WHERE user_id = ? AND read_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`,
			[userId, ...ids]
		);
	} else {
		db.run("UPDATE notifications SET read_at = unixepoch() WHERE user_id = ? AND read_at IS NULL", [userId]);
	}
}

export function clearNotifications(userId: number) {
	db.run("DELETE FROM notifications WHERE user_id = ?", [userId]);
}

function count(sql: string, ...params: number[]): number {
	return db.query<{ n: number }, number[]>(sql).get(...params)?.n ?? 0;
}

let queueCache: { at: number; value: ReturnType<typeof countStaffQueue> } | null = null;

export function forgetStaffQueue() {
	queueCache = null;
}

/** What is waiting for staff to act on. Cached briefly, since every staff page asks. */
export function staffQueue() {
	if (!queueCache || Date.now() - queueCache.at > 5000) queueCache = { at: Date.now(), value: countStaffQueue() };
	return queueCache.value;
}

function countStaffQueue() {
	return {
		submissions: count("SELECT COUNT(*) AS n FROM submissions WHERE status = 'pending'"),
		suggestions: count("SELECT COUNT(*) AS n FROM location_suggestions WHERE status = 'pending'"),
		/** Open tickets where the last word was the player's, or nobody has answered yet. */
		tickets: count(
			`SELECT COUNT(*) AS n FROM support_tickets t WHERE t.status = 'open' AND (
				t.awaiting_staff = 1 OR NOT EXISTS (SELECT 1 FROM ticket_replies r WHERE r.ticket_id = t.id AND r.type = 'staff')
			)`
		),
		users: countEvasionFlags(),
	};
}

export function attentionFor(user: User) {
	const latest = db
		.query<{ id: number; category: string; title: string; body: string | null; link: string | null }, [number]>(
			"SELECT id, category, title, body, link FROM notifications WHERE user_id = ? AND read_at IS NULL ORDER BY id DESC LIMIT 1"
		)
		.get(user.id);
	/** The queue is only worked out for staff who have badges or alerts switched on. */
	const prefs = parsePreferences(user.prefs);
	const wantsQueue = prefs.staff_badges || prefs.staff_alerts;
	const all = isStaff(user) && !user.is_banned && wantsQueue ? staffQueue() : null;
	/** Helpers review submissions and suggestions only; tickets and flags are not theirs to see. */
	const queue = all && !hasRole(user, "moderator") ? { ...all, tickets: 0, users: 0 } : all;
	return {
		unread: count("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL", user.id),
		latest: latest ?? null,
		staff: queue ? { ...queue, total: queue.submissions + queue.suggestions + queue.tickets + queue.users } : null,
		/** Staff chat messages from others that they have not seen, unless they asked not to be told. */
		staff_chat:
			hasRole(user, STAFF_CHAT_ROLE) && !user.is_banned && prefs.staff_chat !== "none"
				? count(
						"SELECT COUNT(*) AS n FROM staff_chat WHERE id > ? AND COALESCE(author_id, 0) != ?",
						user.staff_chat_read ?? 0,
						user.id
					)
				: 0,
	};
}

export function pruneNotifications() {
	db.run("DELETE FROM notifications WHERE created_at < unixepoch() - ?", [RETENTION]);
	db.run(
		`DELETE FROM notifications WHERE id IN (
			SELECT id FROM (
				SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC, id DESC) AS n FROM notifications
			) WHERE n > ?
		)`,
		[MAX_PER_USER]
	);
}

/** In the evening (UTC), reminds players whose streak ends at midnight. At most one a day. */
export function sendStreakReminders(now = new Date()) {
	if (now.getUTCHours() < 18) return 0;
	const due = db
		.query<{ id: number; current_streak: number }, [string, string]>(
			`SELECT u.id, u.current_streak FROM users u
			WHERE u.last_played_date = ? AND u.current_streak >= 2 AND u.is_banned = 0
				AND NOT EXISTS (
					SELECT 1 FROM notifications n
					WHERE n.user_id = u.id AND n.category = 'reminders' AND date(n.created_at, 'unixepoch') = ?
				)`
		)
		.all(utcDate(-1), utcDate());
	for (const user of due) {
		notifyUser(user.id, "reminders", {
			title: `Your ${user.current_streak}-day streak ends tonight`,
			body: "Play the daily challenge or a solo game before midnight UTC to keep it going.",
			link: "/daily",
		});
	}
	return due.length;
}
