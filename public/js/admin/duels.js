import { el, errorStateHtml, escHtml } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { showToast } from "../lib/toast.js";
import { atLeast, reviewHeader } from "./core.js";
import { statCard, statHeading } from "./locations.js";
import { askReason, formatWhen } from "./users.js";

let _duelKind = "";
let _duelSearch = "";
let _duelGames = [];
let _duelMore = false;
let _duelDetail = new Map();
let _openDuel = null;
let _openDuels = [];

const DUEL_KINDS = { "": "All", quickplay: "Quick Play", private: "Private rooms" };

function duelLength(game) {
	if (!game.finished_at) return "";
	const seconds = Math.max(0, game.finished_at - game.created_at);
	return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

export async function loadDuels() {
	let stats;
	try {
		[stats, _openDuels] = await Promise.all([
			api("/api/admin/duels/stats"),
			atLeast("admin") ? api("/api/admin/duels/live") : [],
			fetchDuels(0),
		]);
	} catch (err) {
		el("tab-content").innerHTML = errorStateHtml(err.message || "Couldn't load the duels.", "loadDuels()");
		return;
	}
	const { finished, rating } = stats;
	const share = finished.total ? Math.round((finished.ranked / finished.total) * 100) : 0;
	const people = (title, rows, line, empty) => `<div class="bg-zinc-900 rounded-2xl p-4">
		<div class="text-xs text-zinc-500 uppercase tracking-wider font-medium mb-1">${title}</div>
		${rows.length ? rows.map(line).join("") : `<p class="text-sm text-zinc-600 py-2">${empty}</p>`}
	</div>`;
	const row = (left, right) =>
		`<div class="flex items-baseline gap-2 py-1.5 border-b border-zinc-800 last:border-0 text-sm"><span class="flex-1 min-w-0 truncate">${left}</span><span class="text-xs text-zinc-500 flex-shrink-0">${right}</span></div>`;
	const player = (id, username) =>
		`<button data-on-click="openUserPanel(${id})" class="hover:underline">@${escHtml(username)}</button>`;

	el("tab-content").innerHTML = `
		${reviewHeader("Duels", 0, "loadDuels()")}
		<div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
			${statCard("Finished duels", finished.total.toLocaleString(), `${finished.last_day} today · ${finished.last_week} this week`)}
			${statCard("Quick Play", finished.ranked.toLocaleString(), `${share}% of all duels`)}
			${statCard("Typical duel", finished.avg_seconds ? duelLength({ created_at: 0, finished_at: finished.avg_seconds }) : "0s", `${finished.avg_rounds ?? 0} rounds on average`)}
			${statCard("Live now", stats.live.playing, `${stats.live.waiting} waiting for a player`)}
			${statCard("Rated players", rating.players.toLocaleString(), rating.players ? `average ${rating.average} · highest ${rating.highest}` : "")}
			${statCard("Draws", finished.draws.toLocaleString())}
			${statCard("Never finished", stats.abandoned.toLocaleString(), "Rooms left before the end")}
		</div>
		<div class="grid lg:grid-cols-3 gap-3 mt-3">
			${people("Highest rated", stats.top_rated, (u) => row(player(u.id, u.username), `${u.duel_rating} · ${u.duel_rated_games} rated`), "Nobody is rated yet.")}
			${people("Most duels, last 30 days", stats.most_active, (u) => row(player(u.id, u.username), `${u.games} played · ${u.wins} won`), "No duels in the last 30 days.")}
			${people("Same two players, 5 or more duels in 30 days", stats.repeat_pairs, (p) => row(`${player(p.first_id, p.first)} <span class="text-zinc-600">and</span> ${player(p.second_id, p.second)}`, `${p.games} duels · ${p.ranked} Quick Play`), "No pair has met that often.")}
		</div>

		${
			atLeast("admin")
				? `${statHeading("Open now", "Waiting or being played, private rooms included")}
					<div id="open-duels" class="flex flex-col gap-2">${openDuelsHtml()}</div>`
				: ""
		}

		${statHeading("History")}
		<div class="flex items-center gap-1.5 flex-wrap mb-3">
			${Object.entries(DUEL_KINDS)
				.map(
					([key, label]) =>
						`<button data-on-click="setDuelKind('${key}')" class="m-chip" data-duel-kind="${key}" aria-pressed="${_duelKind === key}">${label}</button>`
				)
				.join("")}
			<input id="duel-search" type="search" value="${escHtml(_duelSearch)}" placeholder="Username or room code" autocomplete="off" class="m-field ml-auto text-xs" style="width: 14rem; padding-block: 0.375rem" />
		</div>
		<div id="duel-list" class="flex flex-col gap-2"></div>`;
	let typing = null;
	el("duel-search").addEventListener("input", (e) => {
		clearTimeout(typing);
		typing = setTimeout(async () => {
			_duelSearch = e.target.value.trim();
			await fetchDuels(0).catch(() => {});
			renderDuelList();
		}, 300);
	});
	renderDuelList();
}

function openDuelsHtml() {
	if (!_openDuels.length) return '<p class="text-sm text-zinc-500">No duels are open right now.</p>';
	return _openDuels
		.map((room) => {
			const playing = room.status === "in_progress";
			const players = room.players
				.map(
					(p) =>
						`<button data-on-click="openUserPanel(${p.user_id})" class="hover:underline ${p.connected ? "" : "text-zinc-500"}">@${escHtml(p.username)}</button>${playing ? ` <span class="font-mono text-xs text-zinc-400">${p.total_score.toLocaleString()}</span>` : ""}${p.connected ? "" : ' <span class="text-xs text-zinc-600">(away)</span>'}`
				)
				.join('<span class="text-zinc-600"> vs </span>');
			return `<div class="bg-zinc-900 rounded-2xl px-4 py-3 flex items-center gap-3 flex-wrap">
				<span class="flex-1 min-w-0">
					<span class="block text-sm truncate">${players || '<span class="text-zinc-500">Nobody yet</span>'}</span>
					<span class="block text-xs text-zinc-500 mt-0.5">${playing ? `Round ${room.round} of ${room.rounds}` : "Waiting for a player"} · ${room.spectators} watching · <span class="font-mono">${escHtml(room.code)}</span></span>
				</span>
				<span class="m-tag ${room.quickplay ? "info" : ""}">${room.quickplay ? "Quick Play" : room.listed ? "Open room" : "Private"}</span>
				<a href="/duel/${encodeURIComponent(room.code)}?spectate" target="_blank" rel="noopener" class="m-btn m-btn-tonal m-btn-sm" title="Opens the duel in a new tab. Players see one more person watching"><span class="material-symbols-outlined">visibility</span>Watch</a>
				<button data-on-click="closeOpenDuel('${escHtml(room.code)}')" class="m-btn m-btn-text m-btn-sm danger">Close</button>
			</div>`;
		})
		.join("");
}

/** Ends a duel for everyone in it. Recorded as abandoned: no winner, and no score or rating changes. */
async function closeOpenDuel(code) {
	const answer = await askReason({
		title: `Close duel ${code}`,
		note: "Everyone in it is sent back to the lobby. Nobody wins or loses: scores, ratings and leaderboards stay as they were.",
		button: "Close duel",
	});
	if (!answer) return;
	try {
		await api(`/api/admin/duels/live/${encodeURIComponent(code)}/close`, { json: { reason: answer.reason } });
		showToast("Duel closed.", "success");
		loadDuels();
	} catch (err) {
		showToast(err.message || "Couldn't close it.", "error");
	}
}

async function fetchDuels(offset) {
	const params = new URLSearchParams({ offset });
	if (_duelKind) params.set("kind", _duelKind);
	if (_duelSearch) params.set("q", _duelSearch);
	const page = await api(`/api/admin/duels?${params}`);
	_duelGames = offset ? [..._duelGames, ...page.games] : page.games;
	_duelMore = page.more;
}

async function setDuelKind(kind) {
	_duelKind = kind;
	for (const chip of document.querySelectorAll("[data-duel-kind]"))
		chip.setAttribute("aria-pressed", chip.dataset.duelKind === kind);
	await fetchDuels(0).catch((err) => showToast(err.message, "error"));
	renderDuelList();
}

async function moreDuels() {
	await fetchDuels(_duelGames.length).catch((err) => showToast(err.message, "error"));
	renderDuelList();
}

async function toggleDuel(id) {
	_openDuel = _openDuel === id ? null : id;
	if (_openDuel && !_duelDetail.has(id)) {
		try {
			_duelDetail.set(id, (await api(`/api/duels/history/${id}`)).rounds_played);
		} catch {
			_duelDetail.set(id, []);
		}
	}
	renderDuelList();
}

function duelRoundsHtml(game) {
	const rows = _duelDetail.get(game.id) ?? [];
	if (!rows.length)
		return '<p class="border-t border-zinc-800 px-4 py-3 text-sm text-zinc-500">No round details are kept for this duel.</p>';
	const rounds = Map.groupBy(rows, (row) => row.round_number);
	return `<div class="border-t border-zinc-800 px-4 py-3 flex flex-col gap-2">
		${[...rounds]
			.map(
				([number, guesses]) => `<div class="text-sm">
					<div class="text-xs text-zinc-500 mb-0.5">Round ${number}${guesses[0].label ? ` · ${escHtml(guesses[0].label)}` : ""}</div>
					${guesses
						.map(
							(g) =>
								`<div class="flex items-baseline gap-2"><span class="flex-1 min-w-0 truncate text-zinc-300">@${escHtml(g.username)}</span><span class="text-xs text-zinc-500">${g.distance === null ? "no guess" : `${Number(g.distance).toLocaleString()} units · ${Number(g.time_taken ?? 0).toFixed(1)}s`}</span><span class="font-mono text-xs w-12 text-right">${g.score.toLocaleString()}</span></div>`
						)
						.join("")}
				</div>`
			)
			.join("")}
	</div>`;
}

function duelRowHtml(game) {
	const open = _openDuel === game.id;
	const finished = game.status === "finished";
	const players = game.players
		.map((p) => {
			const change = p.rating_change;
			const rating =
				change === null || change === undefined
					? ""
					: ` <span class="${change >= 0 ? "text-green-400" : "text-red-400"}">${change >= 0 ? "+" : ""}${change}</span>`;
			return `<span class="${finished && p.user_id === game.winner_id ? "text-white font-semibold" : "text-zinc-400"}">@${escHtml(p.username)} <span class="font-mono text-xs">${p.total_score.toLocaleString()}</span>${rating}</span>`;
		})
		.join('<span class="text-zinc-600"> vs </span>');
	return `<div class="bg-zinc-900 rounded-2xl overflow-hidden ${open ? "ring-1 ring-zinc-700" : ""}">
		<button data-on-click="toggleDuel(${game.id})" aria-expanded="${open}" class="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-800/50 transition">
			<span class="flex-1 min-w-0">
				<span class="block text-sm truncate">${players || '<span class="text-zinc-500">Nobody joined</span>'}</span>
				<span class="block text-xs text-zinc-500 mt-0.5">${game.rounds} round${game.rounds === 1 ? "" : "s"}${finished ? ` · ${duelLength(game)}` : ""} · ${formatWhen(game.finished_at ?? game.created_at)}</span>
			</span>
			<span class="m-tag ${game.quickplay ? "info" : ""} flex-shrink-0">${game.quickplay ? "Quick Play" : "Private"}</span>
			${finished ? (game.winner_id ? "" : '<span class="m-tag flex-shrink-0">Draw</span>') : '<span class="m-tag warn flex-shrink-0">Not finished</span>'}
			<span class="hidden sm:block text-xs font-mono text-zinc-600 flex-shrink-0">${escHtml(game.room_code)}</span>
			<span class="material-symbols-outlined text-zinc-500 text-base flex-shrink-0 transition-transform ${open ? "rotate-180" : ""}">expand_more</span>
		</button>
		${open ? duelRoundsHtml(game) : ""}
	</div>`;
}

function renderDuelList() {
	const list = el("duel-list");
	if (!list) return;
	list.innerHTML = _duelGames.length
		? _duelGames.map(duelRowHtml).join("") +
			(_duelMore
				? '<button data-on-click="moreDuels()" class="m-btn m-btn-tonal m-btn-sm self-center mt-2">Load more</button>'
				: "")
		: '<p class="text-sm text-zinc-500 text-center py-8">No duels match.</p>';
}

Object.assign(window, { closeOpenDuel, loadDuels, moreDuels, setDuelKind, toggleDuel });
