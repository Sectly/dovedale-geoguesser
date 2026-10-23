import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { readFileSync, statSync } from "fs";
import { join, normalize, sep } from "path";
import { currentUser } from "../auth/sessions";
import { db } from "../db";
import { DEV_DISCORD_ID, DEV_MODE, PUBLIC_DIR, SITE_URL, UPLOADS_DIR } from "../config";
import { duelRooms } from "../game/duels/rooms";
import { inviteWorks, tournamentShare } from "../game/tournaments";
import { teamRoomShare } from "../game/teams";
import { SPECIAL_MODES, publicSpecial, specialTagline, specialsFor, type Listed } from "../specials";
import { escapeXml } from "../og/cards";
import { avatarPath, OG_VERSION } from "./og";
import { tileVersion } from "../tile-images";
import { usedIcons } from "../icons";
import { GOOGLE_ICON_CSS, ICON_FONT_DIR, iconStylesheet } from "../icon-font";
import { findProfile, profileStats } from "./profile";
import { getStreak } from "../game/streaks";
import {
	button,
	buttons,
	card,
	embedTag,
	pageEmbed,
	plain,
	separator,
	staticEmbed,
	text,
	withThumbnail,
} from "../og/discord-embed";

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
	"/news": "news.html",
	"/specials/reflex": "special-reflex.html",
	"/specials/teams": "special-teams.html",
	"/specials/memory": "special-memory.html",
	"/tos": "tos.html",
	"/privacy": "privacy.html",
	"/guidelines": "guidelines.html",
	"/fairplay": "fairplay.html",
	"/leaving": "leaving.html",
};

const IMMUTABLE = "public, max-age=31536000, immutable";
/** Tiles change address when rebuilt, so a month of caching is safe. */
const TILE_CACHE = "public, max-age=2592000, immutable";

type Page = { html: string; etag: string };
const pageCache = new Map<string, Page>();

/** For when the tile version the pages carry changes. */
export const forgetPages = () => pageCache.clear();

function assetVersion(path: string): string {
	try {
		return Bun.hash(readFileSync(join(PUBLIC_DIR, path))).toString(36);
	} catch {
		return "0";
	}
}

let importMapTag = "";
let importMapSource = "";

/** Lets the page policy allow the import map, the one inline script. */
export function importMapHash(): string {
	importMap();
	return `'sha256-${new Bun.CryptoHasher("sha256").update(importMapSource).digest("base64")}'`;
}

/** Hashed addresses for every module, so imports cache like script tags and no module loads twice. */
function importMap(): string {
	if (importMapTag && !DEV_MODE) return importMapTag;
	const imports: Record<string, string> = {};
	for (const file of new Bun.Glob("js/**/*.js").scanSync(PUBLIC_DIR)) {
		const path = `/${file.replace(/\\/g, "/")}`;
		imports[path] = `${path}?v=${assetVersion(path)}`;
	}
	importMapSource = JSON.stringify({ imports });
	importMapTag = `<script type="importmap">${importMapSource}</script>`;
	return importMapTag;
}

/** Every module an entry imports, directly or not, so the browser fetches them at once. */
function moduleGraph(entry: string, seen = new Set<string>()): Set<string> {
	if (seen.has(entry)) return seen;
	seen.add(entry);
	let source = "";
	try {
		source = readFileSync(join(PUBLIC_DIR, entry), "utf8");
	} catch {
		return seen;
	}
	for (const [, from, bare] of source.matchAll(/\bfrom\s+"(\.[^"]+)"|^import\s+"(\.[^"]+)"/gm))
		moduleGraph(new URL(from ?? bare, `http://x${entry}`).pathname, seen);
	return seen;
}

/** The page's own address for search engines and link previews, in place of any written in the file. */
function withAddress(html: string, path: string): string {
	if (!SITE_URL) return html;
	const url = escapeXml(SITE_URL + path);
	return html
		.replace(/\s*<link\s+rel="canonical"[^>]*>/gi, "")
		.replace(/\s*<meta\s+property="og:url"[^>]*>/gi, "")
		.replace(
			"</head>",
			() => `<link rel="canonical" href="${url}" />\n<meta property="og:url" content="${url}" />\n</head>`
		);
}

