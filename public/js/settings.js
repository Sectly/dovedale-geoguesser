let currentUser = null;

async function init() {
	currentUser = await fetchUser();
	if (!currentUser) {
		el("main").innerHTML = `<div class="text-center py-16">
		<p class="text-zinc-400 mb-4">You need to be logged in to access settings.</p>
		<a href="/api/auth/login?redirect=/settings" class="bg-blue-600 hover:bg-blue-500 transition px-6 py-2.5 rounded-xl font-semibold">Login with Discord</a>
		<p class="text-zinc-600 text-xs mt-4">By logging in you agree to our <a href="/tos" class="underline hover:text-zinc-400">Terms of Service</a> and <a href="/privacy" class="underline hover:text-zinc-400">Privacy Policy</a>.</p>
	</div>`;
		return;
	}

	renderSettings();
	loadModerationHistory();
}

/* ---- Dialog used for the ticket list and the submissions list ---- */

let _listDialog = null;

function openListDialog(kind, title, actionsHtml = "") {
	_listDialog = kind;
	el("list-dialog-title").textContent = title;
	el("list-dialog-actions").innerHTML = actionsHtml;
	el("list-dialog-body").innerHTML = skeletonRows(3, "h-14");
	show("list-dialog");
}

function closeListDialog() {
	_listDialog = null;
	show("list-dialog", false);
}

async function openMySubmissions() {
	openListDialog("submissions", "My submissions");
	const body = el("list-dialog-body");
	try {
		const subs = await api("/api/submissions/mine");
		if (_listDialog !== "submissions") return;
		if (!subs.length) {
			body.innerHTML = `<div class="text-center py-10">
				<span class="material-symbols-outlined text-4xl text-zinc-700">add_photo_alternate</span>
				<p class="text-zinc-500 text-sm mt-2">You haven't submitted any locations yet.</p>
				<a href="/submit" class="inline-block mt-4 bg-blue-600 hover:bg-blue-500 transition px-4 py-2 rounded-xl text-sm font-semibold">Submit a location</a>
			</div>`;
			return;
		}
		const tone = {
			pending: "bg-yellow-900/50 text-yellow-300",
			approved: "bg-green-900/50 text-green-300",
			denied: "bg-red-900/50 text-red-300",
		};
		body.innerHTML = `<div class="stagger">${subs
			.map(
				(sub) => `<div class="flex items-center gap-3 py-2.5 border-b border-zinc-800 last:border-0">
					<img src="/uploads/${escHtml(sub.image_path)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" class="w-16 h-10 rounded-lg object-cover flex-shrink-0 bg-zinc-800" />
					<div class="flex-1 min-w-0">
						<div class="text-sm font-medium truncate">${escHtml(sub.label || "No label")}</div>
						<div class="text-xs text-zinc-500">SUB-${String(sub.id).padStart(4, "0")} · ${new Date(sub.created_at * 1000).toLocaleDateString()}</div>
						${sub.status === "denied" && sub.deny_reason ? `<div class="text-xs text-red-300 mt-0.5 break-words">${linkRuleCodes(escHtml(sub.deny_reason))}</div>` : ""}
					</div>
					<span class="text-xs px-2 py-0.5 rounded-full flex-shrink-0 ${tone[sub.status] || "bg-zinc-700 text-zinc-400"}">${escHtml(sub.status)}</span>
				</div>`
			)
			.join("")}</div>`;
	} catch (err) {
		body.innerHTML = `<div class="text-red-400 text-sm">${escHtml(err.message)}</div>`;
	}
}

