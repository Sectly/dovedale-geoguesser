import { Context, Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createBunWebSocket } from "hono/bun";
import { WebWireServer } from "@webwirejs/server";
import { webwire } from "@webwirejs/hono";
import { db } from "./db";
import {
	generateAuthUrl,
	validateState,
	exchangeCode,
	upsertUser,
	createSession,
	deleteSession,
	getUserFromContext,
	sessionCookieHeader,
	clearSessionCookie,
	isBanned,
	getOperatorIds,
	getModeratorIds,
} from "./auth";
import {
	getRandomLocations,
	createDuelRoom,
	joinDuelRoom,
	duelRooms,
	startDuel,
	abandonDuel,
	submitDuelGuess,
	setDuelAuditCallback,
	type DuelRoom,
} from "./game";
import type { User, Location } from "./db";
import { randomBytes } from "crypto";
import { writeFile, unlink } from "fs/promises";
import { mkdirSync, readFileSync } from "fs";
import { generateTileVariants } from "./tile-images";
import sharp from "sharp";

process.on("uncaughtException", (err) => {
	console.error("[server] Uncaught exception (server kept running):", err);
});
process.on("unhandledRejection", (reason) => {
	console.error("[server] Unhandled promise rejection (server kept running):", reason);
});

setDuelAuditCallback((action, targetId, details) => {
	auditLog(null, action, { targetType: "duel", targetId, details });
});

generateTileVariants().catch((err) => console.error("Tile variant generation failed:", err));
mkdirSync("./public/uploads", { recursive: true });

db.run("UPDATE duel_games SET status = 'abandoned' WHERE status = 'in_progress'");

setInterval(
	() => {
		db.run("DELETE FROM sessions WHERE expires_at < unixepoch()");
	},
	60 * 60 * 1000
);

setInterval(
	() => {
		db.run("DELETE FROM audit_log WHERE created_at < unixepoch() - 15552000");
		db.run("DELETE FROM fingerprints WHERE last_seen < unixepoch() - 7776000");
		db.run("DELETE FROM location_suggestions WHERE status != 'pending' AND reviewed_at < unixepoch() - 2592000");
		db.run(`DELETE FROM solo_scores WHERE id NOT IN (
		SELECT s2.id FROM solo_scores s2
		WHERE s2.user_id = solo_scores.user_id
		ORDER BY s2.created_at DESC LIMIT 200
	)`);
		db.run("DELETE FROM support_tickets WHERE status = 'closed' AND created_at < unixepoch() - 15552000");
		db.run("DELETE FROM duel_games WHERE status = 'waiting' AND created_at < unixepoch() - 600");
		const now = Date.now();
		for (const [k, v] of _ogCache) {
			if (now - v.ts > OG_TTL) _ogCache.delete(k);
		}
		const staleRoomMs = 10 * 60 * 1000;
		for (const [code, room] of duelRooms) {
			if (room.status === "waiting" && (room.players.length === 0 || Date.now() - room.createdAt > staleRoomMs)) {
				duelRooms.delete(code);
			}
		}
		cleanMatchmakingQueue();
	},
	6 * 60 * 60 * 1000
);

const _rateLimitMap = new Map<string, number[]>();
function checkRateLimit(key: string, max: number, windowMs: number): boolean {
	const now = Date.now();
	const hits = (_rateLimitMap.get(key) ?? []).filter((t) => now - t < windowMs);
	if (hits.length >= max) return false;
	hits.push(now);
	_rateLimitMap.set(key, hits);
	return true;
}
function checkRateLimitUser(user: User | null, key: string, max: number, windowMs: number): boolean {
	return checkRateLimit(key, user?.role ? max * 5 : max, windowMs);
}
setInterval(
	() => {
		const now = Date.now();
		for (const [k, v] of _rateLimitMap) {
			if (v.every((t) => now - t > 3_600_000)) _rateLimitMap.delete(k);
		}
	},
	10 * 60 * 1000
);

const _webhookEventsEnv = (process.env.WEBHOOK_EVENTS || "all").toLowerCase();
const _webhookAll = _webhookEventsEnv === "all";
const _webhookEnabled = new Set(_webhookEventsEnv.split(",").map((s) => s.trim()));

async function sendDiscordWebhook(content: string, category = "misc", adminPath = "/admin") {
	const url = process.env.DISCORD_WEBHOOK_URL;
	if (!url) return;
	if (!_webhookAll && !_webhookEnabled.has(category) && !_webhookEnabled.has("all")) return;
	const siteUrl = (process.env.SITE_URL || "").replace(/\/$/, "");
	const link = siteUrl ? `\n-# [View in Admin](${siteUrl}${adminPath})` : "";
	try {
		await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: content + link }),
		});
	} catch {}
}

async function validateImageBuffer(buffer: Buffer): Promise<{ width: number; height: number; format: string }> {
	const meta = await sharp(buffer).metadata();
	if (!meta.width || !meta.height || !meta.format) throw new Error("Not a valid image");
	if (meta.width < 64 || meta.height < 64) throw new Error("Image too small (min 64×64)");
	if (!["jpeg", "png", "webp", "gif"].includes(meta.format)) throw new Error("Unsupported image format");
	return { width: meta.width, height: meta.height, format: meta.format };
}

async function processUploadedImage(buffer: Buffer): Promise<{ data: Buffer; ext: string; mimeType: string }> {
	await validateImageBuffer(buffer);
	const data = await sharp(buffer)
		.resize(1920, 1080, { fit: "inside", withoutEnlargement: true })
		.webp({ quality: 85 })
		.toBuffer();
	return { data, ext: "webp", mimeType: "image/webp" };
}

const _ogCache = new Map<string, { data: Buffer; ts: number }>();
const OG_TTL = 5 * 60 * 1000;

function _getOgCached(key: string): Buffer | null {
	const hit = _ogCache.get(key);
	if (!hit) return null;
	if (Date.now() - hit.ts < OG_TTL) return hit.data;
	_ogCache.delete(key);
	return null;
}

