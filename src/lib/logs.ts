import { inspect } from "util";
import { db } from "../db";

export type LogLevel = "info" | "warn" | "error";

const MAX_ROWS = 3000;
const MAX_AGE_DAYS = 30;
const MESSAGE_MAX = 300;
const DETAIL_MAX = 6000;

let writing = false;
let sinceTrim = 0;

function text(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof Error) return value.stack || value.message;
	return inspect(value, { depth: 3, breakLength: 120 });
}

export function writeLog(level: LogLevel, args: unknown[]) {
	if (writing) return;
	writing = true;
	try {
		const full = args
			.map((arg, i) => (i > 0 && arg instanceof Error ? `\n${text(arg)}` : text(arg)))
			.join(" ")
			.trim();
		if (!full) return;
		const [first, ...rest] = full.split("\n");
		const detail = [first.length > MESSAGE_MAX ? first : "", ...rest].filter(Boolean).join("\n");
		db.run("INSERT INTO server_logs (level, message, detail) VALUES (?, ?, ?)", [
			level,
			first.trim().slice(0, MESSAGE_MAX),
			detail ? detail.slice(0, DETAIL_MAX) : null,
		]);
		if (++sinceTrim >= 200) pruneLogs();
	} catch {
	} finally {
		writing = false;
	}
}

export function logInfo(message: string, detail?: string) {
	console.log(message);
	writeLog("info", detail ? [`${message}\n${detail}`] : [message]);
}

export function pruneLogs() {
	sinceTrim = 0;
	db.run("DELETE FROM server_logs WHERE created_at < unixepoch() - ?", [MAX_AGE_DAYS * 86400]);
	db.run("DELETE FROM server_logs WHERE id <= (SELECT MAX(id) FROM server_logs) - ?", [MAX_ROWS]);
}

export function captureConsole() {
	for (const level of ["warn", "error"] as const) {
		const original = console[level].bind(console);
		console[level] = (...args: unknown[]) => {
			original(...args);
			writeLog(level, args);
		};
	}
}

type LogQuery = { level?: string; search?: string; before?: number; limit: number };

export function readLogs({ level, search, before, limit }: LogQuery) {
	const where: string[] = [];
	const params: (string | number)[] = [];
	if (level === "info" || level === "warn" || level === "error") {
		where.push("level = ?");
		params.push(level);
	}
	if (search) {
		where.push("(message LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\')");
		const like = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
		params.push(like, like);
	}
	if (before) {
		where.push("id < ?");
		params.push(before);
	}
	return db
		.query(
			`SELECT id, level, message, detail, created_at FROM server_logs
			${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`
		)
		.all(...params, limit);
}

export function logCounts() {
	const rows = db
		.query<{ level: string; n: number }, []>("SELECT level, COUNT(*) AS n FROM server_logs GROUP BY level")
		.all();
	const day = db
		.query<{ n: number }, []>(
			"SELECT COUNT(*) AS n FROM server_logs WHERE level = 'error' AND created_at > unixepoch() - 86400"
		)
		.get();
	return { ...Object.fromEntries(rows.map((r) => [r.level, r.n])), errors_24h: day?.n ?? 0 };
}

export function clearLogs(): number {
	return db.run("DELETE FROM server_logs").changes;
}