async function loadModerationHistory() {
	const area = el("mod-history-area");
	if (!area) return;
	try {
		const { actions } = await api("/api/me/moderation");
		if (!actions.length) {
			area.innerHTML = '<p class="text-zinc-600 text-sm">No moderation actions on your account.</p>';
			return;
		}
		const when = (ts) =>
			new Date(ts * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
		const STYLE = {
			warning: ["warning", "text-yellow-400"],
			limit_upload: ["upload_off", "text-orange-400"],
			limit_duel: ["swords", "text-orange-400"],
			ban_temp: ["timer", "text-red-400"],
			ban_perm: ["block", "text-red-400"],
		};
		const STATUS = {
			active: ["Active", "bg-red-900/60 text-red-300"],
			expired: ["Ended", "bg-zinc-800 text-zinc-400"],
			overturned: ["Overturned", "bg-green-900/50 text-green-300"],
		};
		area.innerHTML = actions
			.map((a) => {
				const [icon, tone] = STYLE[a.type] || ["gavel", "text-zinc-400"];
				const [statusLabel, statusTone] = STATUS[a.status];
				// A warning has no end date, so "active" would only read as alarming.
				const badge =
					a.type === "warning" && a.status === "active"
						? ""
						: `<span class="text-[11px] px-1.5 py-0.5 rounded ${statusTone}">${statusLabel}</span>`;
				return `<div class="flex items-start gap-3 py-2.5 border-b border-zinc-800 last:border-0">
					<span class="material-symbols-outlined ${tone} text-base flex-shrink-0 mt-0.5" style="font-variation-settings:'FILL' 1">${icon}</span>
					<div class="flex-1 min-w-0">
						<div class="flex items-center gap-2 flex-wrap"><span class="text-sm font-medium">${escHtml(a.label)}</span>${badge}</div>
						<div class="text-zinc-400 text-xs mt-0.5 break-words">${linkRuleCodes(escHtml(a.reason))}</div>
						${a.status === "active" && a.expires_at ? `<div class="text-zinc-500 text-xs mt-0.5">Until ${new Date(a.expires_at * 1000).toLocaleString()}</div>` : ""}
						${a.status === "overturned" && a.revoke_reason ? `<div class="text-green-300/80 text-xs mt-0.5 break-words">Overturned: ${escHtml(a.revoke_reason)}</div>` : ""}
					</div>
					<span class="text-zinc-600 text-xs flex-shrink-0">${when(a.created_at)}</span>
				</div>`;
			})
			.join("");
		if (actions.some((a) => a.status === "active")) {
			area.insertAdjacentHTML(
				"beforeend",
				'<p class="text-zinc-500 text-xs mt-3">Think one of these is a mistake? Open a "Ban Appeal" ticket and staff will review it.</p>'
			);
		}
	} catch {
		area.innerHTML = '<p class="text-zinc-600 text-sm">Could not load moderation history.</p>';
	}
}

const SECTIONS = [
	["notifications", "Notifications", "notifications"],
	["preferences", "Preferences", "tune"],
	["support", "Support", "support_agent"],
	["submissions", "My Submissions", "add_photo_alternate"],
	["moderation", "Moderation History", "gavel"],
	["data", "Your Data", "download"],
	["account", "Account", "person_off"],
];

/** One card on the page. `id` is what the menu and links like /settings#support point at. */
function section(id, content) {
	const [, title, icon] = SECTIONS.find(([key]) => key === id);
	return `<section id="${id}" class="bg-zinc-900 rounded-2xl p-5 mb-4 scroll-mt-16">
	<h2 class="font-bold text-base mb-4 text-zinc-200 flex items-center gap-2">
		<span class="material-symbols-outlined text-lg text-zinc-500">${icon}</span>${title}
	</h2>
	${content}
</section>`;
}

/** The jump menu under the page title. */
function sectionMenu() {
	return `<nav class="flex gap-1.5 flex-wrap mb-4" aria-label="Settings sections">
		${SECTIONS.map(
			([id, title]) =>
				`<a href="#${id}" class="px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap bg-zinc-900 text-zinc-400 hover:text-white hover:bg-zinc-800 transition">${title}</a>`
		).join("")}
	</nav>`;
}

function toggleHtml(on, onclick, label) {
	return `<button role="switch" aria-checked="${on}" aria-label="${escHtml(label)}" onclick="${onclick}"
		class="relative flex-shrink-0 w-11 h-6 rounded-full transition-colors ${on ? "bg-blue-600" : "bg-zinc-600"}">
		<span class="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${on ? "translate-x-5" : "translate-x-0"}"></span>
	</button>`;
}

function settingRow(title, description, toggle) {
	return `<div class="flex items-center justify-between gap-4 py-2.5 border-b border-zinc-800 last:border-0">
		<div class="min-w-0">
			<div class="font-medium text-sm">${title}</div>
			<div class="text-zinc-500 text-xs mt-0.5">${description}</div>
		</div>
		${toggle}
	</div>`;
}

/* ---- Preferences ---- */

const NOTIFY_OPTIONS = [
	["submissions", "Submissions", "When a location you submitted is approved or denied"],
	["suggestions", "Suggestions", "When a change you suggested is accepted or declined"],
	["tickets", "Tickets", "When staff reply to or close one of your tickets"],
	["reminders", "Streak reminders", "An evening nudge when your streak is about to end"],
];

function preferencesHtml() {
	const prefs = currentUser.prefs;
	const desktopBlocked = "Notification" in window && Notification.permission === "denied";
	return `
		<div class="text-xs text-zinc-500 uppercase tracking-wider font-medium mb-1">General</div>
		${settingRow("Sound effects", "Short sounds for pins, results, countdowns and new notifications", toggleHtml(prefs.sounds, "setPref('sounds', " + !prefs.sounds + ")", "Sound effects"))}
		${settingRow("Private profile", "Only you and staff can view your profile page. Your name still appears on leaderboards", toggleHtml(!!currentUser.profile_private, "togglePrivacy()", "Private profile"))}

		<div class="text-xs text-zinc-500 uppercase tracking-wider font-medium mt-5 mb-1">Notify me about</div>
		${NOTIFY_OPTIONS.map(([key, title, description]) =>
			settingRow(
				title,
				description,
				toggleHtml(prefs.notify[key], `setPref('notify.${key}', ${!prefs.notify[key]})`, title)
			)
		).join("")}
		${settingRow("Moderation and announcements", "Warnings, limits and bans on your account, and important site news. Always sent.", '<span class="text-xs text-zinc-500 flex-shrink-0">Always on</span>')}

		<div class="text-xs text-zinc-500 uppercase tracking-wider font-medium mt-5 mb-1">How</div>
		${settingRow("In-site toasts", "A small pop-up in the corner of the page when something new arrives", toggleHtml(prefs.toasts, "setPref('toasts', " + !prefs.toasts + ")", "In-site toasts"))}
		${settingRow(
			"Desktop notifications",
			desktopBlocked
				? "Blocked in your browser. Allow notifications for this site in your browser settings first."
				: "A notification from your browser, even when the site is closed (where supported)",
			"Notification" in window
				? toggleHtml(
						prefs.desktop && !desktopBlocked,
						"setDesktopNotifications(" + !prefs.desktop + ")",
						"Desktop notifications"
					)
				: '<span class="text-xs text-zinc-500 flex-shrink-0">Not supported</span>'
		)}
		${
			currentUser.role
				? `<div class="text-xs text-zinc-500 uppercase tracking-wider font-medium mt-5 mb-1">Staff</div>` +
					settingRow(
						"Review queue badges",
						"Show how many items are waiting for review on the staff panel button and in its sidebar",
						toggleHtml(
							prefs.staff_badges,
							"setPref('staff_badges', " + !prefs.staff_badges + ")",
							"Review queue badges"
						)
					) +
					settingRow(
						"Review queue alerts",
						"A pop-up when something new arrives for review. Never shown mid-round.",
						toggleHtml(
							prefs.staff_alerts,
							"setPref('staff_alerts', " + !prefs.staff_alerts + ")",
							"Review queue alerts"
						)
					)
				: ""
		}`;
}

/** Saves one preference ("sounds" or "notify.tickets") and redraws the block. */
async function setPref(path, value) {
	const [group, key] = path.split(".");
	try {
		const { prefs } = await api("/api/settings", {
			json: { prefs: key ? { [group]: { [key]: value } } : { [group]: value } },
		});
		currentUser.prefs = prefs;
		Sounds.setEnabled(prefs.sounds);
		if (path === "sounds" && value) Sounds.play("good");
		el("preferences-body").innerHTML = preferencesHtml();
		refreshAttention();
	} catch (err) {
		showToast(err.message, "error");
	}
}

async function setDesktopNotifications(on) {
	if (on && Notification.permission !== "granted") {
		const answer = await Notification.requestPermission();
		if (answer !== "granted") {
			showToast("Your browser didn't allow notifications for this site.", "error");
			el("preferences-body").innerHTML = preferencesHtml();
			return;
		}
	}
	if (on) await enablePush();
	else await disablePush();
	await setPref("desktop", on);
}

/* ---- Notification inbox ---- */

const NOTIFICATION_ICONS = {
	submissions: ["add_photo_alternate", "text-blue-400"],
	suggestions: ["lightbulb", "text-yellow-400"],
	tickets: ["support_agent", "text-teal-400"],
	moderation: ["gavel", "text-red-400"],
	reminders: ["local_fire_department", "text-orange-400"],
	announcements: ["campaign", "text-purple-400"],
};

function timeAgo(seconds) {
	const diff = Math.max(0, Date.now() / 1000 - seconds);
	if (diff < 60) return "just now";
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
	if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}d ago`;
	return new Date(seconds * 1000).toLocaleDateString();
}

async function loadNotifications() {
	const area = el("notifications-area");
	if (!area) return;
	try {
		const { notifications, unread } = await api("/api/notifications");
		show("notifications-clear", notifications.length > 0);
		if (!notifications.length) {
			area.innerHTML = `<div class="text-center py-6">
				<span class="material-symbols-outlined text-3xl text-zinc-700">notifications_off</span>
				<p class="text-zinc-500 text-sm mt-1">Nothing yet. Updates on your submissions, suggestions and tickets appear here.</p>
			</div>`;
			return;
		}
		area.innerHTML = notifications
			.map((n) => {
				const [icon, tone] = NOTIFICATION_ICONS[n.category] || ["notifications", "text-zinc-400"];
				return `<a href="${escHtml(n.link || "#")}" class="flex items-start gap-3 py-2.5 px-2 rounded-xl border-b border-zinc-800 last:border-0 hover:bg-zinc-800/60 transition ${n.read_at ? "" : "bg-blue-950/30"}">
					<span class="material-symbols-outlined ${tone} text-lg flex-shrink-0 mt-0.5" style="font-variation-settings:'FILL' 1">${icon}</span>
					<div class="flex-1 min-w-0">
						<div class="text-sm font-medium flex items-center gap-2">${escHtml(n.title)}</div>
						${n.body ? `<div class="text-zinc-400 text-xs mt-0.5 break-words">${escHtml(n.body).replace(/\b([FAU]\d{1,2})\b/g, '<span class="rule-code">$1</span>')}</div>` : ""}
					</div>
					<span class="text-zinc-600 text-xs flex-shrink-0">${timeAgo(n.created_at)}</span>
				</a>`;
			})
			.join("");
		// Having the inbox on screen counts as reading it, so the badges clear.
		if (unread > 0) refreshAttention(await api("/api/notifications/read", { method: "POST" }));
	} catch (err) {
		area.innerHTML = `<div class="text-red-400 text-sm">${escHtml(err.message)}</div>`;
	}
}

async function clearNotifications() {
	try {
		refreshAttention(await api("/api/notifications", { method: "DELETE" }));
		loadNotifications();
	} catch (err) {
		showToast(err.message, "error");
	}
}

function banNotice() {
	if (!currentUser.is_banned) return "";
	const expiry =
		currentUser.ban_type === "temp" && currentUser.ban_expires_at
			? `Expires: ${new Date(currentUser.ban_expires_at * 1000).toLocaleString()}`
			: "This ban is permanent.";
	return `<div class="bg-red-950/60 border border-red-700/50 rounded-2xl p-5 mb-6">
	<div class="flex items-center gap-3 mb-2">
		<span class="material-symbols-outlined text-red-400 text-2xl" style="font-variation-settings:'FILL' 1">block</span>
		<h2 class="font-bold text-red-300 text-lg">Your account is banned</h2>
	</div>
	<p class="text-red-200/70 text-sm mb-1">${expiry}</p>
	<p class="text-zinc-400 text-sm mt-2">You can appeal with a ticket in the Support section below.</p>
</div>`;
}

function renderSettings() {
	el("main").innerHTML = `
	<h1 class="text-2xl font-bold mb-4">Settings</h1>
	${sectionMenu()}

	${banNotice()}

	${section(
		"notifications",
		`
		<div id="notifications-area" class="max-h-96 overflow-y-auto overflow-x-hidden pr-1 custom-scroll">
			<div class="skeleton h-14 rounded-xl mb-2"></div><div class="skeleton h-14 rounded-xl"></div>
		</div>
		<div class="flex justify-end mt-3">
			<button id="notifications-clear" onclick="clearNotifications()" class="hidden text-xs text-zinc-500 hover:text-zinc-300 transition">Clear all</button>
		</div>
	`
	)}

	${section("preferences", `<div id="preferences-body">${preferencesHtml()}</div>`)}

	${section(
		"support",
		`
		<p class="text-zinc-400 text-sm mb-4">Appeal a ban, report a problem or ask staff for help.</p>
		<div class="flex gap-2 flex-wrap">
			<button onclick="openTicketInfoModal()" class="m-btn m-btn-filled"><span class="material-symbols-outlined">add</span>New ticket</button>
			<button onclick="openMyTickets()" class="m-btn m-btn-tonal"><span class="material-symbols-outlined">forum</span>My tickets</button>
		</div>
	`
	)}

	${section(
		"submissions",
		`
		<p class="text-zinc-400 text-sm mb-4">The locations you've submitted and how each review went. Denied ones are removed after 30 days.</p>
		<button onclick="openMySubmissions()" class="m-btn m-btn-tonal"><span class="material-symbols-outlined">photo_library</span>My submissions</button>
	`
	)}

	${section(
		"moderation",
		`
		<p class="text-zinc-400 text-sm mb-4">Warnings, limits and bans issued by staff, each with the reason given.</p>
		<div id="mod-history-area"><div class="skeleton h-14 rounded-xl mb-2"></div><div class="skeleton h-14 rounded-xl mb-2"></div><div class="skeleton h-14 rounded-xl"></div></div>
	`
	)}

	${section(
		"data",
		`
		
		<div class="flex items-start justify-between gap-4 py-2 border-b border-zinc-800 mb-2">
			<div>
				<div class="font-medium text-sm">Export your data</div>
				<div class="text-zinc-500 text-xs mt-0.5">Download everything we hold about your account as a JSON file.</div>
			</div>
			<button onclick="exportData()" class="flex-shrink-0 bg-zinc-700 hover:bg-zinc-600 transition px-3 py-1.5 rounded-lg text-sm font-semibold">
				Export
			</button>
		</div>
		
	`
	)}

	${section(
		"account",
		`
		<div class="flex items-start justify-between gap-4 py-2">
			<div>
				<div class="font-medium text-sm">Delete account</div>
				<div class="text-zinc-500 text-xs mt-0.5">Permanently removes your name, scores and personal data. Moderation records are kept.</div>
			</div>
			<button onclick="deleteAccount()" class="flex-shrink-0 bg-red-900 hover:bg-red-800 transition px-3 py-1.5 rounded-lg text-sm font-semibold text-red-200">
				Delete
			</button>
		</div>
		<div id="delete-confirm-row" class="hidden mt-3 bg-red-950/50 border border-red-700/40 rounded-xl p-4 space-y-3">
			<p class="text-red-200 text-sm font-medium">This cannot be undone. Type <code class="bg-red-900/60 px-1 rounded text-red-300">DELETE</code> to confirm.</p>
			<div class="flex gap-2">
				<input id="delete-confirm-input" type="text" placeholder="Type DELETE" maxlength="10"
					class="flex-1 bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 placeholder:text-zinc-600" />
				<button onclick="confirmDeleteAccount()" class="bg-red-700 hover:bg-red-600 transition px-4 py-2 rounded-lg text-sm font-semibold text-white">Confirm</button>
				<button onclick="el('delete-confirm-row').classList.add('hidden')" class="bg-zinc-700 hover:bg-zinc-600 transition px-3 py-2 rounded-lg text-sm">Cancel</button>
			</div>
		</div>
	`
	)}

	<div class="text-xs text-zinc-600 flex gap-4 flex-wrap mt-4">
		<a href="/tos" class="hover:text-zinc-400 transition">Terms of Service</a>
		<a href="/privacy" class="hover:text-zinc-400 transition">Privacy Policy</a>
		<a href="/guidelines" class="hover:text-zinc-400 transition">Upload Guidelines</a>
	</div>
`;
	/** Tickets and submissions load when their dialog is opened, not with the page. */
	const linkedTicket = Number(new URLSearchParams(location.search).get("open_ticket"));
	if (linkedTicket) openMyTickets(linkedTicket);
	loadNotifications();
	// Links like /settings#moderation land on a section that did not exist until now.
	if (location.hash) requestAnimationFrame(() => document.getElementById(location.hash.slice(1))?.scrollIntoView());

	/** Pre-fill ticket form if arriving from a report link (e.g. ?ticket=report_location&loc=42) */
	const urlParams = new URLSearchParams(location.search);
	const preTicket = urlParams.get("ticket");
	if (preTicket) {
		const picker = el("modal-category");
		if ([...picker.options].some((o) => o.value === preTicket)) {
			openTicketInfoModal();
			picker.value = preTicket;
			_ticketPrefillLoc = urlParams.get("loc");
		}
	}
}

async function togglePrivacy() {
	const newVal = !currentUser.profile_private;
	try {
		const r = await fetch("/api/settings", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ profile_private: newVal }),
		});
		if (!r.ok) throw new Error();
		currentUser.profile_private = newVal ? 1 : 0;
		el("preferences-body").innerHTML = preferencesHtml();
	} catch {
		showToast("Failed to update setting.", "error");
	}
}

const CAT_LABELS = {
	ban_appeal: "Ban Appeal",
	submission_appeal: "Submission Appeal",
	bug_report: "Bug Report",
	report_user: "Report User",
	report_location: "Report Location",
	account: "Account Issue",
	other: "Other",
};
/* ---- My tickets: a list dialog, and a conversation view that updates by itself ---- */

let _myTickets = [];
let _ticketsSignature = "";
let _viewingTicketId = null;
let _stopTicketPolling = null;

/** Fetches the player's tickets. Returns true when anything changed since the last fetch. */
async function fetchMyTickets() {
	const tickets = await api("/api/support/mine");
	const signature = JSON.stringify(tickets);
	const changed = signature !== _ticketsSignature;
	_myTickets = tickets;
	_ticketsSignature = signature;
	return changed;
}

/** Opens the ticket list, or goes straight to one conversation when given its id. */
async function openMyTickets(openId = null) {
	openListDialog(
		"tickets",
		"My tickets",
		'<button onclick="closeListDialog(); openTicketInfoModal()" class="m-btn m-btn-tonal m-btn-sm"><span class="material-symbols-outlined">add</span>New</button>'
	);
	try {
		_ticketsSignature = "";
		await fetchMyTickets();
		renderTicketList();
		if (openId) openTicketView(openId);
	} catch (err) {
		el("list-dialog-body").innerHTML = `<div class="text-red-400 text-sm">${escHtml(err.message)}</div>`;
	}
	// While the list or a conversation is on screen, pick up new replies without a reload.
	_stopTicketPolling?.();
	_stopTicketPolling = pollWhile(
		() => _listDialog === "tickets" || _viewingTicketId !== null,
		async () => {
			try {
				if (!(await fetchMyTickets())) return;
				if (_listDialog === "tickets") renderTicketList();
				if (_viewingTicketId !== null) {
					renderTicketView();
					Sounds.play("notify");
				}
			} catch {}
		}
	);
}

function ticketStatusChip(ticket) {
	if (ticket.status === "closed") return '<span class="m-tag">Closed</span>';
	if (ticket.close_requested) return '<span class="m-tag warn">Close requested</span>';
	if (ticket.awaiting_staff || !ticket.replies.some((r) => r.type === "staff"))
		return '<span class="m-tag">Waiting for staff</span>';
	return '<span class="m-tag success">Staff replied</span>';
}

function renderTicketList() {
	if (_listDialog !== "tickets") return;
	const body = el("list-dialog-body");
	if (!_myTickets.length) {
		body.innerHTML = `<div class="text-center py-10">
			<span class="material-symbols-outlined text-4xl text-zinc-700">forum</span>
			<p class="text-zinc-500 text-sm mt-2">You haven't opened any tickets.</p>
		</div>`;
		return;
	}
	body.innerHTML = _myTickets
		.map((ticket) => {
			const last = ticket.replies.at(-1);
			const preview = last ? `${last.type === "staff" ? "Staff" : "You"}: ${last.body}` : ticket.message;
			return `<button onclick="openTicketView(${ticket.id})" class="m-list-item">
				<span class="material-symbols-outlined text-xl text-zinc-500 flex-shrink-0">${ticket.status === "closed" ? "mark_chat_read" : "chat"}</span>
				<div class="flex-1 min-w-0">
					<div class="font-medium text-sm truncate">${escHtml(ticket.subject)}</div>
					<div class="text-xs text-zinc-500 truncate mt-0.5">${escHtml(preview.replace(/\s+/g, " ").slice(0, 90))}</div>
				</div>
				${ticketStatusChip(ticket)}
			</button>`;
		})
		.join("");
}

function openTicketView(ticketId) {
	if (!_myTickets.some((t) => t.id === ticketId)) return showToast("That ticket could not be found.", "error");
	_viewingTicketId = ticketId;
	el("tvm-actions").dataset.state = "";
	show("ticket-view-modal");
	renderTicketView();
	el("tvm-body").scrollTop = el("tvm-body").scrollHeight;
}

/**
 * Draws the open conversation. The messages are redrawn freely, but the reply box
 * is only rebuilt when what the player is allowed to do changes, so a half-typed
 * reply survives new messages arriving.
 */
function renderTicketView() {
	const ticket = _myTickets.find((t) => t.id === _viewingTicketId);
	if (!ticket) return closeTicketView();

	el("tvm-subject").textContent = ticket.subject;
	el("tvm-meta").innerHTML =
		`${ticketStatusChip(ticket)}<span class="text-xs text-zinc-500">${CAT_LABELS[ticket.category] || "Other"} · #${ticket.id}</span>`;
	keepThreadAtBottom(el("tvm-body"), () => (el("tvm-body").innerHTML = ticketThreadHtml(ticket, "user")));

	const open = ticket.status === "open";
	const canReply = open && ticketFollowUps(ticket) < TICKET_MAX_FOLLOW_UPS;
	const state = !open ? "closed" : canReply ? `reply:${ticket.close_requested}` : "wait";
	const actions = el("tvm-actions");
	if (actions.dataset.state === state) return;
	actions.dataset.state = state;

	if (state === "closed") {
		actions.innerHTML =
			'<p class="text-zinc-500 text-sm">This ticket is closed. Open a new one if you need more help.</p>';
	} else if (state === "wait") {
		actions.innerHTML =
			'<p class="text-zinc-400 text-sm">Staff will reply here. You can add more once they have answered.</p>';
	} else {
		actions.innerHTML = `<div class="flex gap-2 items-end">
				<textarea id="tvm-reply-input" rows="2" maxlength="2000" placeholder="Write a message" class="m-field flex-1"></textarea>
				<button onclick="sendUserReply()" id="tvm-send" class="m-icon-btn filled" aria-label="Send" title="Send (Ctrl+Enter)"><span class="material-symbols-outlined">send</span></button>
			</div>
			<div class="flex items-center justify-between gap-3 min-h-[2rem]">
				<p id="tvm-error" class="text-red-300 text-xs"></p>
				${
					ticket.close_requested
						? '<span class="text-xs text-zinc-500 flex-shrink-0">You asked for this to be closed</span>'
						: '<button onclick="requestTicketClose()" class="m-btn m-btn-text m-btn-sm flex-shrink-0">Mark as resolved</button>'
				}
			</div>`;
		el("tvm-reply-input").addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) sendUserReply();
		});
	}
}

