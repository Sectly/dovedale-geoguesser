/** Staff panel core: shared state, dialogs, access checks and tab switching. */

let currentUser = null;
let currentTab = "submissions";
let denyTargetId = null;
let denyCallback = null;
const STAFF_ROLES = ["helper", "moderator", "supervisor", "operator"];
/** A helper reviews what players send in and can look at the locations; nothing else is theirs. */
const HELPER_TABS = ["submissions", "suggestions", "locations"];
const isHelper = () => currentUser?.role === "helper";
/** Whether the logged-in member of staff may open a tab. */
const canOpenTab = (tab) => !isHelper() || HELPER_TABS.includes(tab);
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

	if (currentUser.role === "operator") {
		document.querySelectorAll(".operator-only").forEach((el) => el.classList.remove("hidden"));
	}
	if (currentUser.role === "operator" || currentUser.role === "supervisor") {
		document.querySelectorAll(".senior-only").forEach((el) => el.classList.remove("hidden"));
	}
	for (const btn of document.querySelectorAll(".tab-btn")) {
		if (!canOpenTab(btn.dataset.tab)) btn.classList.add("hidden");
	}

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
	// A denial has to say why: the button stays off until there is a reason to send.
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
				`<span class="tab-count float-right ml-2 min-w-[1.25rem] h-5 px-1.5 rounded-full bg-blue-500 text-white text-[11px] font-bold leading-5 text-center" title="${count} waiting">${count > 99 ? "99+" : count}</span>`
			);
		}
	}
}

function handleHashNav() {
	/** Old links still work: "#support" was the tickets tab, and game events now live in the audit log. */
	const hash = location.hash
		.replace("#", "")
		.replace(/^support/, "tickets")
		.replace(/^(games|duels)$/, "audit");
	if (!hash) {
		switchTab("submissions", true);
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
	// A link or an old bookmark to a tab this role cannot open lands on the first one it can.
	if (!canOpenTab(tab)) tab = HELPER_TABS[0];
	currentTab = tab;
	if (!fromHash) location.hash = tab;

	document.querySelectorAll(".tab-btn").forEach((btn) => {
		const isOpOnly = btn.classList.contains("operator-only");
		const isSeniorOnly = btn.classList.contains("senior-only");
		const active = btn.dataset.tab === tab;
		btn.className = `tab-btn text-left px-3 py-2 rounded-lg text-sm font-medium transition${isOpOnly ? " operator-only" : ""}${isSeniorOnly ? " senior-only" : ""} ${active ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}`;
		if (isOpOnly && currentUser?.role !== "operator") btn.classList.add("hidden");
		if (isSeniorOnly && !["operator", "supervisor"].includes(currentUser?.role)) btn.classList.add("hidden");
		if (!canOpenTab(btn.dataset.tab)) btn.classList.add("hidden");
	});

	const content = el("tab-content");
	content.innerHTML = skeletonRows(5, "h-24");
	refreshAttention();

	if (tab === "submissions") loadSubmissions();
	else if (tab === "suggestions") loadSuggestions();
	else if (tab === "locations") loadLocations();
	else if (tab === "users") loadUsers();
	else if (tab === "tickets") loadTickets(true, autoOpenId);
	else if (tab === "staff") loadStaff();
	else if (tab === "stats") loadStats();
	else if (tab === "audit") loadAudit();
	else if (tab === "system") loadSystem();
}