/** Loads a page from public/, hashing script and style URLs and making share-image URLs absolute. `path` is its address, if any. */
function loadPage(file: string, path?: string): Page {
	const key = path ? `${file} ${path}` : file;
	const cached = pageCache.get(key);
	if (cached && !DEV_MODE) return cached;

	let html = readFileSync(join(PUBLIC_DIR, file), "utf8")
		.replace(
			/\b(src|href)="(\/(?:js|css)\/[^"?#]+)(?:\?[^"]*)?"/g,
			(_, attr, path) => `${attr}="${path}?v=${assetVersion(path)}"`
		)
		.replace(
			/content="\/og\.png\?type=(\w+)"/g,
			(_, type) => `content="${SITE_URL}/og.png?type=${type}&v=${OG_VERSION}"`
		);
	const iconCss = iconStylesheet(usedIcons(), forgetPages);
	html = html
		.replace(/[ \t]*<link rel="preconnect" href="https:\/\/fonts\.g[^"]+"[^>]*>\r?\n/g, "")
		.replace(`href="${GOOGLE_ICON_CSS}"`, `href="${iconCss ?? ""}"`);
	if (!iconCss) html = html.replace(/[ \t]*<link rel="stylesheet" href="" \/>\r?\n/, "");
	const entry = html.match(/<script type="module" src="(\/js\/[^"?]+)/)?.[1];
	if (entry) {
		const preload = [...moduleGraph(entry)]
			.slice(1)
			.map((path) => `<link rel="modulepreload" href="${path}?v=${assetVersion(path)}" />`);
		html = html.replace(
			"</head>",
			`<meta name="tile-version" content="${tileVersion()}" />\n${importMap()}\n${preload.join("\n")}\n</head>`
		);
	}
	if (path) html = withAddress(html, path);
	const page = { html, etag: `"${Bun.hash(html).toString(36)}"` };
	pageCache.set(key, page);
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

type Meta = {
	title: string;
	description: string;
	image: string;
	url: string;
	type: "website" | "profile";
	/** The Discord component embed, from `embedTag`. */
	embed?: string;
};

function withMeta(html: string, meta: Meta): string {
	const e = escapeXml;
	const image = `${SITE_URL}${meta.image}&v=${OG_VERSION}`;
	const tags = `<meta property="og:title" content="${e(meta.title)}" />
<meta property="og:description" content="${e(meta.description)}" />
<meta property="og:image" content="${e(image)}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:type" content="${meta.type}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${e(meta.title)}" />
<meta name="twitter:description" content="${e(meta.description)}" />
<meta name="twitter:image" content="${e(image)}" />${meta.embed ? `\n${meta.embed}` : ""}`;
	const page = html
		.replace(/\s*<meta\s+(?:property="og:|name="twitter:)[^>]*>/gi, "")
		.replace(/<title>[^<]*<\/title>/, () => `<title>${e(meta.title)}</title>`)
		.replace(
			/<meta\s+name="description"[^>]*>/,
			() => `<meta name="description" content="${e(meta.description)}" />`
		)
		.replace("</head>", () => `${tags}\n</head>`);
	return withAddress(page, meta.url);
}

const lines = (...parts: (string | null | false | undefined)[]) => text(parts.filter(Boolean).join("\n"));

function servePage(c: Context, route: string, file: string) {
	const page = loadPage(file, route);
	const embed = staticEmbed(route);
	if (!embed) return sendHtml(c, page.html, page.etag);
	const html = page.html.replace("</head>", () => `${embed}\n</head>`);
	return sendHtml(c, html, `"${Bun.hash(html).toString(36)}"`);
}

/** The rest play at /play?special=<id>. */
const SPECIAL_PAGES: Record<string, string> = {
	teams: "special-teams.html",
	memory: "special-memory.html",
	reflex: "special-reflex.html",
};

const specialPath = (s: Listed) => (SPECIAL_PAGES[s.id] ? `/specials/${s.id}` : `/play?special=${s.id}`);
const dayMonth = (iso: string) =>
	new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });

