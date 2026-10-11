import { Hono } from "hono";
import type { Context } from "hono";
import { readFileSync, statSync } from "fs";
import { join, normalize, sep } from "path";
import { currentUser } from "../auth/sessions";
import { db } from "../db";
import { DEV_DISCORD_ID, DEV_MODE, PUBLIC_DIR, SITE_URL, UPLOADS_DIR } from "../config";
import { duelRooms } from "../game/duels/rooms";
import { escapeXml } from "../og/cards";
import { OG_VERSION } from "./og";
import { findProfile } from "./profile";

/** HTML pages, static files, the sitemap and the 404 page. */
export const pageRoutes = new Hono();

const PAGES: Record<string, string> = {
	"/": "index.html",
	"/play": "solo.html",
	"/daily": "daily.html",
	"/duels": "duels.html",
	"/leaderboard": "leaderboard.html",
	"/settings": "settings.html",
	"/submit": "submit.html",
	"/admin": "admin.html",
	"/specials": "specials.html",
	"/specials/reflex": "special-reflex.html",
	"/specials/teams": "special-teams.html",
	"/specials/memory": "special-memory.html",
	"/tos": "tos.html",
	"/privacy": "privacy.html",
	"/guidelines": "guidelines.html",
	"/fairplay": "fairplay.html",
};

const IMMUTABLE = "public, max-age=31536000, immutable";

type Page = { html: string; etag: string };
const pageCache = new Map<string, Page>();

function assetVersion(path: string): string {
	try {
		return Bun.hash(readFileSync(join(PUBLIC_DIR, path))).toString(36);
	} catch {
		return "0";
	}
}

/**
 * Loads a page from public/ and prepares it for serving: local scripts and styles
 * get a content hash in their URL (so they can be cached forever and still update
 * on deploy) and share-image URLs are made absolute.
 */
function loadPage(file: string): Page {
	const cached = pageCache.get(file);
	if (cached && !DEV_MODE) return cached;

	const html = readFileSync(join(PUBLIC_DIR, file), "utf8")
		.replace(
			/\b(src|href)="(\/(?:js|css)\/[^"?#]+)(?:\?[^"]*)?"/g,
			(_, attr, path) => `${attr}="${path}?v=${assetVersion(path)}"`
		)
		.replace(
			/content="\/og\.png\?type=(\w+)"/g,
			(_, type) => `content="${SITE_URL}/og.png?type=${type}&v=${OG_VERSION}"`
		);
	const page = { html, etag: `"${Bun.hash(html).toString(36)}"` };
	pageCache.set(file, page);
	return page;
}

function sendHtml(c: Context, html: string, etag?: string, status: 200 | 404 = 200) {
	c.header("Cache-Control", "no-cache");
	if (etag) {
		c.header("ETag", etag);
		if (status === 200 && c.req.header("If-None-Match") === etag) return c.body(null, 304);
	}
	return c.html(html, status);
}

type Meta = { title: string; description: string; image: string; url: string; type: "website" | "profile" };

/** Replaces a page's title, description and share tags with ones for a specific room or profile. */
function withMeta(html: string, meta: Meta): string {
	const e = escapeXml;
	const image = `${SITE_URL}${meta.image}&v=${OG_VERSION}`;
	const tags = `<meta property="og:title" content="${e(meta.title)}" />
<meta property="og:description" content="${e(meta.description)}" />
<meta property="og:image" content="${e(image)}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:type" content="${meta.type}" />
<meta property="og:url" content="${e(SITE_URL + meta.url)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${e(meta.title)}" />
<meta name="twitter:description" content="${e(meta.description)}" />
<meta name="twitter:image" content="${e(image)}" />`;
	return html
		.replace(/\s*<meta\s+(?:property="og:|name="twitter:)[^>]*>/gi, "")
		.replace(/<title>[^<]*<\/title>/, () => `<title>${e(meta.title)}</title>`)
		.replace(
			/<meta\s+name="description"[^>]*>/,
			() => `<meta name="description" content="${e(meta.description)}" />`
		)
		.replace("</head>", () => `${tags}\n</head>`);
}

