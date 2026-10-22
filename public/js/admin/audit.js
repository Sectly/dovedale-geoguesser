import { el, errorStateHtml, escHtml } from "../lib/dom.js";
import { ROLE_NAMES } from "./users.js";

export const AUDIT_ACTION_LABELS = {
	submission_approve: { label: "Approved submission", color: "text-green-400" },
	submission_deny: { label: "Denied submission", color: "text-red-400" },
	suggestion_approve: { label: "Approved suggestion", color: "text-green-400" },
	suggestion_deny: { label: "Denied suggestion", color: "text-red-400" },
	location_activate: { label: "Activated location", color: "text-green-400" },
	location_deactivate: { label: "Deactivated location", color: "text-yellow-400" },
	location_stats_reset: { label: "Reset a location's difficulty", color: "text-yellow-400" },
	location_delete: { label: "Deleted location", color: "text-red-400" },
	location_label_edit: { label: "Edited location label", color: "text-blue-400" },
	user_warning: { label: "Warned user", color: "text-yellow-400" },
	user_limit_upload: { label: "Limited uploads", color: "text-orange-400" },
	user_limit_duel: { label: "Limited duels", color: "text-orange-400" },
	user_limit_chat: { label: "Limited chat", color: "text-orange-400" },
	user_warning_overturn: { label: "Overturned warning", color: "text-green-400" },
	user_limit_upload_overturn: { label: "Lifted upload limit", color: "text-green-400" },
	user_limit_duel_overturn: { label: "Lifted duel limit", color: "text-green-400" },
	user_limit_chat_overturn: { label: "Lifted chat limit", color: "text-green-400" },
	user_ban_temp_overturn: { label: "Overturned temp ban", color: "text-green-400" },
	user_ban_perm_overturn: { label: "Overturned perm ban", color: "text-green-400" },
	moderation_record_delete: { label: "Removed moderation record", color: "text-zinc-400" },
	location_create: { label: "Added location", color: "text-green-400" },
	location_hints_edit: { label: "Edited location hints", color: "text-blue-400" },
	announcement: { label: "Sent announcement", color: "text-purple-400" },
	announcement_banner_end: { label: "Took down a banner", color: "text-purple-400" },
	announcement_banner: { label: "Put up a banner", color: "text-purple-400" },
	duel_force_close: { label: "Closed a duel", color: "text-red-400" },
	announcement_draft: { label: "Saved an announcement draft", color: "text-zinc-400" },
	announcement_delete: { label: "Removed an announcement from history", color: "text-zinc-400" },
	changelog_add: { label: "Added a changelog entry", color: "text-green-400" },
	changelog_edit: { label: "Edited a changelog entry", color: "text-zinc-400" },
	changelog_delete: { label: "Removed a changelog entry", color: "text-red-400" },
	announcement_schedule: { label: "Scheduled an announcement", color: "text-purple-400" },
	email_settings: { label: "Changed the mail server", color: "text-orange-400" },
	email_test: { label: "Sent a test email", color: "text-zinc-400" },
	email_clear: { label: "Deleted every player's email", color: "text-red-400" },
	email_run: { label: "Sent due email summaries", color: "text-zinc-400" },
	announcement_recall: { label: "Took back an announcement", color: "text-purple-400" },
	announcement_correct: { label: "Fixed an announcement's wording", color: "text-purple-400" },
	maintenance_on: { label: "Maintenance mode on", color: "text-amber-300" },
	maintenance_off: { label: "Maintenance mode off", color: "text-green-400" },
	backup_create: { label: "Made a backup", color: "text-zinc-400" },
	backup_download: { label: "Downloaded a backup", color: "text-amber-300" },
	backup_delete: { label: "Deleted a backup", color: "text-red-400" },
	logs_clear: { label: "Cleared the server log", color: "text-red-400" },
	server_update: { label: "Started an update", color: "text-blue-400" },
	server_restart: { label: "Restarted the server", color: "text-blue-400" },
	server_restart_cancel: { label: "Called off a restart", color: "text-blue-400" },
	feature_toggle: { label: "Switched a feature", color: "text-blue-400" },
	achievements_backfill: { label: "Recalculated achievements", color: "text-blue-400" },
	team_game_start: { label: "Team duel started", color: "text-zinc-400" },
	team_game_end: { label: "Team duel finished", color: "text-zinc-400" },
	score_edit: { label: "Corrected a score", color: "text-amber-300" },
	score_delete: { label: "Removed a score", color: "text-red-400" },
	score_reset: { label: "Reset scores", color: "text-red-400" },
	staff_lock: { label: "Suspended staff access", color: "text-red-400" },
	staff_unlock: { label: "Restored staff access", color: "text-green-400" },
	evasion_flag: { label: "Possible ban evasion", color: "text-amber-300" },
	gdpr_export: { label: "Exported own data", color: "text-zinc-400" },
	evasion_flag_dismiss: { label: "Dismissed evasion flag", color: "text-zinc-400" },
	fairplay_flag_dismiss: { label: "Dismissed fair-play flag", color: "text-zinc-400" },
	staff_note_add: { label: "Added a staff note", color: "text-zinc-400" },
	staff_note_remove: { label: "Removed a staff note", color: "text-zinc-400" },
	user_ban_perm: { label: "Perma-banned user", color: "text-red-400" },
	user_ban_temp: { label: "Temp-banned user", color: "text-orange-400" },
	user_unban: { label: "Unbanned user", color: "text-green-400" },
	user_role_change: { label: "Changed role", color: "text-purple-400" },
	user_warn: { label: "Warned user", color: "text-yellow-400" },
	warning_delete: { label: "Deleted warning", color: "text-zinc-400" },
	warning_edit: { label: "Edited warning", color: "text-zinc-400" },
	ticket_reply: { label: "Replied to ticket", color: "text-blue-400" },
	ticket_close: { label: "Closed ticket", color: "text-zinc-400" },
	ticket_reopen: { label: "Reopened ticket", color: "text-blue-400" },
	ticket_delete: { label: "Deleted ticket", color: "text-zinc-500" },
	ticket_cleanup: { label: "Ticket cleanup", color: "text-zinc-500" },
	user_register: { label: "User registered", color: "text-zinc-400" },
	user_login: { label: "User login", color: "text-zinc-600" },
	user_delete: { label: "Account deleted", color: "text-zinc-500" },
	user_delete_operator: { label: "Account deleted (op)", color: "text-zinc-500" },
	gdpr_export_operator: { label: "GDPR export (op)", color: "text-zinc-400" },
	duel_room_create: { label: "Created duel room", color: "text-blue-400" },
	duel_join: { label: "Joined duel room", color: "text-blue-300" },
	quickplay_queue: { label: "Entered quickplay queue", color: "text-blue-400" },
	duel_start: { label: "Duel started", color: "text-green-400" },
	duel_end: { label: "Duel ended", color: "text-zinc-300" },
	duel_abandon: { label: "Duel abandoned", color: "text-orange-400" },
	tournament_create: { label: "Created tournament", color: "text-blue-400" },
	tournament_update: { label: "Edited tournament", color: "text-blue-300" },
	tournament_delete: { label: "Deleted tournament", color: "text-red-400" },
	tournament_open: { label: "Opened check-in", color: "text-green-400" },
	tournament_unpublish: { label: "Tournament back to draft", color: "text-zinc-400" },
	tournament_start: { label: "Started tournament", color: "text-green-400" },
	tournament_finish: { label: "Tournament finished", color: "text-zinc-300" },
	tournament_cancel: { label: "Cancelled tournament", color: "text-red-400" },
	tournament_history_reset: { label: "Cleared tournament history", color: "text-red-400" },
	tournament_players_add: { label: "Added tournament players", color: "text-blue-300" },
	tournament_player_remove: { label: "Removed tournament player", color: "text-orange-400" },
	tournament_shuffle: { label: "Shuffled tournament players", color: "text-zinc-400" },
	tournament_invite_on: { label: "Made tournament invite", color: "text-blue-300" },
	tournament_invite_off: { label: "Turned off tournament invite", color: "text-zinc-400" },
	tournament_invite_join: { label: "Joined tournament by invite", color: "text-blue-300" },
	tournament_redraw: { label: "Redrew bracket", color: "text-yellow-400" },
	tournament_reset: { label: "Sent back to check-in", color: "text-yellow-400" },
	tournament_skip: { label: "Skipped tournament countdown", color: "text-zinc-300" },
	tournament_add_time: { label: "Added tournament time", color: "text-zinc-300" },
	tournament_pause: { label: "Paused tournament", color: "text-yellow-400" },
	tournament_resume: { label: "Resumed tournament", color: "text-zinc-300" },
	tournament_continue: { label: "Continued tournament", color: "text-zinc-300" },
	tournament_match_start: { label: "Tournament match started", color: "text-green-400" },
	tournament_match_force: { label: "Started tournament match", color: "text-yellow-400" },
	tournament_match_restart: { label: "Restarted tournament match", color: "text-yellow-400" },
	tournament_award: { label: "Gave tournament match", color: "text-orange-400" },
	tournament_not_ready: { label: "Not ready, put out", color: "text-orange-400" },
	tournament_slot: { label: "Changed bracket place", color: "text-yellow-400" },
	tournament_message: { label: "Tournament message", color: "text-blue-300" },
	tournament_results_show: { label: "Showed tournament results", color: "text-zinc-300" },
	tournament_results_hide: { label: "Hid tournament results", color: "text-zinc-400" },
	tournament_chat_on: { label: "Turned chat on", color: "text-green-400" },
	tournament_chat_off: { label: "Turned chat off", color: "text-zinc-400" },
	tournament_chat_settings: { label: "Changed chat settings", color: "text-zinc-300" },
	tournament_chat_delete: { label: "Deleted chat message", color: "text-orange-400" },
	tournament_chat_approve: { label: "Approved chat message", color: "text-green-400" },
	tournament_chat_clear: { label: "Cleared chat", color: "text-orange-400" },
	chat_filter_add: { label: "Blocked chat words", color: "text-orange-400" },
	chat_filter_allow: { label: "Allowed chat words", color: "text-blue-300" },
	chat_filter_remove: { label: "Removed chat filter word", color: "text-zinc-400" },
	chat_list_add: { label: "Added word list", color: "text-orange-400" },
	chat_list_update: { label: "Changed word list", color: "text-zinc-300" },
	chat_list_remove: { label: "Removed word list", color: "text-zinc-400" },
};

