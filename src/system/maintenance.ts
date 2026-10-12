import { db } from "../db";

/** Maintenance mode: only staff can use the site. Stored in the database, so it survives restarts. */

export type Maintenance = { enabled: boolean; message: string; since: number | null; by: string | null };

const KEY = "maintenance";
const OFF: Maintenance = { enabled: false, message: "", since: null, by: null };
export const MAINTENANCE_MESSAGE_MAX = 300;
export const DEFAULT_MAINTENANCE_MESSAGE = "We're doing some work on the site. It will be back shortly.";

function load(): Maintenance {
	try {
		const row = db.query<{ value: string }, [string]>("SELECT value FROM app_settings WHERE key = ?").get(KEY);
		return row ? { ...OFF, ...JSON.parse(row.value) } : OFF;
	} catch {
		return OFF;
	}
}

let current = load();

export function maintenance(): Maintenance {
	return current;
}

export function setMaintenance(enabled: boolean, message: string, by: string): Maintenance {
	current = enabled
		? {
				enabled: true,
				message: message.slice(0, MAINTENANCE_MESSAGE_MAX),
				since: Math.floor(Date.now() / 1000),
				by,
			}
		: OFF;
	db.run(
		"INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		[KEY, JSON.stringify(current)]
	);
	return current;
}