function specialsHubMeta(path: string): Meta {
	const live = specialsFor(null).filter((s) => s.status === "live");
	return {
		title: "Specials | Dovedale GeoGuesser",
		description: "Side modes, mini-games and seasonal events on Dovedale GeoGuesser.",
		image: "/og.png?type=specials",
		url: path,
		type: "website",
		embed: embedTag([
			lines(
				`# [Specials](${SITE_URL}/specials)`,
				"Side modes, mini-games and seasonal events.",
				...live.map(
					(s) => `- [**${plain(s.title, 40)}**](${SITE_URL}${specialPath(s)}) ${plain(specialTagline(s), 90)}`
				)
			),
			buttons(button("See all specials", "/specials"), button("Play solo", "/play")),
		]),
	};
}

function specialMeta(s: Listed): Meta {
	const path = specialPath(s);
	const starts = s.status === "upcoming" && s.startsAt ? `Starts ${dayMonth(s.startsAt)}.` : null;
	return {
		title: `${s.title} | Dovedale GeoGuesser`,
		description: starts ? `${s.blurb} ${starts}` : s.blurb,
		image: `/og.png?type=special&s=${s.id}`,
		url: path,
		type: "website",
		embed: embedTag([
			lines(
				"-# Specials",
				`# [${plain(s.title, 60)}](${SITE_URL}${path})`,
				plain(s.blurb, 300),
				starts && `-# ${starts}`
			),
			card(`type=special&s=${s.id}`),
			buttons(
				button(starts ? "See specials" : "Play", starts ? "/specials" : path),
				button("All specials", "/specials")
			),
		]),
	};
}

function teamRoomMeta(s: Listed, room: NonNullable<ReturnType<typeof teamRoomShare>>): Meta {
	const path = `/specials/teams?room=${room.code}`;
	const size = `${room.teamSize} vs ${room.teamSize}`;
	const seats = `${room.players} of ${room.teamSize * 2} players`;
	return {
		title: `Join ${room.host}'s Team Duels room | Dovedale GeoGuesser`,
		description: room.playing
			? `${room.host}'s ${size} game is being played right now.`
			: `${size}, ${room.rounds} rounds. ${seats} so far.`,
		image: `/og.png?type=special&s=${s.id}`,
		url: "/specials/teams",
		type: "website",
		embed: embedTag([
			lines(
				"-# Team Duels invite",
				`# [Join ${plain(room.host, 40)}'s room](${SITE_URL}${path})`,
				`${size} · ${room.rounds} rounds · ${seats}`,
				room.playing && "-# A game is being played right now."
			),
			card(`type=special&s=${s.id}`),
			buttons(
				room.playing ? button("Team Duels", "/specials/teams") : button("Join room", path),
				button("All specials", "/specials")
			),
		]),
	};
}

pageRoutes.get("/specials", (c) => sendHtml(c, withMeta(loadPage("specials.html").html, specialsHubMeta("/specials"))));

/** Logged out, these show the hub, whose login returns here. */
for (const [id, file] of Object.entries(SPECIAL_PAGES)) {
	const route = `/specials/${id}`;
	pageRoutes.get(route, (c) => {
		const html = loadPage(currentUser(c) ? file : "specials.html").html;
		const s = publicSpecial(id);
		if (!s) return sendHtml(c, withMeta(html, specialsHubMeta(route)));
		const room = id === "teams" ? teamRoomShare(c.req.query("room") ?? "") : null;
		return sendHtml(c, withMeta(html, room ? teamRoomMeta(s, room) : specialMeta(s)));
	});
}

pageRoutes.get("/play", (c) => {
	const s = publicSpecial(c.req.query("special") ?? "");
	if (!s || !SPECIAL_MODES[s.id]) return servePage(c, "/play", "solo.html");
	return sendHtml(c, withMeta(loadPage("solo.html").html, specialMeta(s)));
});

