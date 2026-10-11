import { db, type User } from "../db";
import { md, notify, type WebhookCategory } from "./webhook";

export type AuditTarget = {
	targetType?: string;
	targetId?: number;
	targetUsername?: string | null;
	details?: string | null;
};

/**
 * Audit actions that are also posted to the staff Discord channel, with their heading
 * and the staff panel tab to open. Actions with a richer message of their own (new
 * submissions, bans, new accounts...) call notify() themselves and are left out here.
 */
const ANNOUNCED: Record<string, [category: WebhookCategory, title: string, path: string]> = {
	user_warning: ["bans", "Warning issued", "/admin#users"],
	user_limit_upload: ["bans", "Uploads limited", "/admin#users"],
	user_limit_duel: ["bans", "Duels limited", "/admin#users"],
	user_warning_overturn: ["bans", "Warning overturned", "/admin#users"],
	user_limit_upload_overturn: ["bans", "Upload limit overturned", "/admin#users"],
	user_limit_duel_overturn: ["bans", "Duel limit overturned", "/admin#users"],
	user_ban_temp_overturn: ["bans", "Temporary ban overturned", "/admin#users"],
	user_ban_perm_overturn: ["bans", "Permanent ban overturned", "/admin#users"],
	moderation_record_delete: ["bans", "Moderation record deleted", "/admin#users"],
	score_edit: ["bans", "Score corrected", "/admin#users"],
	score_delete: ["bans", "Score removed", "/admin#users"],
	score_reset: ["bans", "Scores reset", "/admin#users"],
	evasion_flag: ["bans", "Possible ban evasion", "/admin#users"],
	evasion_flag_dismiss: ["bans", "Ban evasion flag dismissed", "/admin#users"],
	user_role_change: ["users", "Staff role changed", "/admin#staff"],
	staff_lock: ["bans", "Staff access suspended", "/admin#staff"],
	staff_unlock: ["bans", "Staff access restored", "/admin#staff"],
	user_delete: ["users", "Account deleted by its owner", "/admin#users"],
	user_delete_operator: ["users", "Account deleted by an operator", "/admin#users"],
	gdpr_export_operator: ["users", "User data exported by an operator", "/admin#users"],
	suggestion_deny: ["suggestions", "Suggestion denied", "/admin#suggestions"],
	location_activate: ["locations", "Location enabled", "/admin#locations"],
	location_deactivate: ["locations", "Location disabled", "/admin#locations"],
	location_stats_reset: ["locations", "Location difficulty reset", "/admin#locations"],
	location_delete: ["locations", "Location deleted", "/admin#locations"],
	location_label_edit: ["locations", "Location label edited", "/admin#locations"],
	location_hints_edit: ["locations", "Location hints edited", "/admin#locations"],
	ticket_close: ["support", "Ticket closed", "/admin#tickets"],
	ticket_reopen: ["support", "Ticket reopened", "/admin#tickets"],
	ticket_delete: ["support", "Ticket deleted", "/admin#tickets"],
	ticket_cleanup: ["support", "Old tickets cleaned up", "/admin#tickets"],
	announcement: ["system", "Announcement sent", "/admin#audit"],
	announcement_banner_end: ["system", "Announcement banner taken down", "/admin#audit"],
	maintenance_on: ["system", "Maintenance mode switched on", "/admin#system"],
	maintenance_off: ["system", "Maintenance mode switched off", "/admin#system"],
	backup_create: ["system", "Backup made", "/admin#system"],
	backup_download: ["system", "Backup downloaded", "/admin#system"],
	backup_delete: ["system", "Backup deleted", "/admin#system"],
	logs_clear: ["system", "Server log cleared", "/admin#system"],
	server_update: ["system", "Update started", "/admin#system"],
	server_restart: ["system", "Restart requested", "/admin#system"],
	server_restart_cancel: ["system", "Restart called off", "/admin#system"],
	feature_toggle: ["system", "Feature switched", "/admin#system"],
	achievements_backfill: ["system", "Achievements recalculated", "/admin#system"],
};

function announce(actor: User | null, action: string, target: AuditTarget) {
	const entry = ANNOUNCED[action];
	if (!entry) return;
	const [category, title, path] = entry;
	const subject = target.targetUsername
		? `@${md(target.targetUsername)}`
		: target.targetType && target.targetId
			? `${target.targetType} #${target.targetId}`
			: "";
	const lines = [
		[subject, actor ? `by **${md(actor.display_name || actor.username)}**` : ""].filter(Boolean).join(" "),
		target.details ? `> ${md(target.details)}` : "",
	].filter(Boolean);
	notify(category, `**${title}**\n${lines.join("\n")}`, path);
}

/** Records an action in the audit log. A null actor means the system did it. */
export function auditLog(actor: User | null, action: string, target: AuditTarget = {}) {
	try {
		db.run(
			"INSERT INTO audit_log (actor_id, actor_username, action, target_type, target_id, target_username, details) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[
				actor?.id ?? null,
				actor ? actor.display_name || actor.username : "system",
				action,
				target.targetType ?? null,
				target.targetId ?? null,
				target.targetUsername ?? null,
				target.details ?? null,
			]
		);
	} catch (err) {
		console.error("[audit] write failed:", err);
	}
	announce(actor, action, target);
}
