import { el, errorStateHtml, escHtml, locId } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { showToast } from "../lib/toast.js";
import {
	LABEL_MAX_LENGTH,
	atLeast,
	bindPanelSearch,
	currentUser,
	mountReviewMap,
	panelSearchInput,
	restorePanelSearch,
	showConfirm,
	staffUserLink,
	userFilterSelect,
} from "./core.js";
import { shortAgo } from "./overview.js";
import { formatWhen } from "./users.js";

let _locations = [];
let _locationFilter = "all";
let _locationSort = "newest";
let _openLocation = null;
let _locationUser = "";

const LOCATION_FILTERS = {
	all: ["All", () => true],
	active: ["In play", (l) => l.is_active],
	inactive: ["Out of play", (l) => !l.is_active],
	easy: ["Easy", (l) => l.difficulty === "easy"],
	medium: ["Medium", (l) => l.difficulty === "medium"],
	hard: ["Hard", (l) => l.difficulty === "hard"],
	ungraded: ["Ungraded", (l) => !l.difficulty],
};
const LOCATION_SORTS = {
	newest: ["Newest first", (a, b) => b.created_at - a.created_at],
	oldest: ["Oldest first", (a, b) => a.created_at - b.created_at],
	played: ["Most guessed", (a, b) => b.plays - a.plays],
	hardest: ["Lowest average", (a, b) => (a.avg_score ?? Infinity) - (b.avg_score ?? Infinity)],
	easiest: ["Highest average", (a, b) => (b.avg_score ?? -1) - (a.avg_score ?? -1)],
};
const DIFFICULTY_TONE = { easy: "success", medium: "warn", hard: "danger" };

export async function loadLocations() {
	try {
		_locations = await api("/api/admin/locations");
		renderLocations();
	} catch (err) {
		el("tab-content").innerHTML = errorStateHtml(err.message || "Couldn't load the locations.", "loadLocations()");
	}
}

function locationHints(loc) {
	try {
		const hints = JSON.parse(loc.hints || "[]");
		return Array.isArray(hints) ? hints : [];
	} catch {
		return [];
	}
}

function hintRowHtml(text = "") {
	return `<div class="flex items-center gap-1.5">
		<input type="text" value="${escHtml(text)}" placeholder="A clue players can reveal" maxlength="${currentUser.limits.hint_length}" class="hint-input m-field" />
		<button onclick="this.parentElement.remove()" class="m-icon-btn" aria-label="Remove hint"><span class="material-symbols-outlined">close</span></button>
	</div>`;
}

function locationEditorHtml(loc) {
	const readOnly = !atLeast("curator");
	return `<div class="border-t border-zinc-800 p-3 flex flex-col gap-3">
		<div id="loc-map-${loc.id}" class="relative h-48 rounded-xl overflow-hidden bg-zinc-800"></div>
		<div class="text-xs text-zinc-500 flex flex-wrap gap-x-4 gap-y-1">
			<span>Pin <span class="text-zinc-300 font-mono">${Math.round(loc.world_x)}, ${Math.round(loc.world_y)}</span></span>
			<span>Added <span class="text-zinc-300">${formatWhen(loc.created_at)}</span></span>
			${loc.submitted_by ? `<span>By ${staffUserLink(loc.submitted_by, loc.submitted_by_username)}</span>` : ""}
			${loc.approved_by_username ? `<span>Approved by <span class="text-zinc-300">@${escHtml(loc.approved_by_username)}</span></span>` : ""}
		</div>
		<div id="loc-breakdown-${loc.id}" class="flex flex-col gap-3">
			<button onclick="showLocationBreakdown(${loc.id})" class="m-btn m-btn-tonal m-btn-sm self-start"><span class="material-symbols-outlined">query_stats</span>How it has played</button>
		</div>
		${
			readOnly
				? locationHints(loc).length
					? `<div><div class="m-label">Hints</div><ol class="text-sm text-zinc-300 list-decimal pl-5">${locationHints(
							loc
						)
							.map((hint) => `<li>${escHtml(hint)}</li>`)
							.join("")}</ol></div>`
					: ""
				: `<div>
					<label class="m-label" for="loc-label-${loc.id}">Label</label>
					<input id="loc-label-${loc.id}" type="text" value="${escHtml(loc.label || "")}" maxlength="${LABEL_MAX_LENGTH}" class="m-field" />
				</div>
				<div>
					<div class="m-label">Hints</div>
					<div id="hints-${loc.id}" class="flex flex-col gap-1.5">${locationHints(loc).map(hintRowHtml).join("")}</div>
					<button onclick="el('hints-${loc.id}').insertAdjacentHTML('beforeend', hintRowHtml())" class="m-btn m-btn-text m-btn-sm mt-1"><span class="material-symbols-outlined">add</span>Add hint</button>
				</div>
				<div class="flex gap-2 flex-wrap justify-end">
					${atLeast("admin") ? `<button onclick="deleteLocation(${loc.id})" class="m-btn m-btn-text m-btn-sm danger mr-auto">Delete</button>` : ""}
					${loc.plays ? `<button onclick="resetLocationStats(${loc.id})" class="m-btn m-btn-text m-btn-sm" title="Forget how players have done here, e.g. after fixing the pin or the screenshot">Reset difficulty</button>` : ""}
					<button onclick="toggleLocation(${loc.id})" class="m-btn m-btn-tonal m-btn-sm">${loc.is_active ? "Take out of play" : "Put back in play"}</button>
					<button onclick="saveLocation(${loc.id})" class="m-btn m-btn-filled m-btn-sm">Save</button>
				</div>`
		}
	</div>`;
}

