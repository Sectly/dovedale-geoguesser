import { randomBytes } from "crypto";
import { Hono } from "hono";
import type { ErrorHandler } from "hono";
import { join } from "path";
import { ROOT_DIR, SECURE_COOKIES } from "./config";
import { isStaff } from "./auth/guards";
import { currentUser } from "./auth/sessions";
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
import { errorPage, notFound, pageRoutes, wantsPage } from "./routes/pages";
import { profileRoutes } from "./routes/profile";
import { soloRoutes, specialRoutes } from "./routes/solo";
import { submissionRoutes } from "./routes/submissions";
import { supportRoutes } from "./routes/support";
import { teamRoutes } from "./routes/teams";

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

app.use("*", async (c, next) => {
	await next();
	c.header("X-Content-Type-Options", "nosniff");
	c.header("X-Frame-Options", "DENY");
	c.header("Referrer-Policy", "strict-origin-when-cross-origin");
	c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
	// Inline handlers rule out a stricter script policy; this still stops framing, plugins and <base> hijacking.
	c.header(
		"Content-Security-Policy",
		"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
			"font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https://cdn.discordapp.com; " +
			"connect-src 'self' ws: wss:; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
	);
	if (SECURE_COOKIES) c.header("Strict-Transport-Security", "max-age=31536000");
});

/**
 * Maintenance mode. Staff carry on as normal (and are told it is on); everyone else gets
 * the maintenance screen for pages and a 503 for API calls. Logging in stays open so that
 * staff can get in, and scripts, styles and images still load so the screen can be drawn.
 */
app.use("*", async (c, next) => {
	const state = maintenance();
	if (!state.enabled) return next();
	const path = c.req.path;
	const open = path.startsWith("/api/auth/") || path === "/api/status" || path === "/api/meta";
	const asset = !path.startsWith("/api/") && /\.[a-z0-9]+$/i.test(path) && !path.endsWith(".html");
	if (open || asset || isStaff(currentUser(c))) return next();

	const message = state.message || DEFAULT_MAINTENANCE_MESSAGE;
	c.header("Retry-After", "600");
	if (path.startsWith("/api/")) return c.text(`Down for maintenance. ${message}`, 503);
	return errorPage(c, { status: 503, title: "Down for maintenance", message, icon: "construction", help: false });
});

/** API responses depend on who is asking; never let a shared cache hold on to them. */
app.use("/api/*", async (c, next) => {
	await next();
	if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
});

app.route("/api/auth", authRoutes);
app.route("/api/solo", soloRoutes);
app.route("/api/specials", specialRoutes);
app.route("/api/teams", teamRoutes);
app.route("/api/daily", dailyRoutes);
app.route("/api/duels", duelRoutes);
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

/** Turns anything thrown while handling a request into a response: a page for pages, text for API calls. */
export const handleError: ErrorHandler = (err, c) => {
	/** Login and logout live under /api but are opened as pages, so they get the page too. */
	const asPage = wantsPage(c) || (c.req.method === "GET" && c.req.path.startsWith("/api/auth/"));
	if (err instanceof HttpError) {
		if (asPage && err.status !== 404)
			return errorPage(c, { status: 400, title: "That didn't work", message: err.message });
		return c.text(err.message, err.status);
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
