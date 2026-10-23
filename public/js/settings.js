import "./lib/site.js";
import { Sounds } from "./sounds.js";
import { el, escHtml, scrollBehavior, show, skeletonRows } from "./lib/dom.js";
import { api, fetchUser } from "./lib/api.js";
import { showToast } from "./lib/toast.js";
import { disablePush, enablePush } from "./lib/push.js";
import { refreshAttention } from "./lib/attention.js";
import { linkRuleCodes } from "./rules.js";
import { keepThreadAtBottom, pollWhile, ticketFollowUps, ticketThreadHtml } from "./tickets.js";

let currentUser = null;

async function init() {
	currentUser = await fetchUser();
	if (!currentUser) {
		el("main").innerHTML = `<div class="text-center py-16">
		<p class="text-zinc-400 mb-4">You need to be logged in to access settings.</p>
		<a href="/api/auth/login?redirect=/settings" class="m-btn m-btn-lg m-btn-filled">Log in with Discord</a>
		<p class="text-zinc-600 text-xs mt-4">By logging in you agree to our <a href="/tos" class="underline hover:text-zinc-400">Terms of Service</a> and <a href="/privacy" class="underline hover:text-zinc-400">Privacy Policy</a>.</p>
	</div>`;
		return;
	}

	renderSettings();
	loadModerationHistory();
}

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

