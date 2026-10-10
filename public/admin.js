let currentUser = null;
let mapCanvas = null;
let uploadPinWorld = null;
let uploadFile = null;
let currentTab = "submissions";
let denyTargetId = null;

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

async function init() {
	try {
		const r = await fetch("/api/auth/me");
		if (r.ok) currentUser = await r.json();
	} catch {}

	renderAuthArea();

	if (!currentUser) {
		el("access-msg").textContent = "You must be logged in to access this page.";
		return;
	}
	if (!currentUser.role || !["moderator", "supervisor", "operator"].includes(currentUser.role)) {
		el("access-msg").textContent = "Access denied. You need moderator or operator permissions.";
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

	document.querySelectorAll(".tab-btn").forEach((btn) => {
		btn.addEventListener("click", () => switchTab(btn.dataset.tab));
	});

	el("upload-map-back").addEventListener("click", () => {
		el("upload-map-panel").classList.add("hidden");
		switchTab("locations");
	});

	el("upload-file").addEventListener("change", (e) => {
		const file = e.target.files[0];
		if (!file) return;
		uploadFile = file;
		el("upload-filename").textContent = file.name;
		el("upload-preview").src = URL.createObjectURL(file);
		el("upload-preview-wrap").classList.remove("hidden");
		checkUploadReady();
	});

	el("upload-submit-btn").addEventListener("click", uploadLocation);

	el("deny-cancel").addEventListener("click", () => el("deny-modal").classList.add("hidden"));
	el("deny-confirm").addEventListener("click", () => {
		if (denyTargetId !== null) denySubmission(denyTargetId, el("deny-reason").value.trim());
	});

	window.addEventListener("hashchange", handleHashNav);
	handleHashNav();
}

function handleHashNav() {
	const hash = location.hash.replace("#", "");
	if (!hash) {
		switchTab("submissions", true);
		return;
	}
	const [tab, id] = hash.split(":");
	if (tab) switchTab(tab, true, id ? parseInt(id) : null);
}

function renderAuthArea() {
	const area = el("auth-area");
	if (currentUser) {
		const roleTag = currentUser.role
			? `<span class="text-xs bg-zinc-700 px-2 py-0.5 rounded-full text-zinc-300">${currentUser.role}</span>`
			: "";
		area.innerHTML = `
            ${roleTag}
            ${currentUser.avatar_url ? `<img src="${escHtml(currentUser.avatar_url)}" class="w-7 h-7 rounded-full" />` : ""}
            <span class="text-sm text-zinc-300">${escHtml(currentUser.display_name || currentUser.username)}</span>
            <a href="/api/auth/logout" class="text-xs text-zinc-500 hover:text-zinc-300 transition">Logout</a>`;
	}
}

function switchTab(tab, fromHash = false, autoOpenId = null) {
	if (currentTab === tab && !fromHash) {
		location.hash = tab;
		return;
	}
	currentTab = tab;
	if (!fromHash) location.hash = tab;

	document.querySelectorAll(".tab-btn").forEach((btn) => {
		const isOpOnly = btn.classList.contains("operator-only");
		const isSeniorOnly = btn.classList.contains("senior-only");
		const active = btn.dataset.tab === tab;
		btn.className = `tab-btn text-left px-3 py-2 rounded-lg text-sm font-medium transition${isOpOnly ? " operator-only" : ""}${isSeniorOnly ? " senior-only" : ""} ${active ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}`;
		if (isOpOnly && currentUser?.role !== "operator") btn.classList.add("hidden");
		if (isSeniorOnly && !["operator", "supervisor"].includes(currentUser?.role)) btn.classList.add("hidden");
	});

	if (tab === "upload") {
		el("upload-map-panel").classList.remove("hidden");
		if (!mapCanvas) initUploadMap();
		return;
	}

	el("upload-map-panel").classList.add("hidden");

	const content = el("tab-content");
	content.innerHTML = '<div class="text-zinc-500">Loading...</div>';

	if (tab === "submissions") loadSubmissions();
	else if (tab === "suggestions") loadSuggestions();
	else if (tab === "locations") loadLocations();
	else if (tab === "users") loadUsers();
	else if (tab === "support") loadSupport(true, autoOpenId);
	else if (tab === "staff") loadStaff();
	else if (tab === "stats") loadStats();
	else if (tab === "audit") loadAudit();
}

let expandedSubId = null;
let subMapCanvas = null;

async function loadSubmissions() {
	try {
		const r = await fetch("/api/admin/submissions");
		if (!r.ok) throw new Error();
		renderSubmissions(await r.json());
	} catch {
		el("tab-content").innerHTML = '<div class="text-red-400">Failed to load submissions.</div>';
	}
}

function renderSubmissions(items) {
	_lastSubmissions = items;
	if (!items.length) {
		el("tab-content").innerHTML = '<div class="text-zinc-500">No pending submissions.</div>';
		return;
	}
	el("tab-content").innerHTML = `
        <h2 class="font-bold text-lg mb-4">Pending Submissions (${items.length})</h2>
        ${panelSearchInput("Search submission ID, label, username or coordinates…")}
        <div class="flex flex-col gap-3" id="submissions-list">
            ${items.map(renderSubmissionRow).join("")}
            <div id="panel-search-empty" class="hidden text-zinc-500 text-center py-8">No submissions match your search.</div>
        </div>`;
	bindPanelSearch("#submissions-list [data-search]");
}

function renderSubmissionRow(s) {
	const isExpanded = expandedSubId === s.id;
	const expandedHtml = isExpanded
		? `
        <div class="border-t border-zinc-800 px-4 pt-4 pb-2">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 items-stretch" style="min-height:320px">
                <img src="/uploads/${escHtml(s.image_path)}" alt="Submission" class="w-full rounded-xl object-cover" style="max-height:400px" />
                <div class="flex flex-col gap-2">
                    <div class="text-xs text-zinc-500 space-y-1">
                        <div>Coordinates: <span class="text-zinc-300 font-mono">${s.world_x?.toFixed(1)}, ${s.world_y?.toFixed(1)}</span></div>
                        <div>Submitted: <span class="text-zinc-300">${new Date(s.created_at * 1000).toLocaleString()}</span></div>
                        <div>By: <a href="/u/${encodeURIComponent(s.username || "")}" class="text-blue-400 hover:underline">@${escHtml(s.username || "Unknown")}</a></div>
                    </div>
                    <div class="text-xs text-zinc-500">Map location</div>
                    <div class="flex-1" style="min-height:200px">
                        <canvas id="sub-map-canvas" class="w-full h-full rounded-xl"></canvas>
                    </div>
                </div>
            </div>
        </div>`
		: "";
	const searchText = [
		s.id,
		`SUB-${String(s.id).padStart(4, "0")}`,
		s.label,
		s.username,
		s.display_name,
		s.submitted_by,
		s.world_x,
		s.world_y,
		s.image_path,
	].join(" ");
	return `<div class="bg-zinc-900 rounded-2xl overflow-hidden" id="sub-${s.id}" data-search="${escHtml(searchText)}">
        <button onclick="toggleSubmission(${s.id}, ${s.world_x}, ${s.world_y})" class="w-full flex items-center gap-3 p-4 text-left hover:bg-zinc-800/50 transition">
            <img src="/uploads/${escHtml(s.image_path)}" alt="" class="w-14 h-10 rounded-lg object-cover flex-shrink-0" />
            <div class="flex-1 min-w-0">
                <div class="text-sm font-semibold truncate">${s.label ? escHtml(s.label) : '<span class="text-zinc-500 font-normal">No label</span>'}</div>
                <div class="text-xs text-zinc-500 mt-0.5">@${escHtml(s.username || "Unknown")} · ${new Date(s.created_at * 1000).toLocaleDateString()}</div>
            </div>
            <div class="flex items-center gap-2 flex-shrink-0">
                <span class="text-xs font-mono text-zinc-600">SUB-${String(s.id).padStart(4, "0")}</span>
                <span class="material-symbols-outlined text-zinc-500 text-base transition-transform ${isExpanded ? "rotate-180" : ""}">expand_more</span>
            </div>
        </button>
        ${expandedHtml}
        ${
			isExpanded
				? `<div class="px-4 pb-4 space-y-2">
            <div>
                <label class="text-xs text-zinc-500 block mb-1">Label <span class="text-red-400/80">(required, 5-128 chars)</span></label>
                <input id="sub-label-${s.id}" type="text" value="${escHtml(s.label || "")}" placeholder="e.g. Near Dovedale Central" maxlength="128"
                    class="w-full bg-zinc-800 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder:text-zinc-600" />
            </div>
            <div class="flex gap-2">
                <button onclick="approveSubmission(${s.id})" class="flex-1 bg-green-700 hover:bg-green-600 transition px-3 py-1.5 rounded-lg text-sm font-semibold">Approve</button>
                <button onclick="openDenyModal(${s.id})" class="flex-1 bg-red-800 hover:bg-red-700 transition px-3 py-1.5 rounded-lg text-sm font-semibold">Deny</button>
            </div>
        </div>`
				: ""
		}
    </div>`;
}

function toggleSubmission(id, worldX, worldY) {
	expandedSubId = expandedSubId === id ? null : id;
	const items = Array.from(document.querySelectorAll('[id^="sub-"]'))
		.map((n) => n.id.replace("sub-", ""))
		.map(Number);
	const allSubs = _lastSubmissions || [];
	const list = document.getElementById("submissions-list");
	if (list) list.innerHTML = allSubs.map(renderSubmissionRow).join("");
	if (expandedSubId !== null && worldX !== undefined) {
		requestAnimationFrame(() => {
			const canvas = document.getElementById("sub-map-canvas");
			if (canvas) {
				if (subMapCanvas) {
					try {
						subMapCanvas.destroy?.();
					} catch {}
				}
				subMapCanvas = new MapCanvas(canvas, {});
				subMapCanvas.setPin(worldX, worldY);
				subMapCanvas._centerOnPin?.() ?? subMapCanvas.centerOn?.(worldX, worldY);
			}
		});
	}
}

let _lastSubmissions = [];

async function approveSubmission(id) {
	const label = (document.getElementById(`sub-label-${id}`)?.value ?? "").trim();
	if (label.length < LABEL_MIN_LENGTH || label.length > LABEL_MAX_LENGTH) {
		showToast(`Label must be ${LABEL_MIN_LENGTH}-${LABEL_MAX_LENGTH} characters.`, "error");
		document.getElementById(`sub-label-${id}`)?.focus();
		return;
	}
	try {
		const r = await fetch(`/api/admin/submissions/${id}/approve`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ label }),
		});
		if (!r.ok) throw new Error(await r.text());
		_lastSubmissions = _lastSubmissions.filter((s) => s.id !== id);
		if (expandedSubId === id) expandedSubId = null;
		if (!_lastSubmissions.length) {
			el("tab-content").innerHTML = '<div class="text-zinc-500">No pending submissions.</div>';
			return;
		}
		const list = document.getElementById("submissions-list");
		if (list) list.innerHTML = _lastSubmissions.map(renderSubmissionRow).join("");
		else loadSubmissions();
	} catch (err) {
		showToast(err.message || "Failed to approve.", "error");
	}
}

