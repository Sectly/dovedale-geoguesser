import webpush from "web-push";
import { db } from "./db";
import { PUSH } from "./config";

/** Web Push: reaches a device when the site is closed. Off without VAPID keys. */

export const pushEnabled = !!(PUSH.publicKey && PUSH.privateKey);
if (pushEnabled) webpush.setVapidDetails(PUSH.subject, PUSH.publicKey, PUSH.privateKey);

/** The push services browsers use. Nothing else is accepted as an endpoint. */
const PUSH_HOSTS = [
	/^fcm\.googleapis\.com$/,
	/(^|\.)push\.services\.mozilla\.com$/,
	/(^|\.)push\.apple\.com$/,
	/(^|\.)notify\.windows\.com$/,
];

export function isPushEndpoint(endpoint: string): boolean {
	try {
		const url = new URL(endpoint);
		return url.protocol === "https:" && !url.port && PUSH_HOSTS.some((host) => host.test(url.hostname));
	} catch {
		return false;
	}
}

type Subscription = { id: number; endpoint: string; p256dh: string; auth: string };
const MAX_DEVICES = 10;

export function saveSubscription(userId: number, endpoint: string, p256dh: string, auth: string) {
	db.run(
		`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
		ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
		[userId, endpoint, p256dh, auth]
	);
	db.run(
		"DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN (SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT ?)",
		[userId, userId, MAX_DEVICES]
	);
}

export function removeSubscription(userId: number, endpoint?: string) {
	if (endpoint) db.run("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?", [userId, endpoint]);
	else db.run("DELETE FROM push_subscriptions WHERE user_id = ?", [userId]);
}

/** Fire-and-forget delivery to all of a user's devices. Dead subscriptions are dropped. */
export function sendPush(userId: number, message: { title: string; body: string; link: string }) {
	if (!pushEnabled) return;
	const subscriptions = db
		.query<Subscription, [number]>("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?")
		.all(userId);
	for (const sub of subscriptions) {
		webpush
			.sendNotification(
				{ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
				JSON.stringify(message),
				{
					TTL: 24 * 60 * 60,
				}
			)
			.catch((err: { statusCode?: number }) => {
				if (err?.statusCode === 404 || err?.statusCode === 410) {
					db.run("DELETE FROM push_subscriptions WHERE id = ?", [sub.id]);
				}
			});
	}
}