const AUDIT_CATEGORIES = [
	{ key: "", label: "All" },
	{
		key: "moderation",
		label: "Moderation",
		actions: [
			"user_warning",
			"user_limit_upload",
			"user_limit_duel",
			"user_limit_chat",
			"user_ban_temp",
			"user_ban_perm",
			"user_warning_overturn",
			"user_limit_upload_overturn",
			"user_limit_duel_overturn",
			"user_limit_chat_overturn",
			"user_ban_temp_overturn",
			"user_ban_perm_overturn",
			"moderation_record_delete",
			"user_unban",
			"user_warn",
			"user_role_change",
			"staff_lock",
			"staff_unlock",
			"evasion_flag",
			"evasion_flag_dismiss",
			"fairplay_flag_dismiss",
			"staff_note_add",
			"staff_note_remove",
			"score_edit",
			"score_delete",
			"score_reset",
		],
	},
	{
		key: "content",
		label: "Content",
		actions: [
			"submission_approve",
			"submission_deny",
			"suggestion_approve",
			"suggestion_deny",
			"location_activate",
			"location_deactivate",
			"location_stats_reset",
			"location_create",
			"location_delete",
			"location_label_edit",
			"location_hints_edit",
		],
	},
	{
		key: "tickets",
		label: "Tickets",
		actions: ["ticket_reply", "ticket_close", "ticket_reopen", "ticket_delete", "ticket_cleanup"],
	},
	{
		key: "accounts",
		label: "Accounts",
		actions: [
			"user_register",
			"user_login",
			"user_delete",
			"user_delete_operator",
			"gdpr_export",
			"gdpr_export_operator",
		],
	},
	{
		key: "games",
		label: "Games",
		actions: [
			"duel_room_create",
			"duel_join",
			"quickplay_queue",
			"duel_start",
			"duel_end",
			"duel_abandon",
			"team_game_start",
			"team_game_end",
		],
	},
	{
		key: "tournaments",
		label: "Tournaments",
		actions: [
			"tournament_create",
			"tournament_update",
			"tournament_delete",
			"tournament_open",
			"tournament_unpublish",
			"tournament_start",
			"tournament_finish",
			"tournament_cancel",
			"tournament_history_reset",
			"tournament_players_add",
			"tournament_player_remove",
			"tournament_shuffle",
			"tournament_invite_on",
			"tournament_invite_off",
			"tournament_invite_join",
			"tournament_redraw",
			"tournament_reset",
			"tournament_skip",
			"tournament_add_time",
			"tournament_pause",
			"tournament_resume",
			"tournament_continue",
			"tournament_match_start",
			"tournament_match_force",
			"tournament_match_restart",
			"tournament_award",
			"tournament_not_ready",
			"tournament_slot",
			"tournament_message",
			"tournament_results_show",
			"tournament_results_hide",
			"tournament_chat_on",
			"tournament_chat_off",
			"tournament_chat_settings",
			"tournament_chat_delete",
			"tournament_chat_approve",
			"tournament_chat_clear",
			"chat_filter_add",
			"chat_filter_allow",
			"chat_filter_remove",
			"chat_list_add",
			"chat_list_update",
			"chat_list_remove",
		],
	},
	{
		key: "system",
		label: "System",
		actions: [
			"maintenance_on",
			"maintenance_off",
			"backup_create",
			"backup_download",
			"backup_delete",
			"logs_clear",
			"server_update",
			"server_restart",
			"server_restart_cancel",
			"feature_toggle",
			"achievements_backfill",
			"announcement",
			"announcement_banner_end",
			"announcement_banner",
			"announcement_draft",
			"announcement_delete",
			"changelog_add",
			"changelog_edit",
			"changelog_delete",
			"announcement_schedule",
			"email_settings",
			"email_test",
			"email_clear",
			"email_run",
			"announcement_recall",
			"announcement_correct",
		],
	},
];

