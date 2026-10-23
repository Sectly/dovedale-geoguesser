import { Hono } from "hono";
import type { Context } from "hono";
import { db, type User } from "../../db";
import { OPERATOR_IDS } from "../../config";
import { hasRole, requireStaff, roleRank } from "../../auth/guards";
import { auditLog } from "../../lib/audit";
import { fail, idParam, readJson, text } from "../../lib/http";
import { HOUR, nowSec } from "../../lib/time";
import { displayName, notify } from "../../lib/webhook";
import { notifyUser } from "../../notifications";
import {
	ACTION_LABELS,
	canDelete,
	canOverturn,
	deleteAction,
	getAction,
	issueAction,
	overturnAction,
	requireReason,
	userHistory,
	type ActionType,
	type ModerationAction,
} from "../../moderation";
import { dismissEvasionFlag, linkedAccounts, openEvasionFlags } from "../../evasion";
import { FAIRPLAY_LABELS, dismissFairplayFlag, openFairplayFlags } from "../../fairplay";
import { removeFromDuels } from "../../game/duels/rooms";
import { removeFromTeamRooms } from "../../game/teams";
import { deleteUserAccount, exportUserData } from "../account";

const NOTE_MAX = 1000;

export const adminUserRoutes = new Hono();
/** Routes mounted at /api/admin/moderation: acting on a single past action. */
export const adminModerationRoutes = new Hono();

const MAX_LIMIT_HOURS = 96;
const MAX_BAN_HOURS = 365 * 24;

function getUser(id: number): User {
	return db.query<User, [number]>("SELECT * FROM users WHERE id = ?").get(id) ?? fail(404, "User not found");
}

/** The user a moderation action is aimed at. Staff can only act on people ranked below them. */
function moderationTarget(c: Context, actor: User, userId = idParam(c)): User {
	const target = getUser(userId);
	if (target.id === actor.id) fail(403, "You can't do that to yourself");
	if (roleRank(target.role) >= roleRank(actor.role)) fail(403, "You can't moderate staff of equal or higher rank");
	return target;
}

function duration(value: unknown, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
		fail(400, "Enter how many hours it should last");
	return Math.min(max, value);
}

function act(
	actor: User,
	target: User,
	type: ActionType,
	reason: string,
	hours: number | null = null
): ModerationAction {
	const action = issueAction(target, type, reason, actor, hours ? nowSec() + Math.floor(hours * HOUR) : null);
	if (type === "ban_perm" || type === "ban_temp") {
		removeFromDuels(target.id);
		removeFromTeamRooms(target);
	}
	notifyUser(target.id, "moderation", {
		title: type === "warning" ? "You received a warning" : `${ACTION_LABELS[type]} applied to your account`,
		body: `${hours ? `For ${hours} hour${hours === 1 ? "" : "s"}. ` : ""}Reason: ${reason}`,
		link: "/settings#moderation",
	});
	auditLog(actor, `user_${type}`, {
		targetType: "user",
		targetId: target.id,
		targetUsername: target.username,
		details: `${hours ? `${hours}h: ` : ""}${reason}`.slice(0, 200),
	});
	return action;
}

function activeActions(userId: number, types: ActionType[]): ModerationAction[] {
	return db
		.query<ModerationAction, (string | number)[]>(
			`SELECT * FROM moderation_actions WHERE user_id = ? AND type IN (${types.map(() => "?").join(",")})
				AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`
		)
		.all(userId, ...types, nowSec());
}

function overturn(actor: User, action: ModerationAction, reason: string, target: User) {
	if (!canOverturn(actor, action))
		fail(
			403,
			action.type === "ban_perm"
				? "Only operators can overturn permanent bans"
				: "Only supervisors and operators can overturn moderation actions"
		);
	overturnAction(action, reason, actor);
	notifyUser(target.id, "moderation", {
		title: `${ACTION_LABELS[action.type]} overturned`,
		body: `Staff overturned this action. ${reason}`,
		link: "/settings#moderation",
	});
	auditLog(actor, `user_${action.type}_overturn`, {
		targetType: "user",
		targetId: target.id,
		targetUsername: target.username,
		details: reason.slice(0, 200),
	});
}

adminUserRoutes.get("/", (c) => {
	requireStaff(c);
	return c.json(
		db
			.query(
				`SELECT u.id, u.discord_id, u.username, u.display_name, u.avatar_url, u.role, u.created_at,
					u.is_banned, u.ban_type, u.ban_expires_at, u.upload_limited, u.upload_limit_expires_at,
					u.duel_limited, u.duel_limit_expires_at, u.profile_private, u.staff_locked, u.staff_lock_reason,
					u.suggestions_agreed, u.suggestions_agreed_at,
					(SELECT COUNT(*) FROM moderation_actions m WHERE m.user_id = u.id) AS moderation_count,
					(SELECT COUNT(*) FROM moderation_actions m WHERE m.user_id = u.id AND m.type = 'warning' AND m.revoked_at IS NULL) AS warning_count,
					(SELECT COUNT(*) FROM fairplay_flags f WHERE f.user_id = u.id AND f.dismissed_at IS NULL) AS fairplay_flags
				FROM users u ORDER BY u.created_at DESC`
			)
			.all()
	);
});