function locationCardHtml(loc) {
	const open = _openLocation === loc.id;
	const hints = locationHints(loc);
	const searchText = [
		loc.id,
		locId(loc.id),
		loc.label,
		loc.image_path,
		hints.join(" "),
		loc.world_x,
		loc.world_y,
		loc.is_active ? "active in play" : "inactive out of play",
		loc.difficulty || "ungraded",
		loc.submitted_by_username && `@${loc.submitted_by_username}`,
		loc.submitted_by_display_name,
		loc.approved_by_username && `@${loc.approved_by_username}`,
	].join(" ");
	return `<div class="bg-zinc-900 rounded-2xl overflow-hidden ${open ? "ring-1 ring-zinc-700 md:col-span-2 xl:col-span-2" : ""} ${loc.is_active ? "" : "opacity-70"}" id="loc-${loc.id}" data-search="${escHtml(searchText)}">
		<button onclick="${open ? `viewImage('/uploads/${escHtml(loc.image_path)}')` : `toggleLocationEditor(${loc.id})`}" class="block w-full ${open ? "cursor-zoom-in" : ""}" title="${open ? "View larger" : "Open"}" aria-label="${open ? "View the screenshot larger" : "Open this location"}">
			<img loading="lazy" decoding="async" src="/uploads/${escHtml(loc.image_path)}" alt="" class="w-full ${open ? "max-h-80 object-contain bg-black" : "h-40 object-cover"}" />
		</button>
		<button onclick="toggleLocationEditor(${loc.id})" aria-expanded="${open}" class="w-full text-left px-3 py-2.5 hover:bg-zinc-800/50 transition">
			<span class="flex items-center gap-2">
				<span class="flex-1 min-w-0 truncate text-sm font-semibold">${loc.label ? escHtml(loc.label) : '<span class="text-zinc-500 font-normal">No label</span>'}</span>
				<span class="text-xs font-mono text-zinc-600 flex-shrink-0">${locId(loc.id)}</span>
				<span class="material-symbols-outlined text-zinc-500 text-base flex-shrink-0 transition-transform ${open ? "rotate-180" : ""}">expand_more</span>
			</span>
			<span class="flex items-center gap-1.5 flex-wrap mt-1.5">
				<span class="m-tag ${loc.is_active ? "success" : ""}">${loc.is_active ? "In play" : "Out of play"}</span>
				<span class="m-tag ${DIFFICULTY_TONE[loc.difficulty] || ""}">${loc.difficulty ? loc.difficulty[0].toUpperCase() + loc.difficulty.slice(1) : "Ungraded"}</span>
				<span class="text-xs text-zinc-500">${loc.plays ? `${loc.plays.toLocaleString()} guess${loc.plays === 1 ? "" : "es"} · avg ${Number(loc.avg_score).toLocaleString()}` : "No guesses yet"}${hints.length ? ` · ${hints.length} hint${hints.length === 1 ? "" : "s"}` : ""}</span>
			</span>
		</button>
		${open ? locationEditorHtml(loc) : ""}
	</div>`;
}