function closeTicketView() {
	show("ticket-view-modal", false);
	_viewingTicketId = null;
	// Back to the list it was opened from, if that was closed in the meantime.
	if (_listDialog !== "tickets") openMyTickets();
}

/** Runs a ticket action, then refreshes the conversation straight away. */
async function ticketAction(request, { onDone } = {}) {
	const error = el("tvm-error");
	if (error) error.textContent = "";
	try {
		await request();
		onDone?.();
		await fetchMyTickets();
		renderTicketList();
		renderTicketView();
		el("tvm-body").scrollTop = el("tvm-body").scrollHeight;
	} catch (err) {
		if (el("tvm-error")) el("tvm-error").textContent = err.message;
		else showToast(err.message, "error");
	}
}

function sendUserReply() {
	const input = el("tvm-reply-input");
	const message = input?.value.trim() ?? "";
	if (!message) return;
	const send = el("tvm-send");
	send.disabled = true;
	return ticketAction(() => api(`/api/support/${_viewingTicketId}/reply`, { json: { message } }), {
		onDone: () => (input.value = ""),
	}).finally(() => (send.disabled = false));
}

function requestTicketClose() {
	return ticketAction(() => api(`/api/support/${_viewingTicketId}/request-close`, { method: "POST" }), {
		onDone: () => showToast("Asked staff to close this ticket.", "success"),
	});
}

