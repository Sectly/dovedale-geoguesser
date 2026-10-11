import { db } from "../db";

/**
 * Switches for parts of the site that staff may need to turn off in a hurry without a
 * release. Kept in the database, so they survive restarts.
 */

export type Features = {
	/** The preset reactions players can send each other during a duel. */
	duel_emotes: boolean;
};

const KEY = "features";
const DEFAULTS: Features = { duel_emotes: true };

function load(): Features {
	try {
		const row = db.query<{ value: string }, [string]>("SELECT value FROM app_settings WHERE key = ?").get(KEY);
		const stored = row ? JSON.parse(row.value) : {};
		return { duel_emotes: typeof stored.duel_emotes === "boolean" ? stored.duel_emotes : DEFAULTS.duel_emotes };
	} catch {
		return { ...DEFAULTS };
	}
}

let current = load();

export function features(): Features {
	return current;
}

export function setFeature(name: keyof Features, enabled: boolean): Features {
	current = { ...current, [name]: enabled };
	db.run(
		"INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		[KEY, JSON.stringify(current)]
	);
	return current;
}

export function isFeature(name: unknown): name is keyof Features {
	return typeof name === "string" && name in DEFAULTS;
}