function openDenyModal(id) {
	denyTargetId = id;
	el("deny-reason").value = "";
	el("deny-modal").classList.remove("hidden");
}

async function denySubmission(id, reason) {
	el("deny-modal").classList.add("hidden");
	try {
		const r = await fetch(`/api/admin/submissions/${id}/deny`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reason }),
		});
		if (!r.ok) throw new Error(await r.text());
		_lastSubmissions = _lastSubmissions.filter((s) => s.id !== id);
		if (expandedSubId === id) expandedSubId = null;
		if (!_lastSubmissions.length) {
			el("tab-content").innerHTML = '<div class="text-zinc-500">No pending submissions.</div>';
			return;
		}
		const list = document.getElementById("submissions-list");
		if (list) list.innerHTML = _lastSubmissions.map(renderSubmissionRow).join("");
		else loadSubmissions();
	} catch (err) {
		showToast(err.message || "Failed to deny.", "error");
	}
}

const TICKET_CATEGORY_LABELS = {
	ban_appeal: "Ban Appeal",
	submission_appeal: "Submission Appeal",
	bug_report: "Bug Report",
	report_user: "Report User",
	account: "Account",
	other: "Other",
};
const TICKET_CATEGORY_COLORS = {
	ban_appeal: "bg-red-900/60 text-red-300",
	submission_appeal: "bg-orange-900/60 text-orange-300",
	bug_report: "bg-yellow-900/60 text-yellow-300",
	report_user: "bg-purple-900/60 text-purple-300",
	account: "bg-sky-900/60 text-sky-300",
	other: "bg-zinc-700 text-zinc-300",
};

let supportStatus = "open";
let supportCategory = "";
let supportSearch = "";
let expandedTicketId = null;

async function loadSupport(reset = true, autoOpenId = null) {
	if (reset) {
		expandedTicketId = autoOpenId;
	}
	const params = new URLSearchParams({ status: supportStatus });
	if (supportCategory) params.set("category", supportCategory);
	try {
		const [ticketsRes, countsRes] = await Promise.all([
			fetch(`/api/admin/support?${params}`),
			fetch("/api/admin/support/counts"),
		]);
		if (!ticketsRes.ok) throw new Error();
		const tickets = await ticketsRes.json();
		const counts = countsRes.ok ? await countsRes.json() : [];
		renderSupport(tickets, counts);
		if (autoOpenId) {
			setTimeout(() => {
				const node = document.getElementById(`ticket-${autoOpenId}`);
				node?.scrollIntoView({ behavior: "smooth", block: "start" });
			}, 100);
		}
	} catch {
		el("tab-content").innerHTML = '<div class="text-red-400">Failed to load support tickets.</div>';
	}
}

function supportCountFor(counts, status, category = "") {
	return counts
		.filter((c) => c.status === status && (!category || c.category === category))
		.reduce((s, c) => s + c.count, 0);
}

function renderSupport(tickets, counts) {
	const openTotal = supportCountFor(counts, "open");
	const closedTotal = supportCountFor(counts, "closed");

	const statusTabs = ["open", "closed"]
		.map(
			(s) => `
        <button onclick="setSupportStatus('${s}')"
            class="px-3 py-1.5 rounded-lg text-sm font-medium transition ${supportStatus === s ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}">
            ${s === "open" ? "Open" : "Closed"}
            <span class="ml-1 text-xs ${s === "open" ? "text-blue-400" : "text-zinc-500"}">${s === "open" ? openTotal : closedTotal}</span>
        </button>`
		)
		.join("");

	const categories = Object.entries(TICKET_CATEGORY_LABELS);
	const categoryFilters = [
		`<button onclick="setSupportCategory('')" class="px-2.5 py-1 rounded-lg text-xs transition ${!supportCategory ? "bg-zinc-600 text-white" : "text-zinc-400 hover:text-white"}">All</button>`,
		...categories.map(([key, label]) => {
			const cnt = supportCountFor(counts, supportStatus, key);
			return `<button onclick="setSupportCategory('${key}')"
                class="px-2.5 py-1 rounded-lg text-xs transition ${supportCategory === key ? "bg-zinc-600 text-white" : "text-zinc-400 hover:text-white"}">
                ${label}${cnt ? ` <span class="opacity-60">${cnt}</span>` : ""}
            </button>`;
		}),
	].join("");

	const filtered = supportSearch
		? tickets.filter((t) => {
				const q = supportSearch.toLocaleLowerCase();
				return [
					t.id,
					`#${t.id}`,
					t.user_id,
					`User #${t.user_id}`,
					t.username,
					t.subject,
					t.category,
					t.message,
					JSON.stringify(t.replies || []),
				].some((value) =>
					String(value ?? "")
						.toLocaleLowerCase()
						.includes(q)
				);
			})
		: tickets;

	const ticketHtml = filtered.length
		? filtered.map((t) => renderTicketCard(t)).join("")
		: `<div class="text-zinc-500 py-8 text-center">No ${supportStatus} tickets${supportCategory ? " in this category" : ""}${supportSearch ? ' matching "' + escHtml(supportSearch) + '"' : ""}.</div>`;

	el("tab-content").innerHTML = `
        <div class="flex items-center justify-between mb-4 flex-wrap gap-3">
            <div class="flex gap-1">${statusTabs}</div>
            <div class="flex items-center gap-2 ml-auto">
                <input id="support-search" type="search" placeholder="Search ticket/user ID, username or details…" value="${escHtml(supportSearch)}"
                    class="bg-zinc-800 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder:text-zinc-600 w-52" />
                ${
					currentUser?.role === "operator"
						? `<button onclick="cleanupTickets()" class="text-xs bg-zinc-800 hover:bg-zinc-700 transition px-2.5 py-1.5 rounded-lg text-zinc-400 flex items-center gap-1">
                    <span class="material-symbols-outlined text-sm">cleaning_services</span> Cleanup
                </button>`
						: ""
				}
                <button onclick="loadSupport()" class="text-zinc-500 hover:text-zinc-300 transition">
                    <span class="material-symbols-outlined text-sm">refresh</span>
                </button>
            </div>
        </div>
        <div class="flex gap-1.5 flex-wrap mb-5">${categoryFilters}</div>
        <div class="flex flex-col gap-4">${ticketHtml}</div>`;

	const searchEl = document.getElementById("support-search");
	if (searchEl) {
		searchEl.addEventListener("input", (e) => {
			supportSearch = e.target.value;
			renderSupport(tickets, counts);
		});
	}
}

