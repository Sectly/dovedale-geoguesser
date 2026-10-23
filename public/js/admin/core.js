import { MapCanvas } from "../map-canvas.js";
import { el, escHtml, skeletonRows } from "../lib/dom.js";
import { api, fetchUser } from "../lib/api.js";
import { refreshAttention } from "../lib/attention.js";
import { onLive } from "../lib/live.js";
import { setupPhotoLens } from "../lib/effects.js";
import { bindRuleChips, ruleChipsHtml } from "../rules.js";
import { loadOverview, shortAgo } from "./overview.js";
import { loadChat } from "./chat.js";
import { _openSubmission, _submissionView, denySubmission, loadSubmissions } from "./submissions.js";
import { loadSuggestions } from "./suggestions.js";
import { loadLocations, loadStats } from "./locations.js";
import { loadAnnouncementsTab } from "./announcements.js";
import { expandedTicketId, loadTickets } from "./tickets.js";
import { loadDuels } from "./duels.js";
import { loadTournaments } from "./tournaments.js";
import { loadUsers } from "./users.js";
import { loadStaff } from "./staff.js";
import { loadAudit } from "./audit.js";
import { loadSystem } from "./system.js";
import { loadEmail } from "./email.js";

export let currentUser = null;
export let currentTab = "";
let denyTargetId = null;
let denyCallback = null;

/** Opens the deny dialog for a submission by id, or for anything else through `callback`. */
export function openDenyDialog(title, id, callback = null) {
	denyTargetId = id;
	denyCallback = callback;
	el("deny-modal-title").textContent = title;
	el("deny-reason").value = "";
	el("deny-reason").dispatchEvent(new Event("input"));
	el("deny-modal").classList.remove("hidden");
	setTimeout(() => el("deny-reason").focus(), 50);
}
/** Lowest first. Only decides what to show; the server decides what each may do. */
export const ROLE_RANK_JS = { helper: 1, curator: 2, moderator: 3, supervisor: 4, admin: 5, operator: 6 };
const STAFF_ROLES = Object.keys(ROLE_RANK_JS);
export const atLeast = (role) => (ROLE_RANK_JS[currentUser?.role] ?? 0) >= ROLE_RANK_JS[role];
const TAB_MIN_ROLE = {
	overview: "helper",
	chat: "curator",
	submissions: "helper",
	suggestions: "helper",
	locations: "curator",
	users: "moderator",
	tickets: "moderator",
	duels: "moderator",
	tournaments: "moderator",
	staff: "moderator",
	announcements: "admin",
	stats: "supervisor",
	audit: "supervisor",
	email: "operator",
	system: "operator",
};
export const canOpenTab = (tab) => atLeast(TAB_MIN_ROLE[tab] ?? "operator");
const DENY_REASON_MIN = 5;

export let LABEL_MIN_LENGTH = 0;
export let LABEL_MAX_LENGTH = 0;

export function panelSearchInput(placeholder) {
	return `<label class="relative block mb-4">
        <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 text-lg">search</span>
        <input id="panel-search" type="search" placeholder="${escHtml(placeholder)}" autocomplete="off"
            class="w-full bg-zinc-900 border border-zinc-800 rounded-xl pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder:text-zinc-600" />
    </label>`;
}

export function reviewHeader(title, count, refresh) {
	return `<div class="flex items-center gap-2 mb-4">
		<h2 class="font-bold text-lg">${title}</h2>
		${count ? `<span class="m-tag info">${count} waiting</span>` : ""}
		<button data-on-click="${refresh}" class="m-icon-btn ml-auto" aria-label="Refresh" title="Refresh"><span class="material-symbols-outlined">refresh</span></button>
	</div>`;
}

export function emptyQueueHtml(text) {
	return `<div class="flex flex-col items-center gap-2 py-16 text-center">
		<span class="material-symbols-outlined text-4xl text-green-400/70" style="font-variation-settings:'FILL' 1">task_alt</span>
		<p class="text-sm text-zinc-400">${text}</p>
	</div>`;
}

/** Opens their staff panel; helpers can't, so they get plain text. */
export function staffUserLink(userId, username) {
	const name = `@${escHtml(username || "unknown")}`;
	return userId && atLeast("moderator")
		? `<button data-on-click="openUserPanel(${userId})" class="text-blue-400 hover:underline">${name}</button>`
		: `<span class="text-zinc-300">${name}</span>`;
}