function _escXml(s: string): string {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function _stripOgTags(html: string): string {
	return html
		.replace(/<meta\s+property="og:[^"]*"[^>]*\/?>/gi, "")
		.replace(/<meta\s+name="twitter:[^"]*"[^>]*\/?>/gi, "");
}

function _buildGenericOg(title: string, subtitle: string, accent = "#3b82f6"): string {
	return `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="gl" cx="12%" cy="25%" r="55%" gradientUnits="userSpaceOnUse" gradientTransform="translate(0,0)">
      <stop offset="0%" stop-color="#1e3a8a" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="#09090b" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="#09090b"/>
  <rect width="1200" height="630" fill="url(#gl)"/>
  <rect x="0" y="0" width="1200" height="630" fill="none" stroke="#27272a" stroke-width="2"/>
  <rect x="0" y="0" width="8" height="630" fill="${accent}"/>
  <text x="80" y="220" font-family="Arial,sans-serif" font-size="26" fill="#52525b" letter-spacing="3">DOVEDALE RAILWAY</text>
  <text x="80" y="330" font-family="Arial,sans-serif" font-size="80" font-weight="700" fill="white">${_escXml(title)}</text>
  <text x="80" y="410" font-family="Arial,sans-serif" font-size="28" fill="#71717a">${_escXml(subtitle)}</text>
  <rect x="80" y="510" width="60" height="4" fill="${accent}" rx="2"/>
  <text x="80" y="570" font-family="Arial,sans-serif" font-size="22" fill="#3f3f46">dovedalegeoguesser.com</text>
</svg>`;
}

function _buildProfileOg(
	displayName: string,
	username: string,
	memberSince: string,
	stats: { label: string; value: string }[],
	avatarDataUri: string
): string {
	const initials = (displayName || username).slice(0, 2).toUpperCase();
	const avatarEl = avatarDataUri
		? `<defs><clipPath id="av"><circle cx="190" cy="240" r="130"/></clipPath></defs>
       <circle cx="190" cy="240" r="138" fill="#27272a"/>
       <image href="${avatarDataUri}" x="60" y="110" width="260" height="260" clip-path="url(#av)" preserveAspectRatio="xMidYMid slice"/>`
		: `<circle cx="190" cy="240" r="138" fill="#27272a"/>
       <text x="190" y="260" font-family="Arial,sans-serif" font-size="110" font-weight="700" fill="#52525b" text-anchor="middle">${_escXml(initials)}</text>`;

	const statBoxes = stats
		.map((s, i) => {
			const col = i % 2;
			const row = Math.floor(i / 2);
			const bx = 480 + col * 330;
			const by = 80 + row * 170;
			return `<rect x="${bx}" y="${by}" width="300" height="145" fill="#18181b" rx="16"/>
      <text x="${bx + 150}" y="${by + 65}" font-family="Arial,sans-serif" font-size="48" font-weight="700" fill="white" text-anchor="middle">${_escXml(s.value)}</text>
      <text x="${bx + 150}" y="${by + 110}" font-family="Arial,sans-serif" font-size="22" fill="#71717a" text-anchor="middle">${_escXml(s.label)}</text>`;
		})
		.join("\n");

	return `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="gl" cx="35%" cy="50%" r="45%" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#1e3a8a" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#09090b" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="#09090b"/>
  <rect width="1200" height="630" fill="url(#gl)"/>
  <rect x="0" y="0" width="1200" height="630" fill="none" stroke="#27272a" stroke-width="2"/>
  <rect x="0" y="0" width="8" height="630" fill="#3b82f6"/>
  <line x1="440" y1="40" x2="440" y2="590" stroke="#27272a" stroke-width="1"/>
  ${avatarEl}
  <text x="60" y="430" font-family="Arial,sans-serif" font-size="50" font-weight="700" fill="white">${_escXml(displayName || username)}</text>
  <text x="60" y="480" font-family="Arial,sans-serif" font-size="26" fill="#52525b">@${_escXml(username)}</text>
  <text x="60" y="560" font-family="Arial,sans-serif" font-size="22" fill="#3f3f46">Member since ${_escXml(memberSince)}</text>
  ${statBoxes}
  <text x="1140" y="600" font-family="Arial,sans-serif" font-size="20" fill="#3f3f46" text-anchor="end">Dovedale GeoGuesser</text>
</svg>`;
}

function _buildDuelOg(
	code: string,
	hostName: string,
	rounds: number,
	playerCount: number,
	status: string,
	isSpectate: boolean
): string {
	const actionWord = isSpectate ? "Spectating" : "Duel Invite";
	const statusColor = status === "in_progress" ? "#22c55e" : "#3b82f6";
	const statusLabel = status === "in_progress" ? "In progress" : "Waiting for players";
	const playerDots = [0, 1]
		.map(
			(i) =>
				`<circle cx="${840 + i * 90}" cy="340" r="30" fill="${i < playerCount ? "#3b82f6" : "#27272a"}"/>
     <text x="${840 + i * 90}" y="348" font-family="Arial,sans-serif" font-size="24" fill="${i < playerCount ? "white" : "#3f3f46"}" text-anchor="middle">${i < playerCount ? (i === 0 ? "H" : "P") : "?"}</text>`
		)
		.join("\n");

	const safeHost = hostName.length > 22 ? hostName.slice(0, 21) + "…" : hostName;
	return `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="gl" cx="50%" cy="30%" r="55%" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#1e3a8a" stop-opacity="0.4"/>
      <stop offset="100%" stop-color="#09090b" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="#09090b"/>
  <rect width="1200" height="630" fill="url(#gl)"/>
  <rect x="0" y="0" width="1200" height="630" fill="none" stroke="#27272a" stroke-width="2"/>
  <rect x="0" y="0" width="8" height="630" fill="${statusColor}"/>
  <text x="80" y="120" font-family="Arial,sans-serif" font-size="26" fill="#52525b" letter-spacing="3">DOVEDALE RAILWAY</text>
  <text x="80" y="210" font-family="Arial,sans-serif" font-size="72" font-weight="700" fill="white">${_escXml(actionWord)}</text>
  <text x="80" y="285" font-family="Arial,sans-serif" font-size="38" fill="#71717a">Hosted by ${_escXml(safeHost)}</text>
  <rect x="80" y="330" width="200" height="56" fill="#18181b" rx="12"/>
  <text x="180" y="369" font-family="Arial,sans-serif" font-size="26" fill="white" text-anchor="middle">${rounds} rounds</text>
  <rect x="300" y="330" width="320" height="56" fill="#18181b" rx="12"/>
  <text x="460" y="369" font-family="Arial,sans-serif" font-size="26" fill="${statusColor}" text-anchor="middle">${_escXml(statusLabel)}</text>
  <text x="80" y="480" font-family="Arial,sans-serif" font-size="32" fill="#3f3f46">Room code</text>
  <text x="80" y="545" font-family="Arial,sans-serif" font-size="72" font-weight="700" fill="white" letter-spacing="12">${_escXml(code)}</text>
  <text x="1140" y="600" font-family="Arial,sans-serif" font-size="20" fill="#3f3f46" text-anchor="end">Dovedale GeoGuesser</text>
</svg>`;
}

function todayUTC(): string {
	return new Date().toISOString().slice(0, 10);
}

function getOrCreateDailyChallenge(): { location: Location; date: string } | null {
	const date = todayUTC();
	const existing = db
		.query<{ location_id: number }, [string]>("SELECT location_id FROM daily_challenges WHERE date = ?")
		.get(date);

	const locId =
		existing?.location_id ??
		(() => {
			const loc = db
				.query<{ id: number }, []>("SELECT id FROM locations WHERE is_active = 1 ORDER BY RANDOM() LIMIT 1")
				.get();
			if (!loc) return null;
			db.run("INSERT OR IGNORE INTO daily_challenges (date, location_id) VALUES (?, ?)", [date, loc.id]);
			return loc.id;
		})();

	if (!locId) return null;
	const location = db.query<Location, [number]>("SELECT * FROM locations WHERE id = ?").get(locId);
	return location ? { location, date } : null;
}

function updateStreak(userId: number) {
	const user = db
		.query<{ current_streak: number; longest_streak: number; last_played_date: string | null }, [number]>(
			"SELECT current_streak, longest_streak, last_played_date FROM users WHERE id = ?"
		)
		.get(userId);
	if (!user) return;

	const today = todayUTC();
	if (user.last_played_date === today) return;

	const yesterday = new Date();
	yesterday.setUTCDate(yesterday.getUTCDate() - 1);
	const yStr = yesterday.toISOString().slice(0, 10);

	const newStreak = user.last_played_date === yStr ? (user.current_streak || 0) + 1 : 1;
	const newLongest = Math.max(newStreak, user.longest_streak || 0);
	db.run("UPDATE users SET current_streak = ?, longest_streak = ?, last_played_date = ? WHERE id = ?", [
		newStreak,
		newLongest,
		today,
		userId,
	]);
}

const { upgradeWebSocket, websocket } = createBunWebSocket();

const _wireClientBuild = await Bun.build({
	entrypoints: ["./node_modules/@webwirejs/client/src/index.js"],
	bundle: true,
	format: "esm",
	target: "browser",
	minify: true,
});
const wireClientJs = _wireClientBuild.success ? await _wireClientBuild.outputs[0].text() : "";
if (!_wireClientBuild.success) console.error("Failed to bundle WebWire client:", _wireClientBuild.logs);

const app = new Hono();
const PORT = process.env.PORT || 4000;
const LABEL_MIN_LENGTH = 5;
const LABEL_MAX_LENGTH = 128;

app.use("*", async (c, next) => {
	await next();
	c.res.headers.set("X-Content-Type-Options", "nosniff");
	c.res.headers.set("X-Frame-Options", "DENY");
	c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
});

app.get("/og.png", async (c) => {
	const type = c.req.query("type") || "home";
	const username = (c.req.query("u") || "").slice(0, 40);
	const roomCode = (c.req.query("code") || "").toUpperCase().slice(0, 6);
	const cacheKey = `${type}:${username}:${roomCode}`;
	const cached = _getOgCached(cacheKey);
	if (cached) {
		return new Response(cached, {
			headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=300" },
		});
	}

	let svg: string;

	if (type === "profile" && username) {
		const user = db.query<User, [string]>("SELECT * FROM users WHERE username = ?").get(username);
		if (!user || user.is_banned || user.profile_private || (user.discord_id === "0" && !DEV_MODE)) {
			svg = _buildGenericOg("Dovedale GeoGuesser", "Identify locations across Dovedale Railway");
		} else {
			const solo = db
				.query<{ total_games: number; best_score: number | null }, [number]>(
					"SELECT COUNT(*) AS total_games, MAX(total_score) AS best_score FROM solo_scores WHERE user_id = ?"
				)
				.get(user.id);
			const duels = db
				.query<{ wins: number; games: number }, [number]>(
					"SELECT COUNT(*) AS games, SUM(CASE WHEN dg.winner_id = dp.user_id THEN 1 ELSE 0 END) AS wins FROM duel_participants dp JOIN duel_games dg ON dg.id = dp.game_id WHERE dp.user_id = ? AND dg.status = 'finished'"
				)
				.get(user.id);
			const streak = db
				.query<{ current_streak: number }, [number]>("SELECT current_streak FROM users WHERE id = ?")
				.get(user.id);

			const stats = [
				{ label: "Solo Games", value: String(solo?.total_games ?? 0) },
				{ label: "Best Score", value: solo?.best_score != null ? solo.best_score.toLocaleString() : "-" },
				{ label: "Duel Wins", value: String(duels?.wins != null ? duels.wins : 0) },
				{ label: "Day Streak", value: String(streak?.current_streak ?? 0) },
			];

			let avatarDataUri = "";
			if (user.avatar_url) {
				try {
					const res = await fetch(user.avatar_url, { signal: AbortSignal.timeout(3000) });
					if (res.ok) {
						const buf = Buffer.from(await res.arrayBuffer());
						const mime = res.headers.get("content-type") || "image/jpeg";
						avatarDataUri = `data:${mime};base64,${buf.toString("base64")}`;
					}
				} catch {}
			}

			const joined = new Date((user as unknown as { created_at: number }).created_at * 1000).toLocaleDateString(
				"en-GB",
				{ year: "numeric", month: "long" }
			);

			svg = _buildProfileOg(user.display_name || user.username, user.username, joined, stats, avatarDataUri);
		}
	} else if ((type === "duel" || type === "spectate") && roomCode) {
		const room = duelRooms.get(roomCode);
		const hostName = room?.players[0]?.username ?? "Unknown";
		const rounds = room?.rounds ?? 5;
		const playerCount = room?.players.length ?? 0;
		const status = room?.status ?? "waiting";
		svg = _buildDuelOg(roomCode, hostName, rounds, playerCount, status, type === "spectate");
	} else {
		const pageCards: Record<string, [string, string]> = {
			home: ["Dovedale GeoGuesser", "Identify locations across Dovedale Railway"],
			game: ["Solo GeoGuesser", "5 rounds, 90 seconds each - how well do you know the line?"],
			duels: ["Duels", "Challenge a friend to a location guessing duel"],
			daily: ["Daily Challenge", "One location per day - compete for the leaderboard"],
			leaderboard: ["Leaderboard", "The best GeoGuessers on Dovedale Railway"],
		};
		const [title, sub] = pageCards[type] ?? pageCards.home;
		svg = _buildGenericOg(title, sub);
	}

	const png = await sharp(Buffer.from(svg)).png().toBuffer();
	_ogCache.set(cacheKey, { data: png, ts: Date.now() });
	return new Response(png, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=300" } });
});

const _indexHtml = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
const _profileHtml = readFileSync(new URL("./public/profile.html", import.meta.url), "utf8");
const _duelsHtml = readFileSync(new URL("./public/duels.html", import.meta.url), "utf8");

app.get("/", (c) => {
	const siteUrl = (process.env.SITE_URL || "").replace(/\/$/, "");
	const html = _indexHtml.replace(/__OG_IMAGE__/g, _escXml(siteUrl + `/og.png?type=home&v=${_ogVersion}`));
	const r = c.html(html);
	r.headers.set("Cache-Control", "public, max-age=900");
	return r;
});

app.get("/duel/:code", (c) => {
	const code = c.req.param("code").toUpperCase();
	const mode = c.req.query("spectate") !== undefined ? "spectate" : "join";
	const room = duelRooms.get(code);
	const siteUrl = (process.env.SITE_URL || "").replace(/\/$/, "");
	let title: string, description: string, ogType: string;
	if (room) {
		const hostName = room.players[0]?.username ?? "Someone";
		const rounds = room.rounds ?? 5;
		const playerCount = room.players.length;
		const statusLabel = room.status === "in_progress" ? "in progress" : "waiting for players";
		title =
			mode === "spectate"
				? `Spectate ${hostName}'s duel | Dovedale GeoGuesser`
				: `Join ${hostName}'s duel | Dovedale GeoGuesser`;
		description =
			mode === "spectate"
				? `Watch a ${rounds}-round duel ${statusLabel} on the Dovedale Railway.`
				: `${hostName} is hosting a ${rounds}-round duel. ${playerCount}/2 players - ${statusLabel}.`;
		ogType = mode === "spectate" ? "spectate" : "duel";
	} else {
		title = "Duel Room | Dovedale GeoGuesser";
		description = "Join a location guessing duel on the Dovedale Railway.";
		ogType = "duel";
	}
	const ogImage = `${siteUrl}/og.png?type=${ogType}&code=${encodeURIComponent(code)}&v=${_ogVersion}`;
	const ogTags = `<meta property="og:title" content="${_escXml(title)}"/>
<meta property="og:description" content="${_escXml(description)}"/>
<meta property="og:image" content="${_escXml(ogImage)}"/>
<meta property="og:image:width" content="1200"/>
<meta property="og:image:height" content="630"/>
<meta property="og:type" content="website"/>
<meta property="og:url" content="${_escXml(siteUrl + "/duel/" + code)}"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${_escXml(title)}"/>
<meta name="twitter:description" content="${_escXml(description)}"/>
<meta name="twitter:image" content="${_escXml(ogImage)}"/>`;
	const html = _stripOgTags(_duelsHtml)
		.replace(/<title>[^<]*<\/title>/, `<title>${_escXml(title)}</title>`)
		.replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${_escXml(description)}"/>`)
		.replace("</head>", ogTags + "</head>");
	const r = c.html(html);
	r.headers.set("Cache-Control", "public, max-age=900");
	return r;
});

app.get("/u/:username", (c) => {
	const username = c.req.param("username");
	const user = db.query<User, [string]>("SELECT * FROM users WHERE username = ?").get(username);
	const siteUrl = (process.env.SITE_URL || "").replace(/\/$/, "");
	const visible = user && !user.is_banned && !user.profile_private && !(user.discord_id === "0" && !DEV_MODE);
	const displayName = visible ? user!.display_name || user!.username : "Dovedale GeoGuesser";
	const title = visible ? `${displayName} | Dovedale GeoGuesser` : "Dovedale GeoGuesser";
	const description = visible
		? `View ${displayName}'s GeoGuesser profile and stats.`
		: "Identify locations across the Dovedale Railway from screenshots.";
	const ogImage = `${siteUrl}/og.png?type=${visible ? `profile&u=${encodeURIComponent(username)}` : "home"}&v=${_ogVersion}`;
	const ogTags = `<meta property="og:title" content="${_escXml(title)}"/>
<meta property="og:description" content="${_escXml(description)}"/>
<meta property="og:image" content="${_escXml(ogImage)}"/>
<meta property="og:image:width" content="1200"/>
<meta property="og:image:height" content="630"/>
<meta property="og:type" content="profile"/>
<meta property="og:url" content="${_escXml(siteUrl + "/u/" + encodeURIComponent(username))}"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${_escXml(title)}"/>
<meta name="twitter:description" content="${_escXml(description)}"/>
<meta name="twitter:image" content="${_escXml(ogImage)}"/>`;
	const html = _stripOgTags(_profileHtml)
		.replace(/<title>[^<]*<\/title>/, `<title>${_escXml(title)}</title>`)
		.replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${_escXml(description)}"/>`)
		.replace("</head>", ogTags + "</head>");
	const r = c.html(html);
	r.headers.set("Cache-Control", "public, max-age=900");
	return r;
});

const wireServer = new WebWireServer({
	authenticate: async ({ request }: { request: Request }) => {
		const cookieHeader = request.headers.get("Cookie") || "";
		const sessionMatch = cookieHeader
			.split(";")
			.map((s) => s.trim())
			.find((s) => s.startsWith("session="));
		const sessionId = sessionMatch ? decodeURIComponent(sessionMatch.slice("session=".length)) : null;
		if (!sessionId) throw new Error("Not authenticated");
		const session = db
			.query<{ user_id: number; expires_at: number }, [string]>(
				"SELECT user_id, expires_at FROM sessions WHERE id = ?"
			)
			.get(sessionId);
		if (!session || session.expires_at <= Math.floor(Date.now() / 1000)) throw new Error("Session expired");
		return { userId: session.user_id };
	},
});

function buildRoomState(room: DuelRoom, extra: Record<string, unknown> = {}) {
	return {
		code: room.code,
		status: room.status,
		players: room.players.map((pl) => ({
			user_id: pl.userId,
			username: pl.username,
			display_name: pl.displayName,
			avatar_url: pl.avatarUrl,
			is_host: pl.userId === room.players[0]?.userId,
			is_ready: pl.userId === room.players[0]?.userId || room.readyPlayers.has(pl.userId),
		})),
		...extra,
	};
}

function broadcastToSpectators(room: DuelRoom, event: string, data: unknown) {
	for (const spec of room.spectators) {
		try { spec.emit(event, data); } catch {}
	}
}

function safeHandler<T>(name: string, fn: (data: T) => void): (data: T) => void {
	return (data) => {
		try {
			fn(data);
		} catch (err) {
			console.error(`[ws] Error in "${name}" handler:`, err);
		}
	};
}

wireServer.on("connection", (conn) => {
	const userId = (conn.auth as { userId: number }).userId;

	conn.on(
		"join",
		safeHandler("join", (data: { room: string }) => {
			const roomCode = (data?.room || "").toUpperCase();
			const room = duelRooms.get(roomCode);

			if (!room) {
				conn.emit("error", { message: "Room not found" });
				conn.close(1008, "Room not found");
				return;
			}
			if (room.status === "finished") {
				conn.emit("error", { message: "Game already finished" });
				conn.close(1008, "Game already finished");
				return;
			}
			if (room.quickplay) {
				conn.emit("error", { message: "Quickplay rooms cannot be joined directly. Use Quick Play." });
				conn.close(1008, "Quickplay room");
				return;
			}

			const participant = db
				.query<{ id: number }, [number, number]>(
					"SELECT id FROM duel_participants WHERE game_id = ? AND user_id = ?"
				)
				.get(room.dbId, userId);
			if (!participant) {
				conn.emit("error", { message: "You haven't joined this room" });
				conn.close(1008, "Not a participant");
				return;
			}

			const user = db
				.query<
					{ id: number; username: string; display_name: string | null; avatar_url: string | null },
					[number]
				>("SELECT id, username, display_name, avatar_url FROM users WHERE id = ?")
				.get(userId);
			if (!user) {
				conn.close();
				return;
			}

			quickplayMatchedPlayers.delete(userId);

			const existing = room.players.find((p) => p.userId === userId);
			if (existing) {
				existing.conn = conn;
			} else {
				if (room.players.length >= 2) {
					conn.emit("error", { message: "Room is full" });
					conn.close(1008, "Room full");
					return;
				}
				room.players.push({
					userId: user.id,
					username: user.username,
					displayName: user.display_name || user.username,
					avatarUrl: user.avatar_url || "",
					conn,
					totalScore: 0,
				});
			}

			const roomState = buildRoomState(room);
			for (const p of room.players) {
				try {
					p.conn.emit("room_state", roomState);
				} catch {}
			}

			if (room.quickplay && room.status === "waiting" && room.players.length === 2 && !room._autoStartScheduled) {
				room._autoStartScheduled = true;
				setTimeout(() => {
					room._autoStartScheduled = false;
					if (room.status === "waiting" && room.players.length === 2) startDuel(room);
				}, 1000);
			}

			if (room.status === "in_progress" && room.currentRound > 0) {
				const loc = room.locations[room.currentRound - 1];
				try {
					conn.emit("round_start", {
						round: room.currentRound,
						total_rounds: room.rounds,
						image_url: `/uploads/${loc.image_path}`,
						location_id: loc.id,
						time_limit: 60,
					});
				} catch {}
			}
		})
	);

	conn.on(
		"start",
		safeHandler("start", () => {
			for (const room of duelRooms.values()) {
				if (room.players[0]?.userId === userId && room.players[0]?.conn === conn) {
					if (room.status !== "waiting" || room.players.length < 2) return;
					if (!room.quickplay) {
						const joiner = room.players[1];
						if (joiner && !room.readyPlayers.has(joiner.userId)) {
							conn.emit("error", { message: "Waiting for your opponent to ready up" });
							return;
						}
					}
					startDuel(room);
					return;
				}
			}
		})
	);

	conn.on(
		"ready",
		safeHandler("ready", () => {
			for (const room of duelRooms.values()) {
				if (room.players.some((p) => p.userId === userId && p.conn === conn)) {
					if (room.status !== "waiting") return;
					room.readyPlayers.add(userId);
					const state = buildRoomState(room);
					for (const p of room.players) {
						try {
							p.conn.emit("room_state", state);
						} catch {}
					}
					broadcastToSpectators(room, "room_state", state);
					return;
				}
			}
		})
	);

	conn.on(
		"leave",
		safeHandler("leave", () => {
			for (const room of duelRooms.values()) {
				const idx = room.players.findIndex((p) => p.userId === userId && p.conn === conn);
				if (idx === -1) continue;
				if (room.status === "in_progress") {
					abandonDuel(room, userId);
				} else if (room.status === "waiting") {
					if (room._countdownTimer) {
						clearTimeout(room._countdownTimer);
						room._countdownTimer = null;
						room._countdownScheduled = false;
						for (const p of room.players) {
							try {
								p.conn.emit("countdown_cancelled", {});
							} catch {}
						}
					}
					room.readyPlayers.delete(userId);
					room.players.splice(idx, 1);
					if (room.players.length === 0) {
						duelRooms.delete(room.code);
					} else {
						const state = buildRoomState(room);
						for (const p of room.players) {
							try {
								p.conn.emit("room_state", state);
							} catch {}
						}
					}
				}
				return;
			}
		})
	);

	conn.on(
		"guess",
		safeHandler("guess", (data: { world_x?: number; world_y?: number }) => {
			for (const room of duelRooms.values()) {
				if (room.players.some((p) => p.userId === userId && p.conn === conn)) {
					if (room.status !== "in_progress") return;
					submitDuelGuess(
						room,
						userId,
						typeof data?.world_x === "number" ? data.world_x : 0,
						typeof data?.world_y === "number" ? data.world_y : 0
					);
					return;
				}
			}
		})
	);

	conn.on(
		"spectate",
		safeHandler("spectate", (data: { room: string }) => {
			const roomCode = (data?.room || "").toUpperCase();
			const room = duelRooms.get(roomCode);
			if (!room || room.status === "finished") {
				conn.emit("error", { message: "Room not found or already finished" });
				return;
			}
			if ((room.spectators?.length ?? 0) >= 50) {
				conn.emit("error", { message: "Spectator limit reached (50)" });
				conn.close(1008, "Spectator limit");
				return;
			}
			room.spectators.push(conn);
			conn.emit("room_state", buildRoomState(room, { spectating: true }));
			if (room.status === "in_progress" && room.currentRound > 0) {
				const loc = room.locations[room.currentRound - 1];
				try {
					conn.emit("round_start", {
						round: room.currentRound,
						total_rounds: room.rounds,
						image_url: `/uploads/${loc.image_path}`,
						location_id: loc.id,
						time_limit: 60,
					});
				} catch {}
			}
			conn.on("disconnect", () => {
				room.spectators = room.spectators.filter((s) => s !== conn);
			});
		})
	);

	conn.on(
		"disconnect",
		safeHandler("disconnect", () => {
			for (const room of duelRooms.values()) {
				const idx = room.players.findIndex((p) => p.userId === userId && p.conn === conn);
				if (idx === -1) continue;
				if (room.status === "in_progress") {
					abandonDuel(room, userId);
					break;
				}
				if (room.status === "finished") {
					if (room.playAgainRequests.size > 0) {
						if (room._playAgainTimer) { clearTimeout(room._playAgainTimer); room._playAgainTimer = null; }
						const requester = room.players.find((p) => room.playAgainRequests.has(p.userId) && p.conn !== conn);
						if (requester) try { requester.conn.emit("play_again_declined", {}); } catch {}
						room.playAgainRequests.clear();
					}
					break;
				}
				if (room.status !== "waiting") continue;
				if (room._countdownTimer) {
					clearTimeout(room._countdownTimer);
					room._countdownTimer = null;
					room._countdownScheduled = false;
					for (const p of room.players) {
						try {
							p.conn.emit("countdown_cancelled", {});
						} catch {}
					}
				}
				setTimeout(() => {
					const r = duelRooms.get(room.code);
					if (!r) return;
					const i = r.players.findIndex((p) => p.userId === userId && p.conn === conn);
					if (i !== -1) {
						r.readyPlayers.delete(userId);
						r.players.splice(i, 1);
						if (r.players.length === 0) duelRooms.delete(room.code);
						else {
							const state = buildRoomState(r);
							for (const p of r.players) {
								try {
									p.conn.emit("room_state", state);
								} catch {}
							}
						}
					}
				}, 30_000);
				break;
			}
		})
	);

	conn.on(
		"play_again",
		safeHandler("play_again", () => {
			const room = [...duelRooms.values()].find((r) =>
				r.players.some((p) => p.userId === userId && p.conn === conn)
			);
			if (!room || room.status !== "finished") return;

			room.playAgainRequests.add(userId);

			if (room.playAgainRequests.size >= 2) {
				if (room._playAgainTimer) {
					clearTimeout(room._playAgainTimer);
					room._playAgainTimer = null;
				}
				const [p0, p1] = room.players;
				const newRoom = createDuelRoom(p0.userId, room.rounds);
				joinDuelRoom(newRoom.code, p1.userId);
				if (room.quickplay) {
					db.run("UPDATE duel_games SET quickplay = 1 WHERE id = ?", [newRoom.dbId]);
					const nr = duelRooms.get(newRoom.code);
					if (nr) nr.quickplay = true;
				}
				p0.conn.emit("play_again_match", { code: newRoom.code, is_host: true });
				p1.conn.emit("play_again_match", { code: newRoom.code, is_host: false });
				broadcastToSpectators(room, "play_again_available", { code: newRoom.code });
			} else {
				const other = room.players.find((p) => p.userId !== userId);
				conn.emit("play_again_waiting", {});
				if (other) other.conn.emit("play_again_incoming", {});
				room._playAgainTimer = setTimeout(() => {
					room._playAgainTimer = null;
					conn.emit("play_again_expired", {});
				}, 30_000);
			}
		})
	);

	conn.on(
		"play_again_decline",
		safeHandler("play_again_decline", () => {
			const room = [...duelRooms.values()].find((r) =>
				r.players.some((p) => p.userId === userId && p.conn === conn)
			);
			if (!room) return;
			if (room._playAgainTimer) {
				clearTimeout(room._playAgainTimer);
				room._playAgainTimer = null;
			}
			const requester = room.players.find((p) => room.playAgainRequests.has(p.userId));
			if (requester) requester.conn.emit("play_again_declined", {});
			room.playAgainRequests.clear();
		})
	);
});

app.get("/sitemap.xml", (c) => {
	const siteUrl = (process.env.SITE_URL || "").replace(/\/$/, "");
	const staticPages = [
		{ loc: "/", priority: "1.0", changefreq: "weekly" },
		{ loc: "/leaderboard", priority: "0.8", changefreq: "daily" },
		{ loc: "/tos", priority: "0.3", changefreq: "monthly" },
		{ loc: "/privacy", priority: "0.3", changefreq: "monthly" },
		{ loc: "/guidelines", priority: "0.4", changefreq: "monthly" },
		{ loc: "/fairplay", priority: "0.3", changefreq: "monthly" },
	];
	const publicProfiles = db
		.query<{ username: string }, []>(
			"SELECT username FROM users WHERE profile_private = 0 AND username != '[deleted]' ORDER BY id DESC LIMIT 500"
		)
		.all();

	const urls = [
		...staticPages.map(
			(p) =>
				`  <url><loc>${siteUrl}${p.loc}</loc><changefreq>${p.changefreq}</changefreq><priority>${p.priority}</priority></url>`
		),
		...publicProfiles.map(
			(u) =>
				`  <url><loc>${siteUrl}/u/${encodeURIComponent(u.username)}</loc><changefreq>weekly</changefreq><priority>0.5</priority></url>`
		),
	].join("\n");

	return c.body(
		`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`,
		200,
		{ "Content-Type": "application/xml; charset=utf-8" }
	);
});

const _htmlPages: Record<string, string> = Object.fromEntries(
	(
		[
			["/play", "geoguesser.html"],
			["/daily", "daily.html"],
			["/duels", "duels.html"],
			["/leaderboard", "leaderboard.html"],
			["/settings", "settings.html"],
			["/submit", "submit.html"],
			["/admin", "admin.html"],
			["/tos", "tos.html"],
			["/privacy", "privacy.html"],
			["/guidelines", "guidelines.html"],
			["/fairplay", "fairplay.html"],
		] as [string, string][]
	).map(([route, file]) => [route, readFileSync(new URL(`./public/${file}`, import.meta.url), "utf8")])
);

const _staticSiteUrl = (process.env.SITE_URL || "").replace(/\/$/, "");
const _ogVersion = 2;
const _htmlPagesFixed = Object.fromEntries(
	Object.entries(_htmlPages).map(([route, html]) => [
		route,
		html.replace(/content="(\/og\.png[^"]*)"/g, (_, path) => `content="${_staticSiteUrl}${path}&v=${_ogVersion}"`),
	])
);

for (const [route, html] of Object.entries(_htmlPagesFixed)) {
	app.get(route, (c) => {
		const r = c.html(html);
		r.headers.set("Cache-Control", "public, max-age=900");
		return r;
	});
}

const staticMiddleware = serveStatic({ root: "./public" });
const cachedStaticMiddleware = serveStatic({
	root: "./public",
	onFound: (_path, c) => {
		c.res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
	},
});

app.use("*", (c, next) => {
	if (c.req.path.startsWith("/api/")) return next();
	const path = c.req.path;
	if (path.endsWith(".png") || path.endsWith(".webp") || path.endsWith(".svg") || path.endsWith(".ico")) {
		return cachedStaticMiddleware(c, next);
	}
	return staticMiddleware(c, next);
});

const DEV_MODE = process.env.AUTH_DEV === "true";
if (DEV_MODE) {
	console.warn("[!] DEV_MODE=true - OAuth bypassed, using fake dev account");
} else {
	const devUser = db.query<{ id: number }, []>("SELECT id FROM users WHERE discord_id = '0'").get();
	if (devUser) {
		db.run("DELETE FROM sessions WHERE user_id = ?", [devUser.id]);
	}
}

app.get("/api/status", (c) => c.text("200 OK"));

app.post("/api/fp", async (c) => {
	const user = getUserFromContext(c);
	if (!user) return c.body(null, 204);
	if (!checkRateLimit(`fp:${user.id}`, 5, 60 * 1000)) return c.body(null, 204);

	let hash: string;
	try {
		const body = (await c.req.json()) as { h?: unknown };
		if (typeof body.h !== "string" || !/^[0-9a-f]{32}$/.test(body.h)) return c.body(null, 204);
		hash = body.h;
	} catch {
		return c.body(null, 204);
	}

	db.run(
		`
		INSERT INTO fingerprints (fp_hash, user_id) VALUES (?, ?)
		ON CONFLICT(fp_hash, user_id) DO UPDATE SET last_seen = unixepoch()
	`,
		[hash, user.id]
	);

	const bannedMatch = db
		.query<{ user_id: number; ban_type: string | null; ban_expires_at: number | null }, [string, number]>(
			`
		SELECT u.id as user_id, u.ban_type, u.ban_expires_at
		FROM fingerprints f
		JOIN users u ON u.id = f.user_id
		WHERE f.fp_hash = ? AND u.id != ? AND u.is_banned = 1
		LIMIT 1
	`
		)
		.get(hash, user.id);

	if (bannedMatch) {
		const now = Math.floor(Date.now() / 1000);
		const stillBanned =
			bannedMatch.ban_type === "perm" ||
			(bannedMatch.ban_type === "temp" && !!bannedMatch.ban_expires_at && bannedMatch.ban_expires_at > now);

		if (stillBanned && !user.is_banned) {
			db.run("UPDATE users SET is_banned = 1, ban_type = ?, ban_expires_at = ? WHERE id = ?", [
				bannedMatch.ban_type,
				bannedMatch.ban_expires_at,
				user.id,
			]);
		}
	}

	return c.body(null, 204);
});

app.get("/api/auth/login", (c) => {
	const ip = c.req.header("x-forwarded-for") ?? c.req.header("cf-connecting-ip") ?? "unknown";
	if (!checkRateLimit(`login:${ip}`, 10, 15 * 60 * 1000))
		return c.text("Too many login attempts. Try again later.", 429);
	const redirect = c.req.query("redirect") || "/";

	if (DEV_MODE) {
		const { id: devUserId } = upsertUser({
			discord_id: "0",
			username: "DevUser",
			display_name: "Dev User",
			avatar_url: "",
			role: "operator",
		});
		const sessionId = createSession(devUserId);
		const res = c.redirect(redirect.startsWith("/") ? redirect : "/");
		res.headers.append("Set-Cookie", sessionCookieHeader(sessionId));
		return res;
	}

	try {
		const url = generateAuthUrl();
		c.res.headers.set(
			"Set-Cookie",
			`oauth_redirect=${encodeURIComponent(redirect)}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax`
		);
		return c.redirect(url);
	} catch {
		return c.text("Discord OAuth is not configured on this server.", 503);
	}
});

app.get("/api/auth/callback", async (c) => {
	if (DEV_MODE) return c.redirect("/");

	const code = c.req.query("code");
	const state = c.req.query("state");
	const error = c.req.query("error");

	if (error) return c.text(`OAuth error: ${error}`, 400);
	if (!code || !state) return c.text("Missing code or state", 400);
	if (!validateState(state)) return c.text("Invalid or expired state", 400);

	try {
		const userInfo = await exchangeCode(code);
		const { id: userId, isNew } = upsertUser(userInfo);
		const sessionId = createSession(userId);
		if (isNew) {
			sendDiscordWebhook(
				`👤 **New user registered**: **${userInfo.display_name || userInfo.username}** (@${userInfo.username})`,
				"users",
				"/admin#users"
			);
			auditLog(null, "user_register", {
				targetType: "user",
				targetId: userId,
				targetUsername: userInfo.username,
			});
		} else {
			auditLog(null, "user_login", {
				targetType: "user",
				targetId: userId,
				targetUsername: userInfo.username,
			});
		}

		const cookieHeader = c.req.header("Cookie") || "";
		const redirectMatch = cookieHeader
			.split(";")
			.map((s) => s.trim())
			.find((s) => s.startsWith("oauth_redirect="));
		const redirect = redirectMatch ? decodeURIComponent(redirectMatch.slice("oauth_redirect=".length)) : "/";
		const res = c.redirect(redirect.startsWith("/") ? redirect : "/");
		res.headers.append("Set-Cookie", sessionCookieHeader(sessionId));
		res.headers.append("Set-Cookie", "oauth_redirect=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax");
		return res;
	} catch (err) {
		console.error("OAuth callback error:", err);
		return c.text("Authentication failed. Please try again.", 500);
	}
});

const _pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
app.get("/api/meta", (c) => c.json({ repo: _pkg.repository ?? null }));

app.get("/api/auth/me", (c) => {
	const user = getUserFromContext(c);
	if (!user) return c.json(null, 401);
	const banned = isBanned(user);
	return c.json({
		id: user.id,
		discord_id: user.discord_id,
		username: user.username,
		display_name: user.display_name,
		avatar_url: user.avatar_url,
		role: user.role,
		is_banned: banned,
		ban_type: banned ? (user.ban_type ?? null) : null,
		ban_expires_at: banned ? (user.ban_expires_at ?? null) : null,
		upload_limited: !!user.upload_limited,
		duel_limited: !!user.duel_limited,
		profile_private: !!user.profile_private,
	});
});

app.get("/api/auth/logout", (c) => {
	const cookie = c.req.header("Cookie") || "";
	const match = cookie
		.split(";")
		.map((s) => s.trim())
		.find((s) => s.startsWith("session="));
	if (match) deleteSession(decodeURIComponent(match.slice("session=".length)));
	clearSessionCookie(c);
	return c.redirect("/");
});

app.get("/api/locations/random", (c) => {
	if (!getUserFromContext(c)) return c.json({ error: "Login required" }, 401);
	const count = Math.min(20, Math.max(1, parseInt(c.req.query("count") || "5")));
	const locations = getRandomLocations(count);
	return c.json(
		locations.map((l) => ({
			id: l.id,
			image_path: l.image_path,
			world_x: l.world_x,
			world_y: l.world_y,
			label: l.label,
			hints: JSON.parse(l.hints || "[]"),
		}))
	);
});

app.post("/api/solo/score", async (c) => {
	const user = getUserFromContext(c);
	if (!user || isBanned(user)) return c.json({ success: false }, 401);
	if (!checkRateLimit(`score:${user.id}`, 20, 60_000)) return c.json({ success: false }, 429);
	const body = (await c.req.json().catch(() => ({}))) as {
		total_score?: number;
		rounds?: number;
		max_possible?: number;
		time_limit?: number;
	};
	const maxRounds = typeof body.rounds === "number" ? Math.min(body.rounds, 20) : 5;
	const scoreMax = maxRounds * 5000;
	if (typeof body.total_score !== "number" || body.total_score < 0 || body.total_score > scoreMax)
		return c.json({ success: false }, 400);
	const timeLimit =
		typeof body.time_limit === "number" && ALLOWED_TIME_LIMITS.has(body.time_limit) ? body.time_limit : 90;
	db.run("INSERT INTO solo_scores (user_id, total_score, rounds, max_possible, time_limit) VALUES (?, ?, ?, ?, ?)", [
		user.id,
		Math.floor(body.total_score),
		body.rounds ?? 5,
		body.max_possible ?? 25000,
		timeLimit,
	]);
	updateStreak(user.id);
	const updated = db
		.query<{ current_streak: number; longest_streak: number }, [number]>(
			"SELECT current_streak, longest_streak FROM users WHERE id = ?"
		)
		.get(user.id);
	return c.json({
		success: true,
		current_streak: updated?.current_streak ?? 0,
		longest_streak: updated?.longest_streak ?? 0,
	});
});

app.get("/api/leaderboard/solo", (c) => {
	const limit = Math.min(100, parseInt(c.req.query("limit") || "50"));
	const sort = c.req.query("sort") === "avg" ? "avg" : "total";
	const roundsFilter = parseInt(c.req.query("rounds") || "0") || null;
	const timeLimitParam = c.req.query("time_limit");
	const timeLimitFilter =
		timeLimitParam !== undefined && timeLimitParam !== "" && !isNaN(parseInt(timeLimitParam))
			? parseInt(timeLimitParam)
			: null;
	const roundsWhere = roundsFilter ? "AND ss.rounds = ?" : "";
	const timeWhere = timeLimitFilter !== null ? "AND ss.time_limit = ?" : "";
	const roundsWhereInner = roundsFilter ? "AND s2.rounds = ?" : "";
	const timeWhereInner = timeLimitFilter !== null ? "AND s2.time_limit = ?" : "";
	const filterParams: number[] = [];
	if (roundsFilter !== null) filterParams.push(roundsFilter);
	if (timeLimitFilter !== null) filterParams.push(timeLimitFilter);
	const rows = db
		.query(
			`
		SELECT u.id as user_id, u.username, u.display_name, u.avatar_url,
			ss.total_score, ss.rounds, ss.max_possible, ss.time_limit,
			ROUND(CAST(ss.total_score AS REAL) / ss.rounds) as avg_per_round
		FROM solo_scores ss
		JOIN users u ON u.id = ss.user_id
		WHERE u.is_banned = 0
		${roundsWhere}
		${timeWhere}
		AND ss.id = (
			SELECT id FROM solo_scores s2
			WHERE s2.user_id = ss.user_id ${roundsWhereInner} ${timeWhereInner}
			ORDER BY ${sort === "avg" ? "CAST(s2.total_score AS REAL) / s2.rounds" : "s2.total_score"} DESC
			LIMIT 1
		)
		ORDER BY ${sort === "avg" ? "avg_per_round" : "total_score"} DESC
		LIMIT ?
	`
		)
		.all(...filterParams, ...filterParams, limit);
	return c.json(rows);
});

app.get("/api/leaderboard/duels", (c) => {
	const limit = Math.min(100, parseInt(c.req.query("limit") || "50"));
	const sort = c.req.query("sort");
	const mode = c.req.query("mode");
	const modeFilter = mode === "quickplay" ? "AND dg.quickplay = 1" : mode === "room" ? "AND dg.quickplay = 0" : "";
	const orderBy =
		sort === "score"
			? "total_score DESC, wins DESC"
			: sort === "avg"
				? "avg_per_round DESC, wins DESC"
				: "wins DESC, total_score DESC";
	const rows = db
		.query(
			`
		SELECT u.id as user_id, u.username, u.display_name, u.avatar_url,
			SUM(dp.total_score) as total_score,
			COUNT(DISTINCT dp.game_id) as games_played,
			SUM(CASE WHEN dg.winner_id = u.id THEN 1 ELSE 0 END) as wins,
			SUM(CASE WHEN dg.quickplay = 1 THEN 1 ELSE 0 END) as quickplay_games,
			SUM(CASE WHEN dg.quickplay = 0 THEN 1 ELSE 0 END) as room_games,
			CAST(SUM(dp.total_score) AS REAL) / NULLIF(SUM(dg.rounds), 0) as avg_per_round
		FROM duel_participants dp
		JOIN users u ON u.id = dp.user_id
		JOIN duel_games dg ON dg.id = dp.game_id
		WHERE dg.status = 'finished' AND u.is_banned = 0 ${modeFilter}
		GROUP BY dp.user_id
		ORDER BY ${orderBy}
		LIMIT ?
	`
		)
		.all(limit);
	return c.json(rows);
});

app.post("/api/submissions", async (c) => {
	const user = getUserFromContext(c);
	if (!user) return c.text("Login required", 401);
	if (isBanned(user)) return c.text("You are banned", 403);
	if (user.upload_limited) return c.text("Your upload ability has been temporarily limited", 403);
	if (!checkRateLimitUser(user, `sub:${user.id}`, 5, 60 * 60 * 1000))
		return c.text("Too many submissions. Try again later.", 429);

	let formData: FormData;
	try {
		formData = await c.req.formData();
	} catch {
		return c.text("Invalid form data", 400);
	}

	const file = formData.get("image") as File | null;
	const worldX = parseFloat(formData.get("world_x") as string);
	const worldY = parseFloat(formData.get("world_y") as string);
	const label = ((formData.get("label") as string) || "").trim();
	if (label.length < LABEL_MIN_LENGTH || label.length > LABEL_MAX_LENGTH)
		return c.text(
			`Label must be between ${LABEL_MIN_LENGTH} and ${LABEL_MAX_LENGTH} characters (got ${label.length})`,
			400
		);
	const rawHints = formData.get("hints") as string | null;
	const hints = (() => {
		try {
			const parsed = JSON.parse(rawHints || "[]");
			if (!Array.isArray(parsed)) return "[]";
			return JSON.stringify(
				parsed
					.map((h: unknown) => String(h).trim())
					.filter(Boolean)
					.slice(0, 3)
			);
		} catch {
			return "[]";
		}
	})();

	if (!file || !(file instanceof File)) return c.text("Image required", 400);
	if (isNaN(worldX) || isNaN(worldY)) return c.text("Invalid coordinates", 400);
	if (file.size > 8 * 1024 * 1024) return c.text("File too large (max 8MB)", 400);

	const rawBuffer = Buffer.from(await file.arrayBuffer());
	let imgData: Buffer;
	let ext: string;
	try {
		({ data: imgData, ext } = await processUploadedImage(rawBuffer));
	} catch (err: unknown) {
		return c.text(`Invalid image: ${err instanceof Error ? err.message : "unknown error"}`, 400);
	}

	const filename = `${randomBytes(16).toString("hex")}.${ext}`;
	await writeFile(`./public/uploads/${filename}`, imgData);
	const subResult = db
		.query<{ id: number }, [string, number, number, string | null, string, number]>(
			"INSERT INTO submissions (image_path, world_x, world_y, label, hints, submitted_by) VALUES (?, ?, ?, ?, ?, ?) RETURNING id"
		)
		.get(filename, worldX, worldY, label, hints, user.id);

	sendDiscordWebhook(
		`📸 **New submission** #${subResult?.id} from **${user.display_name || user.username}** (@${user.username})${label ? `\n> "${label}"` : ""}`,
		"submissions",
		"/admin#submissions"
	);

	return c.json({ success: true });
});

app.get("/api/submissions/mine", (c) => {
	const user = getUserFromContext(c);
	if (!user) return c.text("Login required", 401);
	const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
	db.run("DELETE FROM submissions WHERE submitted_by = ? AND status = 'denied' AND reviewed_at < ?", [
		user.id,
		thirtyDaysAgo,
	]);
	const rows = db
		.query<
			{
				id: number;
				image_path: string;
				label: string | null;
				status: string;
				deny_reason: string | null;
				created_at: number;
				reviewed_at: number | null;
			},
			[number]
		>(
			"SELECT id, image_path, label, status, deny_reason, created_at, reviewed_at FROM submissions WHERE submitted_by = ? ORDER BY created_at DESC LIMIT 50"
		)
		.all(user.id);
	return c.json(rows);
});

const matchmakingQueue = new Map<number, { code: string; rounds: number; joinedAt: number }>();
const quickplayMatchedPlayers = new Map<number, string>();
const QUEUE_TIMEOUT_MS = 90_000;
const ALLOWED_TIME_LIMITS = new Set([0, 30, 60, 90, 120]);

function cleanMatchmakingQueue() {
	const now = Date.now();
	for (const [uid, entry] of matchmakingQueue) {
		const roomGone = !duelRooms.has(entry.code);
		if (roomGone || now - entry.joinedAt > QUEUE_TIMEOUT_MS) matchmakingQueue.delete(uid);
	}
	for (const [uid, code] of quickplayMatchedPlayers) {
		const room = duelRooms.get(code);
		if (!room || room.status !== "waiting") quickplayMatchedPlayers.delete(uid);
	}
}

app.post("/api/duels/quickplay", async (c) => {
	const user = getUserFromContext(c);
	if (!user) return c.text("Login required", 401);
	if (isBanned(user)) return c.text("You are banned", 403);
	if (user.duel_limited) return c.text("Your duel ability has been temporarily limited", 403);

	cleanMatchmakingQueue();

	const existing = matchmakingQueue.get(user.id);
	if (existing) return c.json({ status: "waiting", code: existing.code });

	const alreadyMatched = quickplayMatchedPlayers.get(user.id);
	if (alreadyMatched) return c.json({ status: "matched", code: alreadyMatched });

	const body = (await c.req.json().catch(() => ({}))) as { rounds?: number };
	const rounds = Math.min(10, Math.max(1, body.rounds || 5));

	for (const [waitingUserId, entry] of matchmakingQueue) {
		if (entry.rounds === rounds) {
			const result = joinDuelRoom(entry.code, user.id);
			if (result === "ok") {
				matchmakingQueue.delete(waitingUserId);
				const room = duelRooms.get(entry.code);
				if (room) room.quickplay = true;
				quickplayMatchedPlayers.set(user.id, entry.code);
				quickplayMatchedPlayers.set(waitingUserId, entry.code);
				auditLog(user, "quickplay_queue", {
					targetType: "duel",
					targetId: room?.dbId,
					details: `matched, room ${entry.code}, ${rounds} rounds`,
				});
				return c.json({ status: "matched", code: entry.code });
			}
		}
	}

	if (!checkRateLimitUser(user, `room:${user.id}`, 10, 60 * 60 * 1000))
		return c.text("Too many rooms created. Try again later.", 429);
	const room = createDuelRoom(user.id, rounds);
	db.run("UPDATE duel_games SET quickplay = 1 WHERE id = ?", [room.dbId]);
	const duelRoom = duelRooms.get(room.code);
	if (duelRoom) duelRoom.quickplay = true;
	matchmakingQueue.set(user.id, { code: room.code, rounds, joinedAt: Date.now() });
	auditLog(user, "quickplay_queue", { targetType: "duel", targetId: room.dbId, details: `queued, ${rounds} rounds` });
	return c.json({ status: "waiting", code: room.code });
});

app.delete("/api/duels/quickplay", (c) => {
	const user = getUserFromContext(c);
	if (!user) return c.text("Login required", 401);

	function cancelRoom(code: string) {
		const room = duelRooms.get(code);
		if (!room || room.status !== "waiting") return;
		room.players = room.players.filter((p) => p.userId !== user.id);
		if (room.players.length === 0) {
			duelRooms.delete(code);
			db.run("DELETE FROM duel_games WHERE room_code = ?", [code]);
		} else {
			const roomState = {
				code: room.code,
				status: room.status,
				players: room.players.map((pl) => ({
					user_id: pl.userId,
					username: pl.username,
					display_name: pl.displayName,
					avatar_url: pl.avatarUrl,
					is_host: pl.userId === room.players[0]?.userId,
				})),
			};
			for (const p of room.players) {
				try {
					p.conn.emit("room_state", roomState);
				} catch {}
			}
		}
	}

	const queueEntry = matchmakingQueue.get(user.id);
	if (queueEntry) {
		matchmakingQueue.delete(user.id);
		cancelRoom(queueEntry.code);
	}

	const matchedCode = quickplayMatchedPlayers.get(user.id);
	if (matchedCode) {
		quickplayMatchedPlayers.delete(user.id);
		cancelRoom(matchedCode);
	}

	return c.json({ success: true });
});

app.post("/api/duels/rooms", async (c) => {
	const user = getUserFromContext(c);
	if (!user) return c.text("Login required", 401);
	if (isBanned(user)) return c.text("You are banned", 403);
	if (user.duel_limited) return c.text("Your duel ability has been temporarily limited", 403);
	if (!checkRateLimitUser(user, `room:${user.id}`, 10, 60 * 60 * 1000))
		return c.text("Too many rooms created. Try again later.", 429);
	const body = (await c.req.json().catch(() => ({}))) as { rounds?: number };
	const rounds = Math.min(10, Math.max(1, body.rounds || 5));
	const room = createDuelRoom(user.id, rounds);
	auditLog(user, "duel_room_create", {
		targetType: "duel",
		targetId: room.dbId,
		details: `${room.code}, ${rounds} rounds`,
	});
	sendDiscordWebhook(
		`⚔️ **Duel room created**: \`${room.code}\` by **${user.display_name || user.username}** (${rounds} rounds)`,
		"duels",
		"/admin#duels"
	);
	return c.json({ code: room.code });
});

app.post("/api/duels/rooms/:code/join", (c) => {
	const user = getUserFromContext(c);
	if (!user) return c.text("Login required", 401);
	if (isBanned(user)) return c.text("You are banned", 403);
	if (user.duel_limited) return c.text("Your duel ability has been temporarily limited", 403);
	const code = c.req.param("code").toUpperCase();
	const targetRoom = duelRooms.get(code);
	if (targetRoom?.quickplay) return c.text("Quickplay rooms cannot be joined directly. Use Quick Play.", 400);
	const result = joinDuelRoom(code, user.id);
	if (result === "not_found") return c.text("Room not found", 404);
	if (result === "abandoned")
		return c.text("This room doesn't exist or can't be joined.", 410);
	if (result === "full") return c.text("Room is full", 409);
	if (result === "in_progress") return c.text("Game already in progress", 409);
	const joinedRoom = duelRooms.get(code);
	if (joinedRoom)
		auditLog(user, "duel_join", { targetType: "duel", targetId: joinedRoom.dbId, details: `joined room ${code}` });
	return c.json({ success: true });
});

app.get("/webwire-client.js", (c) =>
	c.body(wireClientJs, 200, { "Content-Type": "application/javascript; charset=utf-8" })
);

app.route("/api/duels/wire", webwire(wireServer, upgradeWebSocket));

const ROLE_RANK: Record<string, number> = { operator: 3, supervisor: 2, moderator: 1 };
function roleRank(role: string | null): number {
	return ROLE_RANK[role ?? ""] ?? 0;
}

function getModUser(c: Context): User | null {
	const user = getUserFromContext(c);
	if (!user) return null;
	if (!user.role || !["moderator", "supervisor", "operator"].includes(user.role)) return null;
	return user;
}

function getOpUser(c: Context): User | null {
	const user = getUserFromContext(c);
	if (!user || user.role !== "operator") return null;
	return user;
}

function getSeniorUser(c: Context): User | null {
	const user = getUserFromContext(c);
	if (!user) return null;
	if (!user.role || !["supervisor", "operator"].includes(user.role)) return null;
	return user;
}

function auditLog(
	actor: User | null,
	action: string,
	opts: { targetType?: string; targetId?: number; targetUsername?: string; details?: string } = {}
) {
	try {
		db.run(
			"INSERT INTO audit_log (actor_id, actor_username, action, target_type, target_id, target_username, details) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[
				actor?.id ?? null,
				actor ? actor.display_name || actor.username : "system",
				action,
				opts.targetType ?? null,
				opts.targetId ?? null,
				opts.targetUsername ?? null,
				opts.details ?? null,
			]
		);
	} catch (err) {
		console.error("[audit] write failed:", err);
	}
}

