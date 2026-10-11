import type { User } from "./db";
import { isStaff } from "./auth/guards";
import type { RoundRules } from "./game/round";

/**
 * The Specials hub: side modes, mini-games, experiments and limited-time events.
 * Everything in it needs a login. To add something, add an entry to SPECIALS and
 * either point `href` at its page or, for a twist on solo, add its rules to
 * SPECIAL_MODES and link to /play?special=<id>.
 */

export type SpecialKind = "mode" | "minigame" | "experiment" | "event";

/** How a solo-style special changes the screenshot. Drawn by public/js/photo-effects.js. */
export type PhotoEffect = "torch" | "snow";

export type SeasonTheme = "newyear" | "valentines" | "easter" | "halloween" | "bonfire" | "christmas";

export type Special = {
	id: string;
	title: string;
	blurb: string;
	/** A Material Symbols icon name. */
	icon: string;
	kind: SpecialKind;
	href: string;
	/** A one-off window, as ISO dates. */
	startsAt?: string;
	endsAt?: string;
	/** A window that comes round every year, as "MM-DD" (inclusive). May run over New Year. */
	season?: { from: string; to: string };
	/** While this special is running, the homepage is dressed for the occasion. */
	theme?: SeasonTheme;
	/** Only staff see it: for trying things out before everyone gets them. */
	staffOnly?: boolean;
	effect?: PhotoEffect;
};

export const SPECIALS: Special[] = [
	{
		id: "teams",
		title: "Team Duels",
		blurb: "Two against two. You see your teammate's pin as they place it, and each round your team scores its best guess.",
		icon: "groups",
		kind: "mode",
		href: "/specials/teams",
	},
	{
		id: "night-shift",
		title: "Night Shift",
		blurb: "The lights are out. All you have is a torch: sweep it over the screenshot and work out where you are.",
		icon: "flashlight_on",
		kind: "event",
		href: "/play?special=night-shift",
		season: { from: "10-24", to: "11-02" },
		theme: "halloween",
		effect: "torch",
	},
	{
		id: "snowed-in",
		title: "Snowed In",
		blurb: "The screenshot is buried in snow. Wipe it away to see what is underneath, but you can only clear so much.",
		icon: "ac_unit",
		kind: "event",
		href: "/play?special=snowed-in",
		season: { from: "12-01", to: "01-05" },
		theme: "christmas",
		effect: "snow",
	},
	{
		id: "blitz",
		title: "Blitz",
		blurb: "Five rounds, fifteen seconds each, no hints. Faster guesses score more.",
		icon: "bolt",
		kind: "experiment",
		href: "/play?special=blitz",
	},
	{
		id: "memory",
		title: "Memory Match",
		blurb: "Find the matching pairs of screenshots in as few turns as you can.",
		icon: "style",
		kind: "minigame",
		href: "/specials/memory",
	},
	{
		id: "reflex",
		title: "Signal Reflex",
		blurb: "Wait for the signal to clear, then hit it as fast as you can.",
		icon: "traffic",
		kind: "minigame",
		href: "/specials/reflex",
	},
];

const NO_HINTS = (timeLimit: number, maxTimeBonus = 0): RoundRules => ({
	timeLimit,
	hintCost: 0,
	hints: false,
	maxTimeBonus,
});

/** Solo with different rules. Scores from these never reach the leaderboard. */
export const SPECIAL_MODES: Record<string, { rounds: number; rules: RoundRules }> = {
	blitz: { rounds: 5, rules: NO_HINTS(15, 1000) },
	"night-shift": { rounds: 5, rules: NO_HINTS(75) },
	"snowed-in": { rounds: 5, rules: NO_HINTS(75) },
};

const DAY_MS = 86_400_000;

/** When a special runs, as timestamps: its one-off dates, or the nearest turn of its yearly season. */
function windowOf(special: Special, now: number): { start: number | null; end: number | null } {
	if (!special.season) {
		return {
			start: special.startsAt ? Date.parse(special.startsAt) : null,
			end: special.endsAt ? Date.parse(special.endsAt) : null,
		};
	}
	const year = new Date(now).getUTCFullYear();
	const on = (y: number, monthDay: string) => Date.parse(`${y}-${monthDay}T00:00:00Z`);
	const overNewYear = special.season.to < special.season.from;
	// The season that started last year (if it runs over New Year), this year's, then next year's.
	for (const y of [year - 1, year, year + 1]) {
		const start = on(y, special.season.from);
		const end = on(overNewYear ? y + 1 : y, special.season.to) + DAY_MS;
		if (now < end) return { start, end };
	}
	return { start: null, end: null };
}