let _repoUrl = null;
fetch("/api/meta")
	.then((r) => (r.ok ? r.json() : null))
	.then((d) => {
		if (d?.repo) {
			_repoUrl = d.repo;
			const row = el("modal-github-row");
			const link = el("modal-github-link");
			if (row && link) {
				link.href = _repoUrl + "/issues/new";
				link.textContent = "GitHub Issues";
				row.classList.replace("hidden", "flex");
			}
		}
	});

const STRUCTURED_FIELDS = {
	ban_appeal: [
		{ id: "sf_ban_date", label: "Approximately when were you banned?", type: "date", required: true },
		{
			id: "sf_ban_reason",
			label: "What reason were you given (if any)?",
			type: "text",
			placeholder: 'e.g. "Ban evasion" or "No reason given"',
			min: 0,
			max: 200,
		},
		{
			id: "sf_ban_acknowledge",
			label: "Do you understand which rule was broken?",
			type: "select",
			options: ["-- Select --", "Yes", "No", "I disagree with the reason"],
			required: true,
		},
	],
	submission_appeal: [
		{ id: "sf_sub_id", label: "Submission ID (if known)", type: "text", placeholder: "e.g. 42", min: 0, max: 20 },
		{
			id: "sf_sub_location",
			label: "What location or area was the submission for?",
			type: "text",
			placeholder: "e.g. Dovedale Station area",
			min: 2,
			max: 100,
			required: true,
		},
		{
			id: "sf_sub_reason",
			label: "Denial reason shown to you (if any)",
			type: "text",
			placeholder: "Leave blank if none was given",
			min: 0,
			max: 300,
		},
	],
	report_user: [
		{
			id: "sf_report_username",
			label: "Username of the user you are reporting",
			type: "text",
			placeholder: "Exact username",
			min: 3,
			max: 50,
			required: true,
		},
		{ id: "sf_report_when", label: "Approximately when did this occur?", type: "date", required: false },
		{
			id: "sf_report_evidence",
			label: "Any links or evidence? (screenshots, URLs)",
			type: "text",
			placeholder: "Optional but helpful",
			min: 0,
			max: 500,
		},
	],
	report_location: [
		{
			id: "sf_loc_id",
			label: "Location ID (e.g. LOC-0042)",
			type: "text",
			placeholder: "LOC-XXXX",
			min: 0,
			max: 20,
		},
		{
			id: "sf_loc_issue",
			label: "What is the issue with this location?",
			type: "select",
			options: [
				"-- Select --",
				"Incorrect map pin",
				"Image is wrong or offensive",
				"Duplicate of another location",
				"Image quality too low",
				"Other",
			],
			required: true,
		},
		{
			id: "sf_loc_evidence",
			label: "Any additional details or evidence?",
			type: "text",
			placeholder: "Optional",
			min: 0,
			max: 500,
		},
	],
	account: [
		{
			id: "sf_account_type",
			label: "What type of account issue?",
			type: "select",
			options: [
				"-- Select --",
				"Profile or avatar not syncing",
				"Wrong username or display name",
				"My data looks incorrect",
				"I want to transfer my account",
				"Other",
			],
			required: true,
		},
	],
};

