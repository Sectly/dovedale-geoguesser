import { Hono } from "hono";
import sharp from "sharp";
import { duelRooms } from "../game/duels/rooms";
import { clientIp } from "../lib/http";
import { checkRateLimit } from "../lib/rate-limit";
import { getStreak } from "../game/streaks";
import { duelCard, genericCard, profileCard, tournamentCard } from "../og/cards";
import { tournamentShare } from "../game/tournaments";
import { findProfile, profileStats } from "./profile";
import { publicSpecial, specialTagline } from "../specials";

export const ogRoutes = new Hono();

/** Bump to make crawlers refetch share images after a design change. */
export const OG_VERSION = 4;

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 300;
const cache = new Map<string, { png: Buffer; at: number }>();

const PAGE_CARDS: Record<string, [title: string, subtitle: string]> = {
	home: ["Dovedale GeoGuesser", "Identify locations across Dovedale Railway"],
	game: ["Solo GeoGuesser", "How well do you know the line?"],
	duels: ["Duels", "Challenge a friend to a location guessing duel"],
	daily: ["Daily Challenge", "One location a day. Compete for the leaderboard"],
	leaderboard: ["Leaderboard", "The best GeoGuessers on Dovedale Railway"],
	specials: ["Specials", "Side modes, mini-games and seasonal events"],
};

export function pruneOgCache() {
	const now = Date.now();
	for (const [key, entry] of cache) {
		if (now - entry.at > TTL_MS) cache.delete(key);
	}
}

const AVATAR_HOST = "cdn.discordapp.com";
const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

async function fetchAvatar(url: string | null): Promise<{ mime: string; bytes: Buffer } | null> {
	if (!url) return null;
	try {
		const target = new URL(url);
		if (target.protocol !== "https:" || target.hostname !== AVATAR_HOST) return null;
		const res = await fetch(target, { signal: AbortSignal.timeout(3000), redirect: "error" });
		if (!res.ok) return null;
		const mime = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
		if (!AVATAR_TYPES.includes(mime)) return null;
		const bytes = Buffer.from(await res.arrayBuffer());
		if (bytes.length > AVATAR_MAX_BYTES) return null;
		return { mime, bytes };
	} catch {
		return null;
	}
}

async function avatarDataUri(url: string | null): Promise<string> {
	const avatar = await fetchAvatar(url);
	return avatar ? `data:${avatar.mime};base64,${avatar.bytes.toString("base64")}` : "";
}

/** Changes with the avatar, so a new one gets a new address. */
export const avatarVersion = (url: string) => Bun.hash(url).toString(36);

/** Discord won't load its own CDN in a component embed. */
export const avatarPath = (username: string, url: string) =>
	`/u/${encodeURIComponent(username)}/avatar-${avatarVersion(url)}.webp`;

async function profileSvg(username: string): Promise<string | null> {
	const user = findProfile(username);
	if (!user || user.profile_private) return null;
	const stats = profileStats(user.id);
	const joined = new Date(user.created_at * 1000).toLocaleDateString("en-GB", { year: "numeric", month: "long" });
	return profileCard(
		user.display_name || user.username,
		user.username,
		joined,
		[
			{ label: "Solo Games", value: String(stats.solo.total_games) },
			{ label: "Best Score", value: stats.solo.best_score?.toLocaleString() ?? "-" },
			{ label: "Duel Wins", value: String(stats.duels.wins) },
			{ label: "Day Streak", value: String(getStreak(user.id).current_streak) },
		],
		await avatarDataUri(user.avatar_url)
	);
}

function duelSvg(code: string, spectate: boolean): string {
	const room = duelRooms.get(code);
	return duelCard(
		code,
		room?.players[0]?.displayName ?? "Unknown",
		room?.rounds ?? 5,
		room?.players.length ?? 0,
		room?.status ?? "waiting",
		spectate
	);
}

async function tournamentSvg(id: number, invite: boolean): Promise<string | null> {
	const share = tournamentShare(id);
	if (!share) return null;
	return tournamentCard({
		...share,
		invite: invite && (share.status === "open" || share.status === "announced"),
		champion: share.champion
			? { name: share.champion.name, avatar: await avatarDataUri(share.champion.avatarUrl) }
			: null,
	});
}

ogRoutes.get("/og.png", async (c) => {
	const type = c.req.query("type") || "home";
	const username = (c.req.query("u") || "").slice(0, 40);
	const id = Number(c.req.query("id"));
	const special = type === "special" ? publicSpecial(c.req.query("s") || "") : null;
	const invite = c.req.query("invite") !== undefined;
	const code = (c.req.query("code") || "")
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, "")
		.slice(0, 6);

	/** Only the parameters a card actually uses go into the key, so junk queries cannot fill the cache. */
	const key =
		type === "profile" && username
			? `profile:${username}`
			: type === "tournament" && Number.isInteger(id) && id > 0
				? `tournament:${id}:${invite ? 1 : 0}`
				: (type === "duel" || type === "spectate") && code
					? `${type}:${code}`
					: special
						? `special:${special.id}`
						: type in PAGE_CARDS
							? type
							: "home";

	let png = cache.get(key);
	if (!png || Date.now() - png.at > TTL_MS) {
		if (!checkRateLimit(`og:${clientIp(c)}`, 30, 60 * 1000)) {
			png ??= cache.get("home");
			if (!png) return c.text("Too many requests", 429);
			return c.body(new Uint8Array(png.png), 200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
		}
		let svg: string | null = null;
		if (key.startsWith("profile:")) svg = await profileSvg(username);
		else if (key.startsWith("tournament:")) svg = await tournamentSvg(id, invite);
		else if (special) svg = genericCard(special.title, specialTagline(special));
		else if (key.includes(":")) svg = duelSvg(code, type === "spectate");
		svg ??= genericCard(...(PAGE_CARDS[key] ?? PAGE_CARDS.home));

		png = { png: await sharp(Buffer.from(svg)).png().toBuffer(), at: Date.now() };
		if (cache.size >= MAX_ENTRIES) pruneOgCache();
		if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
		cache.set(key, png);
	}
	return c.body(new Uint8Array(png.png), 200, {
		"Content-Type": "image/png",
		"Cache-Control": "public, max-age=300",
	});
});

ogRoutes.get("/u/:username/:file{avatar-[0-9a-z]+\\.webp}", async (c) => {
	const user = findProfile(c.req.param("username"));
	if (!user || user.profile_private || !user.avatar_url) return c.notFound();
	const key = `avatar:${user.id}:${avatarVersion(user.avatar_url)}`;
	let image = cache.get(key);
	if (!image || Date.now() - image.at > TTL_MS) {
		if (!checkRateLimit(`avatar:${clientIp(c)}`, 30, 60 * 1000)) return c.text("Too many requests", 429);
		const avatar = await fetchAvatar(user.avatar_url);
		if (!avatar) return c.notFound();
		image = { png: await sharp(avatar.bytes).resize(256, 256).webp({ quality: 85 }).toBuffer(), at: Date.now() };
		if (cache.size >= MAX_ENTRIES) pruneOgCache();
		if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
		cache.set(key, image);
	}
	return c.body(new Uint8Array(image.png), 200, {
		"Content-Type": "image/webp",
		"Cache-Control": "public, max-age=86400",
	});
});
