import { avatarHtml, avatarSrc, el, errorStateHtml, escHtml, show, skeletonRows } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { showToast } from "../lib/toast.js";
import { refreshAttention } from "../lib/attention.js";
import { bindRuleChips, linkRuleCodes, ruleChipsHtml } from "../rules.js";
import {
	ROLE_RANK_JS,
	atLeast,
	bindPanelSearch,
	currentTab,
	currentUser,
	panelSearchInput,
	showConfirm,
	showPrompt,
} from "./core.js";

export const ROLE_BADGE = {
	operator: "bg-yellow-900/70 text-yellow-300",
	admin: "bg-orange-900/70 text-orange-300",
	supervisor: "bg-purple-900/70 text-purple-300",
	moderator: "bg-blue-900/70 text-blue-300",
	curator: "bg-green-900/70 text-green-300",
	helper: "bg-teal-900/70 text-teal-300",
};
/** Roles someone may hand out, highest first: every role below their own, from supervisor up. */
const assignableRoles = (role) =>
	(ROLE_RANK_JS[role] ?? 0) >= ROLE_RANK_JS.supervisor
		? ["admin", "supervisor", "moderator", "curator", "helper"].filter((r) => ROLE_RANK_JS[r] < ROLE_RANK_JS[role])
		: [];
export const ROLE_NAMES = {
	operator: "Operator",
	admin: "Administrator",
	supervisor: "Supervisor",
	moderator: "Moderator",
	curator: "Curator",
	helper: "Helper",
};
export const roleName = (role) => ROLE_NAMES[role] ?? escHtml(String(role ?? ""));
const ROLE_INFO = {
	helper: {
		summary: "A player trusted with the review queues. Not counted as staff.",
		can: [
			"Approve or deny location submissions",
			"Approve or deny suggested changes to locations (an approved one is applied)",
			"See their own past reviews",
			"Suggest changes to locations without the account age and games a player needs first",
		],
		note: "Helpers still play the game, so they cannot browse the location list here, have no staff chat, and are limited like any player. Suggest Change does show them where every location is.",
	},
	curator: {
		summary: "The first staff role. Everything a helper can do, and:",
		can: [
			"Browse every location and how it has played",
			"Edit locations: labels, hints, switching them on or off, resetting difficulty",
			"See everything that has been reviewed, and by whom",
			"Get in during maintenance, and receive staff announcements",
			"Talk to other staff in the staff chat, and keep up to {pins} of their own messages pinned there",
		],
		note: "Curators do not deal with players: no tickets, warnings or bans.",
	},
	moderator: {
		summary: "Keeps the community in order. Everything a curator can do, and:",
		can: [
			"Warn players, limit uploads or duels, and ban for a set time",
			"Answer and close support tickets",
			"Review ban-evasion and fair-play flags",
			"Leave notes on a player for other staff",
			"See duel history and stats",
			"Run tournaments: players, check-in, breaks, matches, messages, chat and results",
			"Edit the chat filter's blocked and allowed words",
			"Suspend a helper's or curator's access",
			"Pin staff chat messages from a lower role as well as their own, up to {pins}",
		],
	},
	supervisor: {
		summary: "Oversees the moderators. Everything a moderator can do, and:",
		can: [
			"Ban permanently, and overturn limits, warnings and timed bans",
			"Appoint, change or remove helpers, curators and moderators",
			"Suspend a moderator's staff access",
			"Remove another member of staff's note",
			"See site stats and the audit log",
			"Create, open, start, cancel and delete tournaments",
			"Add and remove chat word lists from the web",
			"Delete a lower role's staff chat message or take off its pin, and keep up to {pins} pinned",
		],
	},
	admin: {
		summary: "Runs the community day to day. Everything a supervisor can do, and:",
		can: [
			"Appoint supervisors, and overturn permanent bans",
			"Correct or reset scores, ratings, streaks and achievements",
			"Send, correct and take back announcements, with a link to a page here or to another site",
			"Delete locations and tickets",
			"See every open duel, private rooms included, and watch or close one",
			"Keep up to {pins} staff chat messages pinned",
		],
		note: "Administrators have no access to the server itself or to exporting and deleting player data.",
	},
	operator: {
		summary: "Runs the site. Everything an administrator can do, and:",
		can: [
			"Appoint administrators",
			"Export or delete a player's data, and erase moderation records",
			"Maintenance mode, feature switches, updates, restarts, backups and the server log",
			"Clear all tournament history",
			"Keep up to {pins} staff chat messages pinned",
		],
		note: "Operators are set in the server's configuration, not from this page.",
	},
};
const REASON_MIN = 5;

/** What each moderation action looks like and asks for. Durations are in hours. */
const MOD_ACTIONS = {
	warn: {
		title: "Issue a warning",
		button: "Issue warning",
		tone: "bg-yellow-700 hover:bg-yellow-600",
		endpoint: "warn",
	},
	limit_upload: {
		title: "Limit uploads",
		button: "Limit uploads",
		tone: "bg-orange-700 hover:bg-orange-600",
		endpoint: "limit",
		body: { type: "upload" },
		durations: [6, 24, 48, 96],
		note: "Stops the user submitting locations. Up to 96 hours.",
	},
	limit_duel: {
		title: "Limit duels",
		button: "Limit duels",
		tone: "bg-orange-700 hover:bg-orange-600",
		endpoint: "limit",
		body: { type: "duel" },
		durations: [6, 24, 48, 96],
		note: "Stops the user creating or joining duels. Up to 96 hours.",
	},
	limit_chat: {
		title: "Limit chat",
		button: "Limit chat",
		tone: "bg-orange-700 hover:bg-orange-600",
		endpoint: "limit",
		body: { type: "chat" },
		durations: [1, 6, 24, 96],
		note: "Stops the user reading or writing tournament chat. Up to 96 hours.",
	},
	ban_temp: {
		title: "Temporary ban",
		button: "Ban user",
		tone: "bg-red-700 hover:bg-red-600",
		endpoint: "ban",
		body: { type: "temp" },
		durations: [24, 72, 168, 720],
		note: "Blocks the whole site until it expires. Up to one year.",
	},
	ban_perm: {
		title: "Permanent ban",
		button: "Ban permanently",
		tone: "bg-red-700 hover:bg-red-600",
		endpoint: "ban",
		body: { type: "perm" },
		note: "Blocks the whole site for good. Only an operator can lift it.",
	},
};

const MOD_TYPE_STYLE = {
	warning: ["warning", "text-yellow-400"],
	limit_upload: ["upload_off", "text-orange-400"],
	limit_duel: ["swords", "text-orange-400"],
	limit_chat: ["comments_disabled", "text-orange-400"],
	ban_temp: ["timer", "text-red-400"],
	ban_perm: ["block", "text-red-400"],
};