const AUDIT_ROUTINE = new Set([
	"user_login",
	"user_register",
	"ticket_reply",
	"ticket_close",
	"duel_room_create",
	"duel_join",
	"quickplay_queue",
	"duel_start",
	"duel_end",
	"tournament_match_start",
	"tournament_invite_join",
]);

let auditOffset = 0;
const AUDIT_PAGE = 50;
let auditCategory = "";
let auditActionFilter = "";
let auditSearch = "";
let auditFrom = "";
let auditTo = "";
let auditShowRoutine = false;
let auditSearchTimer = null;
let expandedAuditGroupId = null;
let _lastAuditData = null;

/** A role change is stored as "moderator to helper"; shown with the roles' proper names. */
const roleChangeText = (details) =>
	details.replace(/(none|helper|curator|moderator|supervisor|admin|operator)/g, (role) =>
		role === "none" ? "no role" : ROLE_NAMES[role]
	);

export async function loadAudit(reset = true) {
	if (reset) auditOffset = 0;
	const cat = AUDIT_CATEGORIES.find((c) => c.key === auditCategory);
	const params = new URLSearchParams({ limit: String(AUDIT_PAGE), offset: String(auditOffset) });
	if (auditActionFilter) {
		params.set("action", auditActionFilter);
	} else if (cat?.actions) {
		params.set("actions", cat.actions.join(","));
	}
	if (auditSearch) params.set("q", auditSearch);
	if (auditFrom) params.set("from", auditFrom);
	if (auditTo) params.set("to", auditTo);
	try {
		const r = await fetch(`/api/admin/audit?${params}`);
		if (!r.ok) throw new Error();
		_lastAuditData = await r.json();
		renderAudit(_lastAuditData, reset);
	} catch {
		el("tab-content").innerHTML = errorStateHtml("Couldn't load the audit log.");
	}
}

