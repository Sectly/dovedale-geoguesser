import { avatarHtml, el, errorStateHtml, escHtml } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { showToast } from "../lib/toast.js";
import { live, onLive } from "../lib/live.js";
import { atLeast, currentTab, reviewHeader, showConfirm, showPrompt } from "./core.js";
import { formatWhen } from "./users.js";

/** Setting up a tournament, its list of players, and the controls on the night. */

let _tournamentId = null;
let _tournament = null;
let _editing = false;
let _busy = false;
let _clock = null;

const STATUS_TAGS = {
	draft: ["Draft", "warn"],
	open: ["Check-in open", "info"],
	live: ["Live", "danger"],
	finished: ["Finished", "success"],
	cancelled: ["Cancelled", ""],
};

const BREAK_CHOICES = [15, 30, 60, 120, 180, 300, 600, 900, 1800];
const BREAK_FIELDS = [
	["start", "Before the first match"],
	["match", "Between matches"],
	["round", "Between rounds"],
	["final", "Before the final"],
];
const PHASE_TEXT = {
	lobby: "Not started",
	break: "Break",
	hold: "Waiting for staff",
	match: "Match being played",
	result: "Showing the result",
	done: "Over",
};
const HOLD_REASONS = {
	not_ready: "A player isn't ready. Continue gives a 10-second countdown, then anyone not there loses the match.",
	no_show: "A player didn't join their match.",
	no_winner: "Both players left the match.",
	closed: "The match was stopped.",
	restart: "The server restarted during the tournament.",
	staff: "",
};

const roundsText = (n) => `${n} round${n === 1 ? "" : "s"}`;
const seconds = (s) => (s >= 60 ? `${s / 60} min` : `${s}s`);
const statusTag = (status) => {
	const [label, tone] = STATUS_TAGS[status] || [status, ""];
	return `<span class="m-tag ${tone}">${label}</span>`;
};

export async function loadTournaments(openId = null) {
	if (openId) _tournamentId = openId;
	clearInterval(_clock);
	if (_tournamentId) return openTournament(_tournamentId);
	let list;
	try {
		list = await api("/api/admin/tournaments");
	} catch (err) {
		el("tab-content").innerHTML = errorStateHtml(err.message || "Couldn't load tournaments.", "loadTournaments()");
		return;
	}
	el("tab-content").innerHTML = `
		${reviewHeader("Tournaments", 0, "loadTournaments()")}
		<p class="text-sm text-zinc-400 mb-4 max-w-2xl">A knockout bracket played one match at a time, so everyone watches the same duel. Pick the players, open check-in, then start it when everyone is here.</p>
		${atLeast("supervisor") ? '<button onclick="newTournament()" class="m-btn m-btn-filled mb-5"><span class="material-symbols-outlined">add</span>New tournament</button>' : '<p class="text-xs text-zinc-500 mb-5">Supervisors create, open, start and cancel tournaments. You can run them once they are set up.</p>'}
		<div id="tournament-form-slot"></div>
		<div class="flex flex-col gap-2">${
			list.length
				? list
						.map(
							(
								t
							) => `<button onclick="openTournament(${t.id})" class="bg-zinc-900 hover:bg-zinc-800 transition rounded-2xl px-4 py-3 flex items-center gap-3 text-left">
								<span class="material-symbols-outlined text-zinc-400">trophy</span>
								<span class="flex-1 min-w-0">
									<span class="block font-semibold truncate">${escHtml(t.title)}</span>
									<span class="block text-xs text-zinc-500 mt-0.5">${t.players} player${t.players === 1 ? "" : "s"}${t.starts_at ? ` · starts ${escHtml(new Date(t.starts_at * 1000).toLocaleString())}` : ""}${t.winner_username ? ` · won by @${escHtml(t.winner_username)}` : ""} · created ${formatWhen(t.created_at)}</span>
								</span>
								${statusTag(t.status)}
								<span class="material-symbols-outlined text-zinc-600">chevron_right</span>
							</button>`
						)
						.join("")
				: '<p class="text-sm text-zinc-500 py-8 text-center">No tournaments yet.</p>'
		}</div>`;
}

function newTournament() {
	el("tournament-form-slot").innerHTML = formHtml(null);
}