function renderTicketMessage(message) {
	if (!message) return "";
	const sep = "\n\n---\n\n";
	const sepIdx = message.indexOf(sep);
	if (sepIdx === -1) return `<div class="whitespace-pre-wrap text-zinc-300 text-sm">${escHtml(message)}</div>`;
	const structured = message.slice(0, sepIdx);
	const main = message.slice(sepIdx + sep.length);
	const pairs = structured
		.split("\n\n")
		.filter(Boolean)
		.map((pair) => {
			const nl = pair.indexOf("\n");
			if (nl === -1) return `<div class="text-zinc-400 text-xs">${escHtml(pair)}</div>`;
			return `<div class="mb-2 last:mb-0">
            <div class="text-zinc-500 text-xs font-medium">${escHtml(pair.slice(0, nl))}</div>
            <div class="text-zinc-200 text-sm mt-0.5">${escHtml(pair.slice(nl + 1))}</div>
        </div>`;
		})
		.join("");
	return `<div class="bg-zinc-800/60 border border-zinc-700/50 rounded-lg p-3 mb-2">
        <div class="text-zinc-500 text-xs font-semibold uppercase tracking-wide mb-2">Form fields</div>
        ${pairs}
    </div>
    <div class="whitespace-pre-wrap text-zinc-300 text-sm">${escHtml(main)}</div>`;
}

function renderTicketCard(t) {
	const catLabel = TICKET_CATEGORY_LABELS[t.category] || "Other";
	const catColor = TICKET_CATEGORY_COLORS[t.category] || TICKET_CATEGORY_COLORS.other;
	const isOpen = t.status === "open";
	const isExpanded = expandedTicketId === t.id;

	const statusBadges = [
		t.is_banned ? `<span class="text-xs bg-red-900/60 text-red-400 px-2 py-0.5 rounded-full">Banned</span>` : "",
		t.close_requested
			? `<span class="text-xs bg-orange-900/60 text-orange-300 px-2 py-0.5 rounded-full">Close requested</span>`
			: "",
		t.awaiting_staff && !t.close_requested
			? `<span class="text-xs bg-blue-900/60 text-blue-300 px-2 py-0.5 rounded-full">User replied</span>`
			: "",
	]
		.filter(Boolean)
		.join("");

	const compactRow = `
    <div class="bg-zinc-900 rounded-2xl overflow-hidden" id="ticket-${t.id}">
        <button onclick="toggleTicket(${t.id})" class="w-full flex items-center gap-3 p-4 text-left hover:bg-zinc-800/50 transition">
            ${t.avatar_url ? `<img src="${escHtml(t.avatar_url)}" class="w-8 h-8 rounded-full flex-shrink-0" />` : '<div class="w-8 h-8 rounded-full bg-zinc-700 flex-shrink-0"></div>'}
            <div class="flex-1 min-w-0">
                <div class="font-semibold text-sm leading-tight truncate">${escHtml(t.subject)}</div>
                <div class="text-xs text-zinc-500 mt-0.5 flex items-center gap-2 flex-wrap">
                    <span>@${escHtml(t.username)}</span>
                    <span>·</span>
                    <span>User #${t.user_id}</span>
                    <span>·</span>
                    <span>${new Date(t.created_at * 1000).toLocaleString()}</span>
                    ${statusBadges}
                </div>
            </div>
            <div class="flex items-center gap-2 flex-shrink-0">
                <span class="text-xs px-2 py-0.5 rounded-full ${catColor}">${catLabel}</span>
                <span class="text-xs bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded-full">#${t.id}</span>
                <span class="material-symbols-outlined text-zinc-500 text-base transition-transform ${isExpanded ? "rotate-180" : ""}">expand_more</span>
            </div>
        </button>
        ${isExpanded ? renderTicketBody(t, isOpen) : ""}
    </div>`;
	return compactRow;
}

function renderTicketBody(t, isOpen) {
	const isOp = currentUser?.role === "operator";
	const replies = Array.isArray(t.replies) ? t.replies : [];
	const repliesHtml = replies
		.map((r) => {
			const isStaff = r.type === "staff";
			const ts = new Date(r.created_at * 1000).toLocaleString();
			return `<div class="${isStaff ? "bg-zinc-700/40 border border-zinc-700" : "bg-zinc-800"} rounded-xl px-3 py-2.5">
            <div class="text-xs text-zinc-500 mb-1 flex items-center gap-2">
                <span class="font-medium">${isStaff ? `Staff · @${escHtml(r.author_username || "?")}` : `User reply · @${escHtml(r.author_username || "?")}`}</span>
                <span class="text-zinc-600">${ts}</span>
                ${isStaff ? "" : t.close_requested && r === replies[replies.length - 1] ? '<span class="bg-orange-900/60 text-orange-300 px-2 py-0.5 rounded-full">Close requested</span>' : ""}
            </div>
            <div class="text-sm text-zinc-300 whitespace-pre-wrap">${escHtml(r.body)}</div>
        </div>`;
		})
		.join("");

	const closeRequestBanner = t.close_requested
		? `
        <div class="bg-orange-900/30 border border-orange-700/50 rounded-xl px-3 py-2.5 text-sm text-orange-200">
            <span class="font-semibold">User has requested this ticket be closed.</span> Reply to deny the request, or use Close to confirm.
        </div>`
		: "";

	return `
    <div class="px-4 pb-4 border-t border-zinc-800 pt-4 space-y-3">
        <div class="text-xs text-zinc-500 mb-1 font-medium">Initial message · <span class="text-zinc-600">${new Date(t.created_at * 1000).toLocaleString()}</span></div>
        <div class="bg-zinc-800 rounded-xl px-3 py-2.5 max-h-48 overflow-y-auto custom-scroll">${renderTicketMessage(t.message)}</div>
        ${replies.length ? `<div class="max-h-80 overflow-y-auto flex flex-col gap-2 pr-1 custom-scroll">${repliesHtml}</div>` : ""}
        ${closeRequestBanner}
        ${
			isOpen
				? `
        <textarea id="reply-${t.id}" rows="3" placeholder="Reply message (optional)… Ctrl+Enter to Reply &amp; Close"
            onkeydown="if(event.ctrlKey&&event.key==='Enter'){event.preventDefault();replyTicket(${t.id},true);}"
            class="w-full bg-zinc-800 rounded-xl px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder:text-zinc-600"></textarea>
        <div class="flex gap-2 flex-wrap">
            <button onclick="replyTicket(${t.id}, false)" class="flex-1 bg-blue-700 hover:bg-blue-600 transition px-3 py-1.5 rounded-lg text-sm font-semibold">Reply</button>
            <button onclick="replyTicket(${t.id}, true)" class="bg-green-800 hover:bg-green-700 transition px-3 py-1.5 rounded-lg text-sm">Reply &amp; Close</button>
            <button onclick="closeTicket(${t.id})" class="bg-zinc-700 hover:bg-zinc-600 transition px-3 py-1.5 rounded-lg text-sm">Close</button>
        </div>`
				: `
        <div class="flex gap-2 flex-wrap">
            <button onclick="reopenTicket(${t.id})" class="bg-zinc-700 hover:bg-zinc-600 transition px-3 py-1.5 rounded-lg text-sm">Reopen</button>
            ${isOp ? `<button onclick="deleteTicket(${t.id})" class="bg-red-900 hover:bg-red-800 transition px-3 py-1.5 rounded-lg text-sm">Delete</button>` : ""}
        </div>`
		}
    </div>`;
}