app.get("/api/admin/submissions", (c) => {
	const user = getModUser(c);
	if (!user) return c.text("Forbidden", 403);
	const rows = db
		.query(
			`
		SELECT s.*, u.username, u.display_name
		FROM submissions s
		LEFT JOIN users u ON u.id = s.submitted_by
		WHERE s.status = 'pending'
		ORDER BY s.created_at ASC
	`
		)
		.all();
	return c.json(rows);
});

app.post("/api/admin/submissions/:id/approve", async (c) => {
	const user = getModUser(c);
	if (!user) return c.text("Forbidden", 403);
	const id = parseInt(c.req.param("id"));
	const body = (await c.req.json().catch(() => ({}))) as { label?: string };
	const sub = db
		.query<
			{
				image_path: string;
				world_x: number;
				world_y: number;
				label: string | null;
				hints: string | null;
				submitted_by: number;
				username: string | null;
			},
			[number]
		>(
			"SELECT s.image_path, s.world_x, s.world_y, s.label, s.hints, s.submitted_by, u.username FROM submissions s LEFT JOIN users u ON u.id = s.submitted_by WHERE s.id = ? AND s.status = 'pending'"
		)
		.get(id);
	if (!sub) return c.text("Not found", 404);
	const finalLabel = typeof body.label === "string" ? body.label.trim() : (sub.label || "").trim();
	if (finalLabel.length < LABEL_MIN_LENGTH || finalLabel.length > LABEL_MAX_LENGTH)
		return c.text(
			`A label is required: ${LABEL_MIN_LENGTH}-${LABEL_MAX_LENGTH} characters (got ${finalLabel.length}).`,
			400
		);
	db.run(
		"INSERT INTO locations (image_path, world_x, world_y, label, hints, submitted_by, approved_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
		[sub.image_path, sub.world_x, sub.world_y, finalLabel, sub.hints || "[]", sub.submitted_by, user.id]
	);
	db.run("UPDATE submissions SET status = 'approved', reviewed_by = ?, reviewed_at = unixepoch() WHERE id = ?", [
		user.id,
		id,
	]);
	sendDiscordWebhook(
		`✅ **Submission #${id} approved** by **${user.display_name || user.username}**${finalLabel ? ` - "${finalLabel}"` : ""}${sub.username ? ` (originally by ${sub.username})` : ""}`,
		"submissions",
		"/admin#submissions"
	);
	auditLog(user, "submission_approve", {
		targetType: "submission",
		targetId: id,
		targetUsername: sub.username ?? undefined,
		details: finalLabel ?? undefined,
	});
	return c.json({ success: true });
});

