import { randomBytes } from "crypto";
import { compress } from "hono/compress";
import { Hono } from "hono";
import type { ErrorHandler } from "hono";
import { join } from "path";
import { ROOT_DIR, SECURE_COOKIES } from "./config";
import { hasRole } from "./auth/guards";
import { currentUser } from "./auth/sessions";
import { eventStream, nudgeBanner, nudgeStaffChat, nudgeTicket, ticketOwner } from "./events";
import { forgetStaffQueue } from "./notifications";
import { HttpError } from "./lib/http";
import { reportProblem } from "./lib/problems";
import { accountRoutes } from "./routes/account";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { dailyRoutes } from "./routes/daily";
import { duelRoutes } from "./routes/duels";
import { leaderboardRoutes } from "./routes/leaderboard";
import { locationRoutes, suggestionRoutes } from "./routes/locations";
import { miscRoutes } from "./routes/misc";
import { notificationRoutes } from "./routes/notifications";
import { ogRoutes } from "./routes/og";
import { DEFAULT_MAINTENANCE_MESSAGE, maintenance } from "./system/maintenance";
import { blockedByRestart, justRestarted, restartIn } from "./system/restart";
import { errorPage, importMapHash, notFound, pageRoutes, wantsPage } from "./routes/pages";
import { profileRoutes } from "./routes/profile";
import { soloRoutes, specialRoutes } from "./routes/solo";
import { submissionRoutes } from "./routes/submissions";
import { supportRoutes } from "./routes/support";
import { teamRoutes } from "./routes/teams";
import { tournamentRoutes } from "./routes/tournaments";

/** The WebWire browser client, bundled once at startup and served to the duels page. */
async function bundleWireClient(): Promise<string> {
	const build = await Bun.build({
		entrypoints: [join(ROOT_DIR, "node_modules/@webwirejs/client/src/index.js")],
		format: "esm",
		target: "browser",
		minify: true,
	});
	if (!build.success) {
		console.error("Failed to bundle WebWire client:", build.logs);
		return "";
	}
	return build.outputs[0].text();
}

const wireClientJs = await bundleWireClient();

export const app = new Hono();

const compressed = compress();
/** Sockets and the event stream are left uncompressed: compression would buffer stream messages. */
app.use("*", (c, next) => (c.req.header("Upgrade") || c.req.path === "/api/events" ? next() : compressed(c, next)));

app.use("*", async (c, next) => {
	await next();
	/** Says the answer came from the game itself, not from a proxy standing in while it is down. */
	c.header("X-App", "dovedale");
	c.header("X-Content-Type-Options", "nosniff");
	c.header("X-Frame-Options", "DENY");
	c.header("Referrer-Policy", "strict-origin-when-cross-origin");
	c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
	/** No inline scripts but the import map; pages' handlers are read by public/js/lib/handlers.js. */
	const isPage = c.res.headers.get("Content-Type")?.startsWith("text/html");
	c.header(
		"Content-Security-Policy",
		`default-src 'self'; script-src 'self'${isPage ? ` ${importMapHash()}` : ""}; style-src 'self' 'unsafe-inline'; ` +
			"font-src 'self'; img-src 'self' data: blob: https://cdn.discordapp.com; " +
			"connect-src 'self' ws: wss:; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
	);
	if (SECURE_COOKIES) c.header("Strict-Transport-Security", "max-age=31536000");
	/** Prefetches a page when its link is hovered, without an inline script. */
	if (isPage) c.header("Speculation-Rules", '"/speculation-rules.json"');
});

/** Refuses state changes and sockets from other sites, behind the SameSite=Lax cookie. */
app.use("*", async (c, next) => {
	const unsafe = !["GET", "HEAD", "OPTIONS"].includes(c.req.method) || !!c.req.header("Upgrade");
	if (unsafe && c.req.header("Sec-Fetch-Site") === "cross-site") return c.text("Cross-site request refused.", 403);
	await next();
});

/** Puts a planned restart on every API response. New multiplayer games are refused. */
app.use("/api/*", async (c, next) => {
	if (restartIn() === null) {
		await next();
		/** Just back from a restart: say so, for anyone who reloaded while it was happening. */
		const restarted = justRestarted();
		if (restarted !== null) c.header("X-Restarted", String(restarted));
		return;
	}
	if (blockedByRestart(c.req.method, c.req.path)) {
		c.header("X-Restart-In", String(restartIn()));
		c.header("Retry-After", String(restartIn()! + 10));
		return c.text("The server is about to restart for an update. Try again in a minute.", 503);
	}
	await next();
	/** Asked again here: the request may be the very one that called the restart off. */
	const seconds = restartIn();
	if (seconds !== null) c.header("X-Restart-In", String(seconds));
});