for (const [route, file] of Object.entries(PAGES))
	if (route !== "/play" && !route.startsWith("/specials")) pageRoutes.get(route, (c) => servePage(c, route, file));

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
					: `${host} is hosting a ${room.rounds}-round duel. ${room.players.length}/2 players, ${state}.`,
			image: `/og.png?type=${spectate ? "spectate" : "duel"}&code=${code}`,
			url: `/duel/${code}`,
			type: "website",
			embed: embedTag(
				!room
					? pageEmbed("Duel Room", `/duel/${code}`, "This duel has finished or the code is wrong.", "duels", [
							button("Start a duel", "/duels"),
							button("Play solo", "/play"),
						])
					: [
							text(
								`# ${spectate ? "Watch" : "Join"} ${plain(host, 40)}'s duel\n${room.rounds} rounds · ${room.players.length}/2 players · ${room.status === "in_progress" ? "In progress" : "Waiting for players"}`
							),
							card(`type=${spectate ? "spectate" : "duel"}&code=${code}`),
							buttons(
								...(spectate || room.status === "in_progress"
									? []
									: [button("Join duel", `/duel/${code}`)]),
								button("Watch", `/duel/${code}?spectate`),
								button("Duels", "/duels")
							),
						]
			),
		})
	);
});

const TOURNAMENT_BUTTON: Record<string, string> = {
	announced: "Open",
	open: "Check in",
	live: "Watch live",
	finished: "See results",
};

/** A profile's Discord preview: avatar, headline numbers and a link through. */
function profileEmbed(user: NonNullable<ReturnType<typeof findProfile>>, name: string) {
	const stats = profileStats(user.id);
	const joined = new Date(user.created_at * 1000).toLocaleDateString("en-GB", { year: "numeric", month: "long" });
	const path = `/u/${encodeURIComponent(user.username)}`;
	const heading = `# [${plain(name, 40)}](${SITE_URL}${path})\n-# @${plain(user.username, 40)} · Joined ${joined}`;
	const n = (value: number | null | undefined) => (value == null ? "-" : value.toLocaleString("en-GB"));
	const numbers = [
		`**Solo games** ${n(stats.solo.total_games)} · **Best** ${n(stats.solo.best_score)}`,
		`**Duel wins** ${n(stats.duels.wins)} of ${n(stats.duels.games)}`,
		`**Dailies** ${n(stats.daily.played)} · **Streak** ${n(getStreak(user.id).current_streak)} days`,
	].join("\n");
	return [
		user.avatar_url ? withThumbnail(heading, SITE_URL + avatarPath(user.username, user.avatar_url)) : text(heading),
		separator(),
		text(numbers),
		buttons(button("View profile", path), button("Play solo", "/play"), button("Leaderboard", "/leaderboard")),
	];
}

