import { app } from "../src/app";
import { db, type Role } from "../src/db";
import { createSession } from "../src/auth/sessions";

let counter = 0;

export type TestUser = { id: number; username: string; cookie: string };

export function createUser(opts: { role?: Role; ageDays?: number; username?: string } = {}): TestUser {
	const n = ++counter;
	const username = opts.username ?? `user${n}`;
	const createdAt = Math.floor(Date.now() / 1000) - (opts.ageDays ?? 0) * 86400;
	const id = Number(
		db.run("INSERT INTO users (discord_id, username, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)", [
			`discord-${n}`,
			username,
			`User ${n}`,
			opts.role ?? null,
			createdAt,
		]).lastInsertRowid
	);
	return { id, username, cookie: `session=${createSession(id)}` };
}

export function createLocation(opts: { x?: number; y?: number; hints?: string[]; label?: string } = {}): number {
	const n = ++counter;
	return Number(
		db.run("INSERT INTO locations (image_path, world_x, world_y, label, hints) VALUES (?, ?, ?, ?, ?)", [
			`loc${n}.webp`,
			opts.x ?? n * 100,
			opts.y ?? n * 100,
			opts.label ?? `Location ${n}`,
			JSON.stringify(opts.hints ?? []),
		]).lastInsertRowid
	);
}

/**
 * Empties the review queues. Every test file does this before it starts, so what one
 * file leaves waiting for staff cannot change the counts another file checks.
 */
export function resetReviewQueues() {
	db.run("DELETE FROM evasion_flags");
	db.run("DELETE FROM fingerprints");
	db.run("DELETE FROM ticket_replies");
	db.run("DELETE FROM support_tickets");
	db.run("DELETE FROM location_suggestions WHERE status = 'pending'");
	db.run("DELETE FROM submissions WHERE status = 'pending'");
}

export function clearLocations() {
	db.run("DELETE FROM daily_scores");
	db.run("DELETE FROM daily_attempts");
	db.run("DELETE FROM daily_challenges");
	db.run("DELETE FROM duel_round_scores");
	db.run("DELETE FROM location_suggestions");
	db.run("DELETE FROM locations");
}

type CallOptions = {
	method?: string;
	json?: unknown;
	body?: FormData | string;
	as?: TestUser;
	headers?: Record<string, string>;
};

/** Calls the app in-process and returns the status with the parsed body. */
export async function call(path: string, opts: CallOptions = {}) {
	const headers: Record<string, string> = { ...opts.headers };
	if (opts.as) headers.Cookie = opts.as.cookie;
	if (opts.json !== undefined) headers["Content-Type"] = "application/json";
	const res = await app.fetch(
		new Request(`http://localhost${path}`, {
			method: opts.method ?? (opts.json !== undefined || opts.body ? "POST" : "GET"),
			headers,
			body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
		})
	);
	const raw = await res.text();
	let data: any = raw;
	try {
		data = JSON.parse(raw);
	} catch {}
	return { status: res.status, data, headers: res.headers };
}

export const post = (path: string, as?: TestUser, json: unknown = {}) => call(path, { as, json });