export function userFilterSelect(items, nameOf, current, setter) {
	const counts = new Map();
	for (const item of items) {
		const name = nameOf(item);
		if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	if (counts.size < 2 && !current) return "";
	const names = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	return `<select data-on-change="${setter}(this.value)" class="m-field !w-auto !py-1.5 text-xs" aria-label="Filter by user">
		<option value="">From anyone</option>
		${names.map(([name, count]) => `<option value="${escHtml(name)}" ${name === current ? "selected" : ""}>@${escHtml(name)} (${count})</option>`).join("")}
	</select>`;
}

export function restorePanelSearch(text) {
	const input = el("panel-search");
	if (!text || !input) return;
	input.value = text;
	input.dispatchEvent(new Event("input"));
}

export function reviewViewChips(view, setter, waiting) {
	return `<button data-on-click="${setter}('waiting')" class="m-chip" aria-pressed="${view === "waiting"}">Waiting <span class="count">${waiting}</span></button>
		<button data-on-click="${setter}('reviewed')" class="m-chip" aria-pressed="${view === "reviewed"}">Reviewed</button>`;
}

export function reviewedRowHtml({
	code,
	title,
	image,
	userId,
	username,
	displayName,
	status,
	reviewer,
	reviewedAt,
	reason,
	tag = "",
}) {
	const approved = status === "approved";
	const search = [
		code,
		title,
		username && `@${username}`,
		displayName,
		status,
		reviewer && `@${reviewer}`,
		reason,
	].join(" ");
	return `<div class="bg-zinc-900 rounded-2xl px-4 py-3 flex items-start gap-3" data-search="${escHtml(search)}">
		${image ? `<img loading="lazy" decoding="async" src="/uploads/${escHtml(image)}" alt="" data-on-error="this.remove()" class="w-16 h-10 rounded-lg object-cover flex-shrink-0" />` : ""}
		<div class="flex-1 min-w-0">
			<div class="flex items-center gap-2 flex-wrap">
				${tag}
				<span class="text-sm font-semibold truncate">${title ? escHtml(title) : '<span class="text-zinc-500 font-normal">No label</span>'}</span>
				<span class="m-tag ${approved ? "success" : "danger"}">${approved ? "Approved" : "Denied"}</span>
			</div>
			<div class="text-xs text-zinc-500 mt-0.5">${staffUserLink(userId, username)} · reviewed${reviewedAt ? ` ${shortAgo(reviewedAt)} ago` : ""}${reviewer ? ` by @${escHtml(reviewer)}` : ""}</div>
			${reason ? `<p class="text-xs text-zinc-400 mt-1 break-words">${escHtml(reason)}</p>` : ""}
		</div>
		<span class="text-xs font-mono text-zinc-600 flex-shrink-0">${code}</span>
	</div>`;
}

function viewImage(src) {
	el("image-viewer")?.remove();
	const box = document.createElement("div");
	box.id = "image-viewer";
	box.className = "fixed inset-0 z-[90] bg-black/90 flex items-center justify-center p-4 modal-fade";
	box.setAttribute("role", "dialog");
	box.setAttribute("aria-modal", "true");
	box.setAttribute("aria-label", "Screenshot");
	box.tabIndex = -1;
	box.innerHTML = `<div class="relative inline-block overflow-hidden rounded-xl">
			<img src="${escHtml(src)}" alt="" class="block max-w-[92vw] max-h-[86vh] object-contain cursor-crosshair" />
		</div>
		<div class="absolute top-4 right-4 flex gap-2">
			<a href="${escHtml(src)}" target="_blank" rel="noopener" class="m-btn m-btn-tonal m-btn-sm"><span class="material-symbols-outlined">open_in_new</span>New tab</a>
			<button class="m-icon-btn" aria-label="Close" data-close><span class="material-symbols-outlined">close</span></button>
		</div>
		<p class="absolute bottom-4 left-1/2 -translate-x-1/2 text-xs text-zinc-400 bg-black/60 rounded-full px-3 py-1 pointer-events-none">Hover to magnify, as players can. Scroll to change the zoom.</p>`;
	setupPhotoLens(box.querySelector("img"));
	box.addEventListener("click", (e) => (e.target === box || e.target.closest("[data-close]")) && box.remove());
	box.addEventListener("keydown", (e) => {
		e.stopPropagation();
		if (e.key === "Escape") box.remove();
	});
	document.body.appendChild(box);
	box.focus();
}

const CLAIM_REFRESH_MS = 20_000;
let _claims = [];
let _claimKey = "";

function openClaim() {
	if (currentTab === "submissions" && _submissionView === "waiting" && _openSubmission)
		return { kind: "submission", id: _openSubmission };
	if (currentTab === "tickets" && expandedTicketId) return { kind: "ticket", id: expandedTicketId };
	return {};
}

function paintClaims() {
	for (const slot of document.querySelectorAll("[data-claim]")) {
		const [kind, id] = slot.dataset.claim.split(":");
		const claim = _claims.find((item) => item.kind === kind && item.id === Number(id));
		slot.innerHTML = claim ? `<span class="m-tag warn">${escHtml(claim.name)} is on this</span>` : "";
	}
}

async function syncClaims() {
	const mine = openClaim();
	_claimKey = `${mine.kind}:${mine.id}`;
	try {
		_claims = await api("/api/admin/claims", { json: mine });
	} catch {
		return;
	}
	paintClaims();
}

export function claimChanged() {
	const mine = openClaim();
	if (`${mine.kind}:${mine.id}` !== _claimKey) syncClaims();
	else paintClaims();
}

setInterval(() => {
	if (
		!document.hidden &&
		currentUser?.role &&
		(_claimKey !== "undefined:undefined" || ["submissions", "tickets"].includes(currentTab))
	)
		syncClaims();
}, CLAIM_REFRESH_MS);
onLive("claims", () => ["submissions", "tickets"].includes(currentTab) && !document.hidden && syncClaims());

let _reviewMap = null;

export function mountReviewMap(slot) {
	const canvas =
		_reviewMap?.canvas ??
		Object.assign(document.createElement("canvas"), { className: "absolute inset-0 w-full h-full" });
	slot.appendChild(canvas);
	_reviewMap ??= new MapCanvas(canvas, {});
	_reviewMap._handleResize();
	return _reviewMap;
}

export function bindPanelSearch(selector) {
	const input = el("panel-search");
	if (!input) return;
	input.addEventListener("input", () => {
		const query = input.value.trim().toLocaleLowerCase();
		let visible = 0;
		document.querySelectorAll(selector).forEach((item) => {
			const matches = !query || item.dataset.search?.toLocaleLowerCase().includes(query);
			item.classList.toggle("hidden", !matches);
			if (matches) visible++;
		});
		const empty = el("panel-search-empty");
		if (empty) empty.classList.toggle("hidden", visible > 0);
	});
}

export function showConfirm(title, message, { confirmLabel = "Confirm", confirmClass = "m-btn-danger" } = {}) {
	return new Promise((resolve) => {
		el("confirm-title").textContent = title;
		el("confirm-message").textContent = message;
		const okBtn = el("confirm-ok");
		okBtn.textContent = confirmLabel;
		okBtn.className = `m-btn ${confirmClass}`;
		el("confirm-modal").classList.remove("hidden");
		const done = (val) => {
			el("confirm-modal").classList.add("hidden");
			okBtn.removeEventListener("click", onOk);
			el("confirm-cancel").removeEventListener("click", onCancel);
			resolve(val);
		};
		const onOk = () => done(true);
		const onCancel = () => done(false);
		okBtn.addEventListener("click", onOk);
		el("confirm-cancel").addEventListener("click", onCancel);
	});
}

export function showPrompt(title, placeholder = "", { note = "", type = "text", okLabel = "OK" } = {}) {
	return new Promise((resolve) => {
		el("input-title").textContent = title;
		const noteEl = el("input-note");
		noteEl.textContent = note;
		noteEl.classList.toggle("hidden", !note);
		const field = el("input-field");
		field.type = type;
		field.placeholder = placeholder;
		field.value = "";
		el("input-ok").textContent = okLabel;
		el("input-modal").classList.remove("hidden");
		setTimeout(() => field.focus(), 50);
		const done = (val) => {
			el("input-modal").classList.add("hidden");
			el("input-ok").removeEventListener("click", onOk);
			el("input-cancel").removeEventListener("click", onCancel);
			field.removeEventListener("keydown", onKey);
			resolve(val);
		};
		const onOk = () => done(field.value);
		const onCancel = () => done(null);
		const onKey = (e) => {
			if (e.key === "Enter") done(field.value);
			if (e.key === "Escape") done(null);
		};
		el("input-ok").addEventListener("click", onOk);
		el("input-cancel").addEventListener("click", onCancel);
		field.addEventListener("keydown", onKey);
	});
}

let _sidebar, _sidebarOverlay;

function closeSidebar() {
	_sidebar?.classList.add("hidden");
	_sidebarOverlay?.classList.add("hidden");
}

export async function init() {
	currentUser = await fetchUser();
	if (currentUser) ({ label_min: LABEL_MIN_LENGTH, label_max: LABEL_MAX_LENGTH } = currentUser.limits);

	if (!currentUser) {
		el("access-msg").textContent = "You must be logged in to access this page.";
		return;
	}
	if (currentUser.staff_locked) {
		el("access-msg").textContent =
			"Your staff access has been suspended by a senior member of staff. You can still play as normal. Open a ticket if you think this is a mistake.";
		return;
	}
	if (!STAFF_ROLES.includes(currentUser.role)) {
		el("access-msg").textContent = "Access denied. This page is for staff.";
		return;
	}

	el("access-denied").classList.add("hidden");
	el("admin-panel").classList.remove("hidden");

	for (const btn of document.querySelectorAll(".tab-btn"))
		btn.classList.toggle("hidden", !canOpenTab(btn.dataset.tab));
	for (const label of document.querySelectorAll("div.moderator-up"))
		label.classList.toggle("hidden", !atLeast("moderator"));
	for (const label of document.querySelectorAll("div.senior-only"))
		label.classList.toggle("hidden", !atLeast("supervisor"));

	document.querySelectorAll(".tab-btn").forEach((btn) => {
		btn.addEventListener("click", () => {
			switchTab(btn.dataset.tab);
			closeSidebar();
		});
	});

	_sidebar = el("admin-sidebar");
	_sidebarOverlay = el("sidebar-overlay");
	el("sidebar-toggle")?.addEventListener("click", () => {
		_sidebar.classList.toggle("hidden");
		_sidebarOverlay.classList.toggle("hidden");
	});
	_sidebarOverlay?.addEventListener("click", closeSidebar);

	el("deny-rules").innerHTML = ruleChipsHtml("U");
	bindRuleChips(el("deny-rules"), el("deny-reason"));
	el("deny-reason").addEventListener("input", () => {
		const left = DENY_REASON_MIN - el("deny-reason").value.trim().length;
		el("deny-confirm").disabled = left > 0;
		el("deny-count").textContent =
			left > 0 ? `A reason is required: ${left} more character${left === 1 ? "" : "s"}` : "";
	});
	el("deny-cancel").addEventListener("click", () => el("deny-modal").classList.add("hidden"));
	el("deny-confirm").addEventListener("click", () => {
		const reason = el("deny-reason").value.trim();
		if (reason.length < DENY_REASON_MIN) return;
		el("deny-modal").classList.add("hidden");
		if (denyTargetId !== null) denySubmission(denyTargetId, reason);
		else if (denyCallback) denyCallback(reason);
		denyCallback = null;
	});

	document.addEventListener("attention", (e) =>
		renderQueueCounts(currentUser.prefs?.staff_badges ? e.detail?.staff : null)
	);
	window.addEventListener("hashchange", handleHashNav);
	handleHashNav();
}

function renderQueueCounts(queue) {
	for (const tab of ["submissions", "suggestions", "tickets", "users"]) {
		const btn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
		if (!btn) continue;
		btn.querySelector(".tab-count")?.remove();
		const count = queue?.[tab] ?? 0;
		if (count > 0) {
			btn.insertAdjacentHTML(
				"beforeend",
				`<span class="tab-count ml-auto min-w-[1.25rem] h-5 px-1.5 rounded-full bg-blue-500 text-white text-[11px] font-bold leading-5 text-center" title="${count} waiting">${count > 99 ? "99+" : count}</span>`
			);
		}
	}
}

function handleHashNav() {
	const hash = location.hash
		.replace("#", "")
		.replace(/^support/, "tickets")
		.replace(/^games$/, "audit");
	if (!hash) {
		switchTab("overview", true);
		return;
	}
	const [tab, id] = hash.split(":");
	if (tab) switchTab(tab, true, id ? parseInt(id) : null);
}

export function switchTab(tab, fromHash = false, autoOpenId = null) {
	if (currentTab === tab && !fromHash) {
		location.hash = tab;
		return;
	}
	if (!canOpenTab(tab)) tab = "overview";
	currentTab = tab;
	if (!fromHash) location.hash = tab;

	document.querySelectorAll(".tab-btn").forEach((btn) => {
		const active = btn.dataset.tab === tab;
		btn.className = `tab-btn flex items-center gap-2.5 text-left px-3 py-2 rounded-lg text-sm font-medium transition ${active ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}`;
		btn.classList.toggle("hidden", !canOpenTab(btn.dataset.tab));
	});

	const content = el("tab-content");
	content.innerHTML = skeletonRows(5, "h-24");
	refreshAttention();

	if (tab === "overview") loadOverview();
	else if (tab === "chat") loadChat();
	else if (tab === "submissions") loadSubmissions();
	else if (tab === "suggestions") loadSuggestions();
	else if (tab === "locations") loadLocations();
	else if (tab === "users") loadUsers();
	else if (tab === "tickets") loadTickets(true, autoOpenId);
	else if (tab === "duels") loadDuels();
	else if (tab === "tournaments") loadTournaments(autoOpenId);
	else if (tab === "announcements") loadAnnouncementsTab();
	else if (tab === "staff") loadStaff();
	else if (tab === "stats") loadStats();
	else if (tab === "audit") loadAudit();
	else if (tab === "email") loadEmail();
	else if (tab === "system") loadSystem();
	claimChanged();
}

Object.assign(window, { switchTab, viewImage });