function resendUrl(sub) {
	const params = new URLSearchParams({ label: sub.label || "", x: sub.world_x, y: sub.world_y });
	try {
		for (const hint of JSON.parse(sub.hints || "[]")) params.append("hint", hint);
	} catch {}
	return `/submit?${params}`;
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
				<a href="/submit" class="m-btn m-btn-filled m-btn-sm mt-4">Submit a location</a>
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
					<img src="/uploads/${escHtml(sub.image_path)}" alt="" loading="lazy" decoding="async" data-on-error="this.style.setProperty('visibility', 'hidden')" class="w-16 h-10 rounded-lg object-cover flex-shrink-0 bg-zinc-800" />
					<div class="flex-1 min-w-0">
						<div class="text-sm font-medium truncate">${escHtml(sub.label || "No label")}</div>
						<div class="text-xs text-zinc-500">SUB-${String(sub.id).padStart(4, "0")} · ${new Date(sub.created_at * 1000).toLocaleDateString()}</div>
						${sub.status === "denied" && sub.deny_reason ? `<div class="text-xs text-red-300 mt-0.5 break-words">${linkRuleCodes(escHtml(sub.deny_reason))}</div>` : ""}
						${sub.status === "denied" ? `<a href="${escHtml(resendUrl(sub))}" class="text-xs text-blue-400 hover:underline">Fix and send again</a>` : ""}
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
			limit_chat: ["comments_disabled", "text-orange-400"],
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

function sectionMenu() {
	return `<nav class="flex gap-1.5 flex-wrap mb-4" aria-label="Settings sections">
		${SECTIONS.map(
			([id, title]) =>
				`<a href="#${id}" class="px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap bg-zinc-900 text-zinc-400 hover:text-white hover:bg-zinc-800 transition">${title}</a>`
		).join("")}
	</nav>`;
}

function toggleHtml(on, onclick, label) {
	return `<button role="switch" aria-checked="${on}" aria-label="${escHtml(label)}" data-on-click="${onclick}"
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

const NOTIFY_OPTIONS = [
	["submissions", "Submissions", "When yours is approved or denied"],
	["suggestions", "Suggestions", "When yours is accepted or declined"],
	["tickets", "Tickets", "When staff reply or close one"],
	["reminders", "Streak reminders", "When your streak is about to end"],
	["achievements", "Achievements", "When you unlock one"],
];

const NOTIFY_PRESETS = {
	all: ["Everything", NOTIFY_OPTIONS.map(([key]) => key)],
	essential: ["Just replies", ["submissions", "suggestions", "tickets"]],
	none: ["None", []],
};

async function setNotifyPreset(preset) {
	const on = NOTIFY_PRESETS[preset][1];
	try {
		const { prefs } = await api("/api/settings", {
			json: { prefs: { notify: Object.fromEntries(NOTIFY_OPTIONS.map(([key]) => [key, on.includes(key)])) } },
		});
		currentUser.prefs = prefs;
		el("preferences-body").innerHTML = preferencesHtml();
	} catch (err) {
		showToast(err.message, "error");
	}
}

const EMAIL_FREQUENCIES = {
	off: "Off",
	hourly: "Every hour",
	daily: "Once a day",
	weekly: "Once a week",
	monthly: "Once a month",
};

function emailSettingHtml() {
	const email = currentUser.email;
	const remove =
		'<button data-on-click="removeEmail()" class="m-btn m-btn-text m-btn-sm danger flex-shrink-0">Remove email</button>';
	if (!email?.available)
		return email?.address
			? settingRow(
					"Email summary",
					`Not being sent at the moment. ${escHtml(email.address)} is still saved`,
					remove
				)
			: "";
	if (!email.address)
		return settingRow(
			"Email summary",
			"One email with your unread notifications",
			`<span class="flex gap-2 flex-shrink-0">
				<input id="email-input" type="email" autocomplete="email" maxlength="254" placeholder="you@example.com" class="m-field" style="width: 11rem" aria-label="Email address"
					data-on-keydown="saveEmailOnEnter(event)" />
				<button data-on-click="saveEmail()" class="m-btn m-btn-tonal m-btn-sm">Confirm</button>
			</span>`
		);
	if (!email.verified)
		return settingRow("Email summary", `Open the link we sent to ${escHtml(email.address)}`, remove);
	return settingRow(
		"Email summary",
		`One email with your unread notifications, to ${escHtml(email.address)}`,
		`<span class="flex items-center gap-1 flex-shrink-0 flex-wrap justify-end">
		<select data-on-change="setEmailFrequency(this.value)" class="m-field flex-shrink-0" style="width: auto" aria-label="How often">
			${Object.entries(EMAIL_FREQUENCIES)
				.map(
					([key, label]) =>
						`<option value="${key}" ${email.frequency === key ? "selected" : ""}>${label}</option>`
				)
				.join("")}
		</select>
		${remove}</span>`
	);
}

async function changeEmail(request, done) {
	try {
		await request();
		currentUser.email = (await api("/api/auth/me")).email;
		el("preferences-body").innerHTML = preferencesHtml();
		if (done) showToast(done, "success");
	} catch (err) {
		showToast(err.message, "error");
	}
}

const saveEmailOnEnter = (e) => e.key === "Enter" && saveEmail();
const countMessage = (input) => (el("msg-counter").textContent = `${input.value.length}/2000`);

const saveEmail = () =>
	changeEmail(
		() => api("/api/settings/email", { json: { email: el("email-input").value } }),
		"Confirmation email sent."
	);
/** Deletes the address. Adding it again undoes this. */
const removeEmail = () =>
	changeEmail(() => api("/api/settings/email", { method: "DELETE" }), "Email removed and deleted.");
const setEmailFrequency = (frequency) =>
	changeEmail(() => api("/api/settings/email/frequency", { json: { frequency } }));

function preferencesHtml() {
	const prefs = currentUser.prefs;
	const desktopBlocked = "Notification" in window && Notification.permission === "denied";
	return `
		<div class="text-xs text-zinc-500 uppercase tracking-wider font-medium mb-1">General</div>
		${settingRow("Sound effects", "For pins, results, countdowns and notifications", toggleHtml(prefs.sounds, "setPref('sounds', " + !prefs.sounds + ")", "Sound effects"))}
		${settingRow("Private profile", "Only you and staff can view your profile page. Your name still appears on leaderboards", toggleHtml(!!currentUser.profile_private, "togglePrivacy()", "Private profile"))}

		<div class="flex items-center gap-1.5 flex-wrap mt-5 mb-1">
			<span class="text-xs text-zinc-500 uppercase tracking-wider font-medium mr-auto">Notify me about</span>
			${Object.entries(NOTIFY_PRESETS)
				.map(
					([key, [label, on]]) =>
						`<button data-on-click="setNotifyPreset('${key}')" class="m-chip" aria-pressed="${NOTIFY_OPTIONS.every(([option]) => !!prefs.notify[option] === on.includes(option))}">${label}</button>`
				)
				.join("")}
		</div>
		${NOTIFY_OPTIONS.map(([key, title, description]) =>
			settingRow(
				title,
				description,
				toggleHtml(prefs.notify[key], `setPref('notify.${key}', ${!prefs.notify[key]})`, title)
			)
		).join("")}
		${settingRow("Moderation and announcements", "Warnings, limits and bans on your account, and site news", '<span class="text-xs text-zinc-500 flex-shrink-0">Always on</span>')}

		<div class="text-xs text-zinc-500 uppercase tracking-wider font-medium mt-5 mb-1">How</div>
		${settingRow("In-site toasts", "A pop-up in the corner of the page", toggleHtml(prefs.toasts, "setPref('toasts', " + !prefs.toasts + ")", "In-site toasts"))}
		${settingRow(
			"Desktop notifications",
			desktopBlocked
				? "Blocked. Allow notifications for this site in your browser settings"
				: "From your browser, even when the site is closed",
			"Notification" in window
				? toggleHtml(
						prefs.desktop && !desktopBlocked,
						"setDesktopNotifications(" + !prefs.desktop + ")",
						"Desktop notifications"
					)
				: '<span class="text-xs text-zinc-500 flex-shrink-0">Not supported</span>'
		)}
		${emailSettingHtml()}
		${
			currentUser.role
				? `<div class="text-xs text-zinc-500 uppercase tracking-wider font-medium mt-5 mb-1">Staff</div>` +
					settingRow(
						"Review queue badges",
						"Counts on the staff panel button and sidebar",
						toggleHtml(
							prefs.staff_badges,
							"setPref('staff_badges', " + !prefs.staff_badges + ")",
							"Review queue badges"
						)
					) +
					settingRow(
						"Review queue alerts",
						"A pop-up for new items, never mid-round",
						toggleHtml(
							prefs.staff_alerts,
							"setPref('staff_alerts', " + !prefs.staff_alerts + ")",
							"Review queue alerts"
						)
					)
				: ""
		}`;
}

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

const NOTIFICATION_ICONS = {
	submissions: ["add_photo_alternate", "text-blue-400"],
	suggestions: ["lightbulb", "text-yellow-400"],
	tickets: ["support_agent", "text-teal-400"],
	moderation: ["gavel", "text-red-400"],
	reminders: ["local_fire_department", "text-orange-400"],
	achievements: ["emoji_events", "text-yellow-400"],
	announcements: ["campaign", "text-purple-400"],
	staff_chat: ["forum", "text-blue-400"],
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
		const { notifications, unread, total } = await api("/api/notifications");
		show("notifications-clear", notifications.length > 0);
		resetClearButton();
		el("notifications-note").textContent =
			total > notifications.length ? `Showing the newest ${notifications.length} of ${total}. ` : "";
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
		if (unread > 0) refreshAttention(await api("/api/notifications/read", { method: "POST" }));
	} catch (err) {
		area.innerHTML = `<div class="text-red-400 text-sm">${escHtml(err.message)}</div>`;
	}
}

let _clearArmed = null;

function resetClearButton() {
	clearTimeout(_clearArmed);
	_clearArmed = null;
	el("notifications-clear").textContent = "Clear all";
}

/** Deletes every notification. The first press only asks; the second does it. */
async function clearNotifications() {
	if (!_clearArmed) {
		el("notifications-clear").textContent = "Delete them all? Press again";
		_clearArmed = setTimeout(resetClearButton, 4000);
		return;
	}
	resetClearButton();
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
		<div class="flex items-center justify-between gap-3 mt-3">
			<p class="text-xs text-zinc-600"><span id="notifications-note"></span>Kept for 90 days.</p>
			<button id="notifications-clear" data-on-click="clearNotifications()" class="hidden flex-shrink-0 text-xs text-zinc-500 hover:text-zinc-300 transition">Clear all</button>
		</div>
	`
	)}

	${section("preferences", `<div id="preferences-body">${preferencesHtml()}</div>`)}

	${section(
		"support",
		`
		<p class="text-zinc-400 text-sm mb-4">Appeal a ban, report a problem or ask staff for help.</p>
		<div class="flex gap-2 flex-wrap">
			<button data-on-click="openTicketInfoModal()" class="m-btn m-btn-filled"><span class="material-symbols-outlined">add</span>New ticket</button>
			<button data-on-click="openMyTickets()" class="m-btn m-btn-tonal"><span class="material-symbols-outlined">forum</span>My tickets</button>
		</div>
	`
	)}

	${section(
		"submissions",
		`
		<p class="text-zinc-400 text-sm mb-4">Your submitted locations. Denied ones are removed after 30 days.</p>
		<button data-on-click="openMySubmissions()" class="m-btn m-btn-tonal"><span class="material-symbols-outlined">photo_library</span>My submissions</button>
	`
	)}

	${section(
		"moderation",
		`
		<p class="text-zinc-400 text-sm mb-4">Warnings, limits and bans, with the reason for each.</p>
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
			<button data-on-click="exportData()" class="m-btn m-btn-tonal m-btn-sm flex-shrink-0">
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
			<button data-on-click="deleteAccount()" class="m-btn m-btn-danger m-btn-sm flex-shrink-0">
				Delete
			</button>
		</div>
		<div id="delete-confirm-row" class="hidden mt-3 bg-red-950/50 border border-red-700/40 rounded-xl p-4 space-y-3">
			<p class="text-red-200 text-sm font-medium">This cannot be undone. Type <code class="bg-red-900/60 px-1 rounded text-red-300">DELETE</code> to confirm.</p>
			<div class="flex gap-2">
				<input id="delete-confirm-input" type="text" placeholder="Type DELETE" maxlength="10"
					class="flex-1 bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 placeholder:text-zinc-600" />
				<button data-on-click="confirmDeleteAccount()" class="m-btn m-btn-danger m-btn-sm">Confirm</button>
				<button data-on-click="el('delete-confirm-row').classList.add('hidden')" class="m-btn m-btn-tonal m-btn-sm">Cancel</button>
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
	const linkedTicket = Number(new URLSearchParams(location.search).get("open_ticket"));
	if (linkedTicket) openMyTickets(linkedTicket);
	loadNotifications();
	if (location.hash) requestAnimationFrame(() => document.getElementById(location.hash.slice(1))?.scrollIntoView());

	const urlParams = new URLSearchParams(location.search);
	const preTicket = urlParams.get("ticket");
	if (preTicket) {
		const picker = el("modal-category");
		if ([...picker.options].some((o) => o.value === preTicket)) {
			openTicketInfoModal();
			picker.value = preTicket;
			onModalCategoryChange();
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

async function openMyTickets(openId = null) {
	openListDialog(
		"tickets",
		"My tickets",
		'<button data-on-click="closeListDialog(); openTicketInfoModal()" class="m-btn m-btn-tonal m-btn-sm"><span class="material-symbols-outlined">add</span>New</button>'
	);
	try {
		_ticketsSignature = "";
		await fetchMyTickets();
		renderTicketList();
		if (openId) openTicketView(openId);
	} catch (err) {
		el("list-dialog-body").innerHTML = `<div class="text-red-400 text-sm">${escHtml(err.message)}</div>`;
	}
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
		},
		5000,
		"ticket"
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
			return `<button data-on-click="openTicketView(${ticket.id})" class="m-list-item">
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

/** Draws the open conversation. The reply box is rebuilt only when options change, so a half-typed reply survives. */
function renderTicketView() {
	const ticket = _myTickets.find((t) => t.id === _viewingTicketId);
	if (!ticket) return closeTicketView();

	el("tvm-subject").textContent = ticket.subject;
	el("tvm-meta").innerHTML =
		`${ticketStatusChip(ticket)}<span class="text-xs text-zinc-500">${CAT_LABELS[ticket.category] || "Other"} · #${ticket.id}</span>`;
	keepThreadAtBottom(el("tvm-body"), () => (el("tvm-body").innerHTML = ticketThreadHtml(ticket, "user")));

	const open = ticket.status === "open";
	const canReply = open && ticketFollowUps(ticket) < currentUser.limits.ticket_follow_ups;
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
				<button data-on-click="sendUserReply()" id="tvm-send" class="m-icon-btn filled" aria-label="Send" title="Send (Ctrl+Enter)"><span class="material-symbols-outlined">send</span></button>
			</div>
			<div class="flex items-center justify-between gap-3 min-h-[2rem]">
				<p id="tvm-error" class="text-red-300 text-xs"></p>
				${
					ticket.close_requested
						? '<span class="text-xs text-zinc-500 flex-shrink-0">You asked for this to be closed</span>'
						: '<button data-on-click="requestTicketClose()" class="m-btn m-btn-text m-btn-sm flex-shrink-0">Mark as resolved</button>'
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
	if (_listDialog !== "tickets") openMyTickets();
}

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
				el("modal-github-button").href = _repoUrl + "/issues/new";
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

/** Draws the extra questions for a category. Answers are kept when the same category is drawn again. */
function renderStructuredFields(category) {
	const fields = STRUCTURED_FIELDS[category] || [];
	const container = el("ticket-structured-fields");
	if (container.dataset.category === category) return;
	container.dataset.category = category;
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

/** Tracked on GitHub instead; the form is never opened for these. */
const GITHUB_CATEGORIES = ["bug_report", "feature_request"];
let _ticketCategory = "";
let _ticketCategoryName = "";
/** The subject the form filled in: a category change may replace it, never a typed one. */
let _autoSubject = "";
let _changingCategory = false;
let _ticketPrefillLoc = null;

function onModalCategoryChange() {
	const category = el("modal-category").value;
	const github = GITHUB_CATEGORIES.includes(category);
	show("modal-github-notice", github);
	el("modal-continue").disabled = !category || github;
}

function openTicketInfoModal() {
	onModalCategoryChange();
	el("ticket-info-modal").classList.remove("hidden");
}

/** Cancels step one. From the "Change" button it goes back to the draft untouched. */
function closeTicketInfoModal() {
	el("ticket-info-modal").classList.add("hidden");
	el("modal-category").value = "";
	if (!_changingCategory) return;
	_changingCategory = false;
	show("ticket-form-dialog");
}

function proceedToTicketForm() {
	const picker = el("modal-category");
	const category = picker.value;
	if (!category || GITHUB_CATEGORIES.includes(category)) return;
	_ticketCategory = category;
	_ticketCategoryName = picker.selectedOptions[0].textContent;
	_changingCategory = false;
	el("ticket-info-modal").classList.add("hidden");
	picker.value = "";

	if (!el("ticket-form")) el("ticket-form-slot").innerHTML = TICKET_FORM_HTML;
	el("ticket-category-name").textContent = _ticketCategoryName;
	renderStructuredFields(category);
	const subject = el("ticket-subject");
	if (!subject.value || subject.value === _autoSubject) {
		_autoSubject = CATEGORY_SUBJECTS[category] || "";
		subject.value = _autoSubject;
	}
	el("ticket-error").classList.add("hidden");
	if (_ticketPrefillLoc && el("sf_loc_id"))
		el("sf_loc_id").value = "LOC-" + String(parseInt(_ticketPrefillLoc)).padStart(4, "0");
	_ticketPrefillLoc = null;
	show("ticket-form-dialog");
}

function changeTicketCategory() {
	_changingCategory = true;
	show("ticket-form-dialog", false);
	el("modal-category").value = _ticketCategory;
	openTicketInfoModal();
}

const TICKET_FORM_HTML = `
		<div id="ticket-form" class="flex flex-col gap-3">
			<div class="flex items-center gap-2 bg-zinc-800 rounded-xl pl-4 pr-2 py-2">
				<span class="material-symbols-outlined text-lg text-zinc-500">label</span>
				<span id="ticket-category-name" class="flex-1 min-w-0 truncate text-sm font-semibold"></span>
				<button data-on-click="changeTicketCategory()" class="m-btn m-btn-text m-btn-sm">Change</button>
			</div>
			<div id="ticket-structured-fields" class="space-y-3 empty:hidden"></div>
			<div>
				<label class="m-label" for="ticket-subject">Subject</label>
				<input id="ticket-subject" type="text" minlength="5" maxlength="100" placeholder="A short summary"
					class="m-field" />
			</div>
			<div>
				<label class="m-label" for="ticket-message">Message</label>
				<textarea id="ticket-message" rows="5" minlength="20" maxlength="2000" placeholder="What happened? Include dates, IDs and links where you can."
					data-on-input="countMessage(this)"
					class="m-field"></textarea>
				<div class="flex justify-between mt-1">
					<p class="text-zinc-600 text-xs">Minimum 20 characters. Links are allowed.</p>
					<span id="msg-counter" class="text-zinc-600 text-xs">0/2000</span>
				</div>
			</div>
			<p id="ticket-error" class="text-red-300 text-xs hidden" role="alert"></p>
			<div class="flex gap-2 justify-end">
				<button data-on-click="hideTicketForm()" class="m-btn m-btn-text">Cancel</button>
				<button id="ticket-send" data-on-click="submitTicket()" class="m-btn m-btn-filled">Send ticket</button>
			</div>
		</div>
`;

function hideTicketForm() {
	show("ticket-form-dialog", false);
	_ticketCategory = _ticketCategoryName = _autoSubject = "";
	if (!el("ticket-form")) return;
	const fields = el("ticket-structured-fields");
	fields.innerHTML = "";
	delete fields.dataset.category;
	el("ticket-subject").value = "";
	el("ticket-message").value = "";
	el("msg-counter").textContent = "0/2000";
	el("ticket-error").classList.add("hidden");
}

function collectStructuredFields(category) {
	const fields = STRUCTURED_FIELDS[category];
	if (!fields) return "";
	const lines = [];
	for (const f of fields) {
		const input = el(f.id);
		if (!input) continue;
		const val = input.value.trim();
		if (f.required && !val) return null;
		if (val) lines.push(`${f.label}\n${val}`);
	}
	return lines.join("\n\n");
}

async function submitTicket() {
	const category = _ticketCategory;
	const subject = el("ticket-subject").value.trim();
	const mainMessage = el("ticket-message").value.trim();
	const errEl = el("ticket-error");
	const refuse = (why) => {
		errEl.textContent = why;
		errEl.classList.remove("hidden");
	};
	errEl.classList.add("hidden");

	if (!category) return refuse("Choose a category first.");
	if (subject.length < 5) return refuse("Subject must be at least 5 characters.");
	if (subject.length > 100) return refuse("Subject must be 100 characters or fewer.");
	if (mainMessage.length < 20) return refuse("The message must be at least 20 characters.");
	const structuredPart = collectStructuredFields(category);
	if (structuredPart === null) return refuse("Fill in all the fields marked with *.");

	const message = structuredPart ? structuredPart + "\n\n---\n\n" + mainMessage : mainMessage;
	const send = el("ticket-send");
	send.disabled = true;
	try {
		await api("/api/support", { json: { subject, message, category } });
		hideTicketForm();
		await openMyTickets();
	} catch (err) {
		refuse(err.message || "Couldn't send the ticket. Try again.");
	} finally {
		send.disabled = false;
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
	confirmEl.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
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

Object.assign(window, {
	changeTicketCategory,
	clearNotifications,
	closeListDialog,
	closeTicketInfoModal,
	closeTicketView,
	confirmDeleteAccount,
	deleteAccount,
	exportData,
	hideTicketForm,
	onModalCategoryChange,
	openMySubmissions,
	openMyTickets,
	openTicketInfoModal,
	openTicketView,
	proceedToTicketForm,
	removeEmail,
	requestTicketClose,
	saveEmail,
	saveEmailOnEnter,
	countMessage,
	sendUserReply,
	setDesktopNotifications,
	setEmailFrequency,
	setNotifyPreset,
	setPref,
	submitTicket,
	togglePrivacy,
});