/** A player, ticket or tournament the entry was about. */
function auditTargetHtml(e) {
	const player = e.target_username
		? ` <span class="text-zinc-600">on</span> <a href="/u/${encodeURIComponent(e.target_username)}" class="hover:underline">${escHtml(e.target_username)}</a>`
		: "";
	if (e.target_type === "ticket")
		return e.target_id ? ` <span class="text-zinc-600">on Ticket #${e.target_id}</span>` : "";
	if (e.target_type === "tournament" && e.target_id)
		return `${player} <span class="text-zinc-600">in</span> <a href="/admin#tournaments:${e.target_id}" data-on-click="switchTab('tournaments', false, ${e.target_id}); return false;" class="hover:underline">Tournament #${e.target_id}</a>`;
	return player || (e.target_id ? ` <span class="text-zinc-600">#${e.target_id}</span>` : "");
}

function auditEntryHtml(e, compact = false) {
	const info = AUDIT_ACTION_LABELS[e.action] || { label: e.action, color: "text-zinc-300" };
	const time = new Date(e.created_at * 1000).toLocaleString();
	return `<div class="flex items-start gap-3 bg-zinc-900 rounded-xl px-4 py-2.5 text-sm ${compact ? "opacity-60" : ""}">
        <span class="text-zinc-600 w-36 flex-shrink-0 text-xs pt-0.5">${time}</span>
        <span class="${info.color} w-44 flex-shrink-0 font-medium">${info.label}</span>
        <span class="text-zinc-300 flex-1">
            ${e.actor_username ? `<span class="text-zinc-400">by</span> <a href="/u/${encodeURIComponent(e.actor_username)}" class="hover:underline text-zinc-200">${escHtml(e.actor_username)}</a>` : '<span class="text-zinc-600">system</span>'}
            ${auditTargetHtml(e)}
            ${e.details ? ` <span class="text-zinc-600 text-xs ml-1">${escHtml(e.action === "user_role_change" ? roleChangeText(e.details) : e.details)}</span>` : ""}
        </span>
    </div>`;
}