const MOD_STATUS_BADGE = {
	active: "bg-red-900/60 text-red-300",
	expired: "bg-zinc-800 text-zinc-400",
	overturned: "bg-green-900/50 text-green-300",
};

function formatHours(hours) {
	if (hours % 24 === 0) return `${hours / 24} day${hours === 24 ? "" : "s"}`;
	return `${hours} hour${hours === 1 ? "" : "s"}`;
}

export function formatWhen(seconds) {
	return new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Asks for a reason, and a duration if the action has one. Resolves to { reason, hours } or null. */
export function askReason({
	title,
	note = "",
	button = "Confirm",
	tone = "m-btn-filled",
	durations = null,
	rules = "",
}) {
	return new Promise((resolve) => {
		const reason = el("reason-text");
		const hours = el("reason-hours");
		const ok = el("reason-ok");
		el("reason-title").textContent = title;
		el("reason-note").textContent = note;
		show("reason-note", !!note);
		show("reason-duration", !!durations);
		reason.value = "";
		show("reason-rules-wrap", !!rules);
		el("reason-rules").innerHTML = rules ? ruleChipsHtml(rules) : "";
		if (rules) bindRuleChips(el("reason-rules"), reason);
		hours.value = durations ? durations[1] : "";
		el("reason-presets").innerHTML = (durations || [])
			.map(
				(h) =>
					`<button type="button" data-hours="${h}" class="m-btn m-btn-tonal m-btn-sm">${formatHours(h)}</button>`
			)
			.join("");
		ok.textContent = button;
		ok.className = `m-btn ${tone}`;

		const validate = () => {
			const left = REASON_MIN - reason.value.trim().length;
			const badHours = durations && !(parseFloat(hours.value) > 0);
			ok.disabled = left > 0 || badHours;
			el("reason-count").textContent = left > 0 ? `${left} more character${left === 1 ? "" : "s"} needed` : "";
		};
		const done = (value) => {
			show("reason-modal", false);
			ok.removeEventListener("click", onOk);
			el("reason-cancel").removeEventListener("click", onCancel);
			el("reason-presets").removeEventListener("click", onPreset);
			reason.removeEventListener("input", validate);
			hours.removeEventListener("input", validate);
			document.removeEventListener("keydown", onKey);
			resolve(value);
		};
		const onOk = () => done({ reason: reason.value.trim(), hours: durations ? parseFloat(hours.value) : null });
		const onCancel = () => done(null);
		const onPreset = (e) => {
			const preset = e.target.closest("[data-hours]");
			if (!preset) return;
			hours.value = preset.dataset.hours;
			validate();
		};
		const onKey = (e) => {
			if (e.key === "Escape") done(null);
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !ok.disabled) onOk();
		};
		ok.addEventListener("click", onOk);
		el("reason-cancel").addEventListener("click", onCancel);
		el("reason-presets").addEventListener("click", onPreset);
		reason.addEventListener("input", validate);
		hours.addEventListener("input", validate);
		document.addEventListener("keydown", onKey);
		validate();
		show("reason-modal");
		setTimeout(() => reason.focus(), 50);
	});
}

let _users = [];

let _evasionFlags = [];

function renderEvasionFlags() {
	if (!_evasionFlags.length) return "";
	const rows = _evasionFlags
		.map((f) => {
			const signal = SIGNAL_INFO[f.signal] || SIGNAL_INFO.browser;
			const madeAfterBan = f.banned_at && f.user_created_at > f.banned_at;
			return `<div class="flex items-start gap-3 py-3 flex-wrap sm:flex-nowrap">
				${avatarHtml(f.avatar_url, "w-9 h-9 flex-shrink-0")}
				<div class="flex-1 min-w-0 text-sm">
					<div>
						<button onclick="openUserPanel(${f.user_id})" class="font-semibold hover:underline">@${escHtml(f.username)}</button>
						<span class="text-zinc-400">may be</span>
						<button onclick="openUserPanel(${f.banned_id})" class="font-semibold text-red-300 hover:underline">@${escHtml(f.banned_username)}</button>
						<span class="text-zinc-500">(${f.ban_type === "perm" ? "permanently banned" : `banned until ${formatWhen(f.ban_expires_at)}`})</span>
					</div>
					<div class="flex items-center gap-1.5 flex-wrap mt-1.5">
						<span class="m-tag ${signal.tone}" title="${escHtml(signal.help)}">${signal.label}</span>
						${madeAfterBan ? '<span class="m-tag warn" title="This account was created after the ban was issued">Created after the ban</span>' : ""}
						<span class="text-xs text-zinc-500">Account made ${formatWhen(f.user_created_at)}</span>
					</div>
					${f.ban_reason ? `<div class="text-xs text-zinc-500 mt-1.5 truncate">Ban reason: ${escHtml(f.ban_reason)}</div>` : ""}
				</div>
				<div class="flex gap-2 flex-shrink-0 ml-auto">
					<button onclick="dismissEvasionFlag(${f.id})" class="m-btn m-btn-text m-btn-sm">Not evading</button>
					<button onclick="openUserPanel(${f.user_id})" class="m-btn m-btn-tonal m-btn-sm">Review</button>
				</div>
			</div>`;
		})
		.join("");
	return `<section class="bg-zinc-900 rounded-2xl px-4 pt-4 pb-1 mb-6">
		<div class="flex items-center gap-2 mb-1">
			<span class="material-symbols-outlined text-xl text-amber-300">policy</span>
			<h2 class="font-bold">Possible ban evasion <span class="text-zinc-500 font-normal">(${_evasionFlags.length})</span></h2>
		</div>
		<p class="text-xs text-zinc-500 mb-1">These accounts share a device with a banned one. Nothing has been done to them: a match is a reason to look, not proof. Ban for rule A1 if you are satisfied, or dismiss it.</p>
		<div class="divide-y divide-zinc-800">${rows}</div>
	</section>`;
}

async function dismissEvasionFlag(id) {
	try {
		await api(`/api/admin/users/evasion/${id}/dismiss`, { method: "POST" });
		showToast("Marked as not ban evasion", "success");
		refreshAttention?.();
		loadUsers();
	} catch (err) {
		showToast(err.message, "error");
	}
}

const SIGNAL_INFO = {
	device: {
		label: "Same browser",
		tone: "warn",
		help: "Both accounts were logged in from the very same browser. Strong, but a shared family computer looks the same.",
	},
	browser: {
		label: "Similar device",
		tone: "",
		help: "Same browser and hardware details. Identical phones, tablets and school laptops match each other, so treat this as a hint only.",
	},
};

