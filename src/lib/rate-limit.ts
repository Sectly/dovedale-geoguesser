import { isFullStaff } from "../auth/guards";
import type { User } from "../db";

type Bucket = { hits: number[]; windowMs: number };
const buckets = new Map<string, Bucket>();
/** Past this many keys the stale ones are dropped at once, not at the next scheduled prune. */
const MAX_KEYS = 50_000;

/** Sliding-window limiter. Returns false when the key has used up its allowance. */
export function checkRateLimit(key: string, max: number, windowMs: number): boolean {
	const now = Date.now();
	const hits = (buckets.get(key)?.hits ?? []).filter((t) => now - t < windowMs);
	const allowed = hits.length < max;
	if (allowed) hits.push(now);
	if (!buckets.has(key) && buckets.size >= MAX_KEYS) {
		pruneRateLimits();
		if (buckets.size >= MAX_KEYS) buckets.clear();
	}
	buckets.set(key, { hits, windowMs });
	return allowed;
}

/** Staff get five times the allowance. Helpers and locked-out staff are limited like any player. */
export function checkUserRateLimit(user: User, action: string, max: number, windowMs: number): boolean {
	return checkRateLimit(`${action}:${user.id}`, isFullStaff(user) ? max * 5 : max, windowMs);
}

export function pruneRateLimits() {
	const now = Date.now();
	for (const [key, bucket] of buckets) {
		if (bucket.hits.every((t) => now - t >= bucket.windowMs)) buckets.delete(key);
	}
}

export function rateLimitKeys(): number {
	return buckets.size;
}