function renderAudit({ rows, total, offset }, reset) {
	const container = el("tab-content");
	if (reset) {
		const typing = document.activeElement?.id === "audit-search" ? document.activeElement.selectionStart : null;
		expandedAuditGroupId = null;
		const cat = AUDIT_CATEGORIES.find((c) => c.key === auditCategory);
		const catActions = cat?.actions ?? Object.keys(AUDIT_ACTION_LABELS);
		container.innerHTML = `
            <div class="flex items-center gap-2 mb-3">
                <h2 class="text-lg font-bold">Audit Log</h2>
                <span id="audit-total" class="text-zinc-500 text-sm ml-auto">${total.toLocaleString()} entries</span>
            </div>
            <div class="flex gap-1.5 mb-4 flex-wrap">
                ${AUDIT_CATEGORIES.map((c) => `<button data-on-click="setAuditCategory('${c.key}')" class="audit-cat-btn px-3 py-1.5 rounded-full text-xs font-semibold transition ${auditCategory === c.key ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700"}" data-cat="${c.key}">${c.label}</button>`).join("")}
            </div>
            <div class="flex flex-wrap gap-2 mb-4">
                <input id="audit-search" type="search" value="${escHtml(auditSearch)}" placeholder="Search by name, action, target, details..."
                    class="flex-1 min-w-[200px] bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder:text-zinc-600" />
                <select id="audit-action-filter" class="bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-zinc-300">
                    <option value="">All actions</option>
                    ${catActions.map((a) => `<option value="${a}" ${a === auditActionFilter ? "selected" : ""}>${AUDIT_ACTION_LABELS[a]?.label ?? a}</option>`).join("")}
                </select>
                <input id="audit-from" type="date" value="${escHtml(auditFrom)}" title="From date"
                    class="bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-zinc-300" />
                <input id="audit-to" type="date" value="${escHtml(auditTo)}" title="To date"
                    class="bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-zinc-300" />
            </div>
            <div id="audit-rows" class="flex flex-col gap-1.5"></div>
            <div id="audit-empty" class="${total ? "hidden" : ""} text-zinc-500 text-center py-8">No audit entries match your filters.</div>
            <div id="audit-pagination" class="mt-4 flex gap-3 justify-center"></div>`;
		if (typing !== null) {
			const box = document.getElementById("audit-search");
			box.focus();
			box.setSelectionRange(typing, typing);
		}
		document.getElementById("audit-search").addEventListener("input", (e) => {
			auditSearch = e.target.value.trim();
			clearTimeout(auditSearchTimer);
			auditSearchTimer = setTimeout(() => loadAudit(true), 250);
		});
		document.getElementById("audit-action-filter").addEventListener("change", (e) => {
			auditActionFilter = e.target.value;
			loadAudit(true);
		});
		document.getElementById("audit-from").addEventListener("change", (e) => {
			auditFrom = e.target.value;
			loadAudit(true);
		});
		document.getElementById("audit-to").addEventListener("change", (e) => {
			auditTo = e.target.value;
			loadAudit(true);
		});
	} else {
		const totalEl = document.getElementById("audit-total");
		if (totalEl) totalEl.textContent = `${total.toLocaleString()} entries`;
	}

	const routineRows = [];
	const ticketGroups = new Map();
	const significantRows = [];
	for (const e of rows) {
		if (!auditShowRoutine && AUDIT_ROUTINE.has(e.action)) {
			routineRows.push(e);
		} else if (e.target_type === "ticket" && e.target_id) {
			if (!ticketGroups.has(e.target_id)) ticketGroups.set(e.target_id, []);
			ticketGroups.get(e.target_id).push(e);
		} else {
			significantRows.push(e);
		}
	}

	const ticketGroupsHtml = [...ticketGroups.entries()]
		.map(([ticketId, events]) => {
			const isOpen = expandedAuditGroupId === ticketId;
			const latest = events[events.length - 1];
			const info = AUDIT_ACTION_LABELS[latest.action] || { label: latest.action, color: "text-zinc-300" };
			return `<div class="bg-zinc-900 rounded-xl overflow-hidden">
                <button data-on-click="toggleAuditGroup(${ticketId})" class="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left hover:bg-zinc-800/50 transition">
                    <span class="text-zinc-600 w-36 flex-shrink-0 text-xs">${new Date(latest.created_at * 1000).toLocaleString()}</span>
                    <span class="${info.color} font-medium flex-1">Ticket #${ticketId} · ${events.length} event${events.length !== 1 ? "s" : ""}</span>
                    <span class="material-symbols-outlined text-zinc-500 text-base transition-transform ${isOpen ? "rotate-180" : ""}">expand_more</span>
                </button>
                ${isOpen ? `<div class="border-t border-zinc-800 flex flex-col gap-1 p-2">${events.map((ev) => auditEntryHtml(ev)).join("")}</div>` : ""}
            </div>`;
		})
		.join("");

	let routineHtml = "";
	if (routineRows.length > 0) {
		routineHtml = `<div class="mt-1 border border-zinc-800 rounded-xl overflow-hidden">
            <button data-on-click="toggleAuditRoutine()" class="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-left hover:bg-zinc-800/40 transition text-zinc-500">
                <span class="material-symbols-outlined text-base leading-none">expand_more</span>
                <span>${routineRows.length} routine event${routineRows.length !== 1 ? "s" : ""} - logins, registrations, ticket replies</span>
            </button>
        </div>`;
	}

	const rowsEl = el("audit-rows");
	rowsEl.innerHTML = significantRows.map((e) => auditEntryHtml(e)).join("") + ticketGroupsHtml + routineHtml;

	const emptyEl = document.getElementById("audit-empty");
	if (emptyEl) emptyEl.classList.toggle("hidden", total > 0);

	const pagination = el("audit-pagination");
	const showPrev = offset > 0;
	const showNext = offset + rows.length < total;
	pagination.innerHTML = `
        ${showPrev ? `<button data-on-click="auditPage(-1)" class="m-btn m-btn-tonal m-btn-sm">Previous</button>` : ""}
        ${showNext ? `<button data-on-click="auditPage(1)" class="m-btn m-btn-tonal m-btn-sm">Next</button>` : ""}`;
}

export function toggleAuditGroup(id) {
	expandedAuditGroupId = expandedAuditGroupId === id ? null : id;
	if (_lastAuditData) renderAudit(_lastAuditData, false);
}

export function toggleAuditRoutine() {
	auditShowRoutine = !auditShowRoutine;
	if (_lastAuditData) renderAudit(_lastAuditData, false);
}

export function setAuditCategory(cat) {
	auditCategory = cat;
	auditActionFilter = "";
	loadAudit(true);
}

export function auditPage(dir) {
	auditOffset = Math.max(0, auditOffset + dir * AUDIT_PAGE);
	loadAudit(false);
}

Object.assign(window, { auditPage, setAuditCategory, toggleAuditGroup, toggleAuditRoutine });