for (const [route, file] of Object.entries(PAGES)) {
	pageRoutes.get(route, (c) => {
		// Specials need a login; the hub is where logged-out visitors are asked.
		if (route.startsWith("/specials/") && !currentUser(c)) return c.redirect("/specials");
		const page = loadPage(file);
		return sendHtml(c, page.html, page.etag);
	});
}

pageRoutes.get("/duel/:code", (c) => {
	const code = c.req
		.param("code")
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, "")
		.slice(0, 6);
	const spectate = c.req.query("spectate") !== undefined;
	const room = duelRooms.get(code);
	const host = room?.players[0]?.displayName ?? "Someone";
	const state = room?.status === "in_progress" ? "in progress" : "waiting for players";

	return sendHtml(
		c,
		withMeta(loadPage("duels.html").html, {
			title: !room
				? "Duel Room | Dovedale GeoGuesser"
				: `${spectate ? "Spectate" : "Join"} ${host}'s duel | Dovedale GeoGuesser`,
			description: !room
				? "Join a location guessing duel on the Dovedale Railway."
				: spectate
					? `Watch a ${room.rounds}-round duel ${state} on the Dovedale Railway.`
					: `${host} is hosting a ${room.rounds}-round duel. ${room.players.length}/2 players - ${state}.`,
			image: `/og.png?type=${spectate ? "spectate" : "duel"}&code=${code}`,
			url: `/duel/${code}`,
			type: "website",
		})
	);
});

pageRoutes.get("/u/:username", (c) => {
	const username = c.req.param("username");
	const profile = findProfile(username);
	const visible = profile && !profile.profile_private;
	const name = visible ? profile.display_name || profile.username : null;

	return sendHtml(
		c,
		withMeta(loadPage("profile.html").html, {
			title: name ? `${name} | Dovedale GeoGuesser` : "Dovedale GeoGuesser",
			description: name
				? `View ${name}'s GeoGuesser profile and stats.`
				: "Identify locations across the Dovedale Railway from screenshots.",
			image: name ? `/og.png?type=profile&u=${encodeURIComponent(username)}` : "/og.png?type=home",
			url: `/u/${encodeURIComponent(username)}`,
			type: "profile",
		})
	);
});

pageRoutes.get("/sitemap.xml", (c) => {
	const url = (path: string, changefreq: string, priority: string) =>
		`  <url><loc>${escapeXml(SITE_URL + path)}</loc><changefreq>${changefreq}</changefreq><priority>${priority}</priority></url>`;
	const profiles = db
		.query<{ username: string }, [string]>(
			"SELECT username FROM users WHERE profile_private = 0 AND is_banned = 0 AND username != '[deleted]' AND discord_id != ? ORDER BY id DESC LIMIT 500"
		)
		.all(DEV_DISCORD_ID);

	const urls = [
		url("/", "weekly", "1.0"),
		url("/play", "weekly", "0.9"),
		url("/daily", "daily", "0.9"),
		url("/duels", "weekly", "0.8"),
		url("/leaderboard", "daily", "0.8"),
		url("/guidelines", "monthly", "0.4"),
		url("/tos", "monthly", "0.3"),
		url("/privacy", "monthly", "0.3"),
		url("/fairplay", "monthly", "0.3"),
		...profiles.map((u) => url(`/u/${encodeURIComponent(u.username)}`, "weekly", "0.5")),
	];
	return c.body(
		`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>`,
		200,
		{ "Content-Type": "application/xml; charset=utf-8" }
	);
});