export async function loadUsers() {
	try {
		[_users, _evasionFlags] = await Promise.all([api("/api/admin/users"), api("/api/admin/users/evasion")]);
		renderUsers(_users);
	} catch (err) {
		el("tab-content").innerHTML = `<div class="text-red-400">${escHtml(err.message)}</div>`;
	}
}

function userStatusBadges(u) {
	const badge = (text, tone) => `<span class="text-xs px-1.5 py-0.5 rounded ${tone}">${text}</span>`;
	return [
		u.role ? badge(roleName(u.role), ROLE_BADGE[u.role] || "bg-zinc-700 text-zinc-300") : "",
		u.role && u.staff_locked ? badge("Staff access suspended", "bg-red-900 text-red-300") : "",
		u.is_banned ? badge(u.ban_type === "perm" ? "Banned" : "Temp banned", "bg-red-900 text-red-300") : "",
		u.upload_limited ? badge("Upload limited", "bg-orange-900 text-orange-300") : "",
		u.duel_limited ? badge("Duel limited", "bg-orange-900 text-orange-300") : "",
		u.warning_count
			? badge(`${u.warning_count} warning${u.warning_count === 1 ? "" : "s"}`, "bg-yellow-900/70 text-yellow-300")
			: "",
		u.fairplay_flags ? badge("Fair-play flag", "bg-purple-900/70 text-purple-300") : "",
		u.profile_private ? badge("Private profile", "bg-zinc-700 text-zinc-400") : "",
	].join("");
}

