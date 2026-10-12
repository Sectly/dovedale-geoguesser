import { Hono } from "hono";
import { requireUser } from "../auth/guards";
import { fail, readJson, text } from "../lib/http";
import { isPushEndpoint, pushEnabled, removeSubscription, saveSubscription } from "../push";
import { attentionFor, clearNotifications, countNotifications, listNotifications, markRead } from "../notifications";

/** Routes mounted at /api: the notification inbox and the header's attention summary. */
export const notificationRoutes = new Hono();

notificationRoutes.get("/attention", (c) => c.json(attentionFor(requireUser(c))));

notificationRoutes.get("/notifications", (c) => {
	const user = requireUser(c);
	return c.json({
		notifications: listNotifications(user.id),
		total: countNotifications(user.id),
		...attentionFor(user),
	});
});

notificationRoutes.post("/notifications/read", async (c) => {
	const user = requireUser(c);
	const body = await readJson<{ ids: number[] }>(c);
	const ids = Array.isArray(body.ids) ? body.ids.filter((id) => Number.isInteger(id)).slice(0, 100) : null;
	markRead(user.id, ids);
	return c.json(attentionFor(user));
});

/** Registers this browser to receive push notifications. Only the browsers' own push services are accepted. */
notificationRoutes.post("/push/subscribe", async (c) => {
	const user = requireUser(c);
	if (!pushEnabled) fail(503, "Push notifications are not set up on this server");
	const body = await readJson<{ endpoint: string; keys: { p256dh: string; auth: string } }>(c);
	const endpoint = text(body.endpoint, 1000);
	const p256dh = text(body.keys?.p256dh, 200);
	const auth = text(body.keys?.auth, 200);
	if (!isPushEndpoint(endpoint) || !p256dh || !auth) fail(400, "Invalid subscription");
	saveSubscription(user.id, endpoint, p256dh, auth);
	return c.json({ success: true });
});

notificationRoutes.delete("/push/subscribe", async (c) => {
	const user = requireUser(c);
	const body = await readJson<{ endpoint: string }>(c);
	removeSubscription(user.id, text(body.endpoint, 1000) || undefined);
	return c.json({ success: true });
});

notificationRoutes.delete("/notifications", (c) => {
	const user = requireUser(c);
	clearNotifications(user.id);
	return c.json(attentionFor(user));
});