function toLocalInput(sec) {
	if (!sec) return "";
	const d = new Date(sec * 1000);
	d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
	return d.toISOString().slice(0, 16);
}

function formHtml(t) {
	const s = t?.settings || {
		rounds: 3,
		semiRounds: 5,
		finalRounds: 5,
		breaks: { start: 300, match: 60, round: 180, final: 180 },
		thirdPlace: false,
	};
	const roundsSelect = (name, value) =>
		`<select name="${name}" class="m-field">${Array.from({ length: 10 }, (_, i) => i + 1)
			.map(
				(n) => `<option value="${n}" ${n === value ? "selected" : ""}>${n} round${n === 1 ? "" : "s"}</option>`
			)
			.join("")}</select>`;
	const breakSelect = (key) =>
		`<select name="break_${key}" class="m-field">${[...new Set([...BREAK_CHOICES, s.breaks[key]])]
			.sort((a, b) => a - b)
			.map((n) => `<option value="${n}" ${n === s.breaks[key] ? "selected" : ""}>${seconds(n)}</option>`)
			.join("")}</select>`;
	const field = (label, input) => `<label class="flex flex-col gap-1 text-xs text-zinc-400">${label}${input}</label>`;
	return `<form onsubmit="saveTournament(event)" class="bg-zinc-900 rounded-2xl p-5 mb-5 flex flex-col gap-4 max-w-3xl">
		<h3 class="font-bold">${t ? "Edit tournament" : "New tournament"}</h3>
		${field("Name", `<input name="title" required maxlength="80" class="m-field" value="${escHtml(t?.title || "")}" placeholder="Friday game night" />`)}
		${field("Description <span class='text-zinc-600'>Optional. Shown on the tournament page.</span>", `<textarea name="description" maxlength="500" rows="2" class="m-field">${escHtml(t?.description || "")}</textarea>`)}
		${field("Starts at <span class='text-zinc-600'>Optional. Shown as a countdown; you still start it yourself.</span>", `<input name="starts_at" type="datetime-local" class="m-field" value="${toLocalInput(t?.starts_at)}" />`)}
		<div class="grid sm:grid-cols-3 gap-3">
			${field("Early matches", roundsSelect("rounds", s.rounds))}
			${field("Semi-finals", roundsSelect("semi_rounds", s.semiRounds))}
			${field("Final", roundsSelect("final_rounds", s.finalRounds))}
		</div>
		<div class="grid sm:grid-cols-4 gap-3">${BREAK_FIELDS.map(([key, label]) => field(label, breakSelect(key))).join("")}</div>
		<label class="md-check">
			<input name="third_place" type="checkbox" ${s.thirdPlace ? "checked" : ""} />
			<span class="md-check-box" aria-hidden="true"></span>
			<span>
				<span class="block text-sm text-zinc-200">Match for third place</span>
				<span class="block text-xs text-zinc-500">The semi-final losers play once more, just before the final</span>
			</span>
		</label>
		<div class="flex gap-2">
			<button class="m-btn m-btn-filled">${t ? "Save" : "Create"}</button>
			<button type="button" onclick="${t ? "toggleTournamentEdit(false)" : "loadTournaments()"}" class="m-btn m-btn-text">Cancel</button>
		</div>
	</form>`;
}

async function saveTournament(e) {
	e.preventDefault();
	const form = new FormData(e.target);
	const startsAt = form.get("starts_at");
	const body = {
		title: form.get("title"),
		description: form.get("description"),
		starts_at: startsAt ? new Date(startsAt).getTime() : null,
		rounds: Number(form.get("rounds")),
		semi_rounds: Number(form.get("semi_rounds")),
		final_rounds: Number(form.get("final_rounds")),
		breaks: Object.fromEntries(BREAK_FIELDS.map(([key]) => [key, Number(form.get(`break_${key}`))])),
		third_place: form.get("third_place") === "on",
	};
	try {
		const t = _tournamentId
			? await api(`/api/admin/tournaments/${_tournamentId}`, { method: "PATCH", json: body })
			: await api("/api/admin/tournaments", { json: body });
		_editing = false;
		showToast(_tournamentId ? "Saved" : "Tournament created", "success");
		openTournament(t.id, t);
	} catch (err) {
		showToast(err.message, "error");
	}
}