adminUserRoutes.get("/evasion", (c) => {
	requireStaff(c);
	return c.json(openEvasionFlags());
});

adminUserRoutes.post("/evasion/:id/dismiss", (c) => {
	const actor = requireStaff(c);
	const flag = dismissEvasionFlag(idParam(c), actor) ?? fail(404, "This flag has already been dealt with");
	const suspect = getUser(flag.user_id);
	auditLog(actor, "evasion_flag_dismiss", {
		targetType: "user",
		targetId: suspect.id,
		targetUsername: suspect.username,
		details: `Not ban evasion of @${getUser(flag.matched_user_id).username}`,
	});
	return c.json({ success: true });
});

/** A private note about a player, for other staff. The player is never shown it or told of it. */
adminUserRoutes.post("/:id/notes", async (c) => {
	const actor = requireStaff(c);
	const target = getUser(idParam(c));
	const body = text((await readJson<{ body: string }>(c)).body, NOTE_MAX);
	if (body.length < 3) fail(400, "Write a note first.");
	db.run("INSERT INTO staff_notes (user_id, author_id, author_username, body) VALUES (?, ?, ?, ?)", [
		target.id,
		actor.id,
		actor.username,
		body,
	]);
	auditLog(actor, "staff_note_add", { targetType: "user", targetId: target.id, targetUsername: target.username });
	return c.json({ success: true });
});

/** Removes a note. Its author can, and so can a supervisor. */
adminUserRoutes.delete("/notes/:id", (c) => {
	const actor = requireStaff(c);
	const note = db
		.query<{ id: number; user_id: number; author_id: number | null }, [number]>(
			"SELECT id, user_id, author_id FROM staff_notes WHERE id = ?"
		)
		.get(idParam(c));
	if (!note) fail(404, "That note is already gone.");
	if (note.author_id !== actor.id && !hasRole(actor, "supervisor"))
		fail(403, "Only its author or a supervisor can remove a note.");
	db.run("DELETE FROM staff_notes WHERE id = ?", [note.id]);
	const target = getUser(note.user_id);
	auditLog(actor, "staff_note_remove", { targetType: "user", targetId: target.id, targetUsername: target.username });
	return c.json({ success: true });
});

/** Clears a fair-play flag once reviewed. Its guesses are not counted again. */
adminUserRoutes.post("/fairplay/:id/dismiss", (c) => {
	const actor = requireStaff(c);
	const flag = dismissFairplayFlag(idParam(c), actor) ?? fail(404, "This flag has already been dealt with");
	const player = getUser(flag.user_id);
	auditLog(actor, "fairplay_flag_dismiss", {
		targetType: "user",
		targetId: player.id,
		targetUsername: player.username,
		details: FAIRPLAY_LABELS[flag.signal],
	});
	return c.json({ success: true });
});

