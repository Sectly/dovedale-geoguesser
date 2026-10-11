import type { User } from "../db";

type Bucket = { hits: number[]; windowMs: number };
const buckets = new Map<string, Bucket>();

/** Sliding-window limiter. Returns false when the key has used up its allowance. */
export function checkRateLimit(key: string, max: number, windowMs: number): boolean {
	const now = Date.now();
	const hits = (buckets.get(key)?.hits ?? []).filter((t) => now - t < windowMs);
	const allowed = hits.length < max;
	if (allowed) hits.push(now);
	buckets.set(key, { hits, windowMs });
	return allowed;
}

/** Staff get five times the allowance. */
export function checkUserRateLimit(user: User, action: string, max: number, windowMs: number): boolean {
	return checkRateLimit(`${action}:${user.id}`, user.role ? max * 5 : max, windowMs);
}

/** Drops every key whose hits have all aged out of its own window, so the map cannot grow for ever. */
export function pruneRateLimits() {
	const now = Date.now();
	for (const [key, bucket] of buckets) {
		if (bucket.hits.every((t) => now - t >= bucket.windowMs)) buckets.delete(key);
	}
}

export function rateLimitKeys(): number {
	return buckets.size;
}