function toggleTicket(id) {
	expandedTicketId = expandedTicketId === id ? null : id;
	location.hash = expandedTicketId ? `support:${expandedTicketId}` : "support";
	loadSupport(false);
	if (expandedTicketId) {
		setTimeout(() => {
			document
				.getElementById(`ticket-${expandedTicketId}`)
				?.scrollIntoView({ behavior: "smooth", block: "start" });
		}, 100);
	}
}

function setSupportStatus(s) {
	supportStatus = s;
	supportCategory = "";
	supportSearch = "";
	loadSupport(true);
}
function setSupportCategory(c) {
	supportCategory = c;
	loadSupport(true);
}

async function replyTicket(id, close) {
	const reply = el(`reply-${id}`)?.value?.trim() || "";
	try {
		const r = await fetch(`/api/admin/support/${id}/reply`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reply, close }),
		});
		if (!r.ok) throw new Error(await r.text());
		if (close) expandedTicketId = null;
		loadSupport(false);
	} catch (err) {
		showToast(err.message || "Failed.", "error");
	}
}

async function closeTicket(id) {
	try {
		const r = await fetch(`/api/admin/support/${id}/close`, { method: "POST" });
		if (!r.ok) throw new Error(await r.text());
		expandedTicketId = null;
		loadSupport(false);
	} catch (err) {
		showToast(err.message || "Failed.", "error");
	}
}

async function reopenTicket(id) {
	try {
		const r = await fetch(`/api/admin/support/${id}/reopen`, { method: "POST" });
		if (!r.ok) throw new Error(await r.text());
		loadSupport(true);
	} catch (err) {
		showToast(err.message || "Failed.", "error");
	}
}

async function deleteTicket(id) {
	const ok = await showConfirm("Delete ticket", "Permanently delete this closed ticket? This cannot be undone.", {
		confirmLabel: "Delete",
	});
	if (!ok) return;
	try {
		const r = await fetch(`/api/admin/support/${id}`, { method: "DELETE" });
		if (!r.ok) throw new Error(await r.text());
		showToast("Ticket deleted.", "success");
		loadSupport(true);
	} catch (err) {
		showToast(err.message || "Failed.", "error");
	}
}

async function cleanupTickets() {
	const ok = await showConfirm("Cleanup old tickets", "Delete all closed tickets that are 6 or more months old?", {
		confirmLabel: "Cleanup",
		confirmClass: "bg-orange-700 hover:bg-orange-600",
	});
	if (!ok) return;
	try {
		const r = await fetch("/api/admin/support/cleanup", { method: "POST" });
		if (!r.ok) throw new Error(await r.text());
		const { deleted } = await r.json();
		showToast(`Removed ${deleted} old ticket${deleted !== 1 ? "s" : ""}.`, "success");
		loadSupport(true);
	} catch (err) {
		showToast(err.message || "Failed.", "error");
	}
}

async function loadSuggestions() {
	try {
		const r = await fetch("/api/admin/suggestions");
		if (!r.ok) throw new Error();
		renderSuggestions(await r.json());
	} catch {
		el("tab-content").innerHTML = '<div class="text-red-400">Failed to load suggestions.</div>';
	}
}

function renderSuggestions(items) {
	if (!items.length) {
		el("tab-content").innerHTML = '<div class="text-zinc-500">No pending suggestions.</div>';
		return;
	}
	const typeLabel = { hint: "Hint", screenshot: "Screenshot", coordinates: "Coordinates" };
	el("tab-content").innerHTML = `
        <h2 class="font-bold text-lg mb-4">Pending Suggestions (${items.length})</h2>
        ${panelSearchInput("Search suggestion ID, location, user, type or details…")}
        <div class="flex flex-col gap-4" id="suggestions-list">
            ${items
				.map((s) => {
					let content = {};
					try {
						content = JSON.parse(s.content || "{}");
					} catch {}
					const typeTag = `<span class="text-xs bg-zinc-700 px-2 py-0.5 rounded-full">${typeLabel[s.type] || s.type}</span>`;
					const forLabel = `<span class="text-xs text-zinc-500">For: <span class="text-zinc-300">${escHtml(s.location_label || `#${s.location_id}`)}</span></span>`;
					let body = "";
					if (s.type === "hint") {
						body = `<div class="bg-yellow-900/30 border border-yellow-700/30 text-yellow-200 text-sm px-3 py-2 rounded-lg mt-2">"${escHtml(content.text || "")}"</div>`;
					} else if (s.type === "screenshot") {
						body = `<div class="flex gap-2 mt-2">
                        <div class="flex-1"><div class="text-xs text-zinc-500 mb-1">Current</div><img src="/uploads/${escHtml(s.location_image)}" class="submission-img rounded-lg" /></div>
                        <div class="flex-1"><div class="text-xs text-zinc-500 mb-1">Suggested</div><img src="/uploads/${escHtml(s.image_path)}" class="submission-img rounded-lg" /></div>
                    </div>${content.note ? `<div class="text-xs text-zinc-400 mt-1">"${escHtml(content.note)}"</div>` : ""}`;
					} else if (s.type === "coordinates") {
						body = `<div class="text-xs text-zinc-400 mt-2 bg-zinc-800 rounded-lg px-3 py-2">
                        New coords: (${Math.round(content.world_x ?? 0)}, ${Math.round(content.world_y ?? 0)})
                        ${content.note ? `<br>"${escHtml(content.note)}"` : ""}
                    </div>`;
					}
					const searchText = [
						s.id,
						`SUG-${String(s.id).padStart(4, "0")}`,
						s.location_id,
						`LOC-${String(s.location_id).padStart(4, "0")}`,
						s.location_label,
						s.user_id,
						s.display_name,
						s.username,
						s.type,
						JSON.stringify(content),
						s.image_path,
					].join(" ");
					return `
                <div class="bg-zinc-900 rounded-2xl p-4" id="sug-${s.id}" data-search="${escHtml(searchText)}">
                    <div class="flex items-center gap-2 mb-1">
                        ${typeTag} ${forLabel}
                        <span class="ml-auto text-xs text-zinc-600">${new Date(s.created_at * 1000).toLocaleDateString()}</span>
                    </div>
                    <div class="text-sm text-zinc-400 mb-1">By: <span class="text-zinc-200">${escHtml(s.display_name || s.username)}</span> <span class="text-zinc-600">· SUG-${String(s.id).padStart(4, "0")} · LOC-${String(s.location_id).padStart(4, "0")}</span></div>
                    ${body}
                    <div class="flex gap-2 mt-3">
                        <button onclick="approveSuggestion(${s.id})" class="flex-1 bg-green-700 hover:bg-green-600 transition px-3 py-1.5 rounded-lg text-sm font-semibold">Approve</button>
                        <button onclick="denySuggestion(${s.id})" class="flex-1 bg-red-800 hover:bg-red-700 transition px-3 py-1.5 rounded-lg text-sm font-semibold">Deny</button>
                    </div>
                </div>`;
				})
				.join("")}
            <div id="panel-search-empty" class="hidden text-zinc-500 text-center py-8">No suggestions match your search.</div>
        </div>`;
	bindPanelSearch("#suggestions-list [data-search]");
}