adminUserRoutes.get("/:id/moderation", (c) => {
	const staff = requireStaff(c);
	const target = getUser(idParam(c));
	const count = (sql: string) => db.query<{ n: number }, [number]>(sql).get(target.id)?.n ?? 0;
	return c.json({
		user: {
			id: target.id,
			username: target.username,
			display_name: target.display_name,
			avatar_url: target.avatar_url,
			role: target.role,
			staff_locked: !!target.staff_locked,
			staff_lock_reason: target.staff_lock_reason,
			created_at: target.created_at,
			is_banned: !!target.is_banned,
			ban_type: target.ban_type,
			ban_expires_at: target.ban_expires_at,
			upload_limited: !!target.upload_limited,
			upload_limit_expires_at: target.upload_limit_expires_at,
			duel_limited: !!target.duel_limited,
			duel_limit_expires_at: target.duel_limit_expires_at,
			suggestions_agreed: !!target.suggestions_agreed,
			suggestions_agreed_at: target.suggestions_agreed_at,
		},
		stats: {
			solo_games: count("SELECT COUNT(*) AS n FROM solo_scores WHERE user_id = ?"),
			daily_games: count("SELECT COUNT(*) AS n FROM daily_scores WHERE user_id = ?"),
			duels: count("SELECT COUNT(*) AS n FROM duel_participants WHERE user_id = ?"),
			submissions: count("SELECT COUNT(*) AS n FROM submissions WHERE submitted_by = ?"),
			submissions_denied: count(
				"SELECT COUNT(*) AS n FROM submissions WHERE submitted_by = ? AND status = 'denied'"
			),
			tickets: count("SELECT COUNT(*) AS n FROM support_tickets WHERE user_id = ?"),
		},
		/** Account details that help when answering a ticket or weighing a report. */
		account: {
			last_played_date: target.last_played_date,
			current_streak: target.current_streak,
			longest_streak: target.longest_streak,
			duel_rating: target.duel_rating,
			duel_rated_games: target.duel_rated_games,
			profile_private: !!target.profile_private,
			sessions: count("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > unixepoch()"),
			last_login: count("SELECT MAX(created_at) AS n FROM sessions WHERE user_id = ?") || null,
			devices: count("SELECT COUNT(*) AS n FROM fingerprints WHERE user_id = ?"),
			push_devices: count("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?"),
			achievements: count("SELECT COUNT(*) AS n FROM user_achievements WHERE user_id = ?"),
			suggestions: count("SELECT COUNT(*) AS n FROM location_suggestions WHERE user_id = ?"),
			suggestions_approved: count(
				"SELECT COUNT(*) AS n FROM location_suggestions WHERE user_id = ? AND status = 'approved'"
			),
			locations_live: count("SELECT COUNT(*) AS n FROM locations WHERE submitted_by = ? AND is_active = 1"),
		},
		actions: userHistory(target.id, staff),
		/** Other accounts seen on the same device, which is how ban evasion shows up. */
		linked_accounts: linkedAccounts(target.id),
		fairplay_flags: openFairplayFlags(target.id),
		notes: db
			.query(
				"SELECT id, author_id, author_username, body, created_at FROM staff_notes WHERE user_id = ? ORDER BY id DESC LIMIT 50"
			)
			.all(target.id),
		can_moderate: target.id !== staff.id && roleRank(target.role) < roleRank(staff.role),
	});
});

adminUserRoutes.post("/:id/warn", async (c) => {
	const actor = requireStaff(c);
	const target = moderationTarget(c, actor);
	const body = await readJson<{ reason: string }>(c);
	act(actor, target, "warning", requireReason(body.reason));
	return c.json({ success: true });
});

adminUserRoutes.post("/:id/limit", async (c) => {
	const actor = requireStaff(c);
	const target = moderationTarget(c, actor);
	const body = await readJson<{ type: string; hours: number; reason: string }>(c);
	if (body.type !== "upload" && body.type !== "duel" && body.type !== "chat") fail(400, "Invalid type");
	const type: ActionType = `limit_${body.type}`;
	const reason = requireReason(body.reason);

	if (!body.hours || body.hours <= 0) {
		const active = activeActions(target.id, [type]);
		if (!active.length) fail(400, "This user has no such limit");
		for (const action of active) overturn(actor, action, reason, target);
		return c.json({ success: true });
	}
	act(actor, target, type, reason, duration(body.hours, MAX_LIMIT_HOURS));
	return c.json({ success: true });
});

adminUserRoutes.post("/:id/ban", async (c) => {
	const actor = requireStaff(c);
	const target = moderationTarget(c, actor);
	const body = await readJson<{ type: string; hours: number; reason: string }>(c);
	const who = `**${displayName(target)}** (@${target.username})`;

	if (body.type === "perm") {
		if (!hasRole(actor, "supervisor")) fail(403, "Only supervisors or operators can permanently ban users");
		const reason = requireReason(body.reason);
		act(actor, target, "ban_perm", reason);
		notify("bans", `**Permanent ban**: ${who} banned by **${displayName(actor)}**\n> ${reason}`, "/admin#users");
	} else if (body.type === "temp") {
		const hours = duration(body.hours, MAX_BAN_HOURS);
		const reason = requireReason(body.reason);
		act(actor, target, "ban_temp", reason, hours);
		notify("bans", `**Temp ban (${hours}h)**: ${who} by **${displayName(actor)}**\n> ${reason}`, "/admin#users");
	} else {
		fail(400, "Invalid ban type");
	}
	return c.json({ success: true });
});

adminUserRoutes.post("/:id/unban", async (c) => {
	const actor = requireStaff(c);
	const target = getUser(idParam(c));
	const reason = requireReason((await readJson<{ reason: string }>(c)).reason);
	const bans = activeActions(target.id, ["ban_perm", "ban_temp"]);
	if (!bans.length) fail(400, "This user is not banned");
	for (const ban of bans) {
		if (!canOverturn(actor, ban))
			fail(
				403,
				ban.type === "ban_perm"
					? "Only operators can lift permanent bans"
					: "Only supervisors and operators can lift bans"
			);
	}
	for (const ban of bans) overturn(actor, ban, reason, target);
	return c.json({ success: true });
});