/** A tournament plays out on the duels page. Its share card follows how far it has got. */
pageRoutes.get("/tournament/:id", (c) => {
	const id = Number(c.req.param("id"));
	const share = Number.isInteger(id) && id > 0 ? tournamentShare(id) : null;
	const code = (c.req.query("invite") ?? "").trim().toUpperCase();
	const invite = !!share && /^[A-Z0-9]{1,12}$/.test(code) && inviteWorks(id, code);
	const players = share ? `${share.players} player${share.players === 1 ? "" : "s"}` : "";
	const checkin =
		share?.status === "open"
			? `Check-in is open, ${players} so far.`
			: "Check-in hasn't opened yet. Join with this link once it does.";
	const line = !share
		? "A Dovedale GeoGuesser tournament."
		: invite
			? `You're invited to play in ${share.title}. ${checkin}${share.detail ? ` ${share.detail}.` : ""}`
			: share.status === "announced"
				? `Coming up.${share.detail ? ` ${share.detail}.` : ""} ${players} on the list.`
				: share.status === "open"
					? `Check-in is open. ${players} so far.${share.detail ? ` ${share.detail}.` : ""}`
					: share.status === "live"
						? `Live now: ${share.detail}. Watch every match.`
						: share.status === "finished"
							? `${share.champion ? `Won by ${share.champion.name}. ` : ""}See the final standings and bracket.`
							: "This tournament was called off.";
	const page = `/tournament/${id}`;
	const invitePage = `${page}?invite=${code}`;
	const image = `type=tournament&id=${id}${invite ? "&invite" : ""}`;
	return sendHtml(
		c,
		withMeta(loadPage("duels.html").html, {
			title: share
				? `${invite ? "Join " : ""}${share.title} | Dovedale GeoGuesser`
				: "Tournament | Dovedale GeoGuesser",
			description: share?.description ? `${line} ${share.description}` : line,
			image: share ? `/og.png?${image}` : "/og.png?type=duels",
			url: page,
			type: "website",
			embed: embedTag(
				!share
					? null
					: invite
						? [
								lines(
									"-# You're invited to play",
									`# [${plain(share.title, 80)}](${SITE_URL}${invitePage})`,
									checkin,
									share.detail && `-# ${plain(share.detail, 80)}`,
									share.description && `>>> ${plain(share.description, 400)}`
								),
								card(image),
								buttons(
									button(share.status === "open" ? "Join" : "Open invite", invitePage),
									button("See the tournament", page)
								),
							]
						: [
								lines(
									`# [${plain(share.title, 80)}](${SITE_URL}${page})`,
									plain(line, 300),
									share.match && `-# ${plain(share.match, 120)}`,
									share.description && `>>> ${plain(share.description, 400)}`
								),
								card(image),
								buttons(
									button(TOURNAMENT_BUTTON[share.status] ?? "Open", page),
									button("Duels", "/duels")
								),
							]
			),
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
			embed: embedTag(visible && name ? profileEmbed(profile, name) : null),
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
		url("/news", "weekly", "0.5"),
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

function sendFile(c: Context, root: string, relativePath: string, cacheControl: string) {
	let decoded: string;
	try {
		decoded = decodeURIComponent(relativePath);
	} catch {
		return null;
	}
	if (decoded.includes("\0") || decoded.split("/").some((part) => part.startsWith("."))) return null;
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
	status?: ContentfulStatusCode;
	title?: string;
	message?: string;
	ref?: string;
	/** False to drop the "tell us in a ticket" line, for screens that are not faults. */
	help?: boolean;
};

/** The full-page error screen. `ref` is the server log id; the status picks the animation. */
export function errorPage(c: Context, { status = 500, title, message, ref, help = true }: ErrorPageOptions = {}) {
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
		html = html.replace('data-status="500"', `data-status="${status}"`);
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

/** Never /api links: following one does something. */
const SPECULATION_RULES = JSON.stringify({
	prefetch: [
		{ where: { and: [{ href_matches: "/*" }, { not: { href_matches: "/api/*" } }] }, eagerness: "moderate" },
	],
});

pageRoutes.get("/speculation-rules.json", (c) => {
	c.header("Content-Type", "application/speculationrules+json");
	c.header("Cache-Control", "public, max-age=86400");
	return c.body(SPECULATION_RULES);
});

/** Named after the icon set they hold, so they never change once written. */
pageRoutes.get("/fonts/:file", (c) => sendFile(c, ICON_FONT_DIR, c.req.param("file"), IMMUTABLE) ?? notFound(c));

/** Screenshots have random names and never change once written. */
pageRoutes.get("/uploads/:file", (c) => sendFile(c, UPLOADS_DIR, c.req.param("file"), IMMUTABLE) ?? notFound(c));

pageRoutes.get("*", (c) => {
	const path = c.req.path;
	if (path.startsWith("/api/")) return notFound(c);
	/** Hashed scripts and styles are cached for ever; the rest is revalidated. */
	const hashed = /^\/(js|css)\//.test(path) && c.req.query("v") !== undefined;
	const isMedia = /\.(png|webp|avif|svg|ico|jpg|woff2)$/.test(path);
	const versionedImage = path.startsWith("/images/") && c.req.query("v") !== undefined;
	const cacheControl = hashed
		? IMMUTABLE
		: versionedImage
			? TILE_CACHE
			: isMedia
				? "public, max-age=3600, must-revalidate"
				: "no-cache";
	return sendFile(c, PUBLIC_DIR, path.slice(1), cacheControl) ?? notFound(c);
});

export { notFound };

export function wantsPage(c: Context): boolean {
	return (
		c.req.method === "GET" &&
		!c.req.path.startsWith("/api/") &&
		(c.req.header("Accept") ?? "").includes("text/html")
	);
}
