import { Hono } from "hono";
import { join } from "path";
import { PUSH, ROOT_DIR } from "../config";
import { currentBanner } from "../announcements";
import { currentUser } from "../auth/sessions";
import { getCookie, readJson } from "../lib/http";
import { checkRateLimit } from "../lib/rate-limit";
import { currentSeason } from "../specials";
import { DEVICE_COOKIE, checkForEvasion, deviceCookie, deviceId, hashIdentity, recordSignal } from "../evasion";

/** Routes mounted at /api that belong to no particular feature. */
export const miscRoutes = new Hono();

const pkg = await Bun.file(join(ROOT_DIR, "package.json")).json();

miscRoutes.get("/status", (c) => c.text("200 OK"));
/** The announcement pinned to every page right now, or null. */
miscRoutes.get("/announcement", (c) => c.json(currentBanner()));
miscRoutes.get("/meta", (c) =>
	c.json({
		repo: pkg.repository ?? null,
		push_key: PUSH.publicKey || null,
		season: currentSeason(Date.now(), c.req.query("season")),
	})
);

/**
 * Records the signals used to spot ban evasion for the logged-in user: the device
 * cookie and, when the page sent one, the browser fingerprint. A match with a
 * banned account is flagged for staff; nobody is banned automatically. Always
 * answers 204 so the page learns nothing from it.
 */
miscRoutes.post("/fp", async (c) => {
	const user = currentUser(c);
	if (!user || !checkRateLimit(`fp:${user.id}`, 5, 60 * 1000)) return c.body(null, 204);

	const device = deviceId(getCookie(c.req.header("Cookie"), DEVICE_COOKIE));
	// Sent every time so the cookie's year starts over while the browser is in use.
	c.header("Set-Cookie", deviceCookie(device.id));
	recordSignal(user.id, "device", hashIdentity(device.id));

	const hash = (await readJson<{ h: string }>(c)).h;
	if (typeof hash === "string" && /^[0-9a-f]{32}$/.test(hash)) recordSignal(user.id, "browser", hash);

	checkForEvasion(user.id);
	return c.body(null, 204);
});