function fieldInputClass() {
	return "m-field";
}

function renderStructuredFields(category) {
	const fields = STRUCTURED_FIELDS[category];
	const container = el("ticket-structured-fields");
	if (!fields || !fields.length) {
		container.innerHTML = "";
		return;
	}
	container.innerHTML = fields
		.map((f) => {
			const reqMark = f.required ? '<span class="text-red-400 ml-0.5">*</span>' : "";
			let input = "";
			if (f.type === "select") {
				input = `<select id="${f.id}" class="${fieldInputClass()}"><option value="" disabled selected>${f.options[0]}</option>${f.options
					.slice(1)
					.map((o) => `<option value="${o}">${o}</option>`)
					.join("")}</select>`;
			} else {
				input = `<input id="${f.id}" type="${f.type}" ${f.placeholder ? `placeholder="${f.placeholder}"` : ""} ${f.max ? `maxlength="${f.max}"` : ""} class="${fieldInputClass()}" />`;
			}
			return `<div><label class="m-label" for="${f.id}">${f.label}${reqMark}</label>${input}</div>`;
		})
		.join("");
}

const CATEGORY_SUBJECTS = {
	ban_appeal: "Ban Appeal",
	submission_appeal: "Submission Denied Appeal",
	report_user: "Reporting a User",
	report_location: "Reporting a Location",
	account: "Account Issue",
};