async function openTournament(id, data = null) {
	_tournamentId = id;
	if (currentTab === "tournaments") history.replaceState(null, "", `#tournaments:${id}`);
	try {
		_tournament = data || (await api(`/api/admin/tournaments/${id}`));
	} catch (err) {
		_tournamentId = null;
		el("tab-content").innerHTML = errorStateHtml(
			err.message || "Couldn't load the tournament.",
			"backToTournaments()"
		);
		return;
	}
	renderTournament();
	clearInterval(_clock);
	_clock = setInterval(tickClock, 500);
}

function backToTournaments() {
	_tournamentId = null;
	_tournament = null;
	_editing = false;
	history.replaceState(null, "", "#tournaments");
	loadTournaments();
}

function toggleTournamentEdit(on) {
	_editing = on;
	renderTournament();
}

const nameOf = (t, id) => {
	const p = t.players[id];
	return p ? p.display_name || p.username : "Player";
};

function renderTournament() {
	const t = _tournament;
	if (!t || currentTab !== "tournaments") return;
	/** Supervisors only; the server checks too. */
	const senior = atLeast("supervisor");
	const del = senior ? `<button onclick="deleteTournament()" class="m-btn m-btn-text danger">Delete</button>` : "";
	const cancel = senior
		? `<button onclick="cancelTournament()" class="m-btn m-btn-text danger">Cancel tournament</button>`
		: "";
	const actions = {
		draft: `${senior ? `<button onclick="tournamentAction('open')" class="m-btn m-btn-filled">Open check-in</button>` : ""}${del}`,
		open: senior
			? `<button onclick="startTournament()" class="m-btn m-btn-success">Start tournament</button>
				<button onclick="tournamentAction('unpublish')" class="m-btn m-btn-tonal">Back to draft</button>
				${cancel}`
			: "",
		live: cancel,
		finished: del,
		cancelled: del,
	}[t.status];
	const over = t.status === "finished" || t.status === "cancelled";
	el("tab-content").innerHTML = `
		<button onclick="backToTournaments()" class="text-sm text-zinc-400 hover:text-white flex items-center gap-1 mb-3"><span class="material-symbols-outlined text-base">arrow_back</span>All tournaments</button>
		<div class="flex items-center gap-3 flex-wrap mb-1">
			<h2 class="font-bold text-xl">${escHtml(t.title)}</h2>
			${statusTag(t.status)}
			<a href="/tournament/${t.id}" target="_blank" rel="noopener" class="m-btn m-btn-tonal m-btn-sm ml-auto"><span class="material-symbols-outlined">open_in_new</span>Open page</a>
			${over ? "" : `<button onclick="toggleTournamentEdit(${!_editing})" class="m-btn m-btn-tonal m-btn-sm"><span class="material-symbols-outlined">edit</span>Edit</button>`}
		</div>
		<p class="text-xs text-zinc-500 mb-4">Matches: ${roundsText(t.settings.rounds)}, semi-finals ${roundsText(t.settings.semiRounds)}, final ${roundsText(t.settings.finalRounds)}${t.settings.thirdPlace ? ", with a match for third place" : ""} · breaks: ${BREAK_FIELDS.map(([key, label]) => `${label.toLowerCase()} ${seconds(t.settings.breaks[key])}`).join(", ")}</p>
		${_editing ? formHtml(t) : ""}
		<div class="flex gap-2 flex-wrap mb-6">${actions}</div>
		${t.status === "live" ? liveHtml(t) : ""}
		${t.status === "finished" ? resultsHtml(t) : ""}
		${t.status === "draft" || t.status === "open" ? rosterHtml(t) : ""}
		${t.rounds.length ? bracketHtml(t) : ""}`;
}