async function approveSuggestion(id) {
	try {
		const r = await fetch(`/api/admin/suggestions/${id}/approve`, { method: "POST" });
		if (!r.ok) throw new Error(await r.text());
		el(`sug-${id}`)?.remove();
		if (!el("tab-content").querySelector('[id^="sug-"]')) loadSuggestions();
	} catch (err) {
		showToast(err.message || "Failed to approve.", "error");
	}
}

async function denySuggestion(id) {
	const reason = await showPrompt("Deny suggestion", "Reason (optional)");
	if (reason === null) return;
	try {
		const r = await fetch(`/api/admin/suggestions/${id}/deny`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reason }),
		});
		if (!r.ok) throw new Error(await r.text());
		el(`sug-${id}`)?.remove();
		if (!el("tab-content").querySelector('[id^="sug-"]')) loadSuggestions();
	} catch (err) {
		showToast(err.message || "Failed to deny.", "error");
	}
}

async function loadLocations() {
	try {
		const r = await fetch("/api/admin/locations");
		if (!r.ok) throw new Error();
		renderLocations(await r.json());
	} catch {
		el("tab-content").innerHTML = '<div class="text-red-400">Failed to load locations.</div>';
	}
}

function renderLocations(items) {
	const uploadBtn =
		currentUser?.role === "operator"
			? `<button onclick="switchTab('upload')" class="bg-blue-600 hover:bg-blue-500 transition px-4 py-2 rounded-xl text-sm font-semibold">+ Add Location</button>`
			: "";
	el("tab-content").innerHTML = `
        <div class="flex items-center justify-between mb-4">
            <h2 class="font-bold text-lg">Locations (${items.length})</h2>
            ${uploadBtn}
        </div>
        ${panelSearchInput("Search location ID, label, filename, hints or status…")}
        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4" id="locations-list">
            ${items
				.map((loc) => {
					let parsedHints = [];
					try {
						parsedHints = JSON.parse(loc.hints || "[]");
					} catch {}
					const hintsHtml = parsedHints
						.map(
							(h, i) => `
                    <div class="flex items-center gap-1 mb-1">
                        <input type="text" value="${escHtml(h)}" class="hint-input flex-1 bg-zinc-800 rounded px-2 py-1 text-xs focus:outline-none" data-idx="${i}" data-loc="${loc.id}" />
                        <button onclick="removeHint(${loc.id},${i})" class="text-zinc-500 hover:text-red-400 transition text-xs px-1">✕</button>
                    </div>`
						)
						.join("");
					const searchText = [
						loc.id,
						`LOC-${String(loc.id).padStart(4, "0")}`,
						loc.label,
						loc.image_path,
						parsedHints.join(" "),
						loc.world_x,
						loc.world_y,
						loc.is_active ? "active" : "inactive",
					].join(" ");
					return `
                <div class="bg-zinc-900 rounded-2xl overflow-hidden" id="loc-${loc.id}" data-search="${escHtml(searchText)}">
                    <img src="/uploads/${escHtml(loc.image_path)}" alt="Location" class="submission-img" />
                    <div class="p-3">
                        <div class="flex items-start justify-between gap-2 mb-0.5">
                            <div class="flex-1 flex items-center gap-1 min-w-0">
                                <input type="text" value="${escHtml(loc.label || "")}" placeholder="No label" class="label-input flex-1 bg-transparent text-sm font-semibold focus:bg-zinc-800 focus:outline-none rounded px-1 -mx-1 min-w-0 truncate" data-loc="${loc.id}" onkeydown="if(event.key==='Enter')saveLabel(${loc.id})" />
                                <button onclick="saveLabel(${loc.id})" class="text-xs text-zinc-500 hover:text-zinc-300 transition px-1 flex-shrink-0">Save</button>
                            </div>
                            <span class="text-xs font-mono text-zinc-600 flex-shrink-0">LOC-${String(loc.id).padStart(4, "0")}</span>
                        </div>
                        <div class="text-xs text-zinc-600 mb-2">${new Date(loc.created_at * 1000).toLocaleDateString()} · ${loc.is_active ? '<span class="text-green-400">Active</span>' : '<span class="text-zinc-500">Inactive</span>'}</div>
                        <div class="mb-2">
                            <div class="text-xs text-zinc-500 mb-1">Hints</div>
                            <div id="hints-${loc.id}">${hintsHtml}</div>
                            <button onclick="addHintRow(${loc.id})" class="text-xs text-zinc-500 hover:text-zinc-300 transition mt-1">+ Add hint</button>
                            <button onclick="saveHints(${loc.id})" class="text-xs bg-zinc-700 hover:bg-zinc-600 transition px-2 py-1 rounded ml-2">Save hints</button>
                        </div>
                        <div class="flex gap-2">
                            <button onclick="toggleLocation(${loc.id}, ${loc.is_active})" class="flex-1 bg-zinc-700 hover:bg-zinc-600 transition px-3 py-1.5 rounded-lg text-xs">
                                ${loc.is_active ? "Deactivate" : "Activate"}
                            </button>
                            ${currentUser?.role === "operator" ? `<button onclick="deleteLocation(${loc.id})" class="bg-red-900 hover:bg-red-800 transition px-3 py-1.5 rounded-lg text-xs">Delete</button>` : ""}
                        </div>
                    </div>
                </div>`;
				})
				.join("")}
            <div id="panel-search-empty" class="hidden col-span-full text-zinc-500 text-center py-8">No locations match your search.</div>
        </div>`;
	bindPanelSearch("#locations-list [data-search]");
}

async function saveLabel(locId) {
	const input = document.querySelector(`.label-input[data-loc="${locId}"]`);
	if (!input) return;
	const label = input.value.trim();
	try {
		const r = await fetch(`/api/admin/locations/${locId}/label`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ label }),
		});
		if (!r.ok) throw new Error(await r.text());
		showToast("Label saved.", "success");
	} catch (err) {
		showToast(err.message || "Failed to save label.", "error");
	}
}

function addHintRow(locId) {
	const container = el(`hints-${locId}`);
	const idx = container.querySelectorAll(".hint-input").length;
	const div = document.createElement("div");
	div.className = "flex items-center gap-1 mb-1";
	div.innerHTML = `
        <input type="text" placeholder="Hint text…" class="hint-input flex-1 bg-zinc-800 rounded px-2 py-1 text-xs focus:outline-none" data-idx="${idx}" data-loc="${locId}" />
        <button onclick="this.parentElement.remove()" class="text-zinc-500 hover:text-red-400 transition text-xs px-1">✕</button>`;
	container.appendChild(div);
}

function removeHint(locId, idx) {
	const inputs = el(`hints-${locId}`).querySelectorAll(".hint-input");
	inputs[idx]?.closest("div")?.remove();
}

async function saveHints(locId) {
	const inputs = el(`hints-${locId}`).querySelectorAll(".hint-input");
	const hints = Array.from(inputs)
		.map((i) => i.value.trim())
		.filter(Boolean);
	try {
		const r = await fetch(`/api/admin/locations/${locId}/hints`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ hints }),
		});
		if (!r.ok) throw new Error(await r.text());
		showToast("Hints saved.", "success");
	} catch (err) {
		showToast(err.message || "Failed to save hints.", "error");
	}
}

async function loadStats() {
	try {
		const r = await fetch("/api/admin/stats");
		if (!r.ok) throw new Error();
		renderStats(await r.json());
	} catch {
		el("tab-content").innerHTML = '<div class="text-red-400">Failed to load stats.</div>';
	}
}

