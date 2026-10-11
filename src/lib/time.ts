export const MINUTE = 60;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Current unix time in seconds, matching SQLite's unixepoch(). */
export function nowSec(): number {
	return Math.floor(Date.now() / 1000);
}

export function utcDate(offsetDays = 0): string {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() + offsetDays);
	return d.toISOString().slice(0, 10);
}