function renderLocations() {
	if (_locationUser && !_locations.some((loc) => loc.submitted_by_username === _locationUser)) _locationUser = "";
	const shown = _locations
		.filter(LOCATION_FILTERS[_locationFilter][1])
		.filter((loc) => !_locationUser || loc.submitted_by_username === _locationUser)
		.sort(LOCATION_SORTS[_locationSort][1]);
	const search = el("locations-list") ? el("panel-search")?.value : "";
	el("tab-content").innerHTML = `
		<div class="flex items-center gap-2 mb-4 flex-wrap">
			<h2 class="font-bold text-lg">Locations</h2>
			<span class="m-tag">${_locations.length} in total</span>
			<button onclick="loadLocations()" class="m-icon-btn ml-auto"aria-label="Refresh" title="Refresh"><span class="material-symbols-outlined">refresh</span></button>
		</div>
		${panelSearchInput("Search location ID, label, hints, status or who submitted it...")}
		<div class="flex items-center gap-1.5 flex-wrap mb-4">
			${Object.entries(LOCATION_FILTERS)
				.map(
					([key, [label, test]]) =>
						`<button onclick="setLocationFilter('${key}')" class="m-chip" aria-pressed="${_locationFilter === key}">${label} <span class="count">${_locations.filter(test).length}</span></button>`
				)
				.join("")}
			<span class="ml-auto"></span>
			${userFilterSelect(_locations, (loc) => loc.submitted_by_username, _locationUser, "setLocationUser")}
			<select onchange="setLocationSort(this.value)" class="m-field !w-auto !py-1.5 text-xs" aria-label="Sort by">
				${Object.entries(LOCATION_SORTS)
					.map(
						([key, [label]]) =>
							`<option value="${key}" ${_locationSort === key ? "selected" : ""}>${label}</option>`
					)
					.join("")}
			</select>
		</div>
		<div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3" id="locations-list">
			${shown.map(locationCardHtml).join("")}
			<div id="panel-search-empty" class="${shown.length ? "hidden" : ""} col-span-full text-zinc-500 text-center py-8">No locations match.</div>
		</div>`;
	bindPanelSearch("#locations-list [data-search]");
	restorePanelSearch(search);
	const open = _locations.find((loc) => loc.id === _openLocation);
	const slot = open && el(`loc-map-${open.id}`);
	if (slot) {
		const map = mountReviewMap(slot);
		map.clearPin();
		map.setPin(open.world_x, open.world_y);
		map.fitTo([{ x: open.world_x, y: open.world_y }]);
	}
}

function setLocationFilter(key) {
	_locationFilter = key;
	renderLocations();
}

function setLocationUser(name) {
	_locationUser = name;
	renderLocations();
}

function setLocationSort(key) {
	_locationSort = key;
	renderLocations();
}

function toggleLocationEditor(id) {
	_openLocation = _openLocation === id ? null : id;
	renderLocations();
	el(`loc-${id}`)?.scrollIntoView({ block: "nearest" });
}

async function saveLocation(id) {
	const loc = _locations.find((item) => item.id === id);
	const label = el(`loc-label-${id}`).value.trim();
	const hints = [...el(`hints-${id}`).querySelectorAll(".hint-input")]
		.map((input) => input.value.trim())
		.filter(Boolean);
	try {
		if (label !== (loc.label || "")) await api(`/api/admin/locations/${id}/label`, { json: { label } });
		if (JSON.stringify(hints) !== JSON.stringify(locationHints(loc)))
			await api(`/api/admin/locations/${id}/hints`, { json: { hints } });
		loc.label = label;
		loc.hints = JSON.stringify(hints);
		showToast(`${locId(id)} saved.`, "success");
		renderLocations();
	} catch (err) {
		showToast(err.message || "Couldn't save it.", "error");
	}
}

async function resetLocationStats(id) {
	const ok = await showConfirm(
		"Reset this location's difficulty?",
		"Its guess count and average are cleared, and it stays ungraded until enough new guesses come in.",
		{ confirmLabel: "Reset" }
	);
	if (!ok) return;
	try {
		await api(`/api/admin/locations/${id}/stats/reset`, { method: "POST" });
		showToast("Difficulty reset.", "success");
		loadLocations();
	} catch (err) {
		showToast(err.message || "Couldn't reset it.", "error");
	}
}

async function toggleLocation(id) {
	try {
		await api(`/api/admin/locations/${id}/toggle`, { method: "POST" });
		const loc = _locations.find((item) => item.id === id);
		loc.is_active = loc.is_active ? 0 : 1;
		showToast(loc.is_active ? `${locId(id)} is back in play.` : `${locId(id)} is out of play.`, "success");
		renderLocations();
	} catch (err) {
		showToast(err.message || "Couldn't change it.", "error");
	}
}