/** Maintenance mode: staff carry on; everyone else gets the maintenance screen or a 503. Logins and assets stay open. */
app.use("*", async (c, next) => {
	const state = maintenance();
	if (!state.enabled) return next();
	const path = c.req.path;
	const open = path.startsWith("/api/auth/") || path === "/api/status" || path === "/api/meta";
	const asset = !path.startsWith("/api/") && /\.[a-z0-9]+$/i.test(path) && !path.endsWith(".html");
	if (open || asset || hasRole(currentUser(c), "curator")) return next();

	const message = state.message || DEFAULT_MAINTENANCE_MESSAGE;
	c.header("Retry-After", "600");
	if (path.startsWith("/api/")) return c.text(`Down for maintenance. ${message}`, 503);
	return errorPage(c, { status: 503, title: "Down for maintenance", message, help: false });
});

/** API responses depend on who is asking; never let a shared cache hold on to them. */
app.use("/api/*", async (c, next) => {
	await next();
	if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
});

app.use("/api/*", async (c, next) => {
	await next();
	if (c.req.method === "GET" || c.res.status >= 400) return;
	forgetStaffQueue();
	const path = c.req.path;
	if (path.startsWith("/api/admin/chat")) return nudgeStaffChat();
	if (path.startsWith("/api/admin/announcements")) return nudgeBanner();
	const ticket = path.match(/^\/api\/(?:admin\/)?support(?:\/(\d+))?/);
	if (!ticket) return;
	const id = ticket[1] ? Number(ticket[1]) : null;
	nudgeTicket(id, id ? ticketOwner(id) : (currentUser(c)?.id ?? null));
});

app.get("/api/events", eventStream);
app.route("/api/auth", authRoutes);
app.route("/api/solo", soloRoutes);
app.route("/api/specials", specialRoutes);
app.route("/api/teams", teamRoutes);
app.route("/api/daily", dailyRoutes);
app.route("/api/duels", duelRoutes);
app.route("/api/tournaments", tournamentRoutes);
app.route("/api/leaderboard", leaderboardRoutes);
app.route("/api/submissions", submissionRoutes);
app.route("/api/locations", locationRoutes);
app.route("/api/suggestions", suggestionRoutes);
app.route("/api/profile", profileRoutes);
app.route("/api/support", supportRoutes);
app.route("/api/admin", adminRoutes);
app.route("/api", accountRoutes);
app.route("/api", notificationRoutes);
app.route("/api", miscRoutes);

const wireClientEtag = `"${Bun.hash(wireClientJs).toString(36)}"`;
app.get("/webwire-client.js", (c) => {
	c.header("Cache-Control", "no-cache");
	c.header("ETag", wireClientEtag);
	if (c.req.header("If-None-Match") === wireClientEtag) return c.body(null, 304);
	return c.body(wireClientJs, 200, { "Content-Type": "application/javascript; charset=utf-8" });
});
app.route("/", ogRoutes);
app.route("/", pageRoutes);

app.notFound(notFound);

/** Headings for refusals that reach a page. Any other status says "That didn't work". */
const REFUSAL_TITLES: Record<number, string> = {
	401: "Log in first",
	403: "You can't open that",
	429: "Slow down a moment",
	503: "Not available right now",
};

export const handleError: ErrorHandler = (err, c) => {
	/** Login and logout live under /api but are opened as pages, so they get the page too. */
	const asPage = wantsPage(c) || (c.req.method === "GET" && c.req.path.startsWith("/api/auth/"));
	if (err instanceof HttpError) {
		if (!asPage) return c.text(err.message, err.status);
		/** Login and logout count as pages but live under /api, where notFound answers in JSON. */
		if (err.status === 404) return c.req.path.startsWith("/api/") ? c.text(err.message, 404) : notFound(c);
		return errorPage(c, {
			status: err.status,
			title: REFUSAL_TITLES[err.status] ?? "That didn't work",
			message: err.message,
		});
	}
	/** A short id ties what the player saw to the line in the log. */
	const ref = randomBytes(4).toString("hex");
	console.error(`[server] ${c.req.method} ${c.req.path} failed (ref ${ref}):`, err);
	reportProblem(`Server error on ${c.req.method} ${c.req.path}`, err, ref);
	c.header("X-Error-Ref", ref);
	if (asPage) return errorPage(c, { ref });
	return c.text(`Something went wrong on our end. Please try again. (ref ${ref})`, 500);
};

app.onError(handleError);
