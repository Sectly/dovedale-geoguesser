import { Hono } from "hono";
import { join } from "path";
import { PUSH, ROOT_DIR } from "../config";
import { currentBanner, followLink, pendingAcknowledgement, publicNews } from "../announcements";
import { currentUser } from "../auth/sessions";
import { clientIp, getCookie, idParam, readJson } from "../lib/http";
import { checkRateLimit } from "../lib/rate-limit";
import { currentSeason, upcomingEvent } from "../specials";
import { DEVICE_COOKIE, checkForEvasion, deviceCookie, deviceId, hashIdentity, recordSignal } from "../evasion";

export const miscRoutes = new Hono();

const pkg = await Bun.file(join(ROOT_DIR, "package.json")).json();

miscRoutes.get("/status", (c) => c.text("200 OK"));
miscRoutes.get("/announcement", (c) => c.json(currentBanner()));
/** Follows an announcement's link, counting it. Past a few a minute per address it redirects without counting. */
miscRoutes.get("/announcement/:id/go", (c) =>
	c.redirect(followLink(idParam(c), checkRateLimit(`announcement-link:${clientIp(c)}`, 6, 60 * 1000)))
);
miscRoutes.get("/announcement/pending", (c) => {
	const user = currentUser(c);
	return c.json(user ? pendingAcknowledgement(user.id) : null);
});
miscRoutes.get("/news", (c) => c.json(publicNews()));
miscRoutes.get("/meta", (c) =>
	c.json({
		repo: pkg.repository ?? null,
		push_key: PUSH.publicKey || null,
		season: currentSeason(Date.now(), c.req.query("season")),
		upcoming: upcomingEvent(),
	})
);

/** Records the device cookie and browser fingerprint used to spot ban evasion. Always answers 204. */
miscRoutes.post("/fp", async (c) => {
	const user = currentUser(c);
	if (!user || !checkRateLimit(`fp:${user.id}`, 5, 60 * 1000)) return c.body(null, 204);

	const device = deviceId(getCookie(c.req.header("Cookie"), DEVICE_COOKIE));
	/** Sent every time so the cookie's year starts over while the browser is in use. */
	c.header("Set-Cookie", deviceCookie(device.id));
	recordSignal(user.id, "device", hashIdentity(device.id));

	const hash = (await readJson<{ h: string }>(c)).h;
	if (typeof hash === "string" && /^[0-9a-f]{32}$/.test(hash)) recordSignal(user.id, "browser", hash);

	checkForEvasion(user.id);
	return c.body(null, 204);
});
