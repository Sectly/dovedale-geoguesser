import { isFullStaff } from "../auth/guards";
import { db, type User } from "../db";
import { fail } from "../lib/http";

/** Switches for turning parts of the site off without a release. Stored in the database. */

const DEFAULTS = {
	duel_emotes: true,
	submissions: true,
	suggestions: true,
	/** Starting new duels and team games. Ones already open carry on. */
	new_duels: true,
	signups: true,
	/** Emailed notification summaries. Off until an operator has saved a mail server and switched it on. */
	email_digests: false,
};

export type Features = typeof DEFAULTS;
export type Feature = keyof Features;

const KEY = "features";

function load(): Features {
	const state = { ...DEFAULTS };
	try {
		const row = db.query<{ value: string }, [string]>("SELECT value FROM app_settings WHERE key = ?").get(KEY);
		const stored = row ? JSON.parse(row.value) : {};
		for (const name of Object.keys(state) as Feature[])
			if (typeof stored[name] === "boolean") state[name] = stored[name];
	} catch {}
	return state;
}

let current = load();

export function features(): Features {
	return current;
}

export function setFeature(name: Feature, enabled: boolean): Features {
	current = { ...current, [name]: enabled };
	db.run(
		"INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		[KEY, JSON.stringify(current)]
	);
	return current;
}

export function isFeature(name: unknown): name is Feature {
	return typeof name === "string" && name in DEFAULTS;
}

/** Refuses players while a feature is off. Staff (not helpers) may still use it. */
export function requireFeature(name: Feature, user: User, message: string) {
	if (!current[name] && !isFullStaff(user)) fail(503, message);
}