async function deleteLocation(id) {
	const ok = await showConfirm(
		"Delete this location?",
		"It is removed for good, along with its screenshot. This cannot be undone.",
		{
			confirmLabel: "Delete",
		}
	);
	if (!ok) return;
	try {
		await api(`/api/admin/locations/${id}`, { method: "DELETE" });
		_locations = _locations.filter((loc) => loc.id !== id);
		_openLocation = null;
		showToast("Location deleted.", "success");
		renderLocations();
	} catch (err) {
		showToast(err.message || "Couldn't delete it.", "error");
	}
}

/* ---- How a location has played ---- */

const GUESS_MODES = { solo: "Solo", daily: "Daily", duel: "Duels" };
const SPREAD_BANDS = ["Under 1,000", "1,000s", "2,000s", "3,000s", "4,000 and up"];

async function showLocationBreakdown(id) {
	const box = el(`loc-breakdown-${id}`);
	if (!box) return;
	box.innerHTML = '<p class="text-xs text-zinc-500">Loading...</p>';
	let data;
	try {
		data = await api(`/api/admin/locations/${id}/breakdown`);
	} catch (err) {
		box.innerHTML = `<p class="text-xs text-red-400">${escHtml(err.message || "Couldn't load it.")}</p>`;
		return;
	}
	const { totals, modes, spread, duels, daily, suggestions } = data;
	const sampled = spread.reduce((sum, band) => sum + band.guesses, 0);
	const peak = Math.max(1, ...spread.map((band) => band.guesses));
	const cell = (value, label) =>
		`<div class="bg-zinc-800/60 rounded-xl px-3 py-2"><div class="text-sm font-bold">${value}</div><div class="text-[11px] text-zinc-500">${label}</div></div>`;
	const suggested = suggestions.reduce((sum, row) => sum + row.n, 0);
	box.innerHTML = `
		<div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
			${cell(totals.plays.toLocaleString(), "Times guessed")}
			${cell(totals.plays ? Math.round(totals.score_sum / totals.plays).toLocaleString() : "0", "All-time average")}
			${cell(duels.games.toLocaleString(), "Duels it came up in")}
			${cell(suggested, `Suggestion${suggested === 1 ? "" : "s"} made`)}
		</div>
		${
			sampled
				? `<div>
					<div class="m-label">Score spread <span class="text-zinc-600">Latest ${sampled.toLocaleString()} guesses</span></div>
					${SPREAD_BANDS.map((label, band) => {
						const count = spread.find((row) => row.band === band)?.guesses ?? 0;
						return `<div class="flex items-center gap-2 text-xs py-0.5">
							<span class="w-24 flex-shrink-0 text-zinc-500">${label}</span>
							<span class="flex-1 h-2 rounded-full bg-zinc-800 overflow-hidden"><span class="block h-full bg-blue-500" style="width:${(count / peak) * 100}%"></span></span>
							<span class="w-16 flex-shrink-0 text-right text-zinc-400">${count} · ${Math.round((count / sampled) * 100)}%</span>
						</div>`;
					}).join("")}
				</div>
				<div>
					<div class="m-label">By mode</div>
					<div class="overflow-x-auto"><table class="w-full text-xs">
						<thead><tr class="text-left text-zinc-500"><th class="font-normal py-1">Mode</th><th class="font-normal text-right">Guesses</th><th class="font-normal text-right">Avg points</th><th class="font-normal text-right">Avg distance</th><th class="font-normal text-right">Avg time</th><th class="font-normal text-right">Last</th></tr></thead>
						<tbody>${modes
							.map(
								(m) =>
									`<tr class="border-t border-zinc-800"><td class="py-1 text-zinc-300">${escHtml(GUESS_MODES[m.mode] || m.mode)}</td><td class="text-right">${m.guesses}</td><td class="text-right">${m.avg_points.toLocaleString()}</td><td class="text-right">${m.avg_distance.toLocaleString()}</td><td class="text-right">${m.avg_time}s</td><td class="text-right text-zinc-500">${shortAgo(m.last_at)} ago</td></tr>`
							)
							.join("")}</tbody>
					</table></div>
				</div>`
				: '<p class="text-xs text-zinc-500">No recent guesses on record.</p>'
		}
		${
			daily.length
				? `<div><div class="m-label">As the daily challenge</div>
					${daily.map((d) => `<div class="flex items-baseline gap-2 text-xs py-0.5"><span class="flex-1 text-zinc-300">${escHtml(d.date)}</span><span class="text-zinc-500">${d.players} played${d.players ? ` · avg ${Number(d.avg_score).toLocaleString()} · ${d.avg_hints} hints` : ""}</span></div>`).join("")}
				</div>`
				: ""
		}
		${duels.no_guess ? `<p class="text-xs text-zinc-500">${duels.no_guess} duel round${duels.no_guess === 1 ? "" : "s"} here ran out of time with no guess.</p>` : ""}`;
}