function onCategoryChange() {
	const cat = el("ticket-category").value;
	const isGithub = cat === "bug_report" || cat === "feature_request";
	el("ticket-github-notice").classList.toggle("hidden", !isGithub);
	el("ticket-fields").classList.toggle("hidden", isGithub || !cat);
	el("ticket-form-cancel-row").classList.toggle("hidden", !isGithub);
	if (isGithub && _repoUrl) el("ticket-github-link").href = _repoUrl + "/issues/new";
	if (!isGithub && cat) {
		renderStructuredFields(cat);
		const subjectEl = el("ticket-subject");
		if (subjectEl && !subjectEl.value && CATEGORY_SUBJECTS[cat]) subjectEl.value = CATEGORY_SUBJECTS[cat];
	}
}

/** Location id carried in by a "report this location" link, dropped into the form once it opens. */
let _ticketPrefillLoc = null;

function openTicketInfoModal() {
	el("ticket-info-modal").classList.remove("hidden");
}
function closeTicketInfoModal() {
	el("ticket-info-modal").classList.add("hidden");
	el("modal-category").value = "";
}
function proceedToTicketForm() {
	const modalCat = el("modal-category").value;
	closeTicketInfoModal();
	showTicketForm();
	const catEl = el("ticket-category");
	if (modalCat) {
		catEl.value = modalCat;
		onCategoryChange();
	}
	if (_ticketPrefillLoc) {
		const locField = el("sf_loc_id");
		if (locField) locField.value = "LOC-" + String(parseInt(_ticketPrefillLoc)).padStart(4, "0");
		_ticketPrefillLoc = null;
	}
}
/** The new-ticket form. It lives in its own dialog and is built once, on first use. */
const TICKET_FORM_HTML = `
		<div id="ticket-form" class="flex flex-col gap-3">
			<div>
				<label class="m-label" for="ticket-category">Category</label>
				<select id="ticket-category" onchange="onCategoryChange()"
					class="m-field">
					<option value="" disabled selected>Select a category…</option>
					<option value="ban_appeal">Ban Appeal</option>
					<option value="submission_appeal">Submission Denied Appeal</option>
					<option value="report_user">Report a User</option>
					<option value="report_location">Report a Location</option>
					<option value="account">Account Issue</option>
					<option value="other">Other</option>
					<option value="bug_report">Bug / Technical Issue</option>
					<option value="feature_request">Feature Request</option>
				</select>
			</div>
			<div id="ticket-github-notice" class="hidden bg-zinc-800 rounded-xl p-4 text-sm text-zinc-300">
				<div class="flex items-start gap-2">
					<span class="material-symbols-outlined text-zinc-500 flex-shrink-0 text-lg">bug_report</span>
					<div>
						<div class="font-semibold text-zinc-100 mb-1">Use GitHub Issues instead</div>
						<p class="text-zinc-400 text-xs mb-3">Bugs and feature requests are tracked on GitHub, not in tickets.</p>
						<a id="ticket-github-link" href="#" target="_blank" rel="noopener" class="m-btn m-btn-tonal m-btn-sm">Open GitHub Issues<span class="material-symbols-outlined">open_in_new</span></a>
					</div>
				</div>
			</div>
			<div id="ticket-fields" class="hidden space-y-3">
				<div id="ticket-structured-fields" class="space-y-3 empty:hidden"></div>
				<div>
					<label class="m-label" for="ticket-subject">Subject</label>
					<input id="ticket-subject" type="text" minlength="5" maxlength="100" placeholder="A short summary"
						class="m-field" />
				</div>
				<div>
					<label class="m-label" for="ticket-message">Message</label>
					<textarea id="ticket-message" rows="5" minlength="20" maxlength="2000" placeholder="What happened? Include dates, IDs and links where you can."
						oninput="el('msg-counter').textContent=this.value.length+'/2000'"
						class="m-field"></textarea>
					<div class="flex justify-between mt-1">
						<p class="text-zinc-600 text-xs">Minimum 20 characters. Links are allowed.</p>
						<span id="msg-counter" class="text-zinc-600 text-xs">0/2000</span>
					</div>
				</div>
				<p id="ticket-error" class="text-red-300 text-xs hidden"></p>
				<div class="flex gap-2 justify-end">
					<button onclick="hideTicketForm()" class="m-btn m-btn-text">Cancel</button>
					<button onclick="submitTicket()" class="m-btn m-btn-filled">Send ticket</button>
				</div>
			</div>
			<div id="ticket-form-cancel-row" class="hidden text-right">
				<button onclick="hideTicketForm()" class="m-btn m-btn-text">Close</button>
			</div>
		</div>
`;