app.post("/api/admin/submissions/:id/deny", async (c) => {
	const user = getModUser(c);
	if (!user) return c.text("Forbidden", 403);
	const id = parseInt(c.req.param("id"));
	const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
	const sub = db
		.query<{ username: string | null; label: string | null; image_path: string | null }, [number]>(
			"SELECT u.username, s.label, s.image_path FROM submissions s LEFT JOIN users u ON u.id = s.submitted_by WHERE s.id = ?"
		)
		.get(id);
	const denyResult = db.run(
		"UPDATE submissions SET status = 'denied', reviewed_by = ?, reviewed_at = unixepoch(), deny_reason = ? WHERE id = ? AND status = 'pending'",
		[user.id, body.reason || null, id]
	);
	if (denyResult.changes > 0 && sub?.image_path) {
		try {
			await unlink(`./public/uploads/${sub.image_path}`);
		} catch {}
	}
	sendDiscordWebhook(
		`❌ **Submission #${id} denied** by **${user.display_name || user.username}**${sub?.label ? ` - "${sub.label}"` : ""}${body.reason ? `\n> Reason: ${body.reason}` : ""}`,
		"submissions",
		"/admin#submissions"
	);
	auditLog(user, "submission_deny", {
		targetType: "submission",
		targetId: id,
		targetUsername: sub?.username ?? undefined,
		details: body.reason || undefined,
	});
	return c.json({ success: true });
});

