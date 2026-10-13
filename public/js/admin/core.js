/** Staff panel core: shared state, dialogs, access checks and tab switching. */

let currentUser = null;
let currentTab = "";
let denyTargetId = null;
let denyCallback = null;
/** Roles, lowest first. The server decides what each may do; this only decides what to show. */
const ROLE_RANK_JS = { helper: 1, curator: 2, moderator: 3, supervisor: 4, admin: 5, operator: 6 };
const STAFF_ROLES = Object.keys(ROLE_RANK_JS);
/** Whether whoever is logged in holds at least this role. */
const atLeast = (role) => (ROLE_RANK_JS[currentUser?.role] ?? 0) >= ROLE_RANK_JS[role];
/** The lowest role that may open each tab. */
const TAB_MIN_ROLE = {
	overview: "helper",
	submissions: "helper",
	suggestions: "helper",
	locations: "curator",
	users: "moderator",
	tickets: "moderator",
	duels: "moderator",
	staff: "moderator",
	announcements: "admin",
	stats: "supervisor",
	audit: "supervisor",
	email: "operator",
	system: "operator",
};
const canOpenTab = (tab) => atLeast(TAB_MIN_ROLE[tab] ?? "operator");
/** Shortest reason the server accepts for denying a submission or a suggestion. */
const DENY_REASON_MIN = 5;

const LABEL_MIN_LENGTH = 5;
const LABEL_MAX_LENGTH = 128;

function panelSearchInput(placeholder) {
	return `<label class="relative block mb-4">
        <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 text-lg">search</span>
        <input id="panel-search" type="search" placeholder="${escHtml(placeholder)}" autocomplete="off"
            class="w-full bg-zinc-900 border border-zinc-800 rounded-xl pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder:text-zinc-600" />
    </label>`;
}

/** The title row of a review tab: name, how many are waiting, and a refresh button. */
function reviewHeader(title, count, refresh) {
	return `<div class="flex items-center gap-2 mb-4">
		<h2 class="font-bold text-lg">${title}</h2>
		${count ? `<span class="m-tag info">${count} waiting</span>` : ""}
		<button onclick="${refresh}" class="m-icon-btn ml-auto" aria-label="Refresh" title="Refresh"><span class="material-symbols-outlined">refresh</span></button>
	</div>`;
}

function emptyQueueHtml(text) {
	return `<div class="flex flex-col items-center gap-2 py-16 text-center">
		<span class="material-symbols-outlined text-4xl text-green-400/70" style="font-variation-settings:'FILL' 1">task_alt</span>
		<p class="text-sm text-zinc-400">${text}</p>
	</div>`;
}

/** A player's name that opens their staff panel. Helpers cannot open it, so they get plain text. */
function staffUserLink(userId, username) {
	const name = `@${escHtml(username || "unknown")}`;
	return userId && atLeast("moderator")
		? `<button onclick="openUserPanel(${userId})" class="text-blue-400 hover:underline">${name}</button>`
		: `<span class="text-zinc-300">${name}</span>`;
}

