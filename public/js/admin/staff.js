import { avatarSrc, el, errorStateHtml, escHtml, show } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { showToast } from "../lib/toast.js";
import { bindPanelSearch, currentTab, currentUser, panelSearchInput, ROLE_RANK_JS } from "./core.js";
import { askReason, assignableRoles, ROLE_BADGE, ROLE_NAMES, roleName } from "./users.js";
import { refreshUsers, setUserRole } from "./user-panel.js";

/** The Staff tab: who holds which role, adding staff and locking them out. */

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
												`<button data-on-click="setUserRole(${u.id}, '${r}')" class="m-btn m-btn-sm bg-purple-900/60 hover:bg-purple-800">Make ${roleName(r)}</button>`
										),
									canAppoint && u.role !== "operator"
										? `<button data-on-click="setUserRole(${u.id}, 'none')" class="m-btn m-btn-tonal m-btn-sm">Remove role</button>`
										: "",
									u.staff_locked
										? `<button data-on-click="setStaffLock(${u.id}, false)" class="m-btn m-btn-success m-btn-sm">Restore access</button>`
										: `<button data-on-click="setStaffLock(${u.id}, true)" class="m-btn m-btn-danger m-btn-sm" title="Stops them opening the staff panel or taking staff actions. Their role is kept.">Lock out</button>`,
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
            <button data-on-click="addStaffMember()" class="m-btn m-btn-filled">Add</button>
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

Object.assign(window, {
	addStaffMember,
	setStaffLock,
});