app.get("/api/admin/locations", (c) => {
	const user = getModUser(c);
	if (!user) return c.text("Forbidden", 403);
	return c.json(db.query("SELECT * FROM locations ORDER BY created_at DESC").all());
});

app.post("/api/admin/locations", async (c) => {
	const user = getOpUser(c);
	if (!user) return c.text("Forbidden", 403);

	let formData: FormData;
	try {
		formData = await c.req.formData();
	} catch {
		return c.text("Invalid form data", 400);
	}

	const file = formData.get("image") as File | null;
	const worldX = parseFloat(formData.get("world_x") as string);
	const worldY = parseFloat(formData.get("world_y") as string);
	const label = ((formData.get("label") as string) || "").trim().slice(0, 100) || null;
	const hintsRaw = ((formData.get("hints") as string) || "").trim();
	let hints: string[] = [];
	try {
		const parsed = JSON.parse(hintsRaw);
		if (Array.isArray(parsed))
			hints = parsed
				.map((h) => String(h).trim())
				.filter(Boolean)
				.slice(0, 3);
	} catch {}

	if (!file || !(file instanceof File)) return c.text("Image required", 400);
	if (isNaN(worldX) || isNaN(worldY)) return c.text("Invalid coordinates", 400);
	if (file.size > 8 * 1024 * 1024) return c.text("File too large", 400);
	if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) return c.text("Invalid file type", 400);

	const { data: imgData, ext } = await processUploadedImage(Buffer.from(await file.arrayBuffer()));
	const filename = `${randomBytes(16).toString("hex")}.${ext}`;
	await writeFile(`./public/uploads/${filename}`, imgData);
	db.run(
		"INSERT INTO locations (image_path, world_x, world_y, label, approved_by, hints) VALUES (?, ?, ?, ?, ?, ?)",
		[filename, worldX, worldY, label, user.id, JSON.stringify(hints)]
	);
	return c.json({ success: true });
});

app.post("/api/admin/locations/:id/toggle", (c) => {
	const user = getModUser(c);
	if (!user) return c.text("Forbidden", 403);
	const id = parseInt(c.req.param("id"));
	const loc = db
		.query<{ is_active: number; label: string | null }, [number]>(
			"SELECT is_active, label FROM locations WHERE id = ?"
		)
		.get(id);
	db.run("UPDATE locations SET is_active = 1 - is_active WHERE id = ?", [id]);
	auditLog(user, loc?.is_active ? "location_deactivate" : "location_activate", {
		targetType: "location",
		targetId: id,
		details: loc?.label ?? undefined,
	});
	return c.json({ success: true });
});

app.delete("/api/admin/locations/:id", async (c) => {
	const user = getOpUser(c);
	if (!user) return c.text("Forbidden", 403);
	const id = parseInt(c.req.param("id"));
	const loc = db.query<{ image_path: string }, [number]>("SELECT image_path FROM locations WHERE id = ?").get(id);
	if (!loc) return c.text("Not found", 404);
	db.run("DELETE FROM locations WHERE id = ?", [id]);
	try {
		await unlink(`./public/uploads/${loc.image_path}`);
	} catch {}
	auditLog(user, "location_delete", { targetType: "location", targetId: id });
	return c.json({ success: true });
});

app.get("/api/admin/users", (c) => {
	const user = getModUser(c);
	if (!user) return c.text("Forbidden", 403);
	return c.json(db.query("SELECT * FROM users ORDER BY created_at DESC").all());
});

app.post("/api/admin/users/:id/limit", async (c) => {
	const user = getModUser(c);
	if (!user) return c.text("Forbidden", 403);
	const userId = parseInt(c.req.param("id"));
	if (userId === user.id) return c.text("Cannot limit yourself", 403);
	const body = (await c.req.json().catch(() => ({}))) as { type?: string; hours?: number };
	if (!body.type || !["upload", "duel"].includes(body.type)) return c.text("Invalid type", 400);
	const now = Math.floor(Date.now() / 1000);
	if (!body.hours || body.hours <= 0) {
		if (body.type === "upload")
			db.run("UPDATE users SET upload_limited = 0, upload_limit_expires_at = NULL WHERE id = ?", [userId]);
		else db.run("UPDATE users SET duel_limited = 0, duel_limit_expires_at = NULL WHERE id = ?", [userId]);
	} else {
		const clampedHours = Math.min(96, body.hours);
		const expiresAt = now + Math.floor(clampedHours * 3600);
		if (body.type === "upload")
			db.run("UPDATE users SET upload_limited = 1, upload_limit_expires_at = ? WHERE id = ?", [
				expiresAt,
				userId,
			]);
		else db.run("UPDATE users SET duel_limited = 1, duel_limit_expires_at = ? WHERE id = ?", [expiresAt, userId]);
	}
	return c.json({ success: true });
});

app.post("/api/admin/users/:id/ban", async (c) => {
	const user = getModUser(c);
	if (!user) return c.text("Forbidden", 403);
	const userId = parseInt(c.req.param("id"));
	if (userId === user.id) return c.text("Cannot ban yourself", 403);
	const body = (await c.req.json().catch(() => ({}))) as { type?: string; hours?: number };
	const target = db
		.query<{ username: string; display_name: string | null; role: string | null }, [number]>(
			"SELECT username, display_name, role FROM users WHERE id = ?"
		)
		.get(userId);
	const actorRank = ROLE_RANK[user.role ?? ""] ?? 0;
	const targetRank = ROLE_RANK[target?.role ?? ""] ?? 0;
	if (targetRank >= actorRank) return c.text("Cannot ban a staff member of equal or higher rank", 403);
	if (body.type === "perm") {
		if (!["supervisor", "operator"].includes(user.role ?? ""))
			return c.text("Only supervisors or operators can permanently ban users", 403);
		db.run("UPDATE users SET is_banned = 1, ban_type = 'perm', ban_expires_at = NULL WHERE id = ?", [userId]);
		sendDiscordWebhook(
			`🔨 **Permanent ban**: **${target?.display_name || target?.username || userId}** (@${target?.username}) banned by **${user.display_name || user.username}**`,
			"bans",
			"/admin#users"
		);
		auditLog(user, "user_ban_perm", {
			targetType: "user",
			targetId: userId,
			targetUsername: target?.username ?? undefined,
		});
	} else if (body.type === "temp" && body.hours && body.hours > 0) {
		const maxHours = 365 * 24;
		const clampedHours = Math.min(body.hours, maxHours);
		const expiresAt = Math.floor(Date.now() / 1000) + Math.floor(clampedHours * 3600);
		db.run("UPDATE users SET is_banned = 1, ban_type = 'temp', ban_expires_at = ? WHERE id = ?", [
			expiresAt,
			userId,
		]);
		sendDiscordWebhook(
			`⏱️ **Temp ban (${clampedHours}h)**: **${target?.display_name || target?.username || userId}** (@${target?.username}) by **${user.display_name || user.username}**`,
			"bans",
			"/admin#users"
		);
		auditLog(user, "user_ban_temp", {
			targetType: "user",
			targetId: userId,
			targetUsername: target?.username ?? undefined,
			details: `${clampedHours}h`,
		});
	} else {
		return c.text("Invalid ban params", 400);
	}
	return c.json({ success: true });
});

app.post("/api/admin/users/:id/unban", (c) => {
	const user = getModUser(c);
	if (!user) return c.text("Forbidden", 403);
	const targetId = parseInt(c.req.param("id"));
	const target = db
		.query<{ username: string; ban_type: string | null }, [number]>(
			"SELECT username, ban_type FROM users WHERE id = ?"
		)
		.get(targetId);
	if (target?.ban_type === "perm" && user.role !== "operator")
		return c.text("Only operators can lift permanent bans", 403);
	db.run("UPDATE users SET is_banned = 0, ban_type = NULL, ban_expires_at = NULL WHERE id = ?", [targetId]);
	auditLog(user, "user_unban", { targetType: "user", targetId, targetUsername: target?.username });
	return c.json({ success: true });
});

app.post("/api/admin/users/:id/block", (c) => {
	const user = getOpUser(c);
	if (!user) return c.text("Forbidden", 403);
	db.run("UPDATE users SET is_banned = 1, ban_type = 'perm', ban_expires_at = NULL WHERE id = ?", [
		parseInt(c.req.param("id")),
	]);
	return c.json({ success: true });
});

app.post("/api/admin/users/:id/warn", async (c) => {
	const user = getModUser(c);
	if (!user) return c.text("Forbidden", 403);
	const targetId = parseInt(c.req.param("id"));
	const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
	const reason = (body.reason || "").trim().slice(0, 500);
	if (!reason) return c.text("Reason required", 400);
	const target = db.query<{ username: string }, [number]>("SELECT username FROM users WHERE id = ?").get(targetId);
	if (!target) return c.text("User not found", 404);
	db.run("INSERT INTO user_warnings (user_id, issued_by, issued_by_username, reason) VALUES (?, ?, ?, ?)", [
		targetId,
		user.id,
		user.display_name || user.username,
		reason,
	]);
	auditLog(user, "user_warn", {
		targetType: "user",
		targetId,
		targetUsername: target.username,
		details: reason.slice(0, 100),
	});
	return c.json({ success: true });
});

app.delete("/api/admin/warnings/:id", (c) => {
	const user = getSeniorUser(c);
	if (!user) return c.text("Forbidden", 403);
	const warnId = parseInt(c.req.param("id"));
	const warn = db.query<{ user_id: number }, [number]>("SELECT user_id FROM user_warnings WHERE id = ?").get(warnId);
	if (!warn) return c.text("Not found", 404);
	db.run("DELETE FROM user_warnings WHERE id = ?", [warnId]);
	auditLog(user, "warning_delete", { targetType: "warning", targetId: warnId });
	return c.json({ success: true });
});

app.patch("/api/admin/warnings/:id", async (c) => {
	const user = getSeniorUser(c);
	if (!user) return c.text("Forbidden", 403);
	const warnId = parseInt(c.req.param("id"));
	const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
	const reason = (body.reason || "").trim().slice(0, 500);
	if (!reason) return c.text("Reason required", 400);
	const warn = db.query<{ id: number }, [number]>("SELECT id FROM user_warnings WHERE id = ?").get(warnId);
	if (!warn) return c.text("Not found", 404);
	db.run("UPDATE user_warnings SET reason = ? WHERE id = ?", [reason, warnId]);
	auditLog(user, "warning_edit", { targetType: "warning", targetId: warnId, details: reason.slice(0, 100) });
	return c.json({ success: true });
});

