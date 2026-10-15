import { avatarHtml, el, escHtml, scrollBehavior } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { showToast } from "../lib/toast.js";
import { refreshAttention } from "../lib/attention.js";
import { linkedTextHtml, pollWhile, ticketThreadHtml, ticketTime } from "../tickets.js";
import { atLeast, claimChanged, currentTab, showConfirm } from "./core.js";

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
export let expandedTicketId = null;

let _ticketsSignature = "";
let _stopTicketPolling = null;

/** Loads the ticket list. `quiet` redraws only on a change and keeps typed replies. */
export async function loadTickets(reset = true, autoOpenId = null, { quiet = false } = {}) {
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

		const drafts = new Map(
			[...document.querySelectorAll('textarea[id^="reply-"]')].map((box) => [box.id, box.value])
		);
		const focused = document.activeElement?.id;
		renderTickets(tickets, counts);
		claimChanged();
		for (const [id, value] of drafts) if (el(id)) el(id).value = value;
		if (focused?.startsWith("reply-")) el(focused)?.focus();
		const thread = expandedTicketId && el(`thread-${expandedTicketId}`);
		if (thread) thread.scrollTop = thread.scrollHeight;

		if (autoOpenId) {
			setTimeout(
				() => el(`ticket-${autoOpenId}`)?.scrollIntoView({ behavior: scrollBehavior(), block: "start" }),
				100
			);
		}
	} catch (err) {
		if (!quiet) el("tab-content").innerHTML = `<div class="text-red-400">${escHtml(err.message)}</div>`;
	}
	_stopTicketPolling ??= pollWhile(
		() => currentTab === "tickets",
		() => loadTickets(false, null, { quiet: true }),
		5000,
		"ticket"
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
				atLeast("admin")
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
	if (sepIdx === -1) return `<div class="whitespace-pre-wrap text-zinc-300 text-sm">${linkedTextHtml(message)}</div>`;
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
    <div class="whitespace-pre-wrap text-zinc-300 text-sm">${linkedTextHtml(main)}</div>`;
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
		`<span data-claim="ticket:${t.id}" class="empty:hidden"></span>`,
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
	const isOp = atLeast("admin");
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
				? `<select onchange="useSavedReply(${t.id}, this)" class="m-field" aria-label="Saved replies">
					<option value="">Start from a saved reply...</option>
					${savedReplyOptions()}
				</select>
				<div class="flex gap-2 items-end">
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
				?.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
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

const SAVED_REPLIES = {
	General: [
		[
			"Looking into it",
			"Thanks for getting in touch. We're looking into this and will reply here once we know more.",
		],
		[
			"Need more detail",
			"Thanks for the report. Could you add a bit more detail: what happened, when, and any IDs or links you have?",
		],
		["Fixed", "This should now be fixed. Reload the page, and reply here if it still isn't right."],
		["Known issue", "We know about this and are working on it. There's no need to report it again."],
		["Passed on", "We've passed this to the staff who deal with it. They'll reply here."],
	],
	Reports: [
		[
			"Action taken",
			"Thanks for the report. We looked into it and took action. We can't share details about another player's account.",
		],
		[
			"No action",
			"Thanks for the report. We looked into it and found nothing that breaks the rules, so no action was taken.",
		],
		[
			"Need evidence",
			"Thanks for the report. We need something to go on: a game link, a screenshot, or when it happened.",
		],
		[
			"Already handled",
			"Thanks for the report. This player has already been dealt with, so there's nothing more to do here.",
		],
	],
	Appeals: [
		["Under review", "We've got your appeal and are reviewing it. We'll reply here with the outcome."],
		["Accepted", "We reviewed your appeal and overturned the action. Sorry for the trouble."],
		["Declined", "We reviewed your appeal and the action stands. The reason given at the time still applies."],
		["Ban shortened", "We reviewed your appeal and shortened the ban. It won't be removed completely."],
		[
			"Final",
			"This appeal has already been reviewed and the decision is final. Further tickets about it will be closed.",
		],
	],
	Submissions: [
		["Approved", "We took another look at your submission and approved it. Sorry for the trouble."],
		[
			"Still denied",
			"We took another look at your submission and the decision stands. The reason given at the time still applies.",
		],
		[
			"Resubmit",
			"The submission can't be approved as it is. Fix what the denial reason mentions and submit it again.",
		],
	],
	Locations: [
		["Which one?", "We couldn't find that location. Could you send its ID, the one starting LOC-?"],
		["Fixed", "Thanks for flagging this location. We checked it and corrected it."],
		["Duplicate removed", "You're right, this was a duplicate. We've removed the copy and kept the original."],
		[
			"No change",
			"Thanks for flagging this location. We checked it and found nothing wrong, so it stays as it is.",
		],
		["Back in play", "We've put this location back in play, so it can come up in games again."],
		[
			"Out of play",
			"We've taken this location out of play, so it won't come up in games any more. Thanks for flagging it.",
		],
	],
	Account: [
		[
			"Need proof",
			"Before we change anything on an account we need to be sure it's yours. Could you tell us the username and roughly when you last logged in?",
		],
		[
			"Log in again",
			"Your Discord name and avatar are refreshed each time you log in. Log out and back in, then reply here if it's still wrong.",
		],
		["Data corrected", "We've corrected the data on your account. Reload the page to see it."],
		["Can't transfer", "We can't move progress from one account to another."],
	],
	"Wrong place": [
		[
			"Belongs on GitHub",
			"Bugs and feature requests are tracked on GitHub Issues, not in tickets. Please post it there so it doesn't get lost.",
		],
		[
			"Wrong category",
			"This was filed under the wrong category, so it may take longer. There's no need to open a new ticket.",
		],
		["Not something we handle", "This isn't something staff can help with through tickets."],
		["Duplicate", "You have another ticket open about this, so we'll carry on there and close this one."],
		["One ticket per issue", "Please keep each issue to one ticket. Opening more doesn't speed things up."],
	],
	Conduct: [
		[
			"Please wait",
			"We have everything we need and will reply here when there's news. There's no need to reply again unless you have something new to add.",
		],
		["Be respectful", "Please keep it respectful. We won't carry on with a ticket while staff are being insulted."],
	],
	Documents: [
		["Terms of Service", `This is covered by our Terms of Service: ${location.origin}/tos`],
		["Privacy Policy", `Our Privacy Policy sets out what we collect and why: ${location.origin}/privacy`],
		["Fair Play Policy", `This is covered by our Fair Play Policy: ${location.origin}/fairplay`],
		[
			"Upload Guidelines",
			`Our Upload Guidelines set out what a submission needs. Please read them before your next one: ${location.origin}/guidelines`,
		],
		["Deleting your account", `Deleting your account is covered here: ${location.origin}/privacy#deletion`],
		["Your data rights", `Your rights over your data are set out here: ${location.origin}/privacy#rights`],
		["Reporting illegal content", `Reporting illegal content is covered here: ${location.origin}/tos#reporting`],
	],
	Closing: [
		[
			"Inactive",
			"We haven't heard from you in a while. Reply here if you still need help, otherwise we'll close this ticket.",
		],
		["No reply", "We haven't heard back, so we're closing this ticket. Open a new one if you still need help."],
		["Resolved", "This is sorted, so we're closing the ticket. Open a new one if anything else comes up."],
	],
};

/** Each option's value is its heading and its place under it, which useSavedReply reads back. */
const savedReplyOptions = () =>
	Object.entries(SAVED_REPLIES)
		.map(
			([group, replies]) =>
				`<optgroup label="${group}">${replies.map(([label], i) => `<option value="${group}|${i}">${label}</option>`).join("")}</optgroup>`
		)
		.join("");

function useSavedReply(id, select) {
	const [group, index] = select.value.split("|");
	const reply = SAVED_REPLIES[group]?.[index];
	select.value = "";
	if (!reply) return;
	const box = el(`reply-${id}`);
	box.value = reply[1];
	box.focus();
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

/** Called from inline handlers in the markup. */
Object.assign(window, {
	cleanupTickets,
	closeTicket,
	deleteTicket,
	loadTickets,
	reopenTicket,
	replyTicket,
	setTicketCategory,
	setTicketStatus,
	toggleTicket,
	useSavedReply,
});