function showTicketForm() {
	if (!el("ticket-form")) el("ticket-form-slot").innerHTML = TICKET_FORM_HTML;
	show("ticket-form-dialog");
}
function hideTicketForm() {
	show("ticket-form-dialog", false);
	if (!el("ticket-form")) return;
	el("ticket-github-notice").classList.add("hidden");
	el("ticket-fields").classList.add("hidden");
	el("ticket-form-cancel-row").classList.add("hidden");
	el("ticket-category").value = "";
	el("ticket-structured-fields").innerHTML = "";
	if (el("ticket-subject")) el("ticket-subject").value = "";
	if (el("ticket-message")) el("ticket-message").value = "";
}

function collectStructuredFields(category) {
	const fields = STRUCTURED_FIELDS[category];
	if (!fields) return "";
	const lines = [];
	for (const f of fields) {
		const input = el(f.id);
		if (!input) continue;
		const val = input.value.trim();
		if (f.required && (!val || val.startsWith("--"))) return null; // signals validation fail
		if (val && !val.startsWith("--")) lines.push(`${f.label}\n${val}`);
	}
	return lines.join("\n\n");
}

async function submitTicket() {
	const category = el("ticket-category").value;
	const subject = el("ticket-subject")?.value.trim() ?? "";
	const mainMessage = el("ticket-message")?.value.trim() ?? "";
	const errEl = el("ticket-error");
	errEl.classList.add("hidden");

	if (!category || category === "bug_report" || category === "feature_request") {
		errEl.textContent = "Select a category.";
		errEl.classList.remove("hidden");
		return;
	}
	if (subject.length < 5) {
		errEl.textContent = "Subject must be at least 5 characters.";
		errEl.classList.remove("hidden");
		return;
	}
	if (subject.length > 100) {
		errEl.textContent = "Subject must be 100 characters or fewer.";
		errEl.classList.remove("hidden");
		return;
	}
	if (mainMessage.length < 20) {
		errEl.textContent = "Details must be at least 20 characters.";
		errEl.classList.remove("hidden");
		return;
	}

	const structuredPart = collectStructuredFields(category);
	if (structuredPart === null) {
		errEl.textContent = "Fill in all required fields.";
		errEl.classList.remove("hidden");
		return;
	}

	const message = structuredPart ? structuredPart + "\n\n---\n\n" + mainMessage : mainMessage;

	try {
		const r = await fetch("/api/support", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ subject, message, category }),
		});
		if (!r.ok) throw new Error(await r.text());
		hideTicketForm();
		await openMyTickets();
	} catch (err) {
		errEl.textContent = err.message || "Failed to submit ticket.";
		errEl.classList.remove("hidden");
	}
}

async function exportData() {
	try {
		const r = await fetch("/api/gdpr/export");
		if (!r.ok) throw new Error(await r.text());
		const data = await r.json();
		const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `dovedale-data-${new Date().toISOString().slice(0, 10)}.json`;
		a.click();
		URL.revokeObjectURL(url);
		showToast("Data exported.", "success");
	} catch (err) {
		showToast(err.message || "Failed to export data.", "error");
	}
}

async function deleteAccount() {
	const confirmEl = el("delete-confirm-row");
	if (!confirmEl) return;
	confirmEl.classList.remove("hidden");
	confirmEl.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function confirmDeleteAccount() {
	const input = el("delete-confirm-input");
	if (!input || input.value.trim().toUpperCase() !== "DELETE") {
		showToast("Type DELETE to confirm.", "error");
		return;
	}
	try {
		const r = await fetch("/api/account", {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ confirm: true }),
		});
		if (!r.ok) throw new Error(await r.text());
		window.location.href = "/";
	} catch (err) {
		showToast(err.message || "Failed to delete account.", "error");
	}
}

init();