app.post("/api/admin/users/:id/role", async (c) => {
	const actor = getSeniorUser(c);
	if (!actor) return c.text("Forbidden", 403);

	const targetId = parseInt(c.req.param("id"));
	if (targetId === actor.id) return c.text("Cannot change your own role", 400);

	const body = (await c.req.json().catch(() => ({}))) as { role?: string | null };
	const newRole = body.role && body.role !== "none" ? body.role : null;

	const assignable = actor.role === "operator" ? ["supervisor", "moderator"] : ["moderator"];
	if (newRole !== null && !assignable.includes(newRole))
		return c.text("Insufficient permissions to assign that role", 403);

	const target = db
		.query<{ id: number; role: string | null; discord_id: string; username: string }, [number]>(
			"SELECT id, role, discord_id, username FROM users WHERE id = ?"
		)
		.get(targetId);
	if (!target) return c.text("User not found", 404);

	const opIds = getOperatorIds();
	if (opIds.includes(target.discord_id)) return c.text("Cannot change env-protected operator", 403);
	if (roleRank(target.role) >= roleRank(actor.role))
		return c.text("Cannot change a user with equal or higher rank", 403);

	db.run("UPDATE users SET role = ? WHERE id = ?", [newRole, targetId]);
	auditLog(actor, "user_role_change", {
		targetType: "user",
		targetId,
		targetUsername: target.username ?? undefined,
		details: `${target.role ?? "none"} → ${newRole ?? "none"}`,
	});
	return c.json({ success: true });
});

app.get("/api/admin/stats", (c) => {
	const user = getModUser(c);
	if (!user) return c.text("Forbidden", 403);
	const n = (sql: string) => db.query<{ n: number }, []>(sql).get()?.n ?? 0;
	const week = Math.floor(Date.now() / 1000) - 7 * 86400;
	return c.json({
		users: {
			total: n("SELECT COUNT(*) as n FROM users"),
			last_7d: n(`SELECT COUNT(*) as n FROM users WHERE created_at > ${week}`),
			banned: n("SELECT COUNT(*) as n FROM users WHERE is_banned = 1"),
		},
		locations: {
			total: n("SELECT COUNT(*) as n FROM locations"),
			active: n("SELECT COUNT(*) as n FROM locations WHERE is_active = 1"),
		},
		submissions: {
			total: n("SELECT COUNT(*) as n FROM submissions"),
			pending: n("SELECT COUNT(*) as n FROM submissions WHERE status = 'pending'"),
		},
		scores: {
			total_games: n("SELECT COUNT(*) as n FROM solo_scores"),
			last_7d: n(`SELECT COUNT(*) as n FROM solo_scores WHERE created_at > ${week}`),
		},
		duels: {
			total_rooms: n("SELECT COUNT(*) as n FROM duel_games"),
			active_rooms: duelRooms.size,
		},
		daily: {
			total_plays: n("SELECT COUNT(*) as n FROM daily_scores"),
			last_7d: n(`SELECT COUNT(*) as n FROM daily_scores WHERE created_at > ${week}`),
		},
	});
});

app.post("/api/admin/locations/:id/label", async (c) => {
	const user = getModUser(c);
	if (!user) return c.text("Forbidden", 403);
	const id = parseInt(c.req.param("id"));
	const body = (await c.req.json().catch(() => ({}))) as { label?: string };
	const label = typeof body.label === "string" ? body.label.trim() : "";
	if (label.length < 2 || label.length > 100) return c.text("Label must be 2-100 characters", 400);
	const loc = db.query<{ label: string | null }, [number]>("SELECT label FROM locations WHERE id = ?").get(id);
	if (!loc) return c.text("Not found", 404);
	db.run("UPDATE locations SET label = ? WHERE id = ?", [label, id]);
	auditLog(user, "location_label_edit", {
		targetType: "location",
		targetId: id,
		details: label,
	});
	return c.json({ success: true });
});

app.post("/api/admin/locations/:id/hints", async (c) => {
	const user = getModUser(c);
	if (!user) return c.text("Forbidden", 403);
	const id = parseInt(c.req.param("id"));
	const body = (await c.req.json().catch(() => ({}))) as { hints?: string[] };
	const hints = Array.isArray(body.hints)
		? body.hints
				.map((h) => String(h).trim())
				.filter(Boolean)
				.slice(0, 3)
		: [];
	db.run("UPDATE locations SET hints = ? WHERE id = ?", [JSON.stringify(hints), id]);
	return c.json({ success: true });
});

app.get("/api/daily", (c) => {
	const challenge = getOrCreateDailyChallenge();
	if (!challenge) return c.json(null, 404);

	const user = getUserFromContext(c);
	const alreadyPlayed = user
		? !!db
				.query<{ id: number }, [number, string]>("SELECT id FROM daily_scores WHERE user_id = ? AND date = ?")
				.get(user.id, challenge.date)
		: false;

	return c.json({
		date: challenge.date,
		image_url: `/uploads/${challenge.location.image_path}`,
		hints: JSON.parse(challenge.location.hints || "[]"),
		already_played: alreadyPlayed,
	});
});

app.post("/api/daily/score", async (c) => {
	const user = getUserFromContext(c);
	if (!user || isBanned(user)) return c.json({ error: "Login required" }, 401);

	const challenge = getOrCreateDailyChallenge();
	if (!challenge) return c.json({ error: "No daily challenge today" }, 404);

	const existing = db
		.query<{ id: number }, [number, string]>("SELECT id FROM daily_scores WHERE user_id = ? AND date = ?")
		.get(user.id, challenge.date);
	if (existing) return c.json({ error: "Already played today" }, 409);

	const body = (await c.req.json().catch(() => ({}))) as {
		guessed_x?: number;
		guessed_y?: number;
		time_taken?: number;
		hints_used?: number;
	};

	const loc = challenge.location;
	const gx = typeof body.guessed_x === "number" ? body.guessed_x : null;
	const gy = typeof body.guessed_y === "number" ? body.guessed_y : null;
	const timeTaken = Math.min(90, Math.max(0, body.time_taken ?? 90));
	const hintsUsed = Math.min(3, Math.max(0, Math.floor(body.hints_used ?? 0)));

	let distance: number | null = null;
	let score = 0;
	if (gx !== null && gy !== null) {
		distance = Math.hypot(gx - loc.world_x, gy - loc.world_y);
		score = Math.max(0, Math.round(5000 * Math.exp(-distance / 9322)));
		score = Math.max(0, score - hintsUsed * 500);
	}

	db.run(
		"INSERT INTO daily_scores (user_id, date, score, guessed_x, guessed_y, distance, time_taken, hints_used) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		[user.id, challenge.date, score, gx, gy, distance, timeTaken, hintsUsed]
	);
	updateStreak(user.id);

	const streakRow = db
		.query<{ current_streak: number; longest_streak: number }, [number]>(
			"SELECT current_streak, longest_streak FROM users WHERE id = ?"
		)
		.get(user.id);

	return c.json({
		score,
		distance: distance !== null ? Math.round(distance) : null,
		correct_x: loc.world_x,
		correct_y: loc.world_y,
		location_id: loc.id,
		current_streak: streakRow?.current_streak ?? 0,
		longest_streak: streakRow?.longest_streak ?? 0,
	});
});

app.get("/api/leaderboard/daily", (c) => {
	const date = c.req.query("date") || todayUTC();
	const limit = Math.min(100, parseInt(c.req.query("limit") || "50"));
	const sort = c.req.query("sort");
	const orderBy =
		sort === "distance"
			? "ds.distance ASC"
			: sort === "time"
				? "ds.time_taken ASC"
				: sort === "hints"
					? "ds.hints_used ASC, ds.score DESC"
					: "ds.score DESC";
	const rows = db
		.query(
			`
		SELECT u.id as user_id, u.username, u.display_name, u.avatar_url,
			ds.score, ds.distance, ds.hints_used, ds.time_taken, ds.date,
			u.current_streak
		FROM daily_scores ds
		JOIN users u ON u.id = ds.user_id
		WHERE ds.date = ? AND u.is_banned = 0
		ORDER BY ${orderBy}
		LIMIT ?
	`
		)
		.all(date, limit);
	return c.json(rows);
});

app.get("/api/profile/:username", (c) => {
	const username = c.req.param("username");
	const me = getUserFromContext(c);
	const subject = db
		.query<
			{
				id: number;
				discord_id: string;
				username: string;
				display_name: string | null;
				avatar_url: string | null;
				current_streak: number;
				longest_streak: number;
				created_at: number;
				is_banned: number;
				profile_private: number;
				role: string | null;
			},
			[string]
		>(
			"SELECT id, discord_id, username, display_name, avatar_url, current_streak, longest_streak, created_at, is_banned, profile_private, role FROM users WHERE username = ?"
		)
		.get(username);
	if (!subject || subject.is_banned) return c.text("Not found", 404);
	if (subject.discord_id === "0" && !DEV_MODE) return c.text("Not found", 404);
	if (subject.profile_private && me?.id !== subject.id && !me?.role) return c.text("Profile is private", 403);

	const solo = db
		.query<{ best_score: number | null; total_games: number; avg_score: number | null }, [number]>(
			"SELECT MAX(total_score) as best_score, COUNT(*) as total_games, ROUND(AVG(total_score)) as avg_score FROM solo_scores WHERE user_id = ?"
		)
		.get(subject.id);

	const duels = db
		.query<{ wins: number; games: number; total_score: number }, [number, number]>(
			`
		SELECT
			SUM(CASE WHEN dg.winner_id = ? THEN 1 ELSE 0 END) as wins,
			COUNT(DISTINCT dp.game_id) as games,
			COALESCE(SUM(dp.total_score), 0) as total_score
		FROM duel_participants dp
		JOIN duel_games dg ON dg.id = dp.game_id
		WHERE dp.user_id = ? AND dg.status = 'finished'
	`
		)
		.get(subject.id, subject.id);

	const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
	db.run("DELETE FROM submissions WHERE submitted_by = ? AND status = 'denied' AND reviewed_at < ?", [
		subject.id,
		thirtyDaysAgo,
	]);

	const submissions = db
		.query<{ total: number; approved: number }, [number]>(
			`
		SELECT COUNT(*) as total,
			SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved
		FROM submissions WHERE submitted_by = ?
	`
		)
		.get(subject.id);

	const dailyBest = db
		.query<{ best: number | null; played: number; avg: number | null }, [number]>(
			"SELECT MAX(score) as best, COUNT(*) as played, ROUND(AVG(score)) as avg FROM daily_scores WHERE user_id = ?"
		)
		.get(subject.id);

	return c.json({
		id: subject.id,
		username: subject.username,
		display_name: subject.display_name,
		avatar_url: subject.avatar_url,
		current_streak: subject.current_streak,
		longest_streak: subject.longest_streak,
		created_at: subject.created_at,
		role: subject.role ?? null,
		profile_private: !!subject.profile_private,
		solo,
		duels,
		submissions,
		daily: dailyBest,
	});
});

app.post("/api/settings", async (c) => {
	const user = getUserFromContext(c);
	if (!user) return c.text("Login required", 401);
	const body = (await c.req.json().catch(() => ({}))) as { profile_private?: boolean };
	if (typeof body.profile_private === "boolean") {
		db.run("UPDATE users SET profile_private = ? WHERE id = ?", [body.profile_private ? 1 : 0, user.id]);
	}
	return c.json({ success: true });
});

app.get("/api/me/moderation", (c) => {
	const user = getUserFromContext(c);
	if (!user) return c.text("Login required", 401);
	const warnings = db
		.query<{ id: number; reason: string; created_at: number }, [number]>(
			"SELECT id, reason, created_at FROM user_warnings WHERE user_id = ? ORDER BY created_at DESC"
		)
		.all(user.id);
	const bans = db
		.query<{ action: string; details: string | null; created_at: number }, [number]>(
			"SELECT action, details, created_at FROM audit_log WHERE target_id = ? AND target_type = 'user' AND action IN ('user_ban_perm','user_ban_temp','user_unban') ORDER BY created_at DESC"
		)
		.all(user.id);
	return c.json({ warnings, bans });
});

function collectGdprData(userId: number) {
	const soloScores = db
		.query("SELECT id, total_score, max_possible, rounds, created_at FROM solo_scores WHERE user_id = ?")
		.all(userId);
	const dailyScores = db.query("SELECT id, score, date, created_at FROM daily_scores WHERE user_id = ?").all(userId);
	const duelGames = db
		.query(
			"SELECT dp.game_id, dp.total_score, dg.room_code, dg.status, dg.winner_id, dg.created_at FROM duel_participants dp JOIN duel_games dg ON dg.id = dp.game_id WHERE dp.user_id = ?"
		)
		.all(userId);
	const submissions = db
		.query("SELECT id, image_path, world_x, world_y, label, status, created_at FROM submissions WHERE submitted_by = ?")
		.all(userId);
	const suggestions = db
		.query("SELECT id, location_id, type, content, status, created_at FROM location_suggestions WHERE user_id = ?")
		.all(userId);
	const tickets = db
		.query("SELECT id, subject, message, status, created_at FROM support_tickets WHERE user_id = ?")
		.all(userId);
	const ticketReplies = db
		.query(
			"SELECT tr.id, tr.ticket_id, tr.body, tr.type, tr.created_at FROM ticket_replies tr JOIN support_tickets st ON st.id = tr.ticket_id WHERE st.user_id = ?"
		)
		.all(userId);
	const roundScores = db
		.query(
			"SELECT game_id, round_number, guessed_x, guessed_y, distance, score, created_at FROM duel_round_scores WHERE user_id = ?"
		)
		.all(userId);
	const warnings = db
		.query("SELECT id, issued_by_username, reason, created_at FROM user_warnings WHERE user_id = ?")
		.all(userId);
	const fingerprints = db
		.query("SELECT fp_hash, first_seen, last_seen FROM fingerprints WHERE user_id = ?")
		.all(userId);
	return { soloScores, dailyScores, duelGames, submissions, suggestions, tickets, ticketReplies, roundScores, warnings, fingerprints };
}

app.get("/api/gdpr/export", (c) => {
	const user = getUserFromContext(c);
	if (!user) return c.text("Login required", 401);
	if (!checkRateLimitUser(user, `gdpr:${user.id}`, 3, 24 * 60 * 60 * 1000))
		return c.text("Too many export requests today. Try again tomorrow.", 429);
	const { soloScores, dailyScores, duelGames, submissions, suggestions, tickets, ticketReplies, roundScores, warnings, fingerprints } = collectGdprData(user.id);
	return c.json({
		account: {
			id: user.id,
			username: user.username,
			display_name: user.display_name,
			avatar_url: user.avatar_url,
			is_banned: !!user.is_banned,
			created_at: user.created_at,
		},
		solo_scores: soloScores,
		daily_scores: dailyScores,
		duel_games: duelGames,
		duel_round_scores: roundScores,
		submissions,
		suggestions,
		support_tickets: tickets,
		ticket_replies: ticketReplies,
		warnings,
		fingerprints,
		exported_at: new Date().toISOString(),
		export_version: 3,
	});
});