const ASSIGNABLE_ROLES = ["admin", "supervisor", "moderator", "curator", "helper"];

adminUserRoutes.post("/:id/role", async (c) => {
	const actor = requireStaff(c, "supervisor");
	const target = getUser(idParam(c));
	if (target.id === actor.id) fail(400, "Cannot change your own role");

	const body = await readJson<{ role: string | null }>(c);
	const newRole = body.role && body.role !== "none" ? body.role : null;
	const assignable = ASSIGNABLE_ROLES.filter((role) => roleRank(role) < roleRank(actor.role));
	if (newRole !== null && !assignable.includes(newRole)) fail(403, "Insufficient permissions to assign that role");
	if (OPERATOR_IDS.includes(target.discord_id)) fail(403, "Cannot change env-protected operator");
	if (roleRank(target.role) >= roleRank(actor.role)) fail(403, "Cannot change a user with equal or higher rank");

	db.run("UPDATE users SET role = ?, staff_locked = 0, staff_lock_reason = NULL WHERE id = ?", [newRole, target.id]);
	auditLog(actor, "user_role_change", {
		targetType: "user",
		targetId: target.id,
		targetUsername: target.username,
		details: `${target.role ?? "none"} to ${newRole ?? "none"}`,
	});
	return c.json({ success: true });
});

adminUserRoutes.post("/:id/staff-lock", async (c) => {
	const actor = requireStaff(c, "moderator");
	const target = moderationTarget(c, actor);
	if (!target.role) fail(400, "This user is not a member of staff");
	if (target.staff_locked) fail(400, "Their staff access is already suspended");
	const reason = requireReason((await readJson<{ reason: string }>(c)).reason);

	db.run("UPDATE users SET staff_locked = 1, staff_lock_reason = ? WHERE id = ?", [reason, target.id]);
	auditLog(actor, "staff_lock", {
		targetType: "user",
		targetId: target.id,
		targetUsername: target.username,
		details: `${target.role}: ${reason}`.slice(0, 300),
	});
	notifyUser(target.id, "moderation", {
		title: "Your staff access has been suspended",
		body: `You cannot open the staff panel or take staff actions until it is restored. Reason: ${reason}`,
		link: "/settings#notifications",
	});
	return c.json({ success: true });
});

adminUserRoutes.post("/:id/staff-unlock", async (c) => {
	const actor = requireStaff(c, "moderator");
	const target = moderationTarget(c, actor);
	if (!target.staff_locked) fail(400, "Their staff access is not suspended");
	const reason = requireReason((await readJson<{ reason: string }>(c)).reason);

	db.run("UPDATE users SET staff_locked = 0, staff_lock_reason = NULL WHERE id = ?", [target.id]);
	auditLog(actor, "staff_unlock", {
		targetType: "user",
		targetId: target.id,
		targetUsername: target.username,
		details: reason.slice(0, 300),
	});
	notifyUser(target.id, "moderation", {
		title: "Your staff access has been restored",
		body: reason,
		link: "/admin",
	});
	return c.json({ success: true });
});

adminUserRoutes.get("/:id/gdpr-export", (c) => {
	const actor = requireStaff(c, "operator");
	const target = getUser(idParam(c));
	auditLog(actor, "gdpr_export_operator", {
		targetType: "user",
		targetId: target.id,
		targetUsername: target.username,
	});
	return c.json({ ...exportUserData(target), exported_by_operator: actor.username });
});

adminUserRoutes.delete("/:id/account", async (c) => {
	const actor = requireStaff(c, "operator");
	const target = moderationTarget(c, actor);
	await deleteUserAccount(target.id);
	auditLog(actor, "user_delete_operator", { targetType: "user", targetId: target.id });
	return c.json({ success: true });
});

adminModerationRoutes.post("/:id/overturn", async (c) => {
	const actor = requireStaff(c);
	const action = getAction(idParam(c));
	const reason = requireReason((await readJson<{ reason: string }>(c)).reason);
	overturn(actor, action, reason, getUser(action.user_id));
	return c.json({ success: true });
});

adminModerationRoutes.delete("/:id", (c) => {
	const actor = requireStaff(c);
	if (!canDelete(actor)) fail(403, "Only operators can remove moderation records");
	const action = getAction(idParam(c));
	const target = getUser(action.user_id);
	deleteAction(action);
	auditLog(actor, "moderation_record_delete", {
		targetType: "user",
		targetId: target.id,
		targetUsername: target.username,
		details: `${ACTION_LABELS[action.type]}: ${action.reason}`.slice(0, 200),
	});
	return c.json({ success: true });
});
