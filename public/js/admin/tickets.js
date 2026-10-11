/** Staff panel: support tickets. */

const TICKET_CATEGORY_LABELS = {
	ban_appeal: "Ban Appeal",
	submission_appeal: "Submission Appeal",
	bug_report: "Bug Report",
	report_user: "Report User",
	report_location: "Report Location",
	account: "Account",
	other: "Other",
};

let supportStatus = "open";
let supportCategory = "";
let supportSearch = "";
let expandedTicketId = null;

let _ticketsSignature = "";
let _stopTicketPolling = null;

/**
 * Loads the ticket list. With `quiet`, it is a background refresh: nothing is
 * redrawn unless something actually changed, and replies being typed are kept.
 */
async function loadTickets(reset = true, autoOpenId = null, { quiet = false } = {}) {
	if (reset) expandedTicketId = autoOpenId;
	const params = new URLSearchParams({ status: supportStatus });
	if (supportCategory) params.set("category", supportCategory);
	try {
		const [tickets, counts] = await Promise.all([
			api(`/api/admin/support?${params}`),
			api("/api/admin/support/counts"),
		]);
		const signature = JSON.stringify([tickets, counts, supportStatus, supportCategory]);
		if (quiet && signature === _ticketsSignature) return;
		_ticketsSignature = signature;

		// Hold on to anything being typed, and where the reader had scrolled to.
		const drafts = new Map(
			[...document.querySelectorAll('textarea[id^="reply-"]')].map((box) => [box.id, box.value])
		);
		const focused = document.activeElement?.id;
		renderTickets(tickets, counts);
		for (const [id, value] of drafts) if (el(id)) el(id).value = value;
		if (focused?.startsWith("reply-")) el(focused)?.focus();
		const thread = expandedTicketId && el(`thread-${expandedTicketId}`);
		if (thread) thread.scrollTop = thread.scrollHeight;

		if (autoOpenId) {
			setTimeout(() => el(`ticket-${autoOpenId}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
		}
	} catch (err) {
		if (!quiet) el("tab-content").innerHTML = `<div class="text-red-400">${escHtml(err.message)}</div>`;
	}
	// New tickets and replies show up by themselves while this tab is open.
	_stopTicketPolling ??= pollWhile(
		() => currentTab === "tickets",
		() => loadTickets(false, null, { quiet: true })
	);
}

function supportCountFor(counts, status, category = "") {
	return counts
		.filter((c) => c.status === status && (!category || c.category === category))
		.reduce((s, c) => s + c.count, 0);
}

function renderTickets(tickets, counts) {
	const openTotal = supportCountFor(counts, "open");
	const closedTotal = supportCountFor(counts, "closed");

	const statusTabs = [
		["open", "Open", openTotal],
		["closed", "Closed", closedTotal],
	]
		.map(
			([key, label, total]) =>
				`<button onclick="setTicketStatus('${key}')" aria-pressed="${supportStatus === key}">${label} <span class="count">${total}</span></button>`
		)
		.join("");

	const chip = (key, label, count) =>
		`<button onclick="setTicketCategory('${key}')" class="m-chip" aria-pressed="${supportCategory === key}">${label}${count ? ` <span class="count">${count}</span>` : ""}</button>`;
	const categoryFilters = [
		chip("", "All"),
		...Object.entries(TICKET_CATEGORY_LABELS).map(([key, label]) =>
			chip(key, label, supportCountFor(counts, supportStatus, key))
		),
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
		<div class="flex items-center gap-2 mb-3 flex-wrap">
			<div class="m-segmented">${statusTabs}</div>
			<label class="m-search flex-1 min-w-[12rem] ml-auto max-w-sm">
				<span class="material-symbols-outlined">search</span>
				<input id="support-search" type="search" placeholder="Search tickets" value="${escHtml(supportSearch)}" class="m-field" />
			</label>
			${
				currentUser?.role === "operator"
					? `<button onclick="cleanupTickets()" class="m-icon-btn" title="Delete closed tickets older than six months" aria-label="Clean up old tickets"><span class="material-symbols-outlined">auto_delete</span></button>`
					: ""
			}
			<button onclick="loadTickets()" class="m-icon-btn" title="Refresh" aria-label="Refresh"><span class="material-symbols-outlined">refresh</span></button>
		</div>
		<div class="flex gap-2 flex-wrap mb-5">${categoryFilters}</div>
		<div class="flex flex-col gap-3">${ticketHtml}</div>`;

	const searchEl = document.getElementById("support-search");
	if (searchEl) {
		searchEl.addEventListener("input", (e) => {
			supportSearch = e.target.value;
			renderTickets(tickets, counts);
			const box = el("support-search");
			box.focus();
			box.setSelectionRange(box.value.length, box.value.length);
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
	return `<div class="bg-black/20 rounded-xl p-3 mb-2">
        ${pairs}
    </div>
    <div class="whitespace-pre-wrap text-zinc-300 text-sm">${escHtml(main)}</div>`;
}

function renderTicketCard(t) {
	const isOpen = t.status === "open";
	const isExpanded = expandedTicketId === t.id;
	const waiting = isOpen && (t.awaiting_staff || !t.replies.some((r) => r.type === "staff"));
	const tags = [
		`<span class="m-tag">${TICKET_CATEGORY_LABELS[t.category] || "Other"}</span>`,
		t.close_requested
			? '<span class="m-tag warn">Close requested</span>'
			: waiting
				? '<span class="m-tag info">Needs reply</span>'
				: "",
		t.is_banned ? '<span class="m-tag danger">Banned</span>' : "",
	].join("");

	return `
	<div class="bg-zinc-900 rounded-2xl overflow-hidden" id="ticket-${t.id}">
		<button onclick="toggleTicket(${t.id})" class="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-800/50 transition" aria-expanded="${isExpanded}">
			${avatarHtml(t.avatar_url, "w-10 h-10 flex-shrink-0")}
			<div class="flex-1 min-w-0">
				<div class="font-semibold text-sm truncate">${escHtml(t.subject)}</div>
				<div class="text-xs text-zinc-500 mt-0.5 truncate">
					@${escHtml(t.username)} · #${t.id} · ${ticketTime(t.created_at)} ·
					<span role="link" tabindex="0" onclick="event.stopPropagation(); openUserPanel(${t.user_id})" class="underline hover:text-zinc-200 transition cursor-pointer" title="Open this user's moderation history">history</span>
				</div>
				<div class="flex sm:hidden items-center gap-1.5 flex-wrap mt-1.5">${tags}</div>
			</div>
			<div class="hidden sm:flex items-center gap-1.5 flex-shrink-0">${tags}</div>
			<span class="material-symbols-outlined text-zinc-500 text-xl transition-transform ${isExpanded ? "rotate-180" : ""}">expand_more</span>
		</button>
		${isExpanded ? renderTicketBody(t, isOpen) : ""}
	</div>`;
}

function renderTicketBody(t, isOpen) {
	const isOp = currentUser?.role === "operator";
	const closeRequestBanner = t.close_requested
		? `<div class="flex items-start gap-2 bg-zinc-800 rounded-xl px-3.5 py-2.5 text-sm text-zinc-300">
			<span class="material-symbols-outlined text-lg text-amber-300 flex-shrink-0">task_alt</span>
			<span>The user says this is resolved and asked for it to be closed. Close it to confirm, or reply to keep it open.</span>
		</div>`
		: "";

	return `
	<div class="px-4 pb-4 border-t border-zinc-800 pt-4 flex flex-col gap-3">
		<div id="thread-${t.id}" class="max-h-[26rem] overflow-y-auto flex flex-col gap-3 pr-1">${ticketThreadHtml(t, "staff", renderTicketMessage(t.message))}</div>
		${closeRequestBanner}
		${
			isOpen
				? `<div class="flex gap-2 items-end">
					<textarea id="reply-${t.id}" rows="2" maxlength="2000" placeholder="Write a reply"
						onkeydown="if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();replyTicket(${t.id},false);}"
						class="m-field flex-1"></textarea>
					<button onclick="replyTicket(${t.id}, false)" class="m-icon-btn filled" aria-label="Send reply" title="Send (Ctrl+Enter)"><span class="material-symbols-outlined">send</span></button>
				</div>
				<div class="flex gap-2 flex-wrap justify-end">
					<button onclick="closeTicket(${t.id})" class="m-btn m-btn-text m-btn-sm">Close without replying</button>
					<button onclick="replyTicket(${t.id}, true)" class="m-btn m-btn-tonal m-btn-sm">Reply and close</button>
				</div>`
				: `<div class="flex gap-2 flex-wrap justify-end">
					${isOp ? `<button onclick="deleteTicket(${t.id})" class="m-btn m-btn-text m-btn-sm danger">Delete</button>` : ""}
					<button onclick="reopenTicket(${t.id})" class="m-btn m-btn-tonal m-btn-sm">Reopen</button>
				</div>`
		}
	</div>`;
}

function toggleTicket(id) {
	expandedTicketId = expandedTicketId === id ? null : id;
	location.hash = expandedTicketId ? `tickets:${expandedTicketId}` : "tickets";
	loadTickets(false);
	if (expandedTicketId) {
		setTimeout(() => {
			document
				.getElementById(`ticket-${expandedTicketId}`)
				?.scrollIntoView({ behavior: "smooth", block: "start" });
		}, 100);
	}
}

function setTicketStatus(s) {
	supportStatus = s;
	supportCategory = "";
	supportSearch = "";
	loadTickets(true);
}
function setTicketCategory(c) {
	supportCategory = c;
	loadTickets(true);
}

async function replyTicket(id, close) {
	const box = el(`reply-${id}`);
	const reply = box?.value.trim() || "";
	if (!reply && !close) return box?.focus();
	try {
		await api(`/api/admin/support/${id}/reply`, { json: { reply, close } });
		if (box) box.value = "";
		if (close) expandedTicketId = null;
		await loadTickets(false);
		refreshAttention();
	} catch (err) {
		showToast(err.message, "error");
	}
}

async function closeTicket(id) {
	try {
		const r = await fetch(`/api/admin/support/${id}/close`, { method: "POST" });
		if (!r.ok) throw new Error(await r.text());
		expandedTicketId = null;
		loadTickets(false);
		refreshAttention();
	} catch (err) {
		showToast(err.message || "Failed.", "error");
	}
}

async function reopenTicket(id) {
	try {
		const r = await fetch(`/api/admin/support/${id}/reopen`, { method: "POST" });
		if (!r.ok) throw new Error(await r.text());
		loadTickets(true);
		refreshAttention();
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
		loadTickets(true);
		refreshAttention();
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
		loadTickets(true);
		refreshAttention();
	} catch (err) {
		showToast(err.message || "Failed.", "error");
	}
}