function deleteUserAccount(userId: number) {
	db.transaction(() => {
		db.run(
			`UPDATE users SET username = '[deleted]', display_name = NULL, avatar_url = NULL,
			discord_id = '[deleted:' || ? || ']', profile_private = 1 WHERE id = ?`,
			[userId, userId]
		);
		db.run("DELETE FROM sessions WHERE user_id = ?", [userId]);
		db.run("DELETE FROM solo_scores WHERE user_id = ?", [userId]);
		db.run("DELETE FROM daily_scores WHERE user_id = ?", [userId]);
		db.run("DELETE FROM duel_round_scores WHERE user_id = ?", [userId]);
		db.run("DELETE FROM duel_participants WHERE user_id = ?", [userId]);
		db.run("DELETE FROM fingerprints WHERE user_id = ?", [userId]);
		db.run("DELETE FROM support_tickets WHERE user_id = ?", [userId]);
		db.run("DELETE FROM location_suggestions WHERE user_id = ?", [userId]);
		db.run("DELETE FROM user_warnings WHERE user_id = ?", [userId]);
		db.run("UPDATE submissions SET submitted_by = NULL WHERE submitted_by = ?", [userId]);
	})();
}

app.delete("/api/account", async (c) => {
	const user = getUserFromContext(c);
	if (!user) return c.text("Login required", 401);
	const body = (await c.req.json().catch(() => ({}))) as { confirm?: unknown };
	if (body.confirm !== true) return c.text("Confirmation required", 400);
	deleteUserAccount(user.id);
	auditLog(null, "user_delete", { targetType: "user", targetId: user.id, targetUsername: user.username });
	clearSessionCookie(c);
	return c.json({ success: true });
});

app.get("/api/admin/users/:id/gdpr-export", (c) => {
	const actor = getOpUser(c);
	if (!actor) return c.text("Forbidden", 403);
	const userId = parseInt(c.req.param("id"));
	const target = db
		.query<
			{ id: number; username: string; display_name: string | null; avatar_url: string | null; is_banned: number; created_at: number },
			[number]
		>("SELECT id, username, display_name, avatar_url, is_banned, created_at FROM users WHERE id = ?")
		.get(userId);
	if (!target) return c.text("User not found", 404);
	const { soloScores, dailyScores, duelGames, submissions, suggestions, tickets, ticketReplies, roundScores, warnings, fingerprints } = collectGdprData(userId);
	auditLog(actor, "gdpr_export_operator", { targetType: "user", targetId: userId, targetUsername: target.username });
	return c.json({
		account: {
			id: target.id,
			username: target.username,
			display_name: target.display_name,
			avatar_url: target.avatar_url,
			is_banned: !!target.is_banned,
			created_at: target.created_at,
		},
		solo_scores: soloScores,
		daily_scores: dailyScores,
		duel_games: duelGames,
		duel_round_scores: roundScores,
		submissions,
		suggestions,
		support_tickets: tickets,
		ticket_replies: ticketReplies,
		warnings,
		fingerprints,
		exported_at: new Date().toISOString(),
		export_version: 3,
		exported_by_operator: actor.username,
	});
});

app.delete("/api/admin/users/:id/account", async (c) => {
	const actor = getOpUser(c);
	if (!actor) return c.text("Forbidden", 403);
	const userId = parseInt(c.req.param("id"));
	const target = db.query<{ username: string }, [number]>("SELECT username FROM users WHERE id = ?").get(userId);
	if (!target) return c.text("User not found", 404);
	deleteUserAccount(userId);
	auditLog(actor, "user_delete_operator", { targetType: "user", targetId: userId, targetUsername: target.username });
	return c.json({ success: true });
});

const TICKET_CATEGORIES = [
	"ban_appeal",
	"submission_appeal",
	"report_user",
	"report_location",
	"account",
	"other",
] as const;

app.post("/api/support", async (c) => {
	const user = getUserFromContext(c);
	if (!user) return c.text("Login required", 401);
	// Intentionally NOT blocking banned users - they need to be able to appeal
	if (!checkRateLimitUser(user, `support:${user.id}`, 3, 24 * 60 * 60 * 1000))
		return c.text("Too many tickets today. Try again tomorrow.", 429);

	const body = (await c.req.json().catch(() => ({}))) as { subject?: string; message?: string; category?: string };
	const subject = (body.subject || "").trim().slice(0, 100);
	const message = (body.message || "").trim().slice(0, 2000);
	const category = TICKET_CATEGORIES.includes(body.category as any) ? body.category : null;
	if (!category) return c.text("Invalid category", 400);
	if (subject.length < 5) return c.text("Subject must be at least 5 characters", 400);
	if (message.length < 20) return c.text("Message must be at least 20 characters", 400);

	const result = db.run("INSERT INTO support_tickets (user_id, subject, message, category) VALUES (?, ?, ?, ?)", [
		user.id,
		subject,
		message,
		category,
	]);
	sendDiscordWebhook(
		`🎫 **Support ticket #${result.lastInsertRowid}** [${category}] from **${user.display_name || user.username}**\n> **${subject}**\n> ${message.slice(0, 200)}${message.length > 200 ? "…" : ""}`,
		"support",
		"/admin#support"
	);
	return c.json({ success: true, id: result.lastInsertRowid });
});

app.get("/api/support/mine", (c) => {
	const user = getUserFromContext(c);
	if (!user) return c.text("Login required", 401);
	const rows = db
		.query(
			`
		SELECT t.id, t.subject, t.category, t.status, t.message, t.awaiting_staff, t.close_requested, t.created_at,
			COALESCE((SELECT JSON_GROUP_ARRAY(JSON_OBJECT(
				'id', tr.id, 'body', tr.body, 'type', tr.type,
				'author_username', tr.author_username, 'created_at', tr.created_at
			)) FROM ticket_replies tr WHERE tr.ticket_id = t.id ORDER BY tr.created_at ASC), '[]') AS replies
		FROM support_tickets t WHERE t.user_id = ? ORDER BY t.created_at DESC LIMIT 20
	`
		)
		.all(user.id) as any[];
	for (const r of rows) {
		try {
			r.replies = JSON.parse(r.replies);
		} catch {
			r.replies = [];
		}
	}
	return c.json(rows);
});

app.post("/api/support/:id/reply", async (c) => {
	const user = getUserFromContext(c);
	if (!user) return c.text("Login required", 401);
	const ticketId = parseInt(c.req.param("id"));
	const ticket = db
		.query<{ status: string; awaiting_staff: number }, [number, number]>(
			"SELECT status, awaiting_staff FROM support_tickets WHERE id = ? AND user_id = ?"
		)
		.get(ticketId, user.id);
	if (!ticket) return c.text("Not found", 404);
	if (ticket.status !== "open") return c.text("Ticket is closed", 400);
	const hasStaffReply = !!db
		.query<{ id: number }, [number]>("SELECT id FROM ticket_replies WHERE ticket_id = ? AND type = 'staff' LIMIT 1")
		.get(ticketId);
	if (!hasStaffReply) return c.text("Wait for staff to reply first", 400);
	if (ticket.awaiting_staff) return c.text("Wait for staff to reply before sending another message", 400);
	const body = (await c.req.json().catch(() => ({}))) as { message?: string };
	const message = body.message?.trim() ?? "";
	if (message.length < 5) return c.text("Message too short", 400);
	if (message.length > 2000) return c.text("Message too long", 400);
	db.run(
		"INSERT INTO ticket_replies (ticket_id, author_id, author_username, body, type) VALUES (?, ?, ?, ?, 'user')",
		[ticketId, user.id, user.username, message]
	);
	db.run("UPDATE support_tickets SET awaiting_staff = 1 WHERE id = ?", [ticketId]);
	return c.json({ success: true });
});

app.post("/api/support/:id/request-close", (c) => {
	const user = getUserFromContext(c);
	if (!user) return c.text("Login required", 401);
	const ticketId = parseInt(c.req.param("id"));
	const ticket = db
		.query<{ status: string; awaiting_staff: number }, [number, number]>(
			"SELECT status, awaiting_staff FROM support_tickets WHERE id = ? AND user_id = ?"
		)
		.get(ticketId, user.id);
	if (!ticket) return c.text("Not found", 404);
	if (ticket.status !== "open") return c.text("Ticket is already closed", 400);
	if (ticket.awaiting_staff) return c.text("Cannot request close while waiting for staff reply", 400);
	db.run("UPDATE support_tickets SET close_requested = 1, awaiting_staff = 1 WHERE id = ?", [ticketId]);
	return c.json({ success: true });
});

app.get("/api/admin/support", (c) => {
	const user = getModUser(c);
	if (!user) return c.text("Forbidden", 403);
	const status = c.req.query("status") || "open";
	const category = c.req.query("category") || "";
	const params: any[] = [status];
	let categoryClause = "";
	if (category && TICKET_CATEGORIES.includes(category as any)) {
		categoryClause = "AND t.category = ?";
		params.push(category);
	}
	const rows = db
		.query(
			`
		SELECT t.id, t.user_id, t.subject, t.message, t.category, t.status,
			t.awaiting_staff, t.close_requested, t.created_at,
			u.username, u.display_name, u.avatar_url, u.is_banned,
			COALESCE((SELECT JSON_GROUP_ARRAY(JSON_OBJECT(
				'id', tr.id, 'body', tr.body, 'type', tr.type,
				'author_username', tr.author_username, 'created_at', tr.created_at
			)) FROM ticket_replies tr WHERE tr.ticket_id = t.id ORDER BY tr.created_at ASC), '[]') AS replies
		FROM support_tickets t
		JOIN users u ON u.id = t.user_id
		WHERE t.status = ? ${categoryClause}
		ORDER BY t.created_at ASC
	`
		)
		.all(...params) as any[];
	for (const r of rows) {
		try {
			r.replies = JSON.parse(r.replies);
		} catch {
			r.replies = [];
		}
	}
	return c.json(rows);
});

app.get("/api/admin/support/counts", (c) => {
	const user = getModUser(c);
	if (!user) return c.text("Forbidden", 403);
	const counts = db
		.query(
			`
		SELECT status, category, COUNT(*) as count
		FROM support_tickets GROUP BY status, category
	`
		)
		.all();
	return c.json(counts);
});

app.post("/api/admin/support/:id/reply", async (c) => {
	const user = getModUser(c);
	if (!user) return c.text("Forbidden", 403);
	const id = parseInt(c.req.param("id"));
	const body = (await c.req.json().catch(() => ({}))) as { reply?: string; close?: boolean };
	const reply = (body.reply || "").trim().slice(0, 2000);
	const newStatus = body.close === true ? "closed" : "open";
	if (reply) {
		db.run(
			"INSERT INTO ticket_replies (ticket_id, author_id, author_username, body, type) VALUES (?, ?, ?, ?, 'staff')",
			[id, user.id, user.username, reply]
		);
	}
	db.run("UPDATE support_tickets SET status = ?, awaiting_staff = 0, close_requested = 0 WHERE id = ?", [
		newStatus,
		id,
	]);
	auditLog(user, reply ? "ticket_reply" : "ticket_close", {
		targetType: "ticket",
		targetId: id,
		details: reply ? reply.slice(0, 100) : undefined,
	});
	return c.json({ success: true });
});

app.post("/api/admin/support/:id/close", (c) => {
	const user = getModUser(c);
	if (!user) return c.text("Forbidden", 403);
	const id = parseInt(c.req.param("id"));
	db.run("UPDATE support_tickets SET status = 'closed', replied_by = ?, replied_at = unixepoch() WHERE id = ?", [
		user.id,
		id,
	]);
	auditLog(user, "ticket_close", { targetType: "ticket", targetId: id });
	return c.json({ success: true });
});

app.delete("/api/admin/support/:id", (c) => {
	const user = getOpUser(c);
	if (!user) return c.text("Forbidden", 403);
	const id = parseInt(c.req.param("id"));
	const ticket = db.query<{ status: string }, [number]>("SELECT status FROM support_tickets WHERE id = ?").get(id);
	if (!ticket) return c.text("Not found", 404);
	if (ticket.status !== "closed") return c.text("Can only delete closed tickets", 400);
	db.run("DELETE FROM support_tickets WHERE id = ?", [id]);
	auditLog(user, "ticket_delete", { targetType: "ticket", targetId: id });
	return c.json({ success: true });
});

app.post("/api/admin/support/cleanup", (c) => {
	const user = getOpUser(c);
	if (!user) return c.text("Forbidden", 403);
	const sixMonthsAgo = Math.floor(Date.now() / 1000) - 180 * 24 * 60 * 60;
	const result = db.run("DELETE FROM support_tickets WHERE status = 'closed' AND created_at < ?", [sixMonthsAgo]);
	auditLog(user, "ticket_cleanup", { details: `${result.changes} tickets removed` });
	return c.json({ deleted: result.changes });
});

app.post("/api/admin/support/:id/reopen", (c) => {
	const user = getModUser(c);
	if (!user) return c.text("Forbidden", 403);
	const id = parseInt(c.req.param("id"));
	db.run("UPDATE support_tickets SET status = 'open' WHERE id = ?", [id]);
	auditLog(user, "ticket_reopen", { targetType: "ticket", targetId: id });
	return c.json({ success: true });
});

app.get("/api/locations", (c) => {
	const rows = db
		.query<{ id: number; image_path: string; label: string | null }, []>(
			"SELECT id, image_path, label FROM locations WHERE is_active = 1 ORDER BY created_at DESC"
		)
		.all();
	return c.json(rows);
});

app.get("/api/locations/with-coords", (c) => {
	const user = getUserFromContext(c);
	if (!user) return c.json({ error: "Login required" }, 401);
	const rows = db
		.query<{ id: number; image_path: string; label: string | null; world_x: number; world_y: number }, []>(
			"SELECT id, image_path, label, world_x, world_y FROM locations WHERE is_active = 1 ORDER BY created_at DESC"
		)
		.all();
	return c.json(rows);
});

app.post("/api/suggestions/agree", (c) => {
	const user = getUserFromContext(c);
	if (!user) return c.text("Login required", 401);
	db.run("UPDATE users SET suggestions_agreed = 1, suggestions_agreed_at = unixepoch() WHERE id = ?", [user.id]);
	return c.json({ success: true });
});

