import { join } from "path";

function list(value: string | undefined): string[] {
	return (value || "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

export const ROOT_DIR = join(import.meta.dir, "..");
export const PUBLIC_DIR = join(ROOT_DIR, "public");
export const DATA_DIR = process.env.DATA_DIR || join(ROOT_DIR, "data");
export const UPLOADS_DIR = process.env.UPLOADS_DIR || join(PUBLIC_DIR, "uploads");

export const PORT = Number(process.env.PORT) || 4000;
/** Public-facing origin without a trailing slash, or "" when unset. */
export const SITE_URL = (process.env.SITE_URL || "").replace(/\/+$/, "");
/** Bypasses Discord OAuth with a local operator account. Never enable in production. */
export const DEV_MODE = process.env.AUTH_DEV === "true";
export const SECURE_COOKIES = process.env.NODE_ENV === "production" || !!SITE_URL;

export const DISCORD = {
	clientId: process.env.DISCORD_CLIENT_ID,
	clientSecret: process.env.DISCORD_CLIENT_SECRET,
	redirectUri: process.env.DISCORD_REDIRECT_URI,
	webhookUrl: process.env.DISCORD_WEBHOOK_URL,
	webhookEvents: new Set(list((process.env.WEBHOOK_EVENTS || "all").toLowerCase())),
};

/** Web Push keys (generate with `bun run vapid`). Push is off when they are not set. */
export const PUSH = {
	publicKey: process.env.VAPID_PUBLIC_KEY || "",
	privateKey: process.env.VAPID_PRIVATE_KEY || "",
	subject: process.env.VAPID_SUBJECT || SITE_URL || "mailto:admin@localhost",
};

export const OPERATOR_IDS = list(process.env.OPERATOR_IDS);
export const MODERATOR_IDS = list(process.env.MODERATOR_IDS);

/** discord_id of the fake account used when DEV_MODE is on. */
export const DEV_DISCORD_ID = "0";

export const LIMITS = {
	labelMin: 5,
	labelMax: 128,
	/** Staff may shorten a label when editing an existing location. */
	labelEditMin: 2,
	hintsPerLocation: 3,
	hintLength: 200,
	uploadBytes: 8 * 1024 * 1024,
};

export const GAME = {
	maxRoundScore: 5000,
	hintCost: 500,
	/** Seconds of slack given to a guess that arrives after the round timer ran out. */
	lateGuessGrace: 5,
	/** Longest a round waits for players to load its screenshot before the clock starts anyway. */
	loadingWindow: 6,
	solo: {
		rounds: [3, 5, 10],
		defaultRounds: 5,
		timeLimits: [0, 30, 60, 90, 120],
		defaultTimeLimit: 90,
	},
	daily: { timeLimit: 90 },
	duel: {
		roundTime: 60,
		maxTimeBonus: 1000,
		minRounds: 1,
		maxRounds: 10,
		defaultRounds: 5,
		/** Quick Play duels are all this long, so any two players in the queue can be matched. */
		quickplayRounds: 6,
		/** Quick Play wins in a row before the streak flame shows beside a player's name. */
		streakShown: 3,
		startCountdown: 3,
		resultDelay: 7,
		finalResultDelay: 5,
		maxSpectators: 50,
		/** How long a duel stays paused waiting for a disconnected player before they forfeit. */
		reconnectWindow: 30,
		/** Countdown shown to everyone before a paused duel carries on. */
		resumeCountdown: 3,
		/** Disconnects a player may have in one duel before the next one forfeits it. */
		maxDisconnects: 4,
		/** Reactions a player may send, as Material Symbols names. The page shows them in this order. */
		emotes: [
			"waving_hand",
			"thumb_up",
			"handshake",
			"celebration",
			"local_fire_department",
			"favorite",
			"sentiment_very_satisfied",
			"sentiment_dissatisfied",
			"psychology_alt",
			"bolt",
			"rocket_launch",
			"skull",
		],
		/** Quick Play: totals this close after the last round are settled by one sudden-death round. */
		suddenDeathMargin: 100,
		/** Quick Play: a player this far behind going into the last round scores double in it. */
		comebackGap: 5000,
		/** Shortest gap between two reactions from the same player, in milliseconds. */
		emoteCooldownMs: 1500,
	},
	/** Elo ratings for Quick Play duels. */
	rating: {
		start: 1000,
		floor: 100,
		k: 24,
		/** A new player's rating moves faster for their first few rated duels. */
		kProvisional: 40,
		provisionalGames: 10,
	},
	/** How a location is graded from the average distance score players get on it. */
	difficulty: {
		/** Guesses needed before a location is graded at all. */
		minPlays: 8,
		/** The grade follows about this many of the latest guesses, so a much-played location can still change. */
		window: 60,
		/** An average at or above this is easy; below `hardBelow` is hard; in between is medium. */
		easyFrom: 3200,
		hardBelow: 1600,
	},
	restart: {
		/** Longest warning before a planned restart while matches run, in seconds. */
		notice: 180,
		/** The warning when nobody is playing, and the last call once every game has finished. */
		quietNotice: 10,
	},
};
