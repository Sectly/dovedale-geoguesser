import type { Context } from "hono";
import type { Role, User } from "../db";
import { fail } from "../lib/http";
import { currentUser } from "./sessions";

const ROLE_RANK: Record<Role, number> = { helper: 1, moderator: 2, supervisor: 3, operator: 4 };

export function roleRank(role: string | null | undefined): number {
	return ROLE_RANK[role as Role] ?? 0;
}

/**
 * Staff who may act as staff right now. Someone whose access has been locked keeps their
 * role on record but counts as an ordinary player everywhere until it is restored.
 */
export function isStaff(user: User | null | undefined): boolean {
	return roleRank(user?.role) > 0 && !user?.staff_locked;
}

export function hasRole(user: User | null | undefined, min: Role): boolean {
	return isStaff(user) && roleRank(user?.role) >= ROLE_RANK[min];
}

/** Any logged-in user, including banned ones (they still need settings and appeals). */
export function requireUser(c: Context): User {
	return currentUser(c) ?? fail(401, "Login required");
}

/** A logged-in user who is not banned. */
export function requirePlayer(c: Context): User {
	const user = requireUser(c);
	if (user.is_banned) fail(403, "You are banned");
	return user;
}

/**
 * A member of staff of at least `min`. The default is moderator, so a route has to say
 * "helper" in so many words before the lowest role can reach it.
 */
export function requireStaff(c: Context, min: Role = "moderator"): User {
	const user = currentUser(c);
	if (user?.staff_locked && roleRank(user.role) > 0) fail(403, "Your staff access has been suspended.");
	if (!user || user.is_banned || !hasRole(user, min)) fail(403, "Forbidden");
	return user;
}
