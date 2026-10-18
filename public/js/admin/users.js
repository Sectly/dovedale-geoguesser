import { avatarHtml, el, escHtml, show } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { showToast } from "../lib/toast.js";
import { refreshAttention } from "../lib/attention.js";
import { bindRuleChips, ruleChipsHtml } from "../rules.js";
import { bindPanelSearch, panelSearchInput, ROLE_RANK_JS } from "./core.js";

export const SIGNAL_INFO = {
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

export const ROLE_BADGE = {
	operator: "bg-yellow-900/70 text-yellow-300",
	admin: "bg-orange-900/70 text-orange-300",
	supervisor: "bg-purple-900/70 text-purple-300",
	moderator: "bg-blue-900/70 text-blue-300",
	curator: "bg-green-900/70 text-green-300",
	helper: "bg-teal-900/70 text-teal-300",
};

/** Roles someone may hand out, highest first: every role below their own, from supervisor up. */
export const assignableRoles = (role) =>
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

const REASON_MIN = 5;

/** What each moderation action looks like and asks for. Durations are in hours. */
export const MOD_ACTIONS = {
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
						<button data-on-click="openUserPanel(${f.user_id})" class="font-semibold hover:underline">@${escHtml(f.username)}</button>
						<span class="text-zinc-400">may be</span>
						<button data-on-click="openUserPanel(${f.banned_id})" class="font-semibold text-red-300 hover:underline">@${escHtml(f.banned_username)}</button>
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
					<button data-on-click="dismissEvasionFlag(${f.id})" class="m-btn m-btn-text m-btn-sm">Not evading</button>
					<button data-on-click="openUserPanel(${f.user_id})" class="m-btn m-btn-tonal m-btn-sm">Review</button>
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
					<button data-on-click="openUserPanel(${u.id})" class="m-btn m-btn-tonal m-btn-sm flex-shrink-0">
						Open${u.moderation_count ? ` <span class="text-zinc-400">· ${u.moderation_count} on record</span>` : ""}
					</button>
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

Object.assign(window, {
	dismissEvasionFlag,
});
