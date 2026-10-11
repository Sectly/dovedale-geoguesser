import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Thrown from handlers and helpers; the app error handler turns it into a plain-text response. */
export class HttpError extends Error {
	constructor(
		public status: ContentfulStatusCode,
		message: string
	) {
		super(message);
	}
}

export function fail(status: ContentfulStatusCode, message: string): never {
	throw new HttpError(status, message);
}

/** Parses a positive integer route param, or responds 404. */
export function idParam(c: Context, name = "id"): number {
	const raw = c.req.param(name) ?? "";
	if (!/^\d{1,15}$/.test(raw)) fail(404, "Not found");
	return Number(raw);
}

/** Integer query param clamped to [min, max]; falls back when missing or not a number. */
export function intQuery(c: Context, name: string, fallback: number, min: number, max: number): number {
	const n = parseInt(c.req.query(name) ?? "", 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Reads a JSON object body; anything else (invalid JSON, arrays, primitives) becomes {}. */
export async function readJson<T extends object>(c: Context): Promise<Partial<T>> {
	const body = await c.req.json().catch(() => null);
	return body && typeof body === "object" && !Array.isArray(body) ? (body as Partial<T>) : {};
}

export async function readForm(c: Context): Promise<FormData> {
	try {
		return await c.req.formData();
	} catch {
		fail(400, "Invalid form data");
	}
}

/** Trimmed string from untrusted input, cut to max length. Non-strings become "". */
export function text(value: unknown, max: number): string {
	return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function clientIp(c: Context): string {
	return (
		c.req.header("cf-connecting-ip") ||
		c.req.header("x-forwarded-for")?.split(",")[0].trim() ||
		"unknown"
	).slice(0, 64);
}

/** Only same-site absolute paths are allowed as post-login redirects. */
export function safeRedirect(target: string | undefined | null): string {
	if (!target || !target.startsWith("/") || target.startsWith("//") || /[\\\r\n]/.test(target)) return "/";
	return target;
}

export function getCookie(header: string | null | undefined, name: string): string | null {
	if (!header) return null;
	for (const part of header.split(";")) {
		const s = part.trim();
		if (s.startsWith(`${name}=`)) {
			try {
				return decodeURIComponent(s.slice(name.length + 1));
			} catch {
				return null;
			}
		}
	}
	return null;
}