/** Serves a file from below `root`, or returns null when there is no such file. */
function sendFile(c: Context, root: string, relativePath: string, cacheControl: string) {
	let decoded: string;
	try {
		decoded = decodeURIComponent(relativePath);
	} catch {
		return null;
	}
	if (decoded.includes("\0") || decoded.split("/").some((part) => part.startsWith("."))) return null;
	// The root comes from configuration and may use either kind of slash.
	const base = normalize(root).replace(/[\\/]+$/, "");
	const path = normalize(join(base, decoded));
	if (!path.startsWith(base + sep)) return null;

	let stat;
	try {
		stat = statSync(path);
	} catch {
		return null;
	}
	if (!stat.isFile()) return null;

	const etag = `W/"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
	c.header("ETag", etag);
	c.header("Cache-Control", cacheControl);
	if (c.req.header("If-None-Match") === etag) return c.body(null, 304);
	const file = Bun.file(path);
	c.header("Content-Type", file.type);
	return c.body(file.stream());
}

/** Used when even the error page cannot be read from disk. */
const BARE_ERROR_PAGE = `<!doctype html><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Something went wrong</title>
<body style="background:#09090b;color:#e4e4e7;font-family:system-ui,sans-serif;text-align:center;padding:20vh 1.5rem">
<h1>Something went wrong</h1><p>That one is on us, not you. Try again in a moment.</p><p><a href="/" style="color:#60a5fa">Return home</a></p>`;

type ErrorPageOptions = {
	status?: 400 | 403 | 429 | 500 | 503;
	title?: string;
	message?: string;
	ref?: string;
	/** Material Symbols icon name; defaults to the error icon. */
	icon?: string;
	/** False to drop the "tell us in a ticket" line, for screens that are not faults. */
	help?: boolean;
};

/**
 * The full-page error screen, for when a page (not an API call) cannot be shown.
 * Defaults to the 500 screen; `ref` is the id written to the server log.
 */
export function errorPage(c: Context, { status = 500, title, message, ref, icon, help = true }: ErrorPageOptions = {}) {
	let html = BARE_ERROR_PAGE;
	try {
		const fill = (page: string, id: string, value: string | undefined) =>
			value === undefined
				? page
				: page.replace(new RegExp(`(id="${id}">)[^<]*<`), (_, open) => `${open}${escapeXml(value)}<`);
		html = loadPage("500.html").html;
		html = fill(html, "err-code", status === 500 ? undefined : String(status));
		html = fill(html, "err-title", title);
		html = fill(html, "err-message", message);
		html = fill(html, "err-ref", ref ? ` and quote reference ${ref}` : undefined);
		if (icon)
			html = html.replace(
				/(<span[^>]*>)error(<\/span>)/,
				(_, open, close) => `${open}${escapeXml(icon)}${close}`
			);
		if (!help) html = html.replace(/<p[^>]*id="err-help"[\s\S]*?<\/p>/, '<div class="mb-8"></div>');
		if (title)
			html = html.replace(
				/<title>[^<]*<\/title>/,
				() => `<title>${escapeXml(title)} | Dovedale GeoGuesser</title>`
			);
	} catch (err) {
		console.error("[server] Could not render the error page:", err);
	}
	c.header("Cache-Control", "no-store");
	return c.html(html, status);
}

function notFound(c: Context) {
	if (c.req.path.startsWith("/api/")) return c.json({ error: "Not found" }, 404);
	return sendHtml(c, loadPage("404.html").html, undefined, 404);
}

/** Screenshots have random names and never change once written. */
pageRoutes.get("/uploads/:file", (c) => sendFile(c, UPLOADS_DIR, c.req.param("file"), IMMUTABLE) ?? notFound(c));

pageRoutes.get("*", (c) => {
	const path = c.req.path;
	if (path.startsWith("/api/")) return notFound(c);
	/**
	 * Scripts and styles carry a content hash in their URL, so they may be kept for ever.
	 * Nothing else may: a "?v=" on an image is just a label, and the map tiles in particular
	 * must follow the coordinates when the map is updated. Those are revalidated hourly.
	 */
	const hashed = /^\/(js|css)\//.test(path) && c.req.query("v") !== undefined;
	const isMedia = /\.(png|webp|svg|ico|jpg|woff2)$/.test(path);
	const cacheControl = hashed ? IMMUTABLE : isMedia ? "public, max-age=3600, must-revalidate" : "no-cache";
	return sendFile(c, PUBLIC_DIR, path.slice(1), cacheControl) ?? notFound(c);
});

export { notFound };

/** True when the browser is loading a page, rather than a script calling the API. */
export function wantsPage(c: Context): boolean {
	return (
		c.req.method === "GET" &&
		!c.req.path.startsWith("/api/") &&
		(c.req.header("Accept") ?? "").includes("text/html")
	);
}