function renderStats(s) {
	const statCard = (label, value, sub) => `
        <div class="bg-zinc-900 rounded-2xl px-5 py-4 text-center">
            <div class="text-2xl font-bold font-mono">${value}</div>
            <div class="text-zinc-400 text-sm mt-1">${label}</div>
            ${sub ? `<div class="text-zinc-600 text-xs mt-0.5">${sub}</div>` : ""}
        </div>`;
	el("tab-content").innerHTML = `
        <h2 class="font-bold text-lg mb-4">Site Stats</h2>
        <div class="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
            ${statCard("Total Users", (s.users?.total ?? 0).toLocaleString())}
            ${statCard("Active Locations", (s.locations?.active ?? 0).toLocaleString(), `${s.locations?.total ?? 0} total`)}
            ${statCard("Solo Games", (s.scores?.total_games ?? 0).toLocaleString())}
            ${statCard("Duel Rooms", (s.duels?.total_rooms ?? 0).toLocaleString())}
            ${statCard("Daily Plays", (s.daily?.total_plays ?? 0).toLocaleString())}
            ${statCard("Pending Submissions", (s.submissions?.pending ?? 0).toLocaleString(), `${s.submissions?.total ?? 0} total`)}
        </div>
        <h3 class="font-semibold text-zinc-300 mb-3">Recent Activity</h3>
        <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
            ${statCard("New Users (7d)", (s.users?.last_7d ?? 0).toLocaleString())}
            ${statCard("Games (7d)", (s.scores?.last_7d ?? 0).toLocaleString())}
            ${statCard("Daily Plays (7d)", (s.daily?.last_7d ?? 0).toLocaleString())}
        </div>`;
}

async function toggleLocation(id, currentActive) {
	try {
		const r = await fetch(`/api/admin/locations/${id}/toggle`, { method: "POST" });
		if (!r.ok) throw new Error(await r.text());
		loadLocations();
	} catch (err) {
		showToast(err.message || "Failed to toggle.", "error");
	}
}

async function deleteLocation(id) {
	const ok = await showConfirm("Delete location", "This will permanently remove the location and cannot be undone.", {
		confirmLabel: "Delete",
	});
	if (!ok) return;
	try {
		const r = await fetch(`/api/admin/locations/${id}`, { method: "DELETE" });
		if (!r.ok) throw new Error(await r.text());
		el(`loc-${id}`)?.remove();
		showToast("Location deleted.", "success");
	} catch (err) {
		showToast(err.message || "Failed to delete.", "error");
	}
}

async function loadUsers() {
	try {
		const r = await fetch("/api/admin/users");
		if (!r.ok) throw new Error();
		renderUsers(await r.json());
	} catch {
		el("tab-content").innerHTML = '<div class="text-red-400">Failed to load users.</div>';
	}
}

const ROLE_RANK_JS = { operator: 3, supervisor: 2, moderator: 1 };
const ROLE_BADGE = {
	operator: "bg-yellow-900/70 text-yellow-300",
	supervisor: "bg-purple-900/70 text-purple-300",
	moderator: "bg-blue-900/70 text-blue-300",
};