/* ---- Stats: what is happening now, what needs doing, and how the last two weeks went ---- */

let _stats = null;
let _statSeries = "games";

/** The activity chart shows one of these at a time, so every bar means the same thing. */
const STAT_SERIES = {
	games: ["All games", (d) => d.solo + d.daily + d.duels, "game"],
	new_users: ["New players", (d) => d.new_users, "new player"],
	solo: ["Solo", (d) => d.solo, "solo game"],
	daily: ["Daily", (d) => d.daily, "daily play"],
	duels: ["Duels", (d) => d.duels, "duel"],
};

export async function loadStats() {
	try {
		_stats = await api("/api/admin/stats");
	} catch (err) {
		el("tab-content").innerHTML = errorStateHtml(err.message || "Couldn't load the stats.");
		return;
	}
	renderStats(_stats);
}

export function statCard(label, value, sub = "", href = "") {
	const inner = `<div class="text-2xl font-bold font-mono">${value}</div>
		<div class="text-zinc-400 text-sm mt-1">${label}</div>
		${sub ? `<div class="text-zinc-600 text-xs mt-0.5">${sub}</div>` : ""}`;
	return href
		? `<a href="${href}" class="md-card block bg-zinc-900 hover:bg-zinc-800 rounded-2xl px-5 py-4 text-center">${inner}</a>`
		: `<div class="bg-zinc-900 rounded-2xl px-5 py-4 text-center">${inner}</div>`;
}

export const statHeading = (title, note = "") =>
	`<div class="flex items-baseline gap-2 mb-3 mt-8"><h3 class="font-semibold text-zinc-300">${title}</h3>${note ? `<span class="text-xs text-zinc-600">${note}</span>` : ""}</div>`;