function renderUsers(users) {
	const myRank = ROLE_RANK_JS[currentUser?.role] ?? 0;
	const isOp = currentUser?.role === "operator";
	const filters = [
		["all", "All"],
		["restricted", "Banned or limited"],
		["history", "Has history"],
		["staff", "Staff"],
		["flagged", "Fair-play flags"],
	];

	el("tab-content").innerHTML = `
		${renderEvasionFlags()}
		<h2 class="font-bold text-lg mb-4">Users (${users.length})</h2>
		${panelSearchInput("Search username, display name, user ID, Discord ID or status...")}
		<div class="flex gap-1 mb-4 flex-wrap" id="user-filters">
			${filters.map(([key, label]) => `<button data-filter="${key}" class="px-3 py-1 rounded-lg text-xs font-semibold transition ${key === "all" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}">${label}</button>`).join("")}
		</div>
		<div class="flex flex-col gap-2" id="users-list">
			${users
				.map((u) => {
					const restricted = u.is_banned || u.upload_limited || u.duel_limited;
					const canManageRole =
						myRank >= ROLE_RANK_JS.supervisor &&
						u.id !== currentUser.id &&
						(ROLE_RANK_JS[u.role] ?? 0) < myRank;
					const assignable = assignableRoles(currentUser.role).filter((r) => r !== u.role);
					const searchText = [
						u.id,
						`User #${u.id}`,
						u.discord_id,
						u.username,
						u.display_name,
						u.role,
						u.is_banned ? "banned" : "",
						u.upload_limited ? "upload limited" : "",
						u.duel_limited ? "duel limited" : "",
						u.warning_count ? "warned warning" : "",
					].join(" ");
					const tags = [
						restricted ? "restricted" : "",
						u.moderation_count ? "history" : "",
						u.role ? "staff" : "",
						u.fairplay_flags ? "flagged" : "",
					].join(" ");
					return `
				<div class="bg-zinc-900 rounded-2xl px-4 py-3 flex items-center gap-3 flex-wrap" id="user-${u.id}" data-search="${escHtml(searchText)}" data-tags="${tags}">
					${avatarHtml(u.avatar_url, "w-10 h-10 flex-shrink-0")}
					<div class="flex-1 min-w-[12rem]">
						<div class="font-semibold truncate">${escHtml(u.display_name || u.username)}</div>
						<div class="text-xs text-zinc-500 truncate"><a href="/u/${encodeURIComponent(u.username)}" target="_blank" rel="noopener" class="hover:text-zinc-300 hover:underline transition">@${escHtml(u.username)}</a> · User #${u.id} · joined ${new Date(u.created_at * 1000).toLocaleDateString()} · Suggest Change policy: ${u.suggestions_agreed ? `agreed${u.suggestions_agreed_at ? " " + new Date(u.suggestions_agreed_at * 1000).toLocaleDateString() : ""}` : "pending"}</div>
						<div class="flex gap-1 mt-1 flex-wrap">${userStatusBadges(u)}</div>
					</div>
					<div class="flex gap-1.5 flex-wrap justify-end">
						${
							canManageRole
								? assignable
										.map(
											(r) =>
												`<button onclick="setUserRole(${u.id}, '${r}')" class="m-btn m-btn-sm bg-purple-900/60 hover:bg-purple-800">Make ${roleName(r)}</button>`
										)
										.join("") +
									(u.role
										? `<button onclick="setUserRole(${u.id}, 'none')" class="m-btn m-btn-tonal m-btn-sm">Remove role</button>`
										: "")
								: ""
						}
						<button onclick="openUserPanel(${u.id})" class="m-btn m-btn-filled m-btn-sm">
							<span class="material-symbols-outlined text-sm leading-none">gavel</span> Moderation${u.moderation_count ? ` (${u.moderation_count})` : ""}
						</button>
					</div>
				</div>`;
				})
				.join("")}
			<div id="panel-search-empty" class="hidden text-zinc-500 text-center py-8">No users match your search.</div>
		</div>`;
	bindPanelSearch("#users-list [data-search]");

	el("user-filters").addEventListener("click", (e) => {
		const btn = e.target.closest("[data-filter]");
		if (!btn) return;
		for (const b of el("user-filters").children) {
			b.className = `px-3 py-1 rounded-lg text-xs font-semibold transition ${b === btn ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}`;
		}
		const filter = btn.dataset.filter;
		for (const row of document.querySelectorAll("#users-list [data-tags]")) {
			row.style.display = filter === "all" || row.dataset.tags.split(" ").includes(filter) ? "" : "none";
		}
	});
}

let _panelUserId = null;

export async function openUserPanel(userId) {
	_panelUserId = userId;
	el("user-panel-body").innerHTML = skeletonRows(4, "h-20");
	show("user-panel");
	try {
		renderUserPanel(await api(`/api/admin/users/${userId}/moderation`));
	} catch (err) {
		el("user-panel-body").innerHTML = `<div class="text-red-400 text-sm">${escHtml(err.message)}</div>`;
	}
}

function closeUserPanel() {
	_panelUserId = null;
	show("user-panel", false);
}

async function dismissFairplayFlag(flagId, userId) {
	try {
		await api(`/api/admin/users/fairplay/${flagId}/dismiss`, { method: "POST" });
		showToast("Flag dismissed.", "success");
		openUserPanel(userId);
	} catch (err) {
		showToast(err.message, "error");
	}
}

async function addStaffNote(userId) {
	const body = el("note-input").value.trim();
	if (body.length < 3) return showToast("Write a note first.", "error");
	try {
		await api(`/api/admin/users/${userId}/notes`, { json: { body } });
		openUserPanel(userId);
	} catch (err) {
		showToast(err.message, "error");
	}
}

async function removeStaffNote(noteId, userId) {
	if (!(await showConfirm("Remove this note?", "It is deleted for all staff."))) return;
	try {
		await api(`/api/admin/users/notes/${noteId}`, { method: "DELETE" });
		openUserPanel(userId);
	} catch (err) {
		showToast(err.message, "error");
	}
}

function userAccountHtml(a) {
	const line = (label, value) =>
		`<div class="flex items-baseline gap-2 py-1 border-b border-zinc-800 last:border-0"><span class="flex-1 text-zinc-500">${label}</span><span class="text-zinc-200 text-right">${value}</span></div>`;
	const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
	return `<details class="bg-zinc-800/40 rounded-xl px-3 py-2 mb-4 text-xs">
		<summary class="cursor-pointer text-zinc-300 font-semibold">Account details <span class="font-normal text-zinc-500">${a.last_played_date ? `last played ${escHtml(a.last_played_date)}` : "has not played yet"}</span></summary>
		<div class="mt-2">
			${line("Last logged in", a.last_login ? formatWhen(a.last_login) : "No login on record")}
			${line("Logged in on", count(a.sessions, "browser"))}
			${line("Devices seen", a.devices)}
			${line("Push notifications", a.push_devices ? `On, ${count(a.push_devices, "device")}` : "Off")}
			${line("Profile", a.profile_private ? "Private" : "Public")}
			${line("Daily streak", `${a.current_streak} now · ${a.longest_streak} best`)}
			${line("Duel rating", a.duel_rated_games ? `${a.duel_rating} after ${count(a.duel_rated_games, "rated duel")}` : "Unrated")}
			${line("Achievements", a.achievements)}
			${line("Suggestions", `${a.suggestions} sent · ${a.suggestions_approved} approved`)}
			${line("Locations in play", a.locations_live)}
		</div>
	</details>`;
}

function renderUserPanel({
	user,
	stats,
	account,
	actions,
	linked_accounts,
	fairplay_flags = [],
	notes = [],
	can_moderate,
}) {
	const myRank = ROLE_RANK_JS[currentUser?.role] ?? 0;
	const isOp = currentUser?.role === "operator";
	const until = (ts) => (ts ? `until ${formatWhen(ts)}` : "");
	const status = [
		user.is_banned
			? `<span class="text-red-300">${user.ban_type === "perm" ? "Permanently banned" : `Banned ${until(user.ban_expires_at)}`}</span>`
			: "",
		user.upload_limited
			? `<span class="text-orange-300">Uploads limited ${until(user.upload_limit_expires_at)}</span>`
			: "",
		user.duel_limited
			? `<span class="text-orange-300">Duels limited ${until(user.duel_limit_expires_at)}</span>`
			: "",
	].filter(Boolean);

	const stat = (label, value) =>
		`<div class="bg-zinc-800/60 rounded-xl px-3 py-2"><div class="text-sm font-bold">${value}</div><div class="text-[11px] text-zinc-500">${label}</div></div>`;
	const actionBtn = (key, label, tone) =>
		`<button onclick="moderateUser(${user.id}, '${key}')" class="m-btn m-btn-sm ${tone}">${label}</button>`;

	el("user-panel-title").textContent = user.display_name || user.username;
	el("user-panel-body").innerHTML = `
		<div class="flex items-center gap-3 mb-4">
			${avatarHtml(user.avatar_url, "w-12 h-12 flex-shrink-0")}
			<div class="min-w-0">
				<div class="text-sm text-zinc-400 truncate"><a href="/u/${encodeURIComponent(user.username)}" target="_blank" rel="noopener" class="hover:underline">@${escHtml(user.username)}</a> · User #${user.id}${user.role ? ` · ${roleName(user.role)}` : ""}</div>
				<div class="text-xs text-zinc-500">Joined ${new Date(user.created_at * 1000).toLocaleDateString()}</div>
				<div class="text-xs text-zinc-500" title="The fair-play notice shown before a player can use Suggest Change">
					Suggest Change policy: ${
						user.suggestions_agreed
							? `<span class="text-green-400">agreed</span>${user.suggestions_agreed_at ? ` on ${formatWhen(user.suggestions_agreed_at)}` : ""}`
							: '<span class="text-zinc-400">pending</span>'
					}
				</div>
				<div class="text-xs mt-0.5">${status.length ? status.join(" · ") : '<span class="text-green-400">In good standing</span>'}</div>
			</div>
		</div>

		<div class="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-4">
			${stat("Solo games", stats.solo_games)}${stat("Dailies", stats.daily_games)}${stat("Duels", stats.duels)}
			${stat("Submissions", stats.submissions)}${stat("Denied", stats.submissions_denied)}${stat("Tickets", stats.tickets)}
		</div>
		${account ? userAccountHtml(account) : ""}

		${
			linked_accounts.length
				? `<div class="bg-zinc-800/50 border border-zinc-700/60 rounded-xl px-3 py-2 mb-4 text-xs text-zinc-400">
					<span class="font-semibold text-zinc-300">Linked accounts:</span>
					${linked_accounts.map((a) => `<button onclick="openUserPanel(${a.id})" class="underline hover:text-white ${a.is_banned ? "text-red-300" : ""}" title="${escHtml((SIGNAL_INFO[a.signal] || SIGNAL_INFO.browser).help)}">@${escHtml(a.username)}</button> <span class="text-zinc-500">(${(SIGNAL_INFO[a.signal] || SIGNAL_INFO.browser).label.toLowerCase()}${a.is_banned ? ", banned" : ""})</span>`).join(", ")}
				</div>`
				: ""
		}

		${
			fairplay_flags.length
				? `<div class="bg-purple-950/40 border border-purple-800/50 rounded-xl px-3 py-2.5 mb-4 text-xs text-zinc-300">
					<div class="font-semibold text-purple-200 mb-1">Fair-play flags</div>
					<p class="text-zinc-400 mb-2">Patterns in recent guesses that a person is unlikely to produce. Not proof: look at their games before deciding anything.</p>
					${fairplay_flags
						.map(
							(flag) => `<div class="flex items-start gap-2 py-1.5 border-t border-purple-900/40">
								<div class="flex-1 min-w-0"><span class="font-semibold">${escHtml(flag.label)}.</span> ${escHtml(flag.evidence)} <span class="text-zinc-500">${formatWhen(flag.created_at)}</span></div>
								<button onclick="dismissFairplayFlag(${flag.id}, ${user.id})" class="m-btn m-btn-text m-btn-sm flex-shrink-0">Dismiss</button>
							</div>`
						)
						.join("")}
				</div>`
				: ""
		}

		<div class="mb-5">
			<div class="text-xs text-zinc-500 uppercase tracking-wider font-medium mb-2">Staff notes <span class="normal-case tracking-normal text-zinc-600">Not shown on the site. Included if the player asks for their data.</span></div>
			${notes
				.map(
					(note) => `<div class="bg-zinc-800/50 rounded-xl px-3 py-2 mb-1.5 text-sm">
						<div class="whitespace-pre-wrap break-words">${escHtml(note.body)}</div>
						<div class="flex items-center gap-2 text-xs text-zinc-500 mt-1">
							<span class="flex-1">@${escHtml(note.author_username || "staff")} · ${formatWhen(note.created_at)}</span>
							${note.author_id === currentUser.id || myRank >= ROLE_RANK_JS.supervisor ? `<button onclick="removeStaffNote(${note.id}, ${user.id})" class="hover:text-red-300 transition">Remove</button>` : ""}
						</div>
					</div>`
				)
				.join("")}
			<div class="flex gap-2 items-end">
				<textarea id="note-input" rows="2" maxlength="1000" placeholder="Add a note for other staff" class="m-field flex-1"></textarea>
				<button onclick="addStaffNote(${user.id})" class="m-btn m-btn-tonal m-btn-sm">Add</button>
			</div>
		</div>

		<div class="mb-5">
			<div class="text-xs text-zinc-500 uppercase tracking-wider font-medium mb-2">Take action</div>
			${
				can_moderate
					? `<div class="flex gap-2 flex-wrap">
						${actionBtn("warn", "Warn", "bg-yellow-800 hover:bg-yellow-700")}
						${actionBtn("limit_upload", "Limit uploads", "bg-zinc-700 hover:bg-zinc-600")}
						${actionBtn("limit_duel", "Limit duels", "bg-zinc-700 hover:bg-zinc-600")}
						${actionBtn("limit_chat", "Limit chat", "bg-zinc-700 hover:bg-zinc-600")}
						${actionBtn("ban_temp", "Temp ban", "bg-orange-800 hover:bg-orange-700")}
						${myRank >= ROLE_RANK_JS.supervisor ? actionBtn("ban_perm", "Perm ban", "bg-red-800 hover:bg-red-700") : ""}
					</div>`
					: '<p class="text-xs text-zinc-500">You can\'t moderate yourself or staff of equal or higher rank.</p>'
			}
		</div>

		<div class="text-xs text-zinc-500 uppercase tracking-wider font-medium mb-2">History (${actions.length})</div>
		<div class="flex flex-col gap-2">
			${
				actions.length
					? actions
							.map((a) => {
								const [icon, tone] = MOD_TYPE_STYLE[a.type] || ["gavel", "text-zinc-400"];
								return `<div class="bg-zinc-800/50 rounded-xl px-3 py-2.5 ${a.status === "active" ? "" : "opacity-80"}">
									<div class="flex items-center gap-2 flex-wrap">
										<span class="material-symbols-outlined text-base leading-none ${tone}">${icon}</span>
										<span class="text-sm font-semibold">${escHtml(a.label)}</span>
										<span class="text-[11px] px-1.5 py-0.5 rounded ${MOD_STATUS_BADGE[a.status]}">${a.status}</span>
										<span class="ml-auto text-[11px] text-zinc-500">${formatWhen(a.created_at)}</span>
									</div>
									<div class="text-sm text-zinc-300 mt-1 break-words">${linkRuleCodes(escHtml(a.reason))}</div>
									<div class="text-[11px] text-zinc-500 mt-1">
										By ${escHtml(a.issued_by_username || "unknown")}${a.expires_at ? ` · ${a.status === "active" ? "expires" : a.status === "expired" ? "expired" : "was due to expire"} ${formatWhen(a.expires_at)}` : ""}
									</div>
									${
										a.status === "overturned"
											? `<div class="text-[11px] text-green-300/80 mt-1 break-words">Overturned by ${escHtml(a.revoked_by_username || "unknown")} on ${formatWhen(a.revoked_at)}: ${escHtml(a.revoke_reason || "")}</div>`
											: ""
									}
									${
										a.can_overturn || a.can_delete
											? `<div class="flex gap-2 mt-2">
												${a.can_overturn ? `<button onclick="overturnAction(${a.id}, '${escHtml(a.label)}')" class="m-btn m-btn-success m-btn-sm">Overturn</button>` : ""}
												${a.can_delete ? `<button onclick="deleteModerationRecord(${a.id})" class="m-btn m-btn-tonal m-btn-sm">Remove record</button>` : ""}
											</div>`
											: ""
									}
								</div>`;
							})
							.join("")
					: '<p class="text-sm text-zinc-500">No moderation actions on this account.</p>'
			}
		</div>

		${
			atLeast("admin")
				? `<div class="mt-6 pt-4 border-t border-zinc-800">
					<div class="text-xs text-zinc-500 uppercase tracking-wider font-medium mb-2">Scores and history</div>
					<div id="score-manager" class="mb-5">
						<button onclick="loadScoreManager(${user.id})" class="m-btn m-btn-tonal m-btn-sm"><span class="material-symbols-outlined">leaderboard</span>View and manage scores</button>
					</div>
					${
						isOp
							? `<div class="text-xs text-zinc-500 uppercase tracking-wider font-medium mb-2">Account data</div>
								<div class="flex gap-2 flex-wrap">
									<button onclick="exportUserData(${user.id})" class="m-btn m-btn-tonal m-btn-sm">Export data</button>
									${can_moderate ? `<button onclick="deleteUserAccount(${user.id})" class="m-btn m-btn-danger m-btn-sm">Delete account</button>` : ""}
								</div>`
							: ""
					}
				</div>`
				: ""
		}`;
}

async function refreshUsers() {
	if (currentTab === "users") await loadUsers();
	if (_panelUserId !== null) await openUserPanel(_panelUserId);
}

async function moderateUser(userId, key) {
	const action = MOD_ACTIONS[key];
	/** Upload limits are usually about the upload guidelines; everything else about conduct. */
	const answer = await askReason({ ...action, rules: key === "limit_upload" ? "UF" : "FA" });
	if (!answer) return;
	try {
		await api(`/api/admin/users/${userId}/${action.endpoint}`, {
			json: { ...action.body, reason: answer.reason, ...(answer.hours ? { hours: answer.hours } : {}) },
		});
		showToast("Done. The user will see this in their settings.", "success");
		await refreshUsers();
	} catch (err) {
		showToast(err.message, "error");
	}
}

async function overturnAction(actionId, label) {
	const answer = await askReason({
		title: `Overturn: ${label}`,
		note: "The action stays in the user's history, marked as overturned with your reason.",
		button: "Overturn",
		tone: "bg-green-700 hover:bg-green-600",
	});
	if (!answer) return;
	try {
		await api(`/api/admin/moderation/${actionId}/overturn`, { json: { reason: answer.reason } });
		showToast("Action overturned.", "success");
		await refreshUsers();
	} catch (err) {
		showToast(err.message, "error");
	}
}

async function deleteModerationRecord(actionId) {
	const ok = await showConfirm(
		"Remove record",
		"This erases the action from the user's history completely, as if it never happened. If it is still active it stops applying. This cannot be undone.",
		{ confirmLabel: "Remove record" }
	);
	if (!ok) return;
	try {
		await api(`/api/admin/moderation/${actionId}`, { method: "DELETE" });
		showToast("Record removed.", "success");
		await refreshUsers();
	} catch (err) {
		showToast(err.message, "error");
	}
}

async function setUserRole(userId, role) {
	const label = role === "none" ? "remove their role" : `make them ${roleName(role)}`;
	const ok = await showConfirm("Change role", `Are you sure you want to ${label}?`, {
		confirmLabel: "Confirm",
		confirmClass: "m-btn-filled",
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

export async function loadStaff() {
	try {
		const r = await fetch("/api/admin/users");
		if (!r.ok) throw new Error();
		const users = await r.json();
		renderStaff(users.filter((u) => u.role));
	} catch {
		el("tab-content").innerHTML = errorStateHtml("Couldn't load the staff list.");
	}
}

function renderStaff(staff) {
	const myRole = currentUser?.role;
	const myRank = ROLE_RANK_JS[myRole] ?? 0;
	const grouped = { operator: [], admin: [], supervisor: [], moderator: [], curator: [], helper: [] };
	const canAppoint = myRank >= ROLE_RANK_JS.supervisor;
	for (const u of staff) if (grouped[u.role]) grouped[u.role].push(u);

	const roleSection = (role, members) => {
		if (!members.length) return "";
		const badgeClass = ROLE_BADGE[role] || "bg-zinc-700 text-zinc-300";
		return `
        <div class="mb-6">
            <div class="flex items-center gap-2 mb-3">
                <span class="text-xs font-semibold px-2 py-0.5 rounded ${badgeClass}">${roleName(role)}</span>
                <span class="text-zinc-500 text-xs">${members.length} member${members.length !== 1 ? "s" : ""}</span>
                ${role === "operator" ? '<span class="text-xs text-zinc-600">· env-managed</span>' : ""}
            </div>
            <p class="text-xs text-zinc-500 -mt-1.5 mb-3">${ROLE_INFO[role]?.summary.replace(/, and:$/, ".") ?? ""}</p>
            <div class="flex flex-col gap-2">
                ${members
					.map((u) => {
						const targetRank = ROLE_RANK_JS[u.role] ?? 0;
						/** Anyone ranked below you can be locked out; changing roles takes a supervisor. */
						const canChange = u.id !== currentUser.id && targetRank < myRank;
						const roleButtons = canChange
							? [
									...(canAppoint ? assignableRoles(myRole) : [])
										.filter((r) => r !== u.role)
										.map(
											(r) =>
												`<button onclick="setUserRole(${u.id}, '${r}')" class="m-btn m-btn-sm bg-purple-900/60 hover:bg-purple-800">Make ${roleName(r)}</button>`
										),
									canAppoint && u.role !== "operator"
										? `<button onclick="setUserRole(${u.id}, 'none')" class="m-btn m-btn-tonal m-btn-sm">Remove role</button>`
										: "",
									u.staff_locked
										? `<button onclick="setStaffLock(${u.id}, false)" class="m-btn m-btn-success m-btn-sm">Restore access</button>`
										: `<button onclick="setStaffLock(${u.id}, true)" class="m-btn m-btn-danger m-btn-sm" title="Stops them opening the staff panel or taking staff actions. Their role is kept.">Lock out</button>`,
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
                        ${u.avatar_url ? `<img src="${escHtml(avatarSrc(u.avatar_url, 32))}" alt="" loading="lazy" decoding="async" class="w-8 h-8 rounded-full flex-shrink-0" />` : '<div class="w-8 h-8 rounded-full bg-zinc-700 flex-shrink-0"></div>'}
                        <div class="flex-1 min-w-0">
                            <div class="font-medium text-sm truncate">${escHtml(u.display_name || u.username)}</div>
                            <div class="text-xs text-zinc-500">@${escHtml(u.username)} · User #${u.id} · Discord #${u.discord_id}</div>
                            ${u.staff_locked ? `<div class="text-xs text-red-300 mt-0.5 break-words"><span class="m-tag danger mr-1">Access suspended</span>${escHtml(u.staff_lock_reason || "")}</div>` : ""}
                        </div>
                        ${canChange ? `<div class="flex gap-1.5 flex-wrap">${roleButtons}</div>` : ""}
                    </div>`;
					})
					.join("")}
            </div>
        </div>`;
	};

	const addSection = canAppoint
		? `
    <div class="bg-zinc-900 rounded-xl p-4 mb-6">
        <div class="font-semibold text-sm mb-3">Add staff member</div>
        <div class="flex gap-2">
            <input id="staff-search" type="text" placeholder="Username or user ID..."
                class="flex-1 bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder:text-zinc-600" />
            <select id="staff-role-select" class="bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-zinc-300">
                ${assignableRoles(myRole)
					.map(
						(role, i, all) =>
							/** The lowest role is preselected: the safe default. */
							`<option value="${role}" ${i === all.length - 1 ? "selected" : ""}>${ROLE_NAMES[role]}</option>`
					)
					.join("")}
            </select>
            <button onclick="addStaffMember()" class="m-btn m-btn-filled">Add</button>
        </div>
        <p id="staff-add-error" class="text-red-400 text-xs mt-2 hidden"></p>
    </div>`
		: "";

	const roleGuide = `<details class="bg-zinc-900 rounded-xl mb-6 group">
        <summary class="flex items-center gap-2 px-4 py-3 cursor-pointer list-none">
            <span class="material-symbols-outlined text-lg text-zinc-500">help</span>
            <span class="font-semibold text-sm flex-1">What each role can do</span>
            <span class="material-symbols-outlined text-zinc-500 transition group-open:rotate-180">expand_more</span>
        </summary>
        <div class="grid sm:grid-cols-2 gap-3 px-4 pb-4">
            ${Object.entries(ROLE_INFO)
				.map(
					([role, info]) => `<div class="bg-zinc-800/50 rounded-xl p-3">
                    <span class="text-xs font-semibold px-2 py-0.5 rounded ${ROLE_BADGE[role]}">${ROLE_NAMES[role]}</span>
                    <p class="text-xs text-zinc-400 mt-2 mb-1.5">${info.summary}</p>
                    <ul class="text-xs text-zinc-300 flex flex-col gap-1">${info.can
						.map(
							(line) =>
								`<li class="flex gap-1.5"><span class="material-symbols-outlined text-sm leading-4 text-zinc-600 flex-shrink-0">check</span>${line.replace("{pins}", currentUser.limits?.chat_pin_limits?.[role] ?? "")}</li>`
						)
						.join("")}</ul>
                    ${info.note ? `<p class="text-[11px] text-zinc-600 mt-2">${info.note}</p>` : ""}
                </div>`
				)
				.join("")}
        </div>
        <p class="text-[11px] text-zinc-600 px-4 pb-4 -mt-1">Nobody can change, suspend or moderate someone of their own rank or higher, or themselves.</p>
    </details>`;

	el("tab-content").innerHTML = `
        <h2 class="font-bold text-lg mb-4">Staff Management</h2>
        ${panelSearchInput("Search staff name, username, ID or role...")}
        ${roleGuide}
        ${addSection}
        ${Object.keys(grouped)
			.map((role) => roleSection(role, grouped[role]))
			.join("")}
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
		if (target.role === role) throw new Error(`${target.username} is already ${roleName(role)}`);
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
		closeUserPanel();
		loadUsers();
	} catch (err) {
		showToast(err.message || "Failed.", "error");
	}
}

/** ---- Scores and history (operators): view, correct, remove and reset one player's results ---- */

let _scoreTab = "solo";

async function loadScoreManager(userId, list = _scoreTab) {
	_scoreTab = list;
	const box = el("score-manager");
	if (!box) return;
	let data;
	try {
		data = await api(`/api/admin/scores/${userId}`);
	} catch (err) {
		box.innerHTML = `<p class="text-red-300 text-sm">${escHtml(err.message)}</p>`;
		return;
	}
	const icon = (name, onclick, title) =>
		`<button onclick="${onclick}" class="m-icon-btn" title="${title}" aria-label="${title}"><span class="material-symbols-outlined">${name}</span></button>`;
	const row = (main, sub, actions) => `<div class="flex items-center gap-2 py-1.5">
		<div class="flex-1 min-w-0"><div class="text-sm font-mono">${main}</div><div class="text-[11px] text-zinc-500 truncate">${sub}</div></div>${actions}
	</div>`;
	const empty = '<p class="text-zinc-500 text-sm py-2">Nothing here.</p>';
	const lists = {
		solo: data.solo
			.map((s) =>
				row(
					`${s.total_score.toLocaleString()} <span class="text-zinc-500">/ ${s.max_possible.toLocaleString()}</span>`,
					`${s.rounds} rounds · ${s.time_limit ? `${s.time_limit}s` : "no limit"} · ${formatWhen(s.created_at)}`,
					icon(
						"edit",
						`editScore(${userId}, 'solo', ${s.id}, ${s.total_score}, ${s.max_possible})`,
						"Correct this score"
					) + icon("delete", `removeScore(${userId}, 'solo', ${s.id})`, "Remove this score")
				)
			)
			.join(""),
		daily: data.daily
			.map((d) =>
				row(
					d.score.toLocaleString(),
					`${escHtml(d.date)} · ${d.distance === null ? "no guess" : `${d.distance} studs`} · ${d.hints_used} hint${d.hints_used === 1 ? "" : "s"}`,
					icon("edit", `editScore(${userId}, 'daily', ${d.id}, ${d.score}, 5000)`, "Correct this score") +
						icon("delete", `removeScore(${userId}, 'daily', ${d.id})`, "Remove this score")
				)
			)
			.join(""),
		duels: data.duels
			.map((g) =>
				row(
					`${(g.score ?? 0).toLocaleString()} <span class="text-zinc-500">to ${(g.opponent_score ?? 0).toLocaleString()}</span> <span class="m-tag ${g.status !== "finished" ? "" : g.result === "win" ? "success" : g.result === "loss" ? "danger" : ""}">${g.status !== "finished" ? g.status : g.result}</span>`,
					`vs @${escHtml(g.opponent_username || "nobody")} · ${g.quickplay ? "Quick Play" : "room"} ${escHtml(g.room_code)} · ${formatWhen(g.finished_at || g.created_at)}`,
					g.status === "in_progress"
						? ""
						: icon("block", `removeScore(${userId}, 'duels', ${g.id})`, "Void this duel for both players")
				)
			)
			.join(""),
	};
	const counts = { solo: data.solo.length, daily: data.daily.length, duels: data.duels.length };
	const tab = (key, label) =>
		`<button onclick="loadScoreManager(${userId}, '${key}')" aria-pressed="${_scoreTab === key}">${label} <span class="count">${counts[key]}</span></button>`;
	const resetBtn = (scope, label) =>
		`<button onclick="resetScores(${userId}, '${scope}', '${label}')" class="m-btn m-btn-text m-btn-sm danger">${label}</button>`;

	box.innerHTML = `
		<div class="bg-zinc-800/50 rounded-xl px-3 py-2.5 mb-3 flex items-center gap-3 flex-wrap">
			<span class="material-symbols-outlined text-lg text-amber-300">local_fire_department</span>
			<div class="flex-1 min-w-0 text-sm">Streak <span class="font-mono font-bold">${data.streak.current}</span> <span class="text-zinc-500">· best ${data.streak.longest}${data.streak.last_played_date ? ` · last played ${escHtml(data.streak.last_played_date)}` : ""}</span></div>
			${icon("edit", `editStreak(${userId}, ${data.streak.current}, ${data.streak.longest})`, "Change the streak")}
		</div>
		<div class="bg-zinc-800/50 rounded-xl px-3 py-2.5 mb-3 flex items-center gap-3 flex-wrap">
			<span class="material-symbols-outlined text-lg text-blue-300">swords</span>
			<div class="flex-1 min-w-0 text-sm">Duel rating <span class="font-mono font-bold">${data.rating.value.toLocaleString()}</span> <span class="text-zinc-500">· ${data.rating.games} ranked duel${data.rating.games === 1 ? "" : "s"}</span></div>
			${icon("edit", `editRating(${userId}, ${data.rating.value})`, "Change the rating")}
		</div>
		<details class="bg-zinc-800/50 rounded-xl px-3 py-2.5 mb-3">
			<summary class="flex items-center gap-3 cursor-pointer list-none">
				<span class="material-symbols-outlined text-lg text-yellow-400">emoji_events</span>
				<span class="flex-1 text-sm">Achievements <span class="text-zinc-500">· ${data.achievements.filter((a) => a.earned_at).length} of ${data.achievements.length}</span></span>
				<span class="material-symbols-outlined text-zinc-500">expand_more</span>
			</summary>
			<div class="divide-y divide-zinc-800 mt-2">${data.achievements
				.map((a) =>
					row(
						`<span class="font-sans ${a.earned_at ? "" : "text-zinc-500"}">${escHtml(a.title)}</span>`,
						a.earned_at ? `Earned ${formatWhen(a.earned_at)}` : escHtml(a.description),
						a.earned_at
							? icon(
									"remove_circle",
									`setAchievement(${userId}, '${a.id}', false)`,
									"Take this achievement away"
								)
							: icon("add_circle", `setAchievement(${userId}, '${a.id}', true)`, "Give this achievement")
					)
				)
				.join("")}</div>
		</details>
		<div class="m-segmented mb-2">${tab("solo", "Solo")}${tab("daily", "Daily")}${tab("duels", "Duels")}</div>
		<div class="divide-y divide-zinc-800 max-h-72 overflow-y-auto pr-1">${lists[_scoreTab] || empty}</div>
		<p class="text-[11px] text-zinc-500 mt-2">The newest 200 of each are listed. Voiding a duel removes it for both players. Every change needs a reason, is logged, and the player is told.</p>
		<div class="flex gap-1 flex-wrap mt-2 -ml-2">
			${resetBtn("solo", "Reset solo")}${resetBtn("daily", "Reset daily")}${resetBtn("duels", "Void all duels")}${resetBtn("streak", "Reset streak")}${resetBtn("achievements", "Reset achievements")}${resetBtn("all", "Reset everything")}
		</div>`;
}

async function changeScores(userId, path, options, done) {
	try {
		await api(`/api/admin/scores/${userId}${path}`, options);
		showToast(done, "success");
		await openUserPanel(userId);
		loadScoreManager(userId);
	} catch (err) {
		showToast(err.message, "error");
	}
}

async function editScore(userId, kind, id, current, max) {
	const value = await showPrompt("Correct this score", String(current), {
		note: `A whole number from 0 to ${max.toLocaleString()}. It was ${current.toLocaleString()}.`,
		type: "number",
		okLabel: "Next",
	});
	if (value === null || value === "") return;
	const answer = await askReason({ title: "Why is this score being corrected?", button: "Save score", rules: "F" });
	if (!answer) return;
	const body = kind === "solo" ? { total_score: Number(value) } : { score: Number(value) };
	changeScores(userId, `/${kind}/${id}`, { json: { ...body, reason: answer.reason } }, "Score corrected");
}

async function removeScore(userId, kind, id) {
	const duel = kind === "duels";
	const answer = await askReason({
		title: duel ? "Void this duel?" : "Remove this score?",
		note: duel
			? "The duel is removed for both players, so neither keeps a win or a loss from it. This cannot be undone."
			: "This cannot be undone.",
		button: duel ? "Void duel" : "Remove score",
		tone: "bg-red-700 hover:bg-red-600",
		rules: "F",
	});
	if (!answer) return;
	changeScores(
		userId,
		`/${kind}/${id}`,
		{ method: "DELETE", json: { reason: answer.reason } },
		duel ? "Duel voided" : "Score removed"
	);
}

async function editStreak(userId, current, longest) {
	const now = await showPrompt("Current streak", String(current), {
		note: "In days.",
		type: "number",
		okLabel: "Next",
	});
	if (now === null || now === "") return;
	const best = await showPrompt("Longest streak", String(Math.max(longest, Number(now))), {
		note: "Cannot be shorter than the current streak.",
		type: "number",
		okLabel: "Next",
	});
	if (best === null || best === "") return;
	const answer = await askReason({ title: "Why is this streak being changed?", button: "Save streak" });
	if (!answer) return;
	changeScores(
		userId,
		"/streak",
		{ json: { current: Number(now), longest: Number(best), reason: answer.reason } },
		"Streak changed"
	);
}

async function editRating(userId, current) {
	const value = await showPrompt("Duel rating", String(current), {
		note: "A whole number from 100 to 4,000. New players start on 1,000.",
		type: "number",
		okLabel: "Next",
	});
	if (value === null || value === "") return;
	const answer = await askReason({ title: "Why is this rating being changed?", button: "Save rating", rules: "F" });
	if (!answer) return;
	changeScores(userId, "/rating", { json: { rating: Number(value), reason: answer.reason } }, "Rating changed");
}

async function setAchievement(userId, key, earned) {
	const answer = await askReason({
		title: earned ? "Give this achievement?" : "Take this achievement away?",
		note: "The player is told, with your reason.",
		button: earned ? "Give" : "Take away",
	});
	if (!answer) return;
	changeScores(
		userId,
		`/achievements/${key}`,
		{ json: { earned, reason: answer.reason } },
		earned ? "Achievement given" : "Achievement removed"
	);
}

async function resetScores(userId, scope, label) {
	const answer = await askReason({
		title: `${label}?`,
		note:
			scope === "all"
				? "Every solo and daily score, every finished duel, the duel rating, the streak and every achievement are wiped. This cannot be undone."
				: "This cannot be undone. A backup can be made first from the System tab.",
		button: label,
		tone: "bg-red-700 hover:bg-red-600",
		rules: "F",
	});
	if (!answer) return;
	changeScores(userId, "/reset", { json: { scope, reason: answer.reason } }, "Done");
}

async function setStaffLock(userId, lock) {
	const answer = await askReason(
		lock
			? {
					title: "Lock this member of staff out?",
					note: "They lose the staff panel and every staff action at once, on every device. Their role is kept, and they can still play. Use this for a compromised account or misuse.",
					button: "Lock out",
					tone: "bg-red-700 hover:bg-red-600",
				}
			: {
					title: "Restore their staff access?",
					button: "Restore access",
					tone: "bg-green-700 hover:bg-green-600",
				}
	);
	if (!answer) return;
	try {
		await api(`/api/admin/users/${userId}/staff-${lock ? "lock" : "unlock"}`, { json: { reason: answer.reason } });
		showToast(lock ? "Staff access suspended" : "Staff access restored", "success");
		if (currentTab === "staff") loadStaff();
		else refreshUsers();
	} catch (err) {
		showToast(err.message, "error");
	}
}

/** Called from inline handlers in the markup. */
Object.assign(window, {
	addStaffMember,
	addStaffNote,
	closeUserPanel,
	deleteModerationRecord,
	deleteUserAccount,
	dismissEvasionFlag,
	dismissFairplayFlag,
	editRating,
	editScore,
	editStreak,
	exportUserData,
	loadScoreManager,
	moderateUser,
	openUserPanel,
	overturnAction,
	removeScore,
	removeStaffNote,
	resetScores,
	setAchievement,
	setStaffLock,
	setUserRole,
});