function rosterHtml(t) {
	const checked = t.roster.filter((r) => r.checked_in).length;
	return `<section class="mb-6">
		<div class="flex items-center gap-2 mb-2">
			<h3 class="font-bold">Players</h3>
			<span class="text-xs text-zinc-500">${t.roster.length} on the list · ${checked} checked in</span>
			<button onclick="shuffleTournament()" class="m-btn m-btn-text m-btn-sm ml-auto"><span class="material-symbols-outlined">shuffle</span>Shuffle</button>
		</div>
		<p class="text-xs text-zinc-500 mb-3">The order is the seeding: the first player meets the last in the opening round, and the top two can only meet in the final. Players check in on the tournament page; you can tick them in here too.</p>
		<form onsubmit="addTournamentPlayers(event)" class="flex gap-2 mb-3 max-w-2xl">
			<input name="usernames" class="m-field flex-1" placeholder="Usernames, separated by spaces or commas" autocomplete="off" />
			<button class="m-btn m-btn-filled">Add</button>
		</form>
		<div class="flex flex-col gap-1.5 max-w-2xl">${
			t.roster.length
				? t.roster
						.map((r, i) => {
							const p = t.players[r.user_id] || {};
							return `<div class="bg-zinc-900 rounded-xl px-3 py-2 flex items-center gap-3">
								<span class="text-xs font-mono text-zinc-600 w-5 text-right">${i + 1}</span>
								${avatarHtml(p.avatar_url, "w-7 h-7")}
								<button onclick="openUserPanel(${r.user_id})" class="flex-1 min-w-0 text-left text-sm truncate hover:underline">${escHtml(p.display_name || p.username || "Player")} <span class="text-zinc-500">@${escHtml(p.username || "")}</span></button>
								<button onclick="setTournamentCheckIn(${r.user_id}, ${!r.checked_in})" class="m-tag ${r.checked_in ? "success" : ""}" title="${r.checked_in ? "Mark as not here" : "Check them in"}">${r.checked_in ? "Checked in" : "Not checked in"}</button>
								<button onclick="moveTournamentPlayer(${r.user_id}, -1)" class="m-icon-btn" aria-label="Move up" ${i === 0 ? "disabled" : ""}><span class="material-symbols-outlined">arrow_upward</span></button>
								<button onclick="moveTournamentPlayer(${r.user_id}, 1)" class="m-icon-btn" aria-label="Move down" ${i === t.roster.length - 1 ? "disabled" : ""}><span class="material-symbols-outlined">arrow_downward</span></button>
								<button onclick="removeTournamentPlayer(${r.user_id})" class="m-icon-btn" aria-label="Remove"><span class="material-symbols-outlined">close</span></button>
							</div>`;
						})
						.join("")
				: '<p class="text-sm text-zinc-500 py-4">Nobody yet. Add players by username.</p>'
		}</div>
	</section>`;
}

function liveHtml(t) {
	const phase = t.phase;
	const timed = phase.kind === "break" || phase.kind === "result";
	const paused = phase.paused_left !== null;
	const played = t.rounds.some((r) => r.matches.some((m) => m.game_id !== null));
	const current =
		phase.match_id !== null ? t.rounds.flatMap((r) => r.matches).find((m) => m.id === phase.match_id) : null;
	const vs = current ? current.players.map((p) => (p === null ? "?" : escHtml(nameOf(t, p)))).join(" vs ") : "";
	return `<section class="bg-zinc-900 rounded-2xl p-5 mb-6 max-w-3xl">
		<div class="flex items-center gap-3 flex-wrap">
			<div class="flex-1 min-w-0">
				<div class="text-xs uppercase tracking-wider text-zinc-500 font-semibold">Now</div>
				<div class="font-bold text-lg">${PHASE_TEXT[phase.kind] || phase.kind}${vs ? ` · ${vs}` : ""}</div>
				${phase.kind === "hold" && HOLD_REASONS[phase.reason] ? `<p class="text-sm text-amber-300 mt-1">${HOLD_REASONS[phase.reason]}</p>` : ""}
				${
					current && ["break", "hold"].includes(phase.kind)
						? `<p class="text-xs text-zinc-500 mt-1">Ready: ${
								current.players
									.filter((p) => p !== null && t.ready.includes(p))
									.map((p) => escHtml(nameOf(t, p)))
									.join(", ") || "nobody yet"
							}</p>`
						: ""
				}
			</div>
			${timed ? `<div class="text-3xl font-mono font-bold" ${paused ? "" : `data-ends="${phase.ends_at}" data-offset="${t.now - Date.now()}"`}>${paused ? "Paused" : ""}</div>` : ""}
		</div>
		<div class="flex gap-2 flex-wrap mt-4">
			${timed ? `<button onclick="tournamentControl('skip')" class="m-btn m-btn-filled m-btn-sm">${phase.kind === "break" ? "Start now" : "Move on"}</button>` : ""}
			${timed ? `<button onclick="tournamentControl('add_time')" class="m-btn m-btn-tonal m-btn-sm">+1 minute</button>` : ""}
			${timed ? `<button onclick="tournamentControl('${paused ? "resume" : "pause"}')" class="m-btn m-btn-tonal m-btn-sm">${paused ? "Resume" : "Pause"}</button>` : ""}
			${phase.kind === "hold" ? `<button onclick="tournamentControl('continue')" class="m-btn m-btn-success m-btn-sm">Continue</button>` : ""}
			${!played ? `<button onclick="redrawTournament()" class="m-btn m-btn-text m-btn-sm">Draw the bracket again</button>` : ""}
		</div>
		<form onsubmit="sendTournamentMessage(event)" class="flex gap-2 mt-4">
			<input name="text" maxlength="200" class="m-field flex-1" placeholder="Message everyone watching" value="${escHtml(t.message?.text || "")}" />
			<button class="m-btn m-btn-tonal">Post</button>
			${t.message ? `<button type="button" onclick="clearTournamentMessage()" class="m-btn m-btn-text">Clear</button>` : ""}
		</form>
	</section>`;
}

