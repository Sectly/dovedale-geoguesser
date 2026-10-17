import { avatarHtml, el, errorStateHtml, escHtml } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { currentTab } from "./core.js";
import { AUDIT_ACTION_LABELS } from "./audit.js";

const OVERVIEW_REFRESH_MS = 30_000;
let _overviewTimer = null;

export function shortAgo(seconds) {
	const diff = Math.max(0, Date.now() / 1000 - seconds);
	if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))}m`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
	return `${Math.floor(diff / 86400)}d`;
}

export async function loadOverview() {
	clearInterval(_overviewTimer);
	try {
		renderOverview(await api("/api/admin/overview"));
	} catch (err) {
		el("tab-content").innerHTML = errorStateHtml(err.message || "Couldn't load the overview.", "loadOverview()");
		return;
	}
	_overviewTimer = setInterval(async () => {
		if (currentTab !== "overview") return clearInterval(_overviewTimer);
		if (document.hidden) return;
		try {
			renderOverview(await api("/api/admin/overview"));
		} catch {}
	}, OVERVIEW_REFRESH_MS);
}

function overviewActionRow(a) {
	const label = AUDIT_ACTION_LABELS[a.action]?.label ?? a.action.replaceAll("_", " ");
	const target = a.target_username ? `@${a.target_username}` : a.target_id ? `#${a.target_id}` : "";
	return `<div class="flex items-baseline gap-2 py-1.5 border-b border-zinc-800 last:border-0 text-sm">
		<span class="flex-1 min-w-0 truncate"><span class="text-zinc-200">${escHtml(label)}</span> <span class="text-zinc-500">${escHtml(target)}</span></span>
		${a.actor_username ? `<span class="text-xs text-zinc-500 flex-shrink-0">${escHtml(a.actor_username)}</span>` : ""}
		<span class="text-xs text-zinc-600 flex-shrink-0 w-8 text-right">${shortAgo(a.created_at)}</span>
	</div>`;
}

function renderOverview({ waiting, flagged, live, notices, mine, recent }) {
	const total = waiting.reduce((sum, queue) => sum + queue.count, 0);
	const heading = (text, note = "") =>
		`<div class="flex items-baseline gap-2 mb-3 mt-8"><h3 class="font-semibold text-zinc-300">${text}</h3>${note ? `<span class="text-xs text-zinc-600">${note}</span>` : ""}</div>`;
	const panel = (title, rows, empty) =>
		`<div class="bg-zinc-900 rounded-2xl p-4"><div class="text-xs text-zinc-500 uppercase tracking-wider font-medium mb-1">${title}</div>${rows.length ? rows.map(overviewActionRow).join("") : `<p class="text-sm text-zinc-600 py-2">${empty}</p>`}</div>`;

	el("tab-content").innerHTML = `
		<div class="flex items-center gap-3 flex-wrap mb-1">
			<h2 class="font-bold text-lg flex-1">Overview</h2>
			<button data-on-click="openPalette()" class="m-btn m-btn-tonal m-btn-sm"><span class="material-symbols-outlined">search</span>Jump to <kbd class="kbd ml-1">Ctrl</kbd><kbd class="kbd">K</kbd></button>
		</div>
		<p class="text-sm text-zinc-500">${total ? `${total} thing${total === 1 ? "" : "s"} waiting for staff.` : "Nothing is waiting. All caught up."}</p>

		${
			notices.maintenance
				? `<div class="mt-4 bg-amber-300 text-zinc-950 rounded-2xl px-4 py-2.5 text-sm font-semibold flex items-center gap-2"><span class="material-symbols-outlined text-lg">construction</span>Maintenance mode is on: players are locked out.</div>`
				: ""
		}
		${
			notices.restart_in !== null
				? `<div class="mt-4 bg-amber-300 text-zinc-950 rounded-2xl px-4 py-2.5 text-sm font-semibold flex items-center gap-2"><span class="material-symbols-outlined text-lg">restart_alt</span>A server restart is counting down.</div>`
				: ""
		}

		${heading("Waiting for staff")}
		<div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
			${waiting
				.map(
					(
						queue
					) => `<button data-on-click="switchTab('${queue.tab}')" class="md-card px-5 py-4 text-left !rounded-2xl">
						<div class="text-3xl font-bold font-mono ${queue.count ? "text-white" : "text-zinc-600"}">${queue.count}</div>
						<div class="text-sm text-zinc-300 mt-0.5">${queue.label}</div>
						<div class="text-xs mt-1 ${queue.count ? "text-zinc-500" : "text-green-400/80"}">${queue.count ? (queue.oldest ? `Oldest ${shortAgo(queue.oldest)} ago` : "Open to review") : "All clear"}</div>
					</button>`
				)
				.join("")}
		</div>

		${
			flagged.length
				? `${heading("Fair-play flags", "Players whose recent guesses need a look")}
					<div class="flex flex-col gap-2">
						${flagged
							.map(
								(
									u
								) => `<button data-on-click="openUserPanel(${u.id})" class="bg-zinc-900 hover:bg-zinc-800 transition rounded-2xl px-4 py-2.5 flex items-center gap-3 text-left">
									${avatarHtml(u.avatar_url, "w-8 h-8 flex-shrink-0")}
									<span class="flex-1 min-w-0 truncate"><span class="font-semibold">${escHtml(u.display_name || u.username)}</span> <span class="text-xs text-zinc-500">@${escHtml(u.username)}</span></span>
									<span class="m-tag info">${u.flags} flag${u.flags === 1 ? "" : "s"}</span>
									<span class="text-xs text-zinc-600 w-8 text-right">${shortAgo(u.since)}</span>
								</button>`
							)
							.join("")}
					</div>`
				: ""
		}

		${heading("Live now")}
		<div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
			${[
				["Duels being played", live.duels],
				["Watching duels", live.spectators],
				["Team games", live.team_games],
				["Solo games being played", live.solo_games],
			]
				.map(
					([label, value]) =>
						`<div class="bg-zinc-900 rounded-2xl px-4 py-3"><div class="text-xl font-bold font-mono">${value}</div><div class="text-xs text-zinc-500">${label}</div></div>`
				)
				.join("")}
		</div>

		${heading("Activity")}
		<div class="grid ${recent.length ? "lg:grid-cols-2" : ""} gap-3">
			${panel("Your recent actions", mine, "Nothing yet.")}
			${recent.length ? panel("Other staff", recent, "") : ""}
		</div>`;
}

Object.assign(window, { loadOverview });