function statChartHtml(series) {
	const [title, valueOf, noun] = STAT_SERIES[_statSeries];
	const values = series.map(valueOf);
	const peak = Math.max(...values, 1);
	const total = values.reduce((sum, n) => sum + n, 0);
	const day = (date, options) =>
		new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", ...options });
	const plural = (n) => `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;
	const tabs = Object.entries(STAT_SERIES)
		.map(
			([key, [label]]) =>
				`<button onclick="setStatSeries('${key}')" aria-pressed="${_statSeries === key}">${label}</button>`
		)
		.join("");
	return `<div class="bg-zinc-900 rounded-2xl p-5">
		<div class="flex items-center justify-between gap-3 flex-wrap mb-4">
			<div class="m-segmented">${tabs}</div>
			<div class="text-xs text-zinc-500">${plural(total)} in ${series.length} days · busiest day ${peak === 1 && total === 0 ? "none" : Math.max(...values).toLocaleString()}</div>
		</div>
		<div class="stat-chart" role="img" aria-label="${escHtml(title)} per day over the last ${series.length} days">
			${series
				.map(
					(d, i) =>
						`<div class="stat-chart-col" tabindex="0" data-tip="${escHtml(`${day(d.date, { weekday: "short", day: "numeric", month: "short" })} · ${plural(values[i])}`)}"><div class="stat-chart-bar ${values[i] ? "" : "empty"}" style="height:${values[i] ? Math.max(3, (values[i] / peak) * 100) : 0}%"></div></div>`
				)
				.join("")}
		</div>
		<div class="stat-chart-axis" aria-hidden="true">${series.map((d, i) => `<span>${i % 2 === series.length % 2 ? "" : day(d.date, { day: "numeric", month: "short" })}</span>`).join("")}</div>
		<details class="mt-3">
			<summary class="text-xs text-zinc-500 cursor-pointer hover:text-zinc-300">Show as a table</summary>
			<div class="overflow-x-auto mt-2"><table class="w-full text-xs text-left">
				<thead class="text-zinc-500"><tr><th class="py-1 pr-3 font-medium">Day (UTC)</th><th class="py-1 pr-3 font-medium text-right">New players</th><th class="py-1 pr-3 font-medium text-right">Solo</th><th class="py-1 pr-3 font-medium text-right">Daily</th><th class="py-1 font-medium text-right">Duels</th></tr></thead>
				<tbody class="font-mono text-zinc-300">${[...series]
					.reverse()
					.map(
						(d) =>
							`<tr class="border-t border-zinc-800"><td class="py-1 pr-3 font-sans text-zinc-400">${day(d.date, { weekday: "short", day: "numeric", month: "short" })}</td><td class="py-1 pr-3 text-right">${d.new_users}</td><td class="py-1 pr-3 text-right">${d.solo}</td><td class="py-1 pr-3 text-right">${d.daily}</td><td class="py-1 text-right">${d.duels}</td></tr>`
					)
					.join("")}</tbody>
			</table></div>
		</details>
	</div>`;
}

/** Redraws only the chart, so nothing else on the tab (a half-written announcement, say) is disturbed. */
function setStatSeries(key) {
	_statSeries = key;
	el("stat-chart-box").innerHTML = statChartHtml(_stats.series || []);
}

function renderStats(s) {
	const n = (value) => (value ?? 0).toLocaleString();
	const q = s.queues || {};
	const waiting = (q.submissions || 0) + (q.suggestions || 0) + (q.tickets || 0) + (q.users || 0);
	el("tab-content").innerHTML = `
		<div class="flex items-center justify-between gap-3 mb-1">
			<h2 class="font-bold text-lg">Site Stats</h2>
			<button onclick="loadStats()" class="m-icon-btn" title="Refresh" aria-label="Refresh"><span class="material-symbols-outlined">refresh</span></button>
		</div>

		${statHeading("Right now")}
		<div class="grid grid-cols-2 md:grid-cols-4 gap-3">
			${statCard("Duels being played", n(s.live?.duels), `${n(s.live?.duel_rooms_waiting)} waiting to start`)}
			${statCard("Watching duels", n(s.live?.spectators))}
			${statCard("Team games", n(s.live?.team_games))}
			${statCard("Solo games being played", n(s.live?.solo_games))}
		</div>

		${statHeading("Waiting for staff", waiting ? "" : "Nothing is waiting")}
		<div class="grid grid-cols-2 md:grid-cols-4 gap-3">
			${statCard("Submissions", n(q.submissions), "to review", "#submissions")}
			${statCard("Suggestions", n(q.suggestions), "to review", "#suggestions")}
			${statCard("Tickets", n(q.tickets), "awaiting a reply", "#tickets")}
			${statCard("Evasion flags", n(q.users), "to look at", "#users")}
		</div>

		${statHeading("Last 14 days", "Days are in UTC")}
		<div id="stat-chart-box">${statChartHtml(s.series || [])}</div>

		${statHeading("Players")}
		<div class="grid grid-cols-2 md:grid-cols-4 gap-3">
			${statCard("Accounts", n(s.users?.total), `${n(s.users?.last_7d)} new this week`)}
			${statCard("Played today", n(s.users?.active_today))}
			${statCard("Played this week", n(s.users?.active_7d))}
			${statCard("Played this month", n(s.users?.active_30d), `${n(s.users?.banned)} banned`)}
		</div>

		${statHeading("Games")}
		<div class="grid grid-cols-2 md:grid-cols-4 gap-3">
			${statCard("Solo games", n(s.scores?.total_games), `${n(s.scores?.last_7d)} this week`)}
			${statCard("Daily plays", n(s.daily?.total_plays), `${n(s.daily?.today)} today · ${n(s.daily?.last_7d)} this week`)}
			${statCard("Duels finished", n(s.duels?.finished), `${n(s.duels?.last_7d)} this week`)}
			${statCard("Ranked duels", n(s.duels?.ranked), `${n(s.achievements?.earned)} achievements earned`)}
		</div>

		${statHeading("Locations")}
		<div class="grid grid-cols-2 md:grid-cols-4 gap-3">
			${statCard("Active", n(s.locations?.active), `${n(s.locations?.total)} in total`, "#locations")}
			${statCard("Easy", n(s.locations?.easy))}
			${statCard("Medium", n(s.locations?.medium))}
			${statCard("Hard", n(s.locations?.hard), `${n(s.locations?.ungraded)} not graded yet`)}
		</div>

`;
}

/** Called from inline handlers in the markup. */
Object.assign(window, {
	deleteLocation,
	hintRowHtml,
	loadLocations,
	loadStats,
	resetLocationStats,
	saveLocation,
	setLocationFilter,
	setLocationSort,
	setLocationUser,
	setStatSeries,
	showLocationBreakdown,
	toggleLocation,
	toggleLocationEditor,
});