type Listed = Special & { status: "live" | "upcoming"; preview: boolean };

/**
 * What this user can see right now: live entries first, then what is coming. Staff may
 * open an upcoming special early (`preview`) to check it before players get it.
 */
export function specialsFor(user: User, now = Date.now()): Listed[] {
	const listed: Listed[] = [];
	for (const special of SPECIALS) {
		if (special.staffOnly && !isStaff(user)) continue;
		const { start, end } = windowOf(special, now);
		if (end !== null && end <= now) continue;
		const upcoming = start !== null && start > now;
		listed.push({
			...special,
			startsAt: start === null ? undefined : new Date(start).toISOString(),
			endsAt: end === null ? undefined : new Date(end).toISOString(),
			status: upcoming ? "upcoming" : "live",
			preview: upcoming && isStaff(user),
		});
	}
	return listed.sort((a, b) => Number(a.status === "upcoming") - Number(b.status === "upcoming"));
}

/** The special if this user may play it right now (it is running, or they are staff previewing it). */
export function liveSpecial(id: string, user: User): Special | null {
	return specialsFor(user).find((s) => s.id === id && (s.status === "live" || s.preview)) ?? null;
}

type SeasonWindow =
	| { from: string; to: string }
	/** Days relative to Easter Sunday, which moves every year. */
	| { easter: [from: number, to: number] };

/**
 * Times of year the homepage dresses up for. They need no special of their own: where a
 * special shares the theme and is running, the homepage points at it as well. Earlier
 * entries win when two overlap (New Year falls inside the Christmas season).
 */
export const SEASONS: { theme: SeasonTheme; splash: string; when: SeasonWindow }[] = [
	{ theme: "newyear", splash: "Happy New Year!", when: { from: "12-31", to: "01-02" } },
	{ theme: "valentines", splash: "Happy Valentine's Day!", when: { from: "02-13", to: "02-15" } },
	{ theme: "easter", splash: "Happy Easter!", when: { easter: [-2, 1] } },
	{ theme: "halloween", splash: "Happy Halloween!", when: { from: "10-24", to: "11-02" } },
	{ theme: "bonfire", splash: "Remember, remember!", when: { from: "11-04", to: "11-06" } },
	{ theme: "christmas", splash: "Merry Christmas!", when: { from: "12-01", to: "01-05" } },
];

/** Easter Sunday (Gregorian) for a year, at midnight UTC. */
export function easterSunday(year: number): number {
	const a = year % 19;
	const b = Math.floor(year / 100);
	const c = year % 100;
	const d = Math.floor(b / 4);
	const e = b % 4;
	const g = Math.floor((8 * b + 13) / 25);
	const h = (19 * a + b - d - g + 15) % 30;
	const i = Math.floor(c / 4);
	const k = c % 4;
	const l = (32 + 2 * e + 2 * i - h - k) % 7;
	const m = Math.floor((a + 11 * h + 19 * l) / 433);
	const month = Math.floor((h + l - 7 * m + 90) / 25);
	const day = (h + l - 7 * m + 33 * month + 19) % 32 || 1;
	return Date.UTC(year, month - 1, day);
}

function inSeason(when: SeasonWindow, now: number): boolean {
	if ("easter" in when) {
		const sunday = easterSunday(new Date(now).getUTCFullYear());
		return now >= sunday + when.easter[0] * DAY_MS && now < sunday + (when.easter[1] + 1) * DAY_MS;
	}
	const { start, end } = windowOf({ season: when } as Special, now);
	return start !== null && end !== null && now >= start && now < end;
}

/**
 * What the homepage should wear right now, if anything, and the seasonal special to
 * point at when one is running. Entirely by the calendar: nothing has to be switched on.
 * `preview` names a theme to show regardless of the date, for checking how it looks.
 */
export function currentSeason(now = Date.now(), preview?: string) {
	const season = SEASONS.find((s) => (preview ? s.theme === preview : inSeason(s.when, now)));
	if (!season) return null;
	const special = SPECIALS.find((s) => {
		if (s.theme !== season.theme || s.staffOnly) return false;
		const { start, end } = windowOf(s, now);
		return (start === null || now >= start) && (end === null || now < end);
	});
	return {
		theme: season.theme,
		splash: season.splash,
		event: special
			? {
					title: special.title,
					blurb: special.blurb,
					icon: special.icon,
					href: special.href,
					ends_at: special.season ? new Date(windowOf(special, now).end!).toISOString() : null,
				}
			: null,
	};
}
