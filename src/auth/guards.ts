import type { Context } from "hono";
import type { Role, User } from "../db";
import { fail } from "../lib/http";
import { currentUser } from "./sessions";

const ROLE_RANK: Record<Role, number> = { helper: 1, curator: 2, moderator: 3, supervisor: 4, admin: 5, operator: 6 };

export function roleRank(role: string | null | undefined): number {
	return ROLE_RANK[role as Role] ?? 0;
}

/** Anyone with a role who may use it now, helpers included. A locked account counts as a player. */
export function isStaff(user: User | null | undefined): boolean {
	return roleRank(user?.role) > 0 && !user?.staff_locked;
}

/** Curator and up. Helpers are players with review queues, so staff allowances stop here. */
export function isFullStaff(user: User | null | undefined): boolean {
	return hasRole(user, "curator");
}

export function hasRole(user: User | null | undefined, min: Role): boolean {
	return isStaff(user) && roleRank(user?.role) >= ROLE_RANK[min];
}

/** Any logged-in user, including banned ones (they still need settings and appeals). */
export function requireUser(c: Context): User {
	return currentUser(c) ?? fail(401, "Login required");
}

export function requirePlayer(c: Context): User {
	const user = requireUser(c);
	if (user.is_banned) fail(403, "You are banned");
	return user;
}

/** Staff of at least `min`. Defaults to moderator, so helper access must be asked for by name. */
export function requireStaff(c: Context, min: Role = "moderator"): User {
	const user = currentUser(c);
	if (user?.staff_locked && roleRank(user.role) > 0) fail(403, "Your staff access has been suspended.");
	if (!user || user.is_banned || !hasRole(user, min)) fail(403, "Forbidden");
	return user;
}