function resultsHtml(t) {
	const until = t.results_until ? t.results_until * 1000 : null;
	const showing = until !== null && until > Date.now();
	const later = new Date(Date.now() + 12 * 3600 * 1000);
	return `<section class="bg-zinc-900 rounded-2xl p-5 mb-6 max-w-3xl">
		<div class="text-xs uppercase tracking-wider text-zinc-500 font-semibold">Results</div>
		<p class="font-semibold mt-1">${showing ? `On the home page and Specials until ${escHtml(new Date(until).toLocaleString())}` : "Not on the home page"}</p>
		<p class="text-xs text-zinc-500 mt-1">The results page stays at its link either way.</p>
		<form onsubmit="setTournamentResults(event)" class="flex gap-2 flex-wrap items-center mt-4">
			<label class="text-xs text-zinc-400 flex items-center gap-2">Show until
				<input name="until" type="datetime-local" class="m-field !w-auto" value="${toLocalInput(Math.floor((showing ? until : later.getTime()) / 1000))}" required />
			</label>
			<button class="m-btn m-btn-filled m-btn-sm">${showing ? "Change" : "Show"}</button>
			${showing ? '<button type="button" onclick="hideTournamentResults()" class="m-btn m-btn-text m-btn-sm">Hide now</button>' : ""}
		</form>
	</section>`;
}

function setTournamentResults(e) {
	e.preventDefault();
	const until = new Date(e.target.until.value).getTime();
	act("/results", { json: { until } }, "Saved");
}

const hideTournamentResults = () => act("/results", { json: { until: null } }, "Hidden");

function bracketHtml(t) {
	const live = t.status === "live";
	let number = 0;
	return `<section class="flex flex-col gap-5 max-w-3xl">${t.rounds
		.map(
			(round) => `<div>
				<h3 class="font-bold mb-2">${escHtml(round.name)} <span class="text-xs text-zinc-500 font-normal">${roundsText(round.match_rounds)}</span></h3>
				<div class="flex flex-col gap-1.5">${[...round.matches]
					.sort((a, b) => (a.third ? -1 : a.index) - (b.third ? -1 : b.index))
					.map((m) => matchRowHtml(t, m, m.third ? 0 : ++number, live))
					.join("")}</div>
			</div>`
		)
		.join("")}</section>`;
}