app.post("/api/locations/:id/suggest", async (c) => {
	const user = getUserFromContext(c);
	if (!user) return c.text("Login required", 401);
	if (isBanned(user)) return c.text("You are banned", 403);

	const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
	if (user.created_at > thirtyDaysAgo)
		return c.text("Your account must be at least 30 days old to suggest improvements", 403);

	const gamesRow = db
		.query<{ total: number }, [number, number]>(
			"SELECT (SELECT COUNT(*) FROM solo_scores WHERE user_id = ?) + (SELECT COUNT(*) FROM daily_scores WHERE user_id = ?) AS total"
		)
		.get(user.id, user.id);
	if ((gamesRow?.total ?? 0) < 5) return c.text("You must have played at least 5 games to suggest improvements", 403);

	if (!user.suggestions_agreed) return c.text("You must agree to the suggestions policy first", 403);

	if (!checkRateLimitUser(user, `suggest:${user.id}`, 10, 60 * 60 * 1000))
		return c.text("Too many suggestions. Try again later.", 429);

	const locId = parseInt(c.req.param("id"));
	const loc = db
		.query<{ id: number; label: string | null }, [number]>(
			"SELECT id, label FROM locations WHERE id = ? AND is_active = 1"
		)
		.get(locId);
	if (!loc) return c.text("Location not found", 404);

	const contentType = c.req.header("content-type") || "";

	if (contentType.includes("multipart/form-data")) {
		let formData: FormData;
		try {
			formData = await c.req.formData();
		} catch {
			return c.text("Invalid form data", 400);
		}

		const sugType = ((formData.get("type") as string) || "screenshot").trim();

		if (sugType === "full_edit") {
			const file = formData.get("image") as File | null;
			const rawWorldX = formData.get("world_x") as string | null;
			const rawWorldY = formData.get("world_y") as string | null;
			const rawHints = formData.get("hints") as string | null;
			const newLabel = ((formData.get("label") as string) || "").trim().slice(0, 100) || null;
			const note = ((formData.get("note") as string) || "").trim().slice(0, 200) || null;

			const world_x = rawWorldX !== null ? parseFloat(rawWorldX) : null;
			const world_y = rawWorldY !== null ? parseFloat(rawWorldY) : null;
			let hints: string[] = [];
			try {
				const p = JSON.parse(rawHints || "[]");
				if (Array.isArray(p)) hints = p.map(String).filter(Boolean).slice(0, 3);
			} catch {}

			if (!file && world_x === null && !hints.length && !newLabel)
				return c.text("At least one change is required", 400);

			let filename: string | null = null;
			if (file && file instanceof File) {
				if (file.size > 8 * 1024 * 1024) return c.text("File too large (max 8MB)", 400);
				const rawBuffer = Buffer.from(await file.arrayBuffer());
				let imgData: Buffer;
				let ext: string;
				try {
					({ data: imgData, ext } = await processUploadedImage(rawBuffer));
				} catch (err: unknown) {
					return c.text(`Invalid image: ${err instanceof Error ? err.message : "unknown error"}`, 400);
				}
				filename = `${randomBytes(16).toString("hex")}.${ext}`;
				await writeFile(`./public/uploads/${filename}`, imgData);
			}

			const content = JSON.stringify({ world_x, world_y, hints, label: newLabel, note });
			db.run(
				"INSERT INTO location_suggestions (location_id, user_id, type, content, image_path) VALUES (?, ?, 'full_edit', ?, ?)",
				[locId, user.id, content, filename]
			);
			sendDiscordWebhook(
				`💡 **Full edit suggestion** on "${loc.label || `#${locId}`}" by **${user.display_name || user.username}**${note ? `\n> ${note}` : ""}`,
				"suggestions",
				"/admin#suggestions"
			);
			return c.json({ success: true });
		}

		const file = formData.get("image") as File | null;
		const note = ((formData.get("note") as string) || "").trim().slice(0, 200) || null;
		if (!file || !(file instanceof File)) return c.text("Image required", 400);
		if (file.size > 8 * 1024 * 1024) return c.text("File too large (max 8MB)", 400);

		const rawBuffer = Buffer.from(await file.arrayBuffer());
		let imgData: Buffer;
		let ext: string;
		try {
			({ data: imgData, ext } = await processUploadedImage(rawBuffer));
		} catch (err: unknown) {
			return c.text(`Invalid image: ${err instanceof Error ? err.message : "unknown error"}`, 400);
		}

		const filename = `${randomBytes(16).toString("hex")}.${ext}`;
		await writeFile(`./public/uploads/${filename}`, imgData);
		db.run(
			"INSERT INTO location_suggestions (location_id, user_id, type, content, image_path) VALUES (?, ?, 'screenshot', ?, ?)",
			[locId, user.id, JSON.stringify({ note }), filename]
		);
		sendDiscordWebhook(
			`💡 **Screenshot suggestion** on "${loc.label || `#${locId}`}" by **${user.display_name || user.username}**${note ? `\n> ${note}` : ""}`,
			"suggestions",
			"/admin#suggestions"
		);
		return c.json({ success: true });
	}

	const body = (await c.req.json().catch(() => ({}))) as {
		type?: string;
		text?: string;
		world_x?: number;
		world_y?: number;
		note?: string;
		reason?: string;
	};
	if (!body.type || !["hint", "coordinates", "removal"].includes(body.type))
		return c.text("Invalid suggestion type", 400);

	if (body.type === "hint") {
		const text = (body.text || "").trim().slice(0, 200);
		if (!text) return c.text("Hint text required", 400);
		db.run("INSERT INTO location_suggestions (location_id, user_id, type, content) VALUES (?, ?, 'hint', ?)", [
			locId,
			user.id,
			JSON.stringify({ text }),
		]);
		sendDiscordWebhook(
			`💡 **Hint suggestion** on "${loc.label || `#${locId}`}" by **${user.display_name || user.username}**\n> "${text}"`,
			"suggestions",
			"/admin#suggestions"
		);
	} else if (body.type === "coordinates") {
		if (typeof body.world_x !== "number" || typeof body.world_y !== "number")
			return c.text("Coordinates required", 400);
		const note = (body.note || "").trim().slice(0, 200) || null;
		db.run(
			"INSERT INTO location_suggestions (location_id, user_id, type, content) VALUES (?, ?, 'coordinates', ?)",
			[locId, user.id, JSON.stringify({ world_x: body.world_x, world_y: body.world_y, note })]
		);
		sendDiscordWebhook(
			`💡 **Coordinates correction** on "${loc.label || `#${locId}`}" by **${user.display_name || user.username}**${note ? `\n> ${note}` : ""}`,
			"suggestions",
			"/admin#suggestions"
		);
	} else if (body.type === "removal") {
		const reason = (body.reason || "").trim().slice(0, 300);
		if (!reason) return c.text("Reason required", 400);
		db.run("INSERT INTO location_suggestions (location_id, user_id, type, content) VALUES (?, ?, 'removal', ?)", [
			locId,
			user.id,
			JSON.stringify({ reason }),
		]);
		sendDiscordWebhook(
			`🗑️ **Removal suggestion** on "${loc.label || `#${locId}`}" by **${user.display_name || user.username}**\n> "${reason}"`,
			"suggestions",
			"/admin#suggestions"
		);
	}

	return c.json({ success: true });
});

app.get("/api/admin/suggestions", (c) => {
	const user = getModUser(c);
	if (!user) return c.text("Forbidden", 403);
	const rows = db
		.query(
			`
		SELECT ls.*, u.username, u.display_name, u.avatar_url,
			l.label as location_label, l.image_path as location_image
		FROM location_suggestions ls
		JOIN users u ON u.id = ls.user_id
		JOIN locations l ON l.id = ls.location_id
		WHERE ls.status = 'pending'
		ORDER BY ls.created_at ASC
	`
		)
		.all();
	return c.json(rows);
});

app.post("/api/admin/suggestions/:id/approve", async (c) => {
	const user = getModUser(c);
	if (!user) return c.text("Forbidden", 403);
	const id = parseInt(c.req.param("id"));

	const sug = db
		.query<
			{
				id: number;
				location_id: number;
				user_id: number;
				type: string;
				content: string | null;
				image_path: string | null;
				username: string | null;
				location_label: string | null;
			},
			[number]
		>(
			`
		SELECT ls.*, u.username, l.label as location_label
		FROM location_suggestions ls
		JOIN users u ON u.id = ls.user_id
		JOIN locations l ON l.id = ls.location_id
		WHERE ls.id = ? AND ls.status = 'pending'
	`
		)
		.get(id);
	if (!sug) return c.text("Not found", 404);

	let content: Record<string, unknown> = {};
	try {
		content = JSON.parse(sug.content || "{}");
	} catch {}

	if (sug.type === "hint") {
		const text = content.text as string;
		const loc = db
			.query<{ hints: string }, [number]>("SELECT hints FROM locations WHERE id = ?")
			.get(sug.location_id);
		if (loc) {
			let hints: string[] = [];
			try {
				hints = JSON.parse(loc.hints || "[]");
			} catch {}
			if (!hints.includes(text)) {
				hints.push(text);
				db.run("UPDATE locations SET hints = ? WHERE id = ?", [
					JSON.stringify(hints.slice(0, 3)),
					sug.location_id,
				]);
			}
		}
		sendDiscordWebhook(
			`✅ **Hint suggestion approved** on "${sug.location_label || `#${sug.location_id}`}" by **${user.display_name || user.username}**\n> "${text}"`,
			"suggestions",
			"/admin#suggestions"
		);
	} else if (sug.type === "screenshot" && sug.image_path) {
		const old = db
			.query<{ image_path: string }, [number]>("SELECT image_path FROM locations WHERE id = ?")
			.get(sug.location_id);
		db.run("UPDATE locations SET image_path = ? WHERE id = ?", [sug.image_path, sug.location_id]);
		if (old) {
			try {
				await unlink(`./public/uploads/${old.image_path}`);
			} catch {}
		}
		sendDiscordWebhook(
			`✅ **Screenshot suggestion approved** on "${sug.location_label || `#${sug.location_id}`}" by **${user.display_name || user.username}**`,
			"suggestions",
			"/admin#suggestions"
		);
	} else if (sug.type === "coordinates") {
		const wx = content.world_x as number;
		const wy = content.world_y as number;
		db.run("UPDATE locations SET world_x = ?, world_y = ? WHERE id = ?", [wx, wy, sug.location_id]);
		sendDiscordWebhook(
			`✅ **Coordinates correction approved** on "${sug.location_label || `#${sug.location_id}`}" by **${user.display_name || user.username}**`,
			"suggestions",
			"/admin#suggestions"
		);
	}

	db.run(
		"UPDATE location_suggestions SET status = 'approved', reviewed_by = ?, reviewed_at = unixepoch() WHERE id = ?",
		[user.id, id]
	);
	auditLog(user, "suggestion_approve", {
		targetType: "suggestion",
		targetId: id,
		details: `${sug.type} on ${sug.location_label || `#${sug.location_id}`}`,
	});
	return c.json({ success: true });
});

app.post("/api/admin/suggestions/:id/deny", async (c) => {
	const user = getModUser(c);
	if (!user) return c.text("Forbidden", 403);
	const id = parseInt(c.req.param("id"));
	const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
	const sug = db
		.query<{ type: string; image_path: string | null }, [number]>(
			"SELECT type, image_path FROM location_suggestions WHERE id = ?"
		)
		.get(id);
	const sugDenyResult = db.run(
		"UPDATE location_suggestions SET status = 'denied', reviewed_by = ?, reviewed_at = unixepoch(), deny_reason = ? WHERE id = ? AND status = 'pending'",
		[user.id, body.reason || null, id]
	);
	if (sugDenyResult.changes > 0 && sug?.image_path) {
		try {
			await unlink(`./public/uploads/${sug.image_path}`);
		} catch {}
	}
	auditLog(user, "suggestion_deny", { targetType: "suggestion", targetId: id, details: body.reason || undefined });
	return c.json({ success: true });
});

app.get("/api/admin/audit", (c) => {
	const user = getSeniorUser(c);
	if (!user) return c.text("Forbidden", 403);
	const limit = Math.min(200, parseInt(c.req.query("limit") || "100"));
	const offset = Math.max(0, parseInt(c.req.query("offset") || "0"));
	const action = c.req.query("action") || "";
	const actions = c.req.query("actions") || "";
	const actorId = c.req.query("actor") || "";
	const targetType = c.req.query("target_type") || "";
	const targetId = c.req.query("target_id") || "";
	const from = c.req.query("from") || "";
	const to = c.req.query("to") || "";
	const search = (c.req.query("q") || "").trim().replace(/#/g, "").slice(0, 100);
	const params: (string | number)[] = [];
	const clauses: string[] = [];
	if (action) {
		clauses.push("a.action = ?");
		params.push(action);
	} else if (actions) {
		const list = actions
			.split(",")
			.map((a) => a.trim())
			.filter(Boolean)
			.slice(0, 20);
		if (list.length === 1) {
			clauses.push("a.action = ?");
			params.push(list[0]);
		} else if (list.length > 1) {
			clauses.push(`a.action IN (${list.map(() => "?").join(",")})`);
			params.push(...list);
		}
	}
	if (actorId) {
		clauses.push("a.actor_id = ?");
		params.push(parseInt(actorId));
	}
	if (targetType) {
		clauses.push("a.target_type = ?");
		params.push(targetType);
	}
	if (targetId) {
		clauses.push("a.target_id = ?");
		params.push(parseInt(targetId));
	}
	if (from) {
		const ts = Math.floor(new Date(from).getTime() / 1000);
		if (!isNaN(ts)) {
			clauses.push("a.created_at >= ?");
			params.push(ts);
		}
	}
	if (to) {
		const ts = Math.floor(new Date(to).getTime() / 1000);
		if (!isNaN(ts)) {
			clauses.push("a.created_at <= ?");
			params.push(ts);
		}
	}
	if (search) {
		const pattern = `%${search}%`;
		clauses.push(
			"(CAST(a.id AS TEXT) LIKE ? OR CAST(a.actor_id AS TEXT) LIKE ? OR a.actor_username LIKE ? OR a.action LIKE ? OR a.target_type LIKE ? OR CAST(a.target_id AS TEXT) LIKE ? OR a.target_username LIKE ? OR a.details LIKE ?)"
		);
		params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern);
	}
	const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
	const rows = db
		.query(
			`
		SELECT a.* FROM audit_log a
		${where}
		ORDER BY a.created_at DESC
		LIMIT ? OFFSET ?
	`
		)
		.all(...params, limit, offset);
	const total =
		db.query<{ n: number }, []>(`SELECT COUNT(*) as n FROM audit_log a ${where}`).get(...(params as []))?.n ?? 0;
	return c.json({ rows, total, limit, offset });
});

app.notFound((c) => {
	const path = c.req.path;
	if (path.startsWith("/api/")) return c.json({ error: "Not found" }, 404);
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Page not found | Dovedale GeoGuesser</title>
  <script src="https://cdn.tailwindcss.com/3.4.16"></script>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0..1,0&family=Inter:opsz,wght@14..32,200..700" />
  <link rel="stylesheet" href="/shared.css?v=2" />
</head>
<body class="bg-zinc-950 text-zinc-100 font-[Inter] min-h-screen flex flex-col items-center justify-center px-6 text-center">
  <div class="max-w-md w-full">
    <div class="inline-flex items-center justify-center w-20 h-20 rounded-3xl bg-zinc-900 border border-zinc-800 mb-6">
      <span class="material-symbols-outlined text-5xl text-zinc-500" style="font-variation-settings:'FILL' 1">explore_off</span>
    </div>
    <div class="text-7xl font-bold font-mono text-blue-500 mb-3">404</div>
    <h1 class="text-2xl font-bold mb-2">Page not found</h1>
    <p class="text-zinc-500 text-sm mb-8">The page you're looking for doesn't exist or may have been moved.</p>
    <div class="flex gap-3 justify-center flex-wrap">
      <a href="/" class="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-500 transition px-6 py-2.5 rounded-full font-semibold text-sm shadow-sm">
        <span class="material-symbols-outlined text-base leading-none">home</span> Return Home
      </a>
      <button onclick="history.length > 1 ? history.back() : location.assign('/')" class="inline-flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 transition px-6 py-2.5 rounded-full font-semibold text-sm border border-zinc-700">
        <span class="material-symbols-outlined text-base leading-none">arrow_back</span> Go Back
      </button>
    </div>
  </div>
</body>
</html>`;
	return c.html(html, 404);
});

export default {
	fetch: app.fetch,
	port: PORT,
	websocket,
	idleTimeout: 60,
};