function renderUsers(users) {
	const myRole = currentUser?.role;
	const myRank = ROLE_RANK_JS[myRole] ?? 0;
	const isSenior = myRole === "operator" || myRole === "supervisor";
	const isOp = myRole === "operator";

	el("tab-content").innerHTML = `
        <h2 class="font-bold text-lg mb-4">Users (${users.length})</h2>
        ${panelSearchInput("Search username, display name, user ID, Discord ID or status…")}
        <div class="flex flex-col gap-3" id="users-list">
            ${users
				.map((u) => {
					const isBanned =
						u.is_banned &&
						(u.ban_type === "perm" || (u.ban_expires_at && u.ban_expires_at > Date.now() / 1000));
					const isUploadLimited = u.upload_limited;
					const isDuelLimited = u.duel_limited;
					const targetRank = ROLE_RANK_JS[u.role] ?? 0;
					const canManageRole = isSenior && u.id !== currentUser.id && targetRank < myRank;
					const roleBadge = u.role
						? `<span class="text-xs px-1.5 py-0.5 rounded ${ROLE_BADGE[u.role] || "bg-zinc-700 text-zinc-300"}">${u.role}</span>`
						: "";
					const searchText = [
						u.id,
						`User #${u.id}`,
						u.discord_id,
						`Discord #${u.discord_id}`,
						u.username,
						u.display_name,
						u.role,
						isBanned ? "banned" : "",
						isUploadLimited ? "upload limited" : "",
						isDuelLimited ? "duel limited" : "",
						u.profile_private ? "private profile" : "",
					].join(" ");

					const assignable = isOp ? ["supervisor", "moderator"] : ["moderator"];
					const roleOptions = [
						...assignable
							.filter((r) => r !== u.role)
							.map(
								(r) =>
									`<button onclick="setUserRole(${u.id}, '${r}')" class="bg-purple-900/60 hover:bg-purple-800 transition px-2.5 py-1 rounded-lg text-xs">Set ${r}</button>`
							),
						u.role && u.role !== "operator"
							? `<button onclick="setUserRole(${u.id}, 'none')" class="bg-zinc-700 hover:bg-zinc-600 transition px-2.5 py-1 rounded-lg text-xs">Remove role</button>`
							: "",
					].join("");

					return `
                <div class="bg-zinc-900 rounded-2xl px-5 py-4 flex items-start gap-4" id="user-${u.id}" data-search="${escHtml(searchText)}">
                    ${u.avatar_url ? `<img src="${escHtml(u.avatar_url)}" class="w-10 h-10 rounded-full flex-shrink-0 mt-0.5" />` : `<div class="w-10 h-10 rounded-full bg-zinc-700 flex-shrink-0 mt-0.5"></div>`}
                    <div class="flex-1 min-w-0">
                        <div class="font-semibold truncate">${escHtml(u.display_name || u.username)}</div>
                        <div class="text-xs text-zinc-500"><a href="/u/${encodeURIComponent(u.username)}" target="_blank" class="hover:text-zinc-300 hover:underline transition">@${escHtml(u.username)}</a> · User #${u.id} · Discord #${u.discord_id}</div>
                        <div class="flex gap-1 mt-1 flex-wrap">
                            ${roleBadge}
                            ${isBanned ? `<span class="text-xs bg-red-900 text-red-300 px-1.5 py-0.5 rounded">${u.ban_type === "perm" ? "Banned" : "Temp banned"}</span>` : ""}
                            ${isUploadLimited ? '<span class="text-xs bg-orange-900 text-orange-300 px-1.5 py-0.5 rounded">Upload limited</span>' : ""}
                            ${isDuelLimited ? '<span class="text-xs bg-orange-900 text-orange-300 px-1.5 py-0.5 rounded">Duel limited</span>' : ""}
                            ${u.profile_private ? '<span class="text-xs bg-zinc-700 text-zinc-400 px-1.5 py-0.5 rounded">Private profile</span>' : ""}
                        </div>
                        ${canManageRole ? `<div class="flex gap-1.5 mt-2 flex-wrap">${roleOptions}</div>` : ""}
                    </div>
                    <div class="flex gap-2 flex-wrap justify-end">
                        <button onclick="warnUser(${u.id})" class="bg-yellow-900 hover:bg-yellow-800 transition px-3 py-1.5 rounded-lg text-xs">Warn</button>
                        ${
							!isBanned
								? `
                            <button onclick="limitUser(${u.id}, 'upload')" class="bg-zinc-700 hover:bg-zinc-600 transition px-3 py-1.5 rounded-lg text-xs">${isUploadLimited ? "Remove upload limit" : "Limit uploads"}</button>
                            <button onclick="limitUser(${u.id}, 'duel')" class="bg-zinc-700 hover:bg-zinc-600 transition px-3 py-1.5 rounded-lg text-xs">${isDuelLimited ? "Remove duel limit" : "Limit duels"}</button>
                            <button onclick="tempBanUser(${u.id})" class="bg-orange-800 hover:bg-orange-700 transition px-3 py-1.5 rounded-lg text-xs">Temp Ban</button>
                            ${isSenior ? `<button onclick="permBanUser(${u.id})" class="bg-red-800 hover:bg-red-700 transition px-3 py-1.5 rounded-lg text-xs">Perm Ban</button>` : ""}
                        `
								: `
                            ${u.ban_type === "temp" ? `<button onclick="unbanUser(${u.id})" class="bg-green-800 hover:bg-green-700 transition px-3 py-1.5 rounded-lg text-xs">Unban (temp)</button>` : ""}
                            ${isOp && u.ban_type === "perm" ? `<button onclick="unbanUser(${u.id})" class="bg-green-800 hover:bg-green-700 transition px-3 py-1.5 rounded-lg text-xs">Unban (perm)</button>` : ""}
                        `
						}
                        ${isOp ? `<button onclick="blockFromSite(${u.id})" class="bg-red-900 hover:bg-red-800 transition px-3 py-1.5 rounded-lg text-xs">Block Site</button>` : ""}
                        ${isOp ? `<button onclick="exportUserData(${u.id})" class="bg-zinc-700 hover:bg-zinc-600 transition px-3 py-1.5 rounded-lg text-xs">Export Data</button>` : ""}
                        ${isOp ? `<button onclick="deleteUserAccount(${u.id})" class="bg-red-900 hover:bg-red-800 transition px-3 py-1.5 rounded-lg text-xs">Delete Account</button>` : ""}
                    </div>
                </div>`;
				})
				.join("")}
            <div id="panel-search-empty" class="hidden text-zinc-500 text-center py-8">No users match your search.</div>
        </div>`;
	bindPanelSearch("#users-list [data-search]");
}

async function setUserRole(userId, role) {
	const label = role === "none" ? "remove their role" : `set their role to ${role}`;
	const ok = await showConfirm("Change role", `Are you sure you want to ${label}?`, {
		confirmLabel: "Confirm",
		confirmClass: "bg-blue-600 hover:bg-blue-500",
	});
	if (!ok) return;
	try {
		const r = await fetch(`/api/admin/users/${userId}/role`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ role }),
		});
		if (!r.ok) throw new Error(await r.text());
		loadUsers();
	} catch (err) {
		showToast(err.message || "Failed to update role.", "error");
	}
}

async function loadStaff() {
	try {
		const r = await fetch("/api/admin/users");
		if (!r.ok) throw new Error();
		const users = await r.json();
		renderStaff(users.filter((u) => u.role));
	} catch {
		el("tab-content").innerHTML = '<div class="text-red-400">Failed to load staff.</div>';
	}
}

function renderStaff(staff) {
	const myRole = currentUser?.role;
	const myRank = ROLE_RANK_JS[myRole] ?? 0;
	const isOp = myRole === "operator";

	const grouped = { operator: [], supervisor: [], moderator: [] };
	for (const u of staff) if (grouped[u.role]) grouped[u.role].push(u);

	const roleSection = (role, members) => {
		if (!members.length) return "";
		const badgeClass = ROLE_BADGE[role] || "bg-zinc-700 text-zinc-300";
		return `
        <div class="mb-6">
            <div class="flex items-center gap-2 mb-3">
                <span class="text-xs font-semibold px-2 py-0.5 rounded ${badgeClass}">${role}</span>
                <span class="text-zinc-500 text-xs">${members.length} member${members.length !== 1 ? "s" : ""}</span>
                ${role === "operator" ? '<span class="text-xs text-zinc-600">· env-managed</span>' : ""}
            </div>
            <div class="flex flex-col gap-2">
                ${members
					.map((u) => {
						const targetRank = ROLE_RANK_JS[u.role] ?? 0;
						const canChange = u.id !== currentUser.id && targetRank < myRank;
						const assignable = isOp ? ["supervisor", "moderator"] : ["moderator"];
						const roleButtons = canChange
							? [
									...assignable
										.filter((r) => r !== u.role)
										.map(
											(r) =>
												`<button onclick="setUserRole(${u.id}, '${r}')" class="bg-purple-900/60 hover:bg-purple-800 transition px-2.5 py-1 rounded-lg text-xs">Set ${r}</button>`
										),
									u.role !== "operator"
										? `<button onclick="setUserRole(${u.id}, 'none')" class="bg-zinc-700 hover:bg-zinc-600 transition px-2.5 py-1 rounded-lg text-xs">Remove role</button>`
										: "",
								].join("")
							: "";
						const searchText = [
							u.id,
							`User #${u.id}`,
							u.discord_id,
							`Discord #${u.discord_id}`,
							u.username,
							u.display_name,
							u.role,
						].join(" ");
						return `
                    <div class="bg-zinc-900 rounded-xl px-4 py-3 flex items-center gap-3" data-search="${escHtml(searchText)}">
                        ${u.avatar_url ? `<img src="${escHtml(u.avatar_url)}" class="w-8 h-8 rounded-full flex-shrink-0" />` : '<div class="w-8 h-8 rounded-full bg-zinc-700 flex-shrink-0"></div>'}
                        <div class="flex-1 min-w-0">
                            <div class="font-medium text-sm truncate">${escHtml(u.display_name || u.username)}</div>
                            <div class="text-xs text-zinc-500">@${escHtml(u.username)} · User #${u.id} · Discord #${u.discord_id}</div>
                        </div>
                        ${canChange ? `<div class="flex gap-1.5 flex-wrap">${roleButtons}</div>` : ""}
                    </div>`;
					})
					.join("")}
            </div>
        </div>`;
	};

	const addSection =
		myRole === "operator" || myRole === "supervisor"
			? `
    <div class="bg-zinc-900 rounded-xl p-4 mb-6">
        <div class="font-semibold text-sm mb-3">Add staff member</div>
        <div class="flex gap-2">
            <input id="staff-search" type="text" placeholder="Username or user ID…"
                class="flex-1 bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder:text-zinc-600" />
            <select id="staff-role-select" class="bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-zinc-300">
                ${isOp ? '<option value="supervisor">Supervisor</option>' : ""}
                <option value="moderator">Moderator</option>
            </select>
            <button onclick="addStaffMember()" class="bg-blue-600 hover:bg-blue-500 transition px-4 py-2 rounded-lg text-sm font-semibold">Add</button>
        </div>
        <p id="staff-add-error" class="text-red-400 text-xs mt-2 hidden"></p>
    </div>`
			: "";

	el("tab-content").innerHTML = `
        <h2 class="font-bold text-lg mb-4">Staff Management</h2>
        ${panelSearchInput("Search staff name, username, ID or role…")}
        ${addSection}
        ${roleSection("operator", grouped.operator)}
        ${roleSection("supervisor", grouped.supervisor)}
        ${roleSection("moderator", grouped.moderator)}
        ${!staff.length ? '<div class="text-zinc-500">No staff members found.</div>' : '<div id="panel-search-empty" class="hidden text-zinc-500 text-center py-8">No staff members match your search.</div>'}`;
	bindPanelSearch("#tab-content [data-search]");
}

async function addStaffMember() {
	const query = el("staff-search")?.value?.trim();
	const role = el("staff-role-select")?.value;
	const errEl = el("staff-add-error");
	errEl.classList.add("hidden");
	if (!query) {
		errEl.textContent = "Enter a username or user ID.";
		errEl.classList.remove("hidden");
		return;
	}
	try {
		const search = await fetch(`/api/admin/users`);
		if (!search.ok) throw new Error("Failed to fetch users");
		const users = await search.json();
		const target = users.find(
			(u) =>
				u.username.toLowerCase() === query.toLowerCase() ||
				String(u.id) === query ||
				String(u.discord_id) === query
		);
		if (!target) throw new Error(`No user found matching "${query}"`);
		if (target.role === role) throw new Error(`${target.username} already has the ${role} role`);
		const r = await fetch(`/api/admin/users/${target.id}/role`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ role }),
		});
		if (!r.ok) throw new Error(await r.text());
		el("staff-search").value = "";
		loadStaff();
	} catch (err) {
		errEl.textContent = err.message || "Failed.";
		errEl.classList.remove("hidden");
	}
}

async function limitUser(userId, type) {
	const hours = await showPrompt(`Set ${type} limit`, "Hours", {
		type: "number",
		note: "Enter 0 to remove the limit. Maximum 96 hours.",
	});
	if (hours === null) return;
	const h = parseFloat(hours);
	if (isNaN(h)) return;
	try {
		const r = await fetch(`/api/admin/users/${userId}/limit`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type, hours: h }),
		});
		if (!r.ok) throw new Error(await r.text());
		loadUsers();
	} catch (err) {
		showToast(err.message || "Failed.", "error");
	}
}

async function tempBanUser(userId) {
	const hours = await showPrompt("Temp ban duration", "Hours", {
		type: "number",
		note: "Maximum 8760 hours (1 year).",
	});
	if (hours === null) return;
	const h = Math.min(8760, parseFloat(hours));
	if (isNaN(h) || h <= 0) return;
	try {
		const r = await fetch(`/api/admin/users/${userId}/ban`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: "temp", hours: h }),
		});
		if (!r.ok) throw new Error(await r.text());
		loadUsers();
	} catch (err) {
		showToast(err.message || "Failed.", "error");
	}
}

async function permBanUser(userId) {
	const ok = await showConfirm("Permanent ban", "This will permanently ban the user. Are you sure?", {
		confirmLabel: "Ban permanently",
	});
	if (!ok) return;
	try {
		const r = await fetch(`/api/admin/users/${userId}/ban`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: "perm" }),
		});
		if (!r.ok) throw new Error(await r.text());
		loadUsers();
	} catch (err) {
		showToast(err.message || "Failed.", "error");
	}
}

async function warnUser(userId) {
	const reason = await showPrompt("Issue warning", "Reason (required)", { okLabel: "Issue warning" });
	if (!reason?.trim()) return;
	try {
		const r = await fetch(`/api/admin/users/${userId}/warn`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reason: reason.trim() }),
		});
		if (!r.ok) throw new Error(await r.text());
		showToast("Warning issued.", "success");
	} catch (err) {
		showToast(err.message || "Failed.", "error");
	}
}

async function unbanUser(userId) {
	try {
		const r = await fetch(`/api/admin/users/${userId}/unban`, { method: "POST" });
		if (!r.ok) throw new Error(await r.text());
		loadUsers();
	} catch (err) {
		showToast(err.message || "Failed.", "error");
	}
}

async function blockFromSite(userId) {
	const ok = await showConfirm("Block from site", "This will permanently block the user from the entire site.", {
		confirmLabel: "Block",
	});
	if (!ok) return;
	try {
		const r = await fetch(`/api/admin/users/${userId}/block`, { method: "POST" });
		if (!r.ok) throw new Error(await r.text());
		loadUsers();
	} catch (err) {
		showToast(err.message || "Failed.", "error");
	}
}

async function exportUserData(userId) {
	try {
		const r = await fetch(`/api/admin/users/${userId}/gdpr-export`);
		if (!r.ok) throw new Error(await r.text());
		const blob = await r.blob();
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `user-${userId}-data.json`;
		a.click();
		URL.revokeObjectURL(url);
	} catch (err) {
		showToast(err.message || "Failed to export.", "error");
	}
}

async function deleteUserAccount(userId) {
	const ok = await showConfirm(
		"Delete account",
		"This permanently deletes the user's account, scores, and personal data. This cannot be undone.",
		{ confirmLabel: "Delete account" }
	);
	if (!ok) return;
	try {
		const r = await fetch(`/api/admin/users/${userId}/account`, { method: "DELETE" });
		if (!r.ok) throw new Error(await r.text());
		showToast("Account deleted.", "success");
		loadUsers();
	} catch (err) {
		showToast(err.message || "Failed.", "error");
	}
}

function initUploadMap() {
	mapCanvas = new MapCanvas(el("map-canvas"), {
		onPinPlaced: (wx, wy) => {
			uploadPinWorld = { x: wx, y: wy };
			el("upload-pin-status").textContent = "Pin placed ✓";
			el("upload-pin-status").className = "text-green-400 text-sm";
			checkUploadReady();
		},
	});
}

function checkUploadReady() {
	el("upload-submit-btn").disabled = !(uploadFile && uploadPinWorld);
}

async function uploadLocation() {
	if (!uploadFile || !uploadPinWorld) return;
	el("upload-submit-btn").disabled = true;
	el("upload-error").classList.add("hidden");
	el("upload-success").classList.add("hidden");

	const formData = new FormData();
	formData.append("image", uploadFile);
	formData.append("world_x", uploadPinWorld.x);
	formData.append("world_y", uploadPinWorld.y);
	const label = el("upload-label").value.trim();
	if (label) formData.append("label", label);
	const hints = [el("upload-hint-1"), el("upload-hint-2"), el("upload-hint-3")]
		.map((i) => i.value.trim())
		.filter(Boolean);
	if (hints.length) formData.append("hints", JSON.stringify(hints));

	try {
		const r = await fetch("/api/admin/locations", { method: "POST", body: formData });
		if (!r.ok) throw new Error(await r.text());
		el("upload-success").classList.remove("hidden");
		uploadFile = null;
		uploadPinWorld = null;
		el("upload-file").value = "";
		el("upload-preview-wrap").classList.add("hidden");
		el("upload-label").value = "";
		el("upload-hint-1").value = "";
		el("upload-hint-2").value = "";
		el("upload-hint-3").value = "";
		el("upload-pin-status").textContent = "Click map to mark location";
		el("upload-pin-status").className = "text-zinc-600 text-sm";
		mapCanvas?.clearPin();
	} catch (err) {
		el("upload-error").textContent = err.message || "Upload failed.";
		el("upload-error").classList.remove("hidden");
		el("upload-submit-btn").disabled = false;
	}
}

const AUDIT_ACTION_LABELS = {
	submission_approve: { label: "Approved submission", color: "text-green-400" },
	submission_deny: { label: "Denied submission", color: "text-red-400" },
	suggestion_approve: { label: "Approved suggestion", color: "text-green-400" },
	suggestion_deny: { label: "Denied suggestion", color: "text-red-400" },
	location_activate: { label: "Activated location", color: "text-green-400" },
	location_deactivate: { label: "Deactivated location", color: "text-yellow-400" },
	location_delete: { label: "Deleted location", color: "text-red-400" },
	location_label_edit: { label: "Edited location label", color: "text-blue-400" },
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
};

const AUDIT_CATEGORIES = [
	{ key: "", label: "All" },
	{
		key: "moderation",
		label: "Moderation",
		actions: ["user_ban_perm", "user_ban_temp", "user_unban", "user_warn", "warning_delete", "warning_edit", "user_role_change"],
	},
	{
		key: "content",
		label: "Content",
		actions: ["submission_approve", "submission_deny", "suggestion_approve", "suggestion_deny", "location_activate", "location_deactivate", "location_delete", "location_label_edit"],
	},
	{
		key: "tickets",
		label: "Tickets",
		actions: ["ticket_reply", "ticket_close", "ticket_reopen", "ticket_delete", "ticket_cleanup"],
	},
	{
		key: "accounts",
		label: "Accounts",
		actions: ["user_register", "user_login", "user_delete", "user_delete_operator", "gdpr_export_operator"],
	},
];

// These are high-volume routine events that are collapsed by default
const AUDIT_ROUTINE = new Set(["user_login", "user_register", "ticket_reply", "ticket_close"]);

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
            ${e.target_type !== "ticket" ? (e.target_username ? ` <span class="text-zinc-600">→</span> <a href="/u/${encodeURIComponent(e.target_username)}" class="hover:underline">${escHtml(e.target_username)}</a>` : e.target_id ? ` <span class="text-zinc-600">#${e.target_id}</span>` : "") : e.target_id ? ` <span class="text-zinc-600">→ Ticket #${e.target_id}</span>` : ""}
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
                <input id="audit-search" type="search" value="${escHtml(auditSearch)}" placeholder="Search by name, action, target, details…"
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

	// Separate routine from significant, and group tickets
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
                <span>${routineRows.length} routine event${routineRows.length !== 1 ? "s" : ""} — logins, registrations, ticket replies</span>
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
        ${showPrev ? `<button onclick="auditPage(-1)" class="text-sm bg-zinc-800 hover:bg-zinc-700 transition px-4 py-2 rounded-lg">← Previous</button>` : ""}
        ${showNext ? `<button onclick="auditPage(1)" class="text-sm bg-zinc-800 hover:bg-zinc-700 transition px-4 py-2 rounded-lg">Next →</button>` : ""}`;
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

window.auditPage = auditPage;
window.toggleAuditGroup = toggleAuditGroup;
window.toggleAuditRoutine = toggleAuditRoutine;
window.setAuditCategory = setAuditCategory;
window.toggleSubmission = toggleSubmission;
window.warnUser = warnUser;

init();