/** A picker of everyone with something in the list, busiest first. */
function userFilterSelect(items, nameOf, current, setter) {
	const counts = new Map();
	for (const item of items) {
		const name = nameOf(item);
		if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	if (counts.size < 2 && !current) return "";
	const names = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	return `<select onchange="${setter}(this.value)" class="m-field !w-auto !py-1.5 text-xs" aria-label="Filter by user">
		<option value="">From anyone</option>
		${names.map(([name, count]) => `<option value="${escHtml(name)}" ${name === current ? "selected" : ""}>@${escHtml(name)} (${count})</option>`).join("")}
	</select>`;
}

/** Puts a search back after a list is redrawn. */
function restorePanelSearch(text) {
	const input = el("panel-search");
	if (!text || !input) return;
	input.value = text;
	input.dispatchEvent(new Event("input"));
}

/** The Waiting and Reviewed switch at the top of a review tab. */
function reviewViewChips(view, setter, waiting) {
	return `<button onclick="${setter}('waiting')" class="m-chip" aria-pressed="${view === "waiting"}">Waiting <span class="count">${waiting}</span></button>
		<button onclick="${setter}('reviewed')" class="m-chip" aria-pressed="${view === "reviewed"}">Reviewed</button>`;
}

/** One line of a Reviewed list: what it was, who sent it, who reviewed it and why it was denied. */
function reviewedRowHtml({
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
		${image ? `<img loading="lazy" src="/uploads/${escHtml(image)}" alt="" onerror="this.remove()" class="w-16 h-10 rounded-lg object-cover flex-shrink-0" />` : ""}
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

/** Shows a screenshot large, with the in-game magnifier. */
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
	/** The same magnifier players get in a round, so staff see what they will see. */
	setupPhotoLens(box.querySelector("img"));
	box.addEventListener("click", (e) => (e.target === box || e.target.closest("[data-close]")) && box.remove());
	/** Keys pressed here must not reach the review shortcuts underneath. */
	box.addEventListener("keydown", (e) => {
		e.stopPropagation();
		if (e.key === "Escape") box.remove();
	});
	document.body.appendChild(box);
	box.focus();
}

/* ---- Claims: who else has an item open ---- */

const CLAIM_REFRESH_MS = 20_000;
let _claims = [];
let _claimKey = "";

/** What this member of staff has open right now, if it is something others could also pick up. */
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

/** Tells the server what is open here and learns what others have open. Also keeps this claim alive. */
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

/** After a list is drawn: repaints the markers, and reports in if something else was opened. */
function claimChanged() {
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

let _reviewMap = null;

/** The one map the review tabs share, moved to whichever slot shows it. */
function mountReviewMap(slot) {
	const canvas =
		_reviewMap?.canvas ??
		Object.assign(document.createElement("canvas"), { className: "absolute inset-0 w-full h-full" });
	slot.appendChild(canvas);
	_reviewMap ??= new MapCanvas(canvas, {});
	_reviewMap._handleResize();
	return _reviewMap;
}

function bindPanelSearch(selector) {
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

function showConfirm(title, message, { confirmLabel = "Confirm", confirmClass = "bg-red-600 hover:bg-red-500" } = {}) {
	return new Promise((resolve) => {
		el("confirm-title").textContent = title;
		el("confirm-message").textContent = message;
		const okBtn = el("confirm-ok");
		okBtn.textContent = confirmLabel;
		okBtn.className = `px-5 py-2 rounded-xl transition text-sm font-semibold ${confirmClass}`;
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

function showPrompt(title, placeholder = "", { note = "", type = "text", okLabel = "OK" } = {}) {
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

async function init() {
	currentUser = await fetchUser();

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
	/** The group headings follow the tabs under them. */
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
	/** A denial has to say why: the button stays off until there is a reason to send. */
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

/** Puts the number of items waiting on each tab that has a queue (for Users: possible ban evasion). */
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
	/** Old links still work: "#support" was the tickets tab, and "#games" is now part of the audit log. */
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

function switchTab(tab, fromHash = false, autoOpenId = null) {
	if (currentTab === tab && !fromHash) {
		location.hash = tab;
		return;
	}
	/** A link or an old bookmark to a tab this role cannot open lands on the first one it can. */
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
	else if (tab === "submissions") loadSubmissions();
	else if (tab === "suggestions") loadSuggestions();
	else if (tab === "locations") loadLocations();
	else if (tab === "users") loadUsers();
	else if (tab === "tickets") loadTickets(true, autoOpenId);
	else if (tab === "duels") loadDuels();
	else if (tab === "announcements") loadAnnouncementsTab();
	else if (tab === "staff") loadStaff();
	else if (tab === "stats") loadStats();
	else if (tab === "audit") loadAudit();
	else if (tab === "email") loadEmail();
	else if (tab === "system") loadSystem();
	claimChanged();
}
