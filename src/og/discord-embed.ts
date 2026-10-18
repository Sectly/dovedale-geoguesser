import { SITE_URL } from "../config";
import { db } from "../db";
import { utcDate } from "../lib/time";
import { OG_VERSION } from "../routes/og";

type Component = Record<string, unknown>;

/** Discord drops the whole payload past this, escapes included. */
const MAX_BYTES = 3000;
const ACCENT = 0x2563eb;

const link = (path: string) => SITE_URL + path;

export const text = (content: string): Component => ({ type: 10, content });

export const button = (label: string, path: string): Component => ({ type: 2, style: 5, label, url: link(path) });

/** Up to five buttons in a row. */
export const buttons = (...items: Component[]): Component => ({ type: 1, components: items.slice(0, 5) });

/** A share card from /og.png, `query` being what follows its `?`. */
export const card = (query: string): Component => ({
	type: 12,
	items: [{ media: { url: link(`/og.png?${query}&v=${OG_VERSION}`) } }],
});

export const separator = (): Component => ({ type: 14 });

/** Text with a small picture to its right. */
export const withThumbnail = (content: string, url: string): Component => ({
	type: 9,
	components: [text(content)],
	accessory: { type: 11, media: { url } },
});

/** For names and other text players write, so it shows as typed instead of as formatting. */
export function plain(value: string, max = 200): string {
	const cut = value.length > max ? `${value.slice(0, max - 1).trimEnd()}...` : value;
	return cut.replace(/[\\*_~`|>#[\]()<:@-]/g, "\\$&").replace(/\s+/g, " ");
}

/** The script tag for a page's head, or nothing when there is no public address or it would not fit. */
export function embedTag(components: Component[] | null): string {
	if (!SITE_URL || !components) return "";
	const json = JSON.stringify({ component: { type: 17, accent_color: ACCENT, components } }).replace(/</g, "\\u003c");
	if (Buffer.byteLength(json) > MAX_BYTES) return "";
	return `<script id="discord:component-embed" type="application/json">${json}</script>`;
}

const MAIN_BUTTONS = [
	button("Play solo", "/play"),
	button("Daily", "/daily"),
	button("Duels", "/duels"),
	button("Leaderboard", "/leaderboard"),
];

/** A heading, a line under it, the share image and the main buttons. */
export function pageEmbed(title: string, path: string, line: string, type: string, links = MAIN_BUTTONS) {
	return [text(`# [${title}](${link(path)})\n${line}`), card(`type=${type}`), buttons(...links)];
}

type Ranked = { name: string; score: number };

function todaysDaily() {
	const date = utcDate();
	const played = db
		.query<{ n: number }, [string]>(
			"SELECT COUNT(*) AS n FROM daily_scores ds JOIN users u ON u.id = ds.user_id WHERE ds.date = ? AND u.is_banned = 0"
		)
		.get(date)!.n;
	const top = db
		.query<Ranked, [string]>(
			`SELECT COALESCE(u.display_name, u.username) AS name, ds.score FROM daily_scores ds
			JOIN users u ON u.id = ds.user_id
			WHERE ds.date = ? AND u.is_banned = 0 ORDER BY ds.score DESC, ds.time_taken ASC, u.id ASC LIMIT 1`
		)
		.get(date);
	return { played, top };
}

function soloTopThree(): Ranked[] {
	return db
		.query<Ranked, []>(
			`SELECT COALESCE(u.display_name, u.username) AS name, MAX(ss.total_score) AS score FROM solo_scores ss
			JOIN users u ON u.id = ss.user_id
			WHERE u.is_banned = 0 GROUP BY u.id ORDER BY score DESC, MIN(ss.id) ASC LIMIT 3`
		)
		.all();
}

const MEDALS = ["🥇", "🥈", "🥉"];

const STATIC_EMBEDS: Record<string, () => Component[]> = {
	"/": () =>
		pageEmbed(
			"Dovedale GeoGuesser",
			"/",
			"Identify locations across the Dovedale Railway from screenshots. Challenge friends, climb the leaderboard.",
			"home"
		),
	"/play": () =>
		pageEmbed("Solo GeoGuesser", "/play", "How well do you know the line? Play solo, no login needed.", "game", [
			button("Play now", "/play"),
			button("Daily", "/daily"),
			button("Leaderboard", "/leaderboard"),
		]),
	"/daily": () => {
		const { played, top } = todaysDaily();
		const today = !played
			? "No one has played today's location yet."
			: `${played} player${played === 1 ? "" : "s"} today${top ? `. Top score **${top.score.toLocaleString("en-GB")}** by ${plain(top.name, 40)}` : ""}.`;
		return pageEmbed("Daily Challenge", "/daily", `One location a day.\n-# ${today}`, "daily", [
			button("Play today's location", "/daily"),
			button("Daily leaderboard", "/leaderboard"),
		]);
	},
	"/duels": () =>
		pageEmbed("Duels", "/duels", "Challenge a friend to a real-time location guessing duel.", "duels", [
			button("Start a duel", "/duels"),
			button("Leaderboard", "/leaderboard"),
		]),
	"/leaderboard": () => {
		const top = soloTopThree();
		const lines = top.map((r, i) => `${MEDALS[i]} ${plain(r.name, 40)} **${r.score.toLocaleString("en-GB")}**`);
		return [
			text(
				`# [Leaderboard](${link("/leaderboard")})\nThe best GeoGuessers on the Dovedale Railway.${lines.length ? `\n### Best solo scores\n${lines.join("\n")}` : ""}`
			),
			separator(),
			buttons(button("See every board", "/leaderboard"), button("Play solo", "/play")),
		];
	},
};

/** Built pages are kept a minute, as the ones with live numbers query on every view. */
const STATIC_TTL_MS = 60 * 1000;
const staticCache = new Map<string, { tag: string; at: number }>();

/** The embed for one of the fixed pages, or nothing for a page that has none. */
export function staticEmbed(route: string): string {
	const build = STATIC_EMBEDS[route];
	if (!build) return "";
	const hit = staticCache.get(route);
	if (hit && Date.now() - hit.at < STATIC_TTL_MS) return hit.tag;
	const tag = embedTag(build());
	staticCache.set(route, { tag, at: Date.now() });
	return tag;
}
