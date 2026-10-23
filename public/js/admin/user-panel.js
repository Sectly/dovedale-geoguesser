import { avatarHtml, el, escHtml, show, skeletonRows } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { showToast } from "../lib/toast.js";
import { linkRuleCodes } from "../rules.js";
import { atLeast, currentTab, currentUser, ROLE_RANK_JS, showConfirm, showPrompt } from "./core.js";
import { askReason, assignableRoles, formatWhen, loadUsers, MOD_ACTIONS, roleName, SIGNAL_INFO } from "./users.js";

const MOD_TYPE_STYLE = {
	warning: ["warning", "text-yellow-400"],
	limit_upload: ["file_upload_off", "text-orange-400"],
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
	const actionBtn = (key, label, tone = "m-btn-tonal") =>
		`<button data-on-click="moderateUser(${user.id}, '${key}')" class="m-btn m-btn-sm ${tone}">${label}</button>`;
	const canManageRole =
		myRank >= ROLE_RANK_JS.supervisor && user.id !== currentUser.id && (ROLE_RANK_JS[user.role] ?? 0) < myRank;
	const section = (title) =>
		`<div class="text-xs text-zinc-500 uppercase tracking-wider font-medium mb-2">${title}</div>`;

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
					${linked_accounts.map((a) => `<button data-on-click="openUserPanel(${a.id})" class="underline hover:text-white ${a.is_banned ? "text-red-300" : ""}" title="${escHtml((SIGNAL_INFO[a.signal] || SIGNAL_INFO.browser).help)}">@${escHtml(a.username)}</button> <span class="text-zinc-500">(${(SIGNAL_INFO[a.signal] || SIGNAL_INFO.browser).label.toLowerCase()}${a.is_banned ? ", banned" : ""})</span>`).join(", ")}
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
								<button data-on-click="dismissFairplayFlag(${flag.id}, ${user.id})" class="m-btn m-btn-text m-btn-sm flex-shrink-0">Dismiss</button>
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
							${note.author_id === currentUser.id || myRank >= ROLE_RANK_JS.supervisor ? `<button data-on-click="removeStaffNote(${note.id}, ${user.id})" class="hover:text-red-300 transition">Remove</button>` : ""}
						</div>
					</div>`
				)
				.join("")}
			<div class="flex gap-2 items-end">
				<textarea id="note-input" rows="2" maxlength="1000" placeholder="Add a note for other staff" class="m-field flex-1"></textarea>
				<button data-on-click="addStaffNote(${user.id})" class="m-btn m-btn-tonal m-btn-sm">Add</button>
			</div>
		</div>

		<div class="mb-5">
			<div class="text-xs text-zinc-500 uppercase tracking-wider font-medium mb-2">Take action</div>
			${
				can_moderate
					? `<div class="flex gap-2 flex-wrap">
						${actionBtn("warn", "Warn")}
						${actionBtn("limit_upload", "Limit uploads")}
						${actionBtn("limit_duel", "Limit duels")}
						${actionBtn("limit_chat", "Limit chat")}
						${actionBtn("ban_temp", "Temp ban", "m-btn-danger")}
						${myRank >= ROLE_RANK_JS.supervisor ? actionBtn("ban_perm", "Perm ban", "m-btn-danger") : ""}
					</div>`
					: '<p class="text-xs text-zinc-500">You can\'t moderate yourself or staff of equal or higher rank.</p>'
			}
		</div>

		${
			canManageRole
				? `<div class="mb-5">
					${section("Role")}
					<div class="flex gap-2 items-center flex-wrap">
						<select id="role-select" class="m-field !w-auto" aria-label="Role">
							<option value="none" ${user.role ? "" : "selected"}>No role</option>
							${assignableRoles(currentUser.role)
								.map(
									(r) =>
										`<option value="${r}" ${user.role === r ? "selected" : ""}>${roleName(r)}</option>`
								)
								.join("")}
						</select>
						<button data-on-click="changeRoleFromPanel(${user.id})" class="m-btn m-btn-tonal m-btn-sm">Change role</button>
					</div>
				</div>`
				: ""
		}

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
												${a.can_overturn ? `<button data-on-click="overturnAction(${a.id}, '${escHtml(a.label)}')" class="m-btn m-btn-success m-btn-sm">Overturn</button>` : ""}
												${a.can_delete ? `<button data-on-click="deleteModerationRecord(${a.id})" class="m-btn m-btn-tonal m-btn-sm">Remove record</button>` : ""}
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
						<button data-on-click="loadScoreManager(${user.id})" class="m-btn m-btn-tonal m-btn-sm"><span class="material-symbols-outlined">leaderboard</span>View and manage scores</button>
					</div>
					${
						isOp
							? `${section("Account data")}
								<button data-on-click="exportUserData(${user.id})" class="m-btn m-btn-tonal m-btn-sm">Export data</button>`
							: ""
					}
				</div>`
				: ""
		}
		${
			isOp && can_moderate
				? `<div class="mt-6 border border-red-900/60 rounded-2xl p-4">
					<div class="text-sm font-semibold text-red-300 mb-1">Delete account</div>
					<p class="text-xs text-zinc-400 mb-3">Deletes their account, scores and personal data for good. Moderation records stay.</p>
					<button data-on-click="deleteUserAccount(${user.id}, '${escHtml(user.username)}')" class="m-btn m-btn-danger m-btn-sm">Delete account</button>
				</div>`
				: ""
		}`;
}

export async function refreshUsers() {
	if (currentTab === "users") await loadUsers();
	if (_panelUserId !== null) await openUserPanel(_panelUserId);
}

async function moderateUser(userId, key) {
	const action = MOD_ACTIONS[key];
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

export async function setUserRole(userId, role) {
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
		showToast("Role changed", "success");
		await refreshUsers();
	} catch (err) {
		showToast(err.message || "Failed to update role.", "error");
	}
}

const changeRoleFromPanel = (userId) => setUserRole(userId, el("role-select").value);

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

/** Needs the username typed out. */
async function deleteUserAccount(userId, username) {
	const typed = await showPrompt(`Delete @${username}?`, username, {
		note: "Type their username to confirm. This cannot be undone.",
		okLabel: "Delete account",
	});
	if (typed === null) return;
	if (typed.trim().replace(/^@/, "").toLowerCase() !== username.toLowerCase())
		return showToast("The username didn't match, so nothing was deleted.", "error");
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

Object.assign(window, {
	addStaffNote,
	changeRoleFromPanel,
	closeUserPanel,
	deleteModerationRecord,
	deleteUserAccount,
	dismissFairplayFlag,
	exportUserData,
	moderateUser,
	openUserPanel,
	overturnAction,
	removeStaffNote,
	setUserRole,
	closeUserPanelFromBackdrop: (e) => e.target === el("user-panel") && closeUserPanel(),
});
