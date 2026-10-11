/** Staff panel: the audit log. */

const AUDIT_ACTION_LABELS = {
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
	user_warning_overturn: { label: "Overturned warning", color: "text-green-400" },
	user_limit_upload_overturn: { label: "Lifted upload limit", color: "text-green-400" },
	user_limit_duel_overturn: { label: "Lifted duel limit", color: "text-green-400" },
	user_ban_temp_overturn: { label: "Overturned temp ban", color: "text-green-400" },
	user_ban_perm_overturn: { label: "Overturned perm ban", color: "text-green-400" },
	moderation_record_delete: { label: "Removed moderation record", color: "text-zinc-400" },
	location_create: { label: "Added location", color: "text-green-400" },
	location_hints_edit: { label: "Edited location hints", color: "text-blue-400" },
	announcement: { label: "Sent announcement", color: "text-purple-400" },
	announcement_banner_end: { label: "Took down a banner", color: "text-purple-400" },
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
			"user_ban_temp",
			"user_ban_perm",
			"user_warning_overturn",
			"user_limit_upload_overturn",
			"user_limit_duel_overturn",
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

async function loadAudit(reset = true) {
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
		el("tab-content").innerHTML = '<div class="text-red-400">Failed to load audit log.</div>';
	}
}

function auditEntryHtml(e, compact = false) {
	const info = AUDIT_ACTION_LABELS[e.action] || { label: e.action, color: "text-zinc-300" };
	const time = new Date(e.created_at * 1000).toLocaleString();
	return `<div class="flex items-start gap-3 bg-zinc-900 rounded-xl px-4 py-2.5 text-sm ${compact ? "opacity-60" : ""}">
        <span class="text-zinc-600 w-36 flex-shrink-0 text-xs pt-0.5">${time}</span>
        <span class="${info.color} w-44 flex-shrink-0 font-medium">${info.label}</span>
        <span class="text-zinc-300 flex-1">
            ${e.actor_username ? `<span class="text-zinc-400">by</span> <a href="/u/${encodeURIComponent(e.actor_username)}" class="hover:underline text-zinc-200">${escHtml(e.actor_username)}</a>` : '<span class="text-zinc-600">system</span>'}
            ${e.target_type !== "ticket" ? (e.target_username ? ` <span class="text-zinc-600">on</span> <a href="/u/${encodeURIComponent(e.target_username)}" class="hover:underline">${escHtml(e.target_username)}</a>` : e.target_id ? ` <span class="text-zinc-600">#${e.target_id}</span>` : "") : e.target_id ? ` <span class="text-zinc-600">on Ticket #${e.target_id}</span>` : ""}
            ${e.details ? ` <span class="text-zinc-600 text-xs ml-1">${escHtml(e.details)}</span>` : ""}
        </span>
    </div>`;
}

function renderAudit({ rows, total, offset }, reset) {
	const container = el("tab-content");
	if (reset) {
		expandedAuditGroupId = null;
		const cat = AUDIT_CATEGORIES.find((c) => c.key === auditCategory);
		const catActions = cat?.actions ?? Object.keys(AUDIT_ACTION_LABELS);
		container.innerHTML = `
            <div class="flex items-center gap-2 mb-3">
                <h2 class="text-lg font-bold">Audit Log</h2>
                <span id="audit-total" class="text-zinc-500 text-sm ml-auto">${total.toLocaleString()} entries</span>
            </div>
            <div class="flex gap-1.5 mb-4 flex-wrap">
                ${AUDIT_CATEGORIES.map((c) => `<button onclick="setAuditCategory('${c.key}')" class="audit-cat-btn px-3 py-1.5 rounded-full text-xs font-semibold transition ${auditCategory === c.key ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700"}" data-cat="${c.key}">${c.label}</button>`).join("")}
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
                <button onclick="toggleAuditGroup(${ticketId})" class="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left hover:bg-zinc-800/50 transition">
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
            <button onclick="toggleAuditRoutine()" class="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-left hover:bg-zinc-800/40 transition text-zinc-500">
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
        ${showPrev ? `<button onclick="auditPage(-1)" class="text-sm bg-zinc-800 hover:bg-zinc-700 transition px-4 py-2 rounded-lg">Previous</button>` : ""}
        ${showNext ? `<button onclick="auditPage(1)" class="text-sm bg-zinc-800 hover:bg-zinc-700 transition px-4 py-2 rounded-lg">Next</button>` : ""}`;
}

function toggleAuditGroup(id) {
	expandedAuditGroupId = expandedAuditGroupId === id ? null : id;
	if (_lastAuditData) renderAudit(_lastAuditData, false);
}

function toggleAuditRoutine() {
	auditShowRoutine = !auditShowRoutine;
	if (_lastAuditData) renderAudit(_lastAuditData, false);
}

function setAuditCategory(cat) {
	auditCategory = cat;
	auditActionFilter = "";
	loadAudit(true);
}

function auditPage(dir) {
	auditOffset = Math.max(0, auditOffset + dir * AUDIT_PAGE);
	loadAudit(false);
}