function matchRowHtml(t, m, number, live) {
	const known = (side) => m.players[side] !== null || m.closed[side];
	const sideHtml = (side) => {
		const id = m.players[side];
		const label =
			id !== null
				? escHtml(nameOf(t, id))
				: m.closed[side]
					? '<span class="text-zinc-500">Bye</span>'
					: '<span class="text-zinc-600">To be decided</span>';
		const won = m.status === "done" && id !== null && m.winner === id;
		const tools =
			live && m.status === "waiting" && (known(side) || m.round === 0)
				? `<button onclick="setTournamentSlot(${m.id}, ${side})" class="text-xs text-blue-400 hover:underline">${id === null ? "Fill" : "Swap"}</button>${id !== null ? ` <button onclick="removeTournamentPlayer(${id})" class="text-xs text-red-400 hover:underline">Take out</button>` : ""}`
				: "";
		return `<span class="flex items-center gap-2 min-w-0 ${won ? "font-bold text-white" : ""}">${label}${m.scores && id !== null ? ` <span class="font-mono text-xs text-zinc-400">${m.scores[side].toLocaleString()}</span>` : ""} ${tools}</span>`;
	};
	const award =
		live && m.status !== "done" && m.players.every((p) => p !== null)
			? m.players
					.map(
						(p) =>
							`<button onclick="awardTournamentMatch(${m.id}, ${p})" class="m-btn m-btn-text m-btn-sm">${escHtml(nameOf(t, p))} wins</button>`
					)
					.join("")
			: "";
	const status =
		m.status === "live"
			? `<span class="m-tag danger">Live</span> <a href="/duel/${escHtml(m.code)}?spectate" target="_blank" rel="noopener" class="m-btn m-btn-tonal m-btn-sm">Watch</a> <button onclick="restartTournamentMatch(${m.id})" class="m-btn m-btn-text m-btn-sm">Restart</button>`
			: m.status === "done"
				? `<span class="m-tag">${m.decided === "bye" ? "Walkover" : m.decided === "staff" ? "Staff decision" : m.decided === "forfeit" ? "Forfeit" : m.decided === "no_show" ? "No-show" : "Played"}</span>`
				: "";
	return `<div class="bg-zinc-900 rounded-xl px-3 py-2 flex items-center gap-3 flex-wrap ${t.phase.match_id === m.id ? "ring-1 ring-blue-500" : ""}">
		<span class="text-xs font-mono text-zinc-600 w-14">${m.third ? "3rd place" : `Match ${number}`}</span>
		<span class="flex-1 min-w-0 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 text-sm">${sideHtml(0)}<span class="text-zinc-600 hidden sm:inline">vs</span>${sideHtml(1)}</span>
		${status}${award}
	</div>`;
}

let _lastPoll = 0;

function tickClock() {
	if (currentTab !== "tournaments") return clearInterval(_clock);
	/** Without the live stream, check every few seconds. */
	if (
		!live.connected &&
		["open", "live"].includes(_tournament?.status) &&
		Date.now() - _lastPoll > 5000 &&
		!_busy &&
		!_editing
	) {
		_lastPoll = Date.now();
		api(`/api/admin/tournaments/${_tournamentId}`)
			.then((t) => {
				if (t.id !== _tournamentId || t.version === _tournament?.version || _editing) return;
				_tournament = t;
				renderTournament();
			})
			.catch(() => {});
	}
	for (const node of document.querySelectorAll("#tab-content [data-ends]")) {
		const left = Math.max(
			0,
			Math.ceil((Number(node.dataset.ends) - Date.now() - Number(node.dataset.offset || 0)) / 1000)
		);
		node.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
	}
}

async function act(path, options = {}, done = "") {
	if (_busy) return;
	_busy = true;
	try {
		const t = await api(`/api/admin/tournaments/${_tournamentId}${path}`, { method: "POST", ...options });
		_tournament = t.tournament || t;
		if (done) showToast(done, "success");
		renderTournament();
		return t;
	} catch (err) {
		showToast(err.message, "error");
	} finally {
		_busy = false;
	}
}

const tournamentAction = (name) => act(`/${name}`, {}, name === "open" ? "Check-in is open" : "");
const tournamentControl = (action) => act("/control", { json: { action } });

async function startTournament() {
	/** Players check in up to the last moment, so count them now. */
	try {
		_tournament = await api(`/api/admin/tournaments/${_tournamentId}`);
		renderTournament();
	} catch {}
	const checked = _tournament.roster.filter((r) => r.checked_in).length;
	const ok = await showConfirm(
		"Start the tournament?",
		`The bracket is drawn from the ${checked} checked-in player${checked === 1 ? "" : "s"}, and the countdown to the first match begins. Anyone not checked in is left out; you can still add them to an empty place later.`,
		{ confirmLabel: "Start", confirmClass: "m-btn-success" }
	);
	if (ok) act("/start", {}, "Started");
}

async function redrawTournament() {
	if (
		await showConfirm("Draw the bracket again?", "Everyone checked in gets a new place, in list order.", {
			confirmLabel: "Draw again",
			confirmClass: "m-btn-filled",
		})
	)
		act("/redraw");
}

