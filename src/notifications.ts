import { db, type User } from "./db";
import { countEvasionFlags } from "./evasion";
import { hasRole, isStaff } from "./auth/guards";
import { DAY, utcDate } from "./lib/time";
import { sendPush } from "./push";

/**
 * Per-user notifications ("your submission was approved") and the preferences
 * that control them. Staff also get a count of the work waiting for them, which
 * is computed live rather than stored.
 */

export const NOTIFICATION_CATEGORIES = [
	"submissions",
	"suggestions",
	"tickets",
	"reminders",
	"achievements",
	"moderation",
] as const;
/** Sent to everyone regardless of preferences: things a user needs to know. */
const ALWAYS_SENT = ["moderation", "announcements"];
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number] | "announcements";

export type Preferences = {
	/** Sound effects in games and for new notifications. */
	sounds: boolean;
	/** Pop-up messages inside the site when something new arrives. */
	toasts: boolean;
	/** Browser notifications, delivered by push even when the site is closed where supported. */
	desktop: boolean;
	/** For staff: show what is waiting for review on the staff panel button and sidebar. */
	staff_badges: boolean;
	/** For staff: pop up a message when something new arrives in a review queue. */
	staff_alerts: boolean;
	/** Which kinds of notification the user wants to receive. */
	notify: Record<(typeof NOTIFICATION_CATEGORIES)[number], boolean>;
};

export const DEFAULT_PREFERENCES: Preferences = {
	sounds: true,
	toasts: true,
	desktop: false,
	staff_badges: true,
	staff_alerts: true,
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
	const { staff_badges, staff_alerts, ...shared } = parsePreferences(user.prefs);
	return isStaff(user) ? { ...shared, staff_badges, staff_alerts } : shared;
}

/** Applies a partial update from the settings page and returns the stored result. */
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

type NewNotification = { title: string; body?: string | null; link?: string };

/**
 * Tells a user something happened to them. Respects their category preferences;
 * moderation notices always go through, since a ban is not something to opt out of hearing about.
 */
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
		db.run("INSERT INTO notifications (user_id, category, title, body, link) VALUES (?, ?, ?, ?, ?)", [
			userId,
			category,
			title,
			body,
			link,
		]);
		if (prefs.desktop) sendPush(userId, { title, body: body ?? "", link });
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

/** Marks notifications as read: the given ids, or everything when none are given. */
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

/** What is waiting for staff to act on. */
export function staffQueue() {
	return {
		submissions: count("SELECT COUNT(*) AS n FROM submissions WHERE status = 'pending'"),
		suggestions: count("SELECT COUNT(*) AS n FROM location_suggestions WHERE status = 'pending'"),
		// Open tickets where the last word was the player's, or nobody has answered yet.
		tickets: count(
			`SELECT COUNT(*) AS n FROM support_tickets t WHERE t.status = 'open' AND (
				t.awaiting_staff = 1 OR NOT EXISTS (SELECT 1 FROM ticket_replies r WHERE r.ticket_id = t.id AND r.type = 'staff')
			)`
		),
		users: countEvasionFlags(),
	};
}

/**
 * Everything that needs this user's attention, in one cheap call the header polls:
 * their unread notifications and, for staff who want it, the review queues.
 */
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
	// Helpers review submissions and suggestions only; tickets and flags are not theirs to see.
	const queue = all && !hasRole(user, "moderator") ? { ...all, tickets: 0, users: 0 } : all;
	return {
		unread: count("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL", user.id),
		latest: latest ?? null,
		staff: queue ? { ...queue, total: queue.submissions + queue.suggestions + queue.tickets + queue.users } : null,
	};
}

export function pruneNotifications() {
	db.run("DELETE FROM notifications WHERE created_at < unixepoch() - ?", [RETENTION]);
}

/**
 * In the evening (UTC), nudges players whose streak will end at midnight because
 * they have not played today. Each player gets at most one reminder a day.
 */
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