async function cancelTournament() {
	if (
		await showConfirm(
			"Cancel the tournament?",
			"Any match being played is stopped and nobody wins. This can't be undone.",
			{ confirmLabel: "Cancel tournament" }
		)
	)
		act("/cancel", {}, "Tournament cancelled");
}

async function deleteTournament() {
	if (
		!(await showConfirm("Delete this tournament?", "Its bracket and results are removed for good.", {
			confirmLabel: "Delete",
		}))
	)
		return;
	try {
		await api(`/api/admin/tournaments/${_tournamentId}`, { method: "DELETE" });
		backToTournaments();
	} catch (err) {
		showToast(err.message, "error");
	}
}

async function addTournamentPlayers(e) {
	e.preventDefault();
	const input = e.target.usernames;
	const result = await act("/players", { json: { usernames: input.value } });
	if (!result) return;
	if (result.missing.length) showToast(`No player called ${result.missing.join(", ")}`, "error");
	else if (result.limited.length)
		showToast(`Not added, their duels are limited: ${result.limited.join(", ")}`, "error");
	else if (result.added.length) showToast(`Added ${result.added.length}`, "success");
	el("tab-content").querySelector("[name=usernames]")?.focus();
}

const setTournamentCheckIn = (userId, value) => act(`/players/${userId}/checkin`, { json: { checked_in: value } });
const moveTournamentPlayer = (userId, by) => act(`/players/${userId}/move`, { json: { by } });
const shuffleTournament = () => act("/shuffle", {}, "Shuffled");

async function removeTournamentPlayer(userId) {
	const t = _tournament;
	if (t.status === "live") {
		const ok = await showConfirm(
			`Take ${nameOf(t, userId)} out?`,
			"They leave the bracket and their opponent goes through. A match they're playing ends now.",
			{ confirmLabel: "Take out" }
		);
		if (!ok) return;
	}
	act(`/players/${userId}`, { method: "DELETE" });
}

async function setTournamentSlot(matchId, side) {
	const username = await showPrompt("Who plays here?", "Username", {
		note: "They can be anyone not already in the bracket. Their match countdown starts again if it's next.",
		okLabel: "Put them in",
	});
	if (username) act(`/matches/${matchId}/slot`, { json: { side, username } });
}

async function awardTournamentMatch(matchId, userId) {
	const ok = await showConfirm(
		`Give the match to ${nameOf(_tournament, userId)}?`,
		"They go through without the match being played to the end.",
		{
			confirmLabel: "Give the match",
			confirmClass: "m-btn-filled",
		}
	);
	if (ok) act(`/matches/${matchId}/award`, { json: { user_id: userId } });
}

async function restartTournamentMatch(matchId) {
	if (
		await showConfirm(
			"Restart this match?",
			"It stops now and starts again from the first round after a short break.",
			{ confirmLabel: "Restart", confirmClass: "m-btn-filled" }
		)
	)
		act(`/matches/${matchId}/restart`);
}

function sendTournamentMessage(e) {
	e.preventDefault();
	act("/message", { json: { text: e.target.text.value } }, "Posted");
}

const clearTournamentMessage = () => act("/message", { json: { text: "" } });

/** Updates without a reload. */
onLive("tournament", (summary) => {
	if (currentTab !== "tournaments" || !_tournamentId || _busy) return;
	if (summary && summary.id !== _tournamentId) return;
	if (summary && _tournament && summary.version === _tournament.version) return;
	api(`/api/admin/tournaments/${_tournamentId}`)
		.then((t) => {
			if (_editing || t.id !== _tournamentId) return;
			_tournament = t;
			renderTournament();
		})
		.catch(() => {});
});

/** Called from inline handlers in the markup. */
Object.assign(window, {
	addTournamentPlayers,
	awardTournamentMatch,
	backToTournaments,
	cancelTournament,
	clearTournamentMessage,
	deleteTournament,
	hideTournamentResults,
	loadTournaments,
	moveTournamentPlayer,
	newTournament,
	openTournament,
	redrawTournament,
	removeTournamentPlayer,
	restartTournamentMatch,
	saveTournament,
	sendTournamentMessage,
	setTournamentCheckIn,
	setTournamentResults,
	setTournamentSlot,
	shuffleTournament,
	startTournament,
	toggleTournamentEdit,
	tournamentAction,
	tournamentControl,
});
