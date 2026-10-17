import { Sounds } from "./sounds.js";
import { avatarHtml, el, escHtml, prefersReducedMotion } from "./lib/dom.js";
import { api, loginUrl } from "./lib/api.js";
import { showToast } from "./lib/toast.js";
import { celebrate } from "./lib/effects.js";
import { live, onLive } from "./lib/live.js";
import { setChatInMatch, startChat } from "./tournament-chat.js";

/** The tournament page: the bracket and breaks, handing each match to the duel screens. Once finished, its results. */

/** How often to check without the live stream. */
const POLL_MS = 5000;
/** A duel round plus its result, roughly, for the wait estimate. */
const ROUND_SECONDS = 80;
const CHIMES_AT = [300, 60];

/** Bracket layout, in CSS pixels. */
const CARD_W = 208;
const CARD_H = 84;
const ROW_GAP = 16;
const COL_GAP = 48;
const HEAD_H = 28;
/** Below this width the bracket shows one round at a time instead of shrinking. */
const NARROW_PX = 640;

const HOLD_TEXT = {
	not_ready: ["Waiting for the players", "The match starts once both players are ready."],
	no_show: ["Waiting for staff", "A player didn't join their match."],
	no_winner: ["Waiting for staff", "Both players left the match."],
	closed: ["Match stopped", "Staff will start it again shortly."],
	restart: ["Back after a restart", "Staff will carry on shortly."],
	staff: ["Waiting for staff", ""],
};

const DECIDED_TEXT = {
	sudden_death: "Sudden death",
	tiebreak: "Tiebreak",
	forfeit: "Forfeit",
	no_show: "No-show",
	not_ready: "Didn't ready up",
	staff: "Staff decision",
	bye: "Walkover",
};

const LABEL = "text-xs text-zinc-500 uppercase tracking-widest font-medium";

let id = 0;
let user = null;
let duel = null;
let state = null;
let offset = 0;
let root = null;
/** The room on screen, and one the viewer dropped out of, which is not rejoined by itself. */
let inMatch = null;
let leftMatch = null;
let revealed = false;
let loading = false;
let again = false;
let lastSecond = null;
const alerted = new Set();
/** Lobby: who was checked in last time it was drawn (null before the first), and the bar's last width. */
let seenCheckedIn = null;
let lastProgress = 0;
let justCheckedIn = false;
let lobbyEntered = false;
let seenMessage = null;
let seenNotice = null;
/** Narrow screens: the round shown, or null to follow the match being played. */
let shownRound = null;
/** Rounds played at once: the match shown, the viewer's choice (match id, "bracket" or null), and the end-screen pause. */
let watching = null;
let watchingBatch = false;
let watchChoice = null;
let lingerUntil = 0;
let lingerTimer = null;
let switcherOpen = false;
const LINGER_MS = 10_000;

/** From an invite link: /tournament/5?invite=CODE. */
const inviteCode = () => new URLSearchParams(location.search).get("invite") || "";

const serverNow = () => Date.now() + offset;
const player = (userId) => state.players[userId] || null;
const nameOf = (userId) => player(userId)?.display_name || player(userId)?.username || "Player";
const isMe = (userId) => user !== null && userId === user.id;
const roundsText = (n) => `${n} round${n === 1 ? "" : "s"}`;

/** Every match, in the order they are played. */
function allMatches() {
	return state.rounds
		.flatMap((round, r) => round.matches.map((m) => ({ ...m, round: r })))
		.sort((a, b) => a.round - b.round || (a.third ? -1 : a.index) - (b.third ? -1 : b.index));
}

const matchById = (matchId) => allMatches().find((m) => m.id === matchId) || null;
const matchNumber = (matchId) =>
	allMatches()
		.filter((m) => !m.third)
		.findIndex((m) => m.id === matchId) + 1;
/** "Semi-finals · Match 5", or just "Third place". */
const matchTitle = (m) => (m.third ? m.name : `${m.name} · Match ${matchNumber(m.id)}`);
const ready = (userId) => state.ready.includes(userId);
const isFinalRound = (m) => m.round === state.rounds.length - 1;
const liveMatches = () => allMatches().filter((m) => m.status === "live" && m.code);
/** The round being played all at once, or its break; null when matches go one at a time. */
const batchRound = () => state.phase.round ?? null;

/** Own match, then the viewer's pick, the featured match, the current one, then the closest. */
function pickWatch() {
	const live = liveMatches();
	const mine = live.find((m) => m.players.some(isMe));
	if (mine) return mine;
	if (watchChoice === "bracket") return null;
	const chosen = live.find((m) => m.id === watchChoice);
	if (chosen) return chosen;
	if (typeof watchChoice === "number") watchChoice = null;
	const featured = live.find((m) => m.id === state.featured);
	if (featured) return featured;
	const current = live.find((m) => m.id === watching);
	if (current) return current;
	const gap = (m) => (m.live ? Math.abs(m.live.scores[0] - m.live.scores[1]) : Number.MAX_SAFE_INTEGER);
	return [...live].sort((a, b) => gap(a) - gap(b))[0] ?? null;
}

function ordinal(n) {
	const tail = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th";
	return `${n}${tail}`;
}

function clock(ms) {
	const s = Math.max(0, Math.ceil(ms / 1000));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = String(s % 60).padStart(2, "0");
	return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function startStage(tournamentId, viewer, duelControls) {
	id = tournamentId;
	user = viewer;
	duel = duelControls;
	root = document.createElement("div");
	root.id = "stage";
	root.className = "stage";
	root.innerHTML = `
		<div class="flex items-center justify-between gap-3 px-5 py-4 flex-shrink-0">
			<a href="/" class="flex items-center gap-1.5 text-zinc-500 hover:text-zinc-300 transition text-sm">
				<span class="material-symbols-outlined text-base leading-none">arrow_back</span> Home
			</a>
			<div class="flex items-center gap-2">
				<span id="stage-watching" class="hidden text-xs text-zinc-500 items-center gap-1"></span>
				<button id="stage-sound" class="w-9 h-9 rounded-full flex items-center justify-center text-zinc-400 hover:text-white hover:bg-zinc-800 transition"><span class="material-symbols-outlined text-xl"></span></button>
			</div>
		</div>
		<main class="w-full max-w-6xl mx-auto px-4 sm:px-6 pb-16 flex flex-col gap-8">
			<div id="stage-message" class="hidden bg-zinc-900 border border-zinc-800 rounded-2xl px-4 py-3 text-sm flex items-center gap-3 max-w-2xl mx-auto w-full" role="status"></div>
			<section id="stage-hero" class="text-center flex flex-col items-center" aria-live="polite"></section>
			<p id="stage-me" class="hidden text-center text-sm text-zinc-300 -mt-4"></p>
			<section id="stage-standings" class="hidden"></section>
			<section id="stage-bracket-wrap" class="hidden">
				<div id="stage-rounds" class="hidden flex gap-1.5 flex-wrap justify-center mb-4"></div>
				<div id="stage-bracket" class="bk"></div>
			</section>
			<section id="stage-roster" class="hidden"></section>
		</main>
		<button id="stage-sound-hint" class="hidden fixed bottom-4 left-1/2 -translate-x-1/2 z-10 m-btn m-btn-tonal m-btn-sm">
			<span class="material-symbols-outlined">volume_up</span>Click anywhere for sound
		</button>
		<div id="stage-banner" class="stage-banner" aria-hidden="true"></div>`;
	document.body.appendChild(root);
	const switcher = document.createElement("div");
	switcher.id = "match-switcher";
	switcher.className = "hidden fixed top-3 left-1/2 -translate-x-1/2 z-[48] flex flex-col items-center";
	switcher.addEventListener("click", onClick);
	document.body.appendChild(switcher);
	document.addEventListener("click", (e) => {
		if (switcherOpen && !switcher.contains(e.target)) {
			switcherOpen = false;
			renderSwitcher();
		}
	});
	const endCount = document.createElement("p");
	endCount.id = "stage-end-count";
	endCount.className = "hidden text-zinc-500 text-sm mt-2";
	el("end-series")?.after(endCount);

	el("stage-sound").addEventListener("click", toggleSound);
	root.addEventListener("click", onClick);
	paintSound();
	const unlock = () => {
		Sounds.unlock();
		setTimeout(paintSound, 50);
	};
	document.addEventListener("pointerdown", unlock);
	document.addEventListener("keydown", unlock);
	swipeRounds(el("stage-bracket"));
	let wasNarrow = null;
	new ResizeObserver(() => {
		const narrow = isNarrow();
		if (state && narrow !== wasNarrow) renderBracket(null);
		else fitBracket();
		wasNarrow = narrow;
	}).observe(el("stage-bracket-wrap"));

	refresh();
	startChat(tournamentId, viewer);
	onLive("tournament", (summary) => {
		if (!state || !summary || summary.id !== id || summary.version !== state.version) refresh();
	});
	onLive("watching", (data) => {
		const count = data?.count ?? 0;
		const box = el("stage-watching");
		box.classList.toggle("hidden", count < 2);
		box.classList.toggle("flex", count >= 2);
		box.innerHTML = `<span class="material-symbols-outlined text-base">visibility</span>${count.toLocaleString()} watching`;
	});
	setInterval(() => !live.connected && !document.hidden && refresh(), POLL_MS);
	document.addEventListener("visibilitychange", () => !document.hidden && refresh());
	setInterval(tick, 250);

	return {
		/** For the duel's versus screen. */
		label() {
			const m = !state
				? null
				: watchingBatch
					? matchById(watching)
					: state.phase.match_id !== null
						? matchById(state.phase.match_id)
						: null;
			return m ? matchTitle(m) : "Tournament";
		},
		/** For a spectator's end screen. */
		pickResult(winnerId) {
			const m = state && state.phase.match_id !== null ? matchById(state.phase.match_id) : null;
			const mine = m ? state.my_votes?.[m.id] : undefined;
			if (mine === undefined || winnerId == null) return "";
			return m.players[mine] === winnerId ? "You called it." : "Not your pick this time.";
		},
		/** The connection dropped or the room closed. */
		matchLeft() {
			if (!inMatch) return;
			leftMatch = inMatch;
			inMatch = null;
			watching = null;
			renderSwitcher();
			showStage();
			render(null);
			refresh();
		},
	};
}

/** `force` redraws for fresh live scores even when the version is unchanged. */
async function refresh(force = false) {
	if (loading) return void (again = true);
	loading = true;
	try {
		const next = await api(`/api/tournaments/${id}`);
		if (force || !state || next.version !== state.version || next.status !== state.status) apply(next);
		else offset = next.now - Date.now();
	} catch (err) {
		if (!state) {
			el("stage-hero").innerHTML =
				`<h1 class="text-4xl font-bold">${err.status === 404 ? "Tournament not found" : "Couldn't load the tournament"}</h1>
				<p class="text-zinc-500 mt-2">${err.status === 404 ? "It may have been removed." : escHtml(err.message)}</p>
				<a href="/" class="m-btn m-btn-tonal mt-6">Home</a>`;
		}
	} finally {
		loading = false;
		if (again) {
			again = false;
			refresh();
		}
	}
}

function apply(next) {
	const prev = state;
	state = next;
	offset = next.now - Date.now();
	const watched = watching !== null ? matchById(watching) : null;
	/** A finished match in a round played all at once stays on its end screen for a moment. */
	if (inMatch && watchingBatch && watched?.status === "done" && !lingerTimer) {
		lingerUntil = Date.now() + LINGER_MS;
		lingerTimer = setTimeout(() => {
			lingerTimer = null;
			if (typeof watchChoice === "number") watchChoice = null;
			follow();
			render(state);
		}, LINGER_MS);
	}
	follow();
	render(prev);
}

/** Shows the match the viewer should be watching, or the stage when there is none. */
function follow() {
	if (lingerTimer) return;
	const phase = state.phase;
	if (phase.kind === "batch") {
		const target = pickWatch();
		if (target && target.code !== inMatch && target.code !== leftMatch) enterMatch(target, true);
		else if (!target && inMatch) leaveMatch();
	} else if (phase.kind === "match" && phase.code) {
		if (inMatch !== phase.code && leftMatch !== phase.code) enterMatch(matchById(phase.match_id), false);
	} else if (phase.kind !== "result" && inMatch) {
		leaveMatch();
	} else if (phase.kind === "result" && !inMatch) {
		showStage();
	}
}

function enterMatch(m, batch) {
	if (!m?.code) return;
	const fromStage = !inMatch;
	inMatch = m.code;
	watching = m.id;
	watchingBatch = batch;
	leftMatch = null;
	switcherOpen = false;
	if (fromStage) {
		Sounds.play("horn");
		root.classList.add("stage-leaving");
		setTimeout(() => inMatch === m.code && (root.hidden = true), prefersReducedMotion() ? 0 : 350);
	}
	duel.join(m.code, m.players.some(isMe));
	setChatInMatch(true);
	renderSwitcher();
}

function leaveMatch() {
	inMatch = null;
	watching = null;
	duel.leave();
	setChatInMatch(false);
	renderSwitcher();
	showStage();
}

/** The bar over a match in a round played all at once, for switching to another or back to automatic. */
function renderSwitcher() {
	const box = el("match-switcher");
	if (!box) return;
	const watched = watching !== null ? matchById(watching) : null;
	const showing =
		!!state &&
		!!inMatch &&
		watchingBatch &&
		!!watched &&
		!watched.players.some(isMe) &&
		state.phase.kind === "batch";
	box.classList.toggle("hidden", !showing);
	if (!showing) return;
	const live = liveMatches();
	const vs = (m) => `${escHtml(nameOf(m.players[0]))} vs ${escHtml(nameOf(m.players[1]))}`;
	const check = (on) =>
		`<span class="material-symbols-outlined text-base ${on ? "text-blue-400" : "invisible"}">check</span>`;
	const item = (action, label, sub, on, extra = "") =>
		`<button data-action="${action}" ${extra} class="w-full flex items-center gap-2 text-left px-3 py-2 rounded-xl hover:bg-zinc-800 transition">
			${check(on)}<span class="flex-1 min-w-0"><span class="block text-sm truncate">${label}</span>${sub ? `<span class="block text-xs text-zinc-500">${sub}</span>` : ""}</span>
		</button>`;
	box.innerHTML = `<button data-action="switcher" aria-expanded="${switcherOpen}" class="flex items-center gap-1.5 bg-zinc-900/95 border border-zinc-800 rounded-full pl-3 pr-2 py-1.5 text-xs shadow-lg max-w-[70vw]">
			<span class="truncate">${vs(watched)}</span>
			<span class="text-zinc-500 flex-shrink-0">· ${live.length} live${watchChoice === null ? " · Automatic" : ""}</span>
			<span class="material-symbols-outlined text-base flex-shrink-0">expand_more</span>
		</button>
		${
			switcherOpen
				? `<div class="mt-2 bg-zinc-900 border border-zinc-800 rounded-2xl p-1.5 w-80 max-w-[92vw] max-h-[60vh] overflow-y-auto shadow-xl">
				${item("auto", "Automatic", "Follows the featured or closest match", watchChoice === null)}
				${live
					.map((m) =>
						item(
							"watch-match",
							vs(m),
							[
								`Match ${matchNumber(m.id)}`,
								m.live ? `round ${m.live.round} of ${m.live.rounds}` : "",
								m.live
									? `${m.live.scores[0].toLocaleString()} to ${m.live.scores[1].toLocaleString()}`
									: "",
								m.id === state.featured ? "Featured" : "",
							]
								.filter(Boolean)
								.join(" · "),
							watchChoice === m.id,
							`data-match="${m.id}"`
						)
					)
					.join("")}
				${item("bracket", "Show the bracket", "", false)}
			</div>`
				: ""
		}`;
}

function showStage() {
	if (!root.hidden && !root.classList.contains("stage-leaving")) return;
	root.hidden = false;
	root.classList.remove("stage-leaving");
	root.classList.add("stage-entering");
	setTimeout(() => root.classList.remove("stage-entering"), 500);
	requestAnimationFrame(fitBracket);
}

/* ---- Drawing ---- */

function render(prev) {
	if (!state) return;
	document.title = `${state.title} | Dovedale GeoGuesser`;
	const phase = state.phase;
	const upNext = phase.match_id !== null ? matchById(phase.match_id) : null;
	const isFinal = !!upNext && isFinalRound(upNext) && !upNext.third && ["break", "hold"].includes(phase.kind);
	renderHero(prev, upNext, isFinal);
	renderMe();
	renderMessage(prev);
	renderStandings();
	renderBracket(prev);
	renderRoster();
	renderSwitcher();
	cues(prev, upNext);
}

function titleHtml(line) {
	return `<div class="${LABEL} mb-2">${escHtml(line)}</div>
		<h1 class="text-4xl font-bold tracking-tight">${escHtml(state.title)}</h1>`;
}

function renderHero(prev, upNext, isFinal) {
	const phase = state.phase;
	const samePanel = prev && prev.phase.kind === phase.kind && prev.phase.match_id === phase.match_id;
	let html = "";

	if (state.status === "finished") {
		const champ = state.champion;
		html = champ
			? `<div class="stage-champion flex flex-col items-center">
				<span class="material-symbols-outlined text-5xl text-yellow-400" style="font-variation-settings:'FILL' 1">emoji_events</span>
				<div class="mt-3">${avatarHtml(player(champ)?.avatar_url, "w-24 h-24 border-4 border-zinc-800")}</div>
				<div class="${LABEL} mt-5 mb-1">Champion</div>
				<h1 class="text-4xl font-bold tracking-tight">${escHtml(nameOf(champ))}</h1>
				<p class="text-zinc-500 text-sm mt-1">Winner of ${escHtml(state.title)}</p>
			</div>`
			: titleHtml("Finished");
	} else if (state.status === "cancelled") {
		html = `${titleHtml("Cancelled")}<p class="text-zinc-500 text-sm mt-2">This tournament was called off.</p>`;
	} else if (state.status !== "live") {
		html = lobbyHero();
	} else if (phase.kind === "batch") {
		html = batchHero();
	} else if (phase.kind === "break" && phase.round !== null) {
		const mine = allMatches().find(
			(m) => m.round === phase.round && m.status === "waiting" && m.players.some(isMe)
		);
		const count = allMatches().filter((m) => m.round === phase.round && m.status === "waiting").length;
		html = `${titleHtml("Tournament")}
			<div class="${LABEL} mt-8">${escHtml(phase.label === "start" ? "Starting in" : `${state.rounds[phase.round].name} in`)}</div>
			${countdownHtml(phase)}
			${
				mine
					? versusHtml(mine, { animate: !samePanel }) + readyHtml(mine)
					: `<p class="text-zinc-400 mt-4">All ${count} matches in ${escHtml(state.rounds[phase.round].name.toLowerCase())} start together.</p>
						<p class="text-zinc-500 text-sm mt-1">You'll follow one automatically, and can switch at any time.</p>`
			}`;
	} else if (phase.kind === "break") {
		const line =
			phase.label === "start"
				? "Starting in"
				: phase.label === "final"
					? "The final starts in"
					: phase.label === "round" && upNext
						? `${upNext.name} in`
						: "Next match in";
		html = `${titleHtml("Tournament")}
			<div class="${LABEL} mt-8">${escHtml(line)}</div>
			${countdownHtml(phase)}
			${upNext ? versusHtml(upNext, { animate: !samePanel, final: isFinal }) + readyHtml(upNext) + pickHtml(upNext) : ""}`;
	} else if (phase.kind === "hold") {
		const [title, sub] = HOLD_TEXT[phase.reason] || HOLD_TEXT.staff;
		html = `${titleHtml("Tournament")}
			<div class="text-xl font-bold mt-8">${escHtml(title)}</div>
			${sub ? `<p class="text-zinc-500 text-sm mt-1">${escHtml(sub)}</p>` : ""}
			${upNext ? versusHtml(upNext, { animate: !samePanel, final: isFinal }) + readyHtml(upNext) + pickHtml(upNext) : ""}`;
	} else if (phase.kind === "match" && upNext) {
		const mine = upNext.players.some(isMe);
		html = `${titleHtml("Match being played")}
			${versusHtml(upNext, { animate: !samePanel })}
			${picksText(upNext)}
			<button class="m-btn m-btn-filled m-btn-lg mt-6" data-action="watch">${mine ? "Back to your match" : "Watch"}</button>`;
	} else if (phase.kind === "result" && upNext) {
		html = `${titleHtml("Result")}${resultHtml(upNext)}`;
	}
	el("stage-hero").innerHTML = html;
	growProgress();
}

/** A round being played all at once, seen from the stage: progress and every live match. */
function batchHero() {
	const phase = state.phase;
	const inRound = allMatches().filter((m) => m.round === phase.round && !m.third);
	const done = inRound.filter((m) => m.status === "done").length;
	const live = liveMatches();
	const held = inRound.filter((m) => m.status === "waiting");
	const mine = held.find((m) => m.players.some(isMe));
	const row = (m) => {
		const score = m.live ? `${m.live.scores[0].toLocaleString()} to ${m.live.scores[1].toLocaleString()}` : "";
		return `<div class="bg-zinc-900 rounded-2xl px-4 py-3 flex items-center gap-3 text-left ${m.id === state.featured ? "ring-2 ring-blue-500" : ""}">
			<div class="flex-1 min-w-0">
				<div class="text-sm font-semibold truncate">${escHtml(nameOf(m.players[0]))} <span class="text-zinc-500 font-normal">vs</span> ${escHtml(nameOf(m.players[1]))}</div>
				<div class="text-xs text-zinc-500">${[`Match ${matchNumber(m.id)}`, m.live ? `round ${m.live.round} of ${m.live.rounds}` : "", score, m.status === "waiting" ? "Waiting for players" : ""].filter(Boolean).join(" · ")}</div>
			</div>
			${m.status === "live" ? `<button class="m-btn m-btn-tonal m-btn-sm" data-action="watch-match" data-match="${m.id}">Watch</button>` : ""}
		</div>`;
	};
	return `${titleHtml("Tournament")}
		<div class="text-xl font-bold mt-8">${escHtml(state.rounds[phase.round].name)}: ${live.length} playing</div>
		<p class="text-zinc-500 text-sm mt-1">${done} of ${inRound.length} matches done</p>
		${mine ? versusHtml(mine) + readyHtml(mine) : ""}
		${live.length ? '<button class="m-btn m-btn-filled m-btn-lg mt-6" data-action="auto">Watch automatically</button>' : ""}
		<div class="grid gap-2 mt-6 w-full max-w-3xl" style="grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr))">${[...live, ...held.filter((m) => m !== mine)].map(row).join("")}</div>`;
}

/** Days, hours, minutes and seconds left, leaving out days when there are none. */
function clockUnits(ms) {
	const total = Math.max(0, Math.ceil(ms / 1000));
	const units = [
		[Math.floor(total / 86400), "days"],
		[Math.floor((total % 86400) / 3600), "hours"],
		[Math.floor((total % 3600) / 60), "mins"],
		[total % 60, "secs"],
	];
	return (units[0][0] ? units : units.slice(1)).map(([n, label]) => [String(n).padStart(2, "0"), label]);
}

/** The wait before the start, one box per unit. Read out once as a time, not every second. */
function lobbyClockHtml(starts) {
	const at = new Date(starts).toLocaleString(undefined, { weekday: "long", hour: "2-digit", minute: "2-digit" });
	return `<span class="sr-only">Starts ${escHtml(at)}</span>
		<div class="lobby-clock" data-clock-ends="${starts}" aria-hidden="true">${clockUnits(starts - serverNow())
			.map(
				([digits, label]) => `<div class="lobby-unit">
					<div class="lobby-digits" data-unit="${label}">${[...digits].map((d) => `<span class="lobby-digit">${d}</span>`).join("")}</div>
					<div class="lobby-unit-label">${label}</div>
				</div>`
			)
			.join("")}</div>`;
}

/** Updates only the digits that changed, so only those animate. */
function paintClocks() {
	for (const node of root.querySelectorAll("[data-clock-ends]")) {
		const left = Number(node.dataset.clockEnds) - serverNow();
		const units = clockUnits(left);
		if (units.length !== node.querySelectorAll("[data-unit]").length) return render(state);
		for (const [digits, label] of units) {
			const spans = node.querySelectorAll(`[data-unit="${label}"] .lobby-digit`);
			[...digits].forEach((d, i) => {
				const span = spans[i];
				if (!span || span.textContent === d) return;
				span.textContent = d;
				span.classList.remove("roll");
				void span.offsetWidth;
				span.classList.add("roll");
			});
		}
	}
}

/** A negative delay that keeps a looping animation where it was when the hero is redrawn. */
const inPhase = (periodMs) => `animation-delay:-${Date.now() % periodMs}ms`;

function lobbyHero() {
	const starts = state.starts_at ? state.starts_at * 1000 : null;
	const onList = user && state.roster.find((r) => r.user_id === user.id);
	const open = state.status === "open";
	let action = "";
	if (open) {
		if (!user)
			action = `<p class="text-zinc-500 text-sm mt-8">Playing? <a class="underline hover:text-zinc-300" href="${escHtml(loginUrl())}">Log in</a> to ${inviteCode() && state.invite_open ? "join" : "check in"}.</p>`;
		else if (!onList && state.invite_open)
			action = inviteCode()
				? `<button class="m-btn m-btn-lg m-btn-success lobby-cta mt-8" style="${inPhase(2400)}" data-action="join">Join the tournament</button>`
				: `<form class="mt-8 flex gap-2 justify-center" data-join-form>
					<input name="code" maxlength="12" autocomplete="off" placeholder="Invite code" aria-label="Invite code" class="m-field !w-40 uppercase text-center tracking-widest" />
					<button class="m-btn m-btn-tonal" data-action="join">Join</button>
				</form>`;
		else if (onList?.checked_in)
			action = `<p class="${justCheckedIn ? "lobby-done " : ""}text-green-400 font-semibold mt-8 flex items-center gap-2"><span class="material-symbols-outlined" style="font-variation-settings:'FILL' 1">check_circle</span>You're checked in</p>`;
		else if (onList)
			action = `<button class="m-btn m-btn-lg m-btn-success lobby-cta mt-8" style="${inPhase(2400)}" data-action="checkin">I'm here</button>
				<p class="text-zinc-500 text-sm mt-3">Check in to get your place in the bracket.</p>`;
	}
	const timeText = (ms) =>
		new Date(ms).toLocaleString(undefined, {
			weekday: "long",
			day: "numeric",
			month: "long",
			hour: "2-digit",
			minute: "2-digit",
		});
	if (state.status === "announced")
		action = `${onList ? `<p class="text-white font-semibold mt-8 flex items-center gap-2"><span class="material-symbols-outlined text-yellow-400" style="font-variation-settings:'FILL' 1">confirmation_number</span>You're on the list</p>` : ""}
			<p class="text-zinc-400 ${onList ? "mt-2" : "mt-8"}">${state.checkin_at ? `Check-in opens ${escHtml(timeText(state.checkin_at))}.` : "Check-in opens before the start."}</p>`;
	justCheckedIn = false;
	const checked = state.roster.filter((r) => r.checked_in).length;
	const progress = !open
		? ""
		: state.roster.length
			? `<div class="flex flex-col items-center gap-2 mt-8 w-full">
			<div class="lobby-progress" role="progressbar" aria-label="Players checked in" aria-valuemin="0" aria-valuemax="${state.roster.length}" aria-valuenow="${checked}">
				<div class="lobby-progress-bar" style="width:${lastProgress}%" data-progress="${(checked / state.roster.length) * 100}"></div>
			</div>
			<p class="text-sm text-zinc-400">${checked} of ${state.roster.length} checked in</p>
		</div>`
			: "";
	const when = starts ? timeText(starts) : "";
	/** The big entrance plays once per visit; later redraws only update. */
	const entering = !lobbyEntered;
	lobbyEntered = true;
	return `<div class="lobby-event ${entering ? "lobby-enter" : ""}">
			<div class="lobby-rays" style="${inPhase(90_000)}" aria-hidden="true"></div>
			<div class="relative flex flex-col items-center">
				<div class="lobby-trophy" style="${inPhase(3200)}" aria-hidden="true"><span class="material-symbols-outlined">trophy</span></div>
				<div class="lobby-eyebrow">${open ? "Check-in open" : state.status === "draft" ? "Draft" : "Coming up"}${when ? ` · ${escHtml(when)}` : ""}</div>
				<h1 class="lobby-title">${escHtml(state.title)}</h1>
				${state.description ? `<p class="text-zinc-300 text-lg mt-4 max-w-xl whitespace-pre-line">${escHtml(state.description)}</p>` : ""}
				${starts && starts > serverNow() ? `<div class="${LABEL} mt-10">Starts in</div>${lobbyClockHtml(starts)}` : starts ? '<p class="text-zinc-300 text-lg mt-10">Starting soon</p>' : ""}
				${progress}
				${action}
			</div>
			<div class="lobby-track" style="${inPhase(1200)}" aria-hidden="true"></div>
		</div>`;
}

function growProgress() {
	const bar = root.querySelector("[data-progress]");
	if (!bar) return;
	requestAnimationFrame(() =>
		requestAnimationFrame(() => {
			lastProgress = Number(bar.dataset.progress);
			bar.style.width = `${lastProgress}%`;
		})
	);
}

function countdownHtml(phase) {
	if (phase.paused_left !== null)
		return `<div class="stage-count text-zinc-500">${clock(phase.paused_left)}</div><p class="text-zinc-500 text-sm">Paused</p>`;
	return `<div class="stage-count" data-ends="${phase.ends_at}">${clock(phase.ends_at - serverNow())}</div>`;
}

function pathText(userId) {
	const beaten = allMatches()
		.filter((m) => m.status === "done" && m.winner === userId)
		.map((m) => m.players.find((p) => p !== null && p !== userId))
		.filter((p) => p !== undefined && p !== null);
	return beaten.length ? `Beat ${beaten.map(nameOf).join(", ")}` : "";
}

function versusHtml(m, { animate = false, final = false } = {}) {
	const phase = state.phase;
	const showReady =
		m.status === "waiting" &&
		(((phase.kind === "break" || phase.kind === "hold") && phase.match_id === m.id) ||
			(phase.round !== null && m.round === phase.round));
	const side = (userId) => {
		if (userId === null)
			return `<div class="flex flex-col items-center gap-2 w-32 sm:w-40 opacity-50">
				<div class="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-zinc-800 border-2 border-dashed border-zinc-700"></div>
				<span class="text-sm">To be decided</span>
			</div>`;
		const path = final ? pathText(userId) : "";
		return `<div class="flex flex-col items-center gap-2 w-32 sm:w-40">
			${avatarHtml(player(userId)?.avatar_url, `w-16 h-16 sm:w-20 sm:h-20 border-4 ${isMe(userId) ? "border-blue-500" : "border-zinc-800"}`)}
			<span class="font-bold text-sm sm:text-base max-w-full truncate">${escHtml(nameOf(userId))}</span>
			${path ? `<span class="text-xs text-zinc-500">${escHtml(path)}</span>` : ""}
			${showReady ? (ready(userId) ? '<span class="text-xs text-green-400">Ready</span>' : '<span class="text-xs text-zinc-500">Not ready</span>') : ""}
		</div>`;
	};
	return `<div class="${animate ? "versus" : ""} flex items-start justify-center gap-4 sm:gap-8 mt-8">
			${side(m.players[0])}<span class="versus-mark text-2xl sm:text-3xl font-black text-zinc-500 self-center">VS</span>${side(m.players[1])}
		</div>
		<p class="text-zinc-500 text-xs mt-4">${escHtml(matchTitle(m))} · ${roundsText(m.match_rounds)}</p>`;
}

function readyHtml(m) {
	if (!user || !m.players.some(isMe)) return "";
	return ready(user.id)
		? '<p class="text-zinc-400 text-sm mt-5">Waiting for your opponent to get ready</p>'
		: '<button class="m-btn m-btn-lg m-btn-success mt-5" data-action="ready">Ready</button>';
}

function picksText(m) {
	if (!m.votes) return "";
	const total = m.votes[0] + m.votes[1];
	const lead = m.votes[0] >= m.votes[1] ? 0 : 1;
	if (m.players[lead] === null) return "";
	const share = Math.round((m.votes[lead] / total) * 100);
	return `<p class="text-zinc-500 text-sm mt-3">${share}% of ${total} picked ${escHtml(nameOf(m.players[lead]))}</p>`;
}

/** "Who wins?" for logged-in spectators, before the match starts. */
function pickHtml(m) {
	if (!user || m.players.some(isMe) || m.players.some((p) => p === null)) return "";
	const mine = state.my_votes?.[m.id];
	if (mine !== undefined)
		return `<p class="text-zinc-400 text-sm mt-5">You picked ${escHtml(nameOf(m.players[mine]))}</p>${picksText(m)}`;
	return `<div class="mt-6">
		<div class="${LABEL} mb-2">Who wins?</div>
		<div class="flex gap-2 justify-center flex-wrap">${m.players
			.map(
				(p, side) =>
					`<button class="m-btn m-btn-tonal" data-action="vote" data-side="${side}">${escHtml(nameOf(p))}</button>`
			)
			.join("")}</div>
	</div>`;
}

function resultHtml(m) {
	if (m.winner === null) return "";
	const loser = m.players.find((p) => p !== m.winner);
	const score = m.scores
		? `${Math.max(...m.scores).toLocaleString()} to ${Math.min(...m.scores).toLocaleString()}`
		: "";
	const details = [
		loser !== undefined && loser !== null ? `against ${escHtml(nameOf(loser))}` : "",
		score,
		DECIDED_TEXT[m.decided] || "",
	].filter(Boolean);
	const mine = state.my_votes?.[m.id];
	const called =
		mine !== undefined ? (m.players[mine] === m.winner ? "You called it." : "Not your pick this time.") : "";
	return `<div class="mt-8 flex flex-col items-center">
		${avatarHtml(player(m.winner)?.avatar_url, "w-20 h-20 border-4 border-zinc-800")}
		<div class="text-2xl font-bold mt-3">${escHtml(nameOf(m.winner))} wins</div>
		<p class="text-zinc-500 text-sm mt-1">${details.join(" · ")}</p>
		${picksText(m)}
		${called ? `<p class="text-zinc-400 text-sm mt-1">${called}</p>` : ""}
	</div>`;
}

/** Each player's final place, as [place, shared]. */
function placings() {
	const matches = allMatches();
	const rounds = state.rounds.length;
	const third = matches.find((m) => m.third && m.status === "done");
	const place = new Map();
	for (const m of matches) {
		if (m.status !== "done" || m.decided === "bye") continue;
		const loser = m.players.find((p, i) => p !== null && p !== m.winner && !m.closed[i]);
		if (m.third) {
			if (m.winner !== null) place.set(m.winner, [3, false]);
			if (loser !== undefined) place.set(loser, [4, false]);
		} else if (isFinalRound(m)) {
			if (m.winner !== null) place.set(m.winner, [1, false]);
			if (loser !== undefined) place.set(loser, [2, false]);
		} else if (loser !== undefined && !place.has(loser)) {
			const fromEnd = rounds - 1 - m.round;
			/** Placed by the match for third place instead. */
			if (fromEnd === 1 && third) continue;
			place.set(loser, [2 ** fromEnd + 1, true]);
		}
	}
	return place;
}

function renderStandings() {
	const box = el("stage-standings");
	const showing = state.status === "finished";
	box.classList.toggle("hidden", !showing);
	if (!showing) return;
	const place = placings();
	const stats = new Map();
	for (const m of allMatches()) {
		if (m.status !== "done") continue;
		m.players.forEach((p, side) => {
			if (p === null) return;
			const row = stats.get(p) ?? { wins: 0, played: 0, points: 0 };
			if (m.decided !== "bye") row.played++;
			if (m.winner === p && m.decided !== "bye") row.wins++;
			row.points += m.scores?.[side] ?? 0;
			stats.set(p, row);
		});
	}
	const rows = [...place.entries()].sort((a, b) => a[1][0] - b[1][0]);
	const medal = (n) =>
		n === 1 ? "text-yellow-400" : n === 2 ? "text-zinc-300" : n <= 4 ? "text-amber-600" : "text-zinc-600";
	box.innerHTML = `<div class="${LABEL} mb-3 text-center">Final standings</div>
		<div class="stagger flex flex-col gap-2 max-w-xl mx-auto">${rows
			.map(([userId, [n, joint]]) => {
				const s = stats.get(userId) ?? { wins: 0, played: 0, points: 0 };
				return `<div class="flex items-center gap-4 bg-zinc-900 rounded-2xl px-5 py-3 ${isMe(userId) ? "ring-2 ring-blue-500" : ""}">
					<span class="w-12 text-sm font-bold ${medal(n)}">${joint ? "=" : ""}${ordinal(n)}</span>
					${avatarHtml(player(userId)?.avatar_url, "w-9 h-9")}
					<div class="flex-1 min-w-0">
						<div class="font-semibold truncate">${escHtml(nameOf(userId))}${isMe(userId) ? " (you)" : ""}</div>
						<div class="text-xs text-zinc-500">${s.wins} of ${s.played} match${s.played === 1 ? "" : "es"} won</div>
					</div>
					<div class="text-right">
						<div class="font-mono font-bold">${s.points.toLocaleString()}</div>
						<div class="text-xs text-zinc-500">points</div>
					</div>
				</div>`;
			})
			.join("")}</div>`;
}

function renderMe() {
	const line = el("stage-me");
	const text = meText();
	line.classList.toggle("hidden", !text);
	line.textContent = text;
}

function meText() {
	if (!user || (state.status !== "live" && state.status !== "finished")) return "";
	const mine = allMatches().filter((m) => m.players.includes(user.id));
	if (!mine.length) return "";
	const open = mine.find((m) => m.status !== "done");
	if (!open) {
		const spot = placings().get(user.id);
		if (!spot) return "";
		if (spot[0] === 1) return "You won the tournament!";
		return `You finished ${spot[1] ? "joint " : ""}${ordinal(spot[0])}. Thanks for playing!`;
	}
	const phase = state.phase;
	if (open.status === "live") return "You're playing now";
	if (batchRound() !== null && open.round === batchRound())
		return state.phase.kind === "batch"
			? "Your match is waiting for both players to be ready"
			: "Your match starts with this round";
	if (phase.match_id === open.id && ["break", "hold"].includes(phase.kind)) return "Your match is next";
	const known = open.players.every((p, i) => p !== null || open.closed[i]);
	if (!known) return `You're through to the ${open.name}. Waiting to see who you play.`;
	const order = allMatches();
	const ahead = order
		.slice(
			0,
			order.findIndex((m) => m.id === open.id)
		)
		.filter((m) => m.status !== "done" && !m.closed.some(Boolean)).length;
	const minutes = Math.max(
		1,
		Math.round((ahead * (state.settings.rounds * ROUND_SECONDS + state.settings.breaks.match)) / 60)
	);
	return `You play ${open.third ? "for third place" : `in match ${matchNumber(open.id)}`}, about ${minutes} minute${minutes === 1 ? "" : "s"} away`;
}

function renderMessage(prev) {
	const box = el("stage-message");
	const message = state.message;
	box.classList.toggle("hidden", !message);
	if (message)
		box.innerHTML = `<span class="material-symbols-outlined text-zinc-400">campaign</span><span>${escHtml(message.text)}</span>`;
	if (message && seenMessage !== null && message.at > seenMessage) Sounds.play("notify");
	seenMessage = message?.at ?? 0;
	const notice = state.notice;
	if (notice && prev && seenNotice !== null && notice.at > seenNotice) showToast(notice.text, "info");
	seenNotice = notice?.at ?? 0;
}

function renderRoster() {
	const box = el("stage-roster");
	const showing = ["draft", "announced", "open"].includes(state.status);
	/** Before check-in nobody is marked as waiting. */
	const checking = state.status === "open";
	box.classList.toggle("hidden", !showing || !state.roster.length);
	if (!showing) return void (seenCheckedIn = null);
	const first = seenCheckedIn === null;
	const arrived = (r) => r.checked_in && !first && !seenCheckedIn.has(r.user_id);
	box.innerHTML = `<div class="${LABEL} mb-3">Players</div>
		<div class="${first ? "lobby-rise " : ""}grid gap-2" style="grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr))">${state.roster
			.map(
				(
					r,
					i
				) => `<div style="--i:${i}" class="lobby-player ${r.checked_in || !checking ? "bg-zinc-900" : "waiting"} ${arrived(r) ? "arrived" : ""} rounded-2xl px-3 py-2.5 flex items-center gap-3 ${isMe(r.user_id) ? "ring-2 ring-blue-500" : ""}">
					${avatarHtml(player(r.user_id)?.avatar_url, `w-8 h-8 ${r.checked_in || !checking ? "" : "opacity-60"}`)}
					<span class="flex-1 min-w-0 truncate text-sm ${r.checked_in || !checking ? "" : "text-zinc-500"}">${escHtml(nameOf(r.user_id))}</span>
					${
						!checking
							? ""
							: r.checked_in
								? '<span class="lobby-check material-symbols-outlined text-lg text-green-400" style="font-variation-settings:\'FILL\' 1" title="Checked in">check_circle</span>'
								: '<span class="material-symbols-outlined text-lg text-zinc-600" title="Not checked in yet">hourglass_empty</span>'
					}
				</div>`
			)
			.join("")}</div>`;
	seenCheckedIn = new Set(state.roster.filter((r) => r.checked_in).map((r) => r.user_id));
}

/* ---- The bracket ---- */

const isNarrow = () => {
	const width = el("stage-bracket-wrap").clientWidth;
	return width > 0 && width < NARROW_PX;
};

/** Each later card is centred between the two it follows. */
function layout() {
	const tops = [];
	state.rounds.forEach((round, r) => {
		tops[r] = [];
		for (const m of round.matches) {
			if (m.third) continue;
			tops[r][m.index] =
				r === 0 ? m.index * (CARD_H + ROW_GAP) : (tops[r - 1][m.index * 2] + tops[r - 1][m.index * 2 + 1]) / 2;
		}
	});
	const last = state.rounds.length - 1;
	const thirdTop = tops[last][0] + CARD_H + HEAD_H + ROW_GAP;
	const firstHeight = state.rounds[0].matches.length * (CARD_H + ROW_GAP) - ROW_GAP;
	const hasThird = state.rounds[last].matches.some((m) => m.third);
	const height = Math.max(firstHeight, hasThird ? thirdTop + CARD_H : 0);
	const width = state.rounds.length * CARD_W + (state.rounds.length - 1) * COL_GAP;
	return { tops, thirdTop, width, height };
}

function renderBracket(prev) {
	const wrap = el("stage-bracket-wrap");
	wrap.classList.toggle("hidden", !state.rounds.length);
	if (!state.rounds.length) return;
	const phase = state.phase;
	const prevById = new Map(prev?.rounds?.length ? prev.rounds.flatMap((r) => r.matches.map((m) => [m.id, m])) : []);
	const matches = allMatches();
	/** Just-finished matches and the places their winners move into, to animate. */
	const justDone = new Set();
	const arriving = new Set();
	for (const m of matches) {
		const before = prevById.get(m.id);
		if (!before || before.status === "done" || m.status !== "done") continue;
		justDone.add(m.id);
		const next = matches.find((x) => !x.third && x.round === m.round + 1 && x.index === Math.floor(m.index / 2));
		if (next && m.winner !== null) arriving.add(`${next.id}:${m.index % 2}`);
	}

	const card = (m, style = "", n = 0) => {
		const playing = m.status === "live";
		const next = !playing && phase.match_id === m.id && ["break", "hold"].includes(phase.kind);
		const note = playing ? "Playing now" : next ? "Next" : m.status === "done" ? DECIDED_TEXT[m.decided] || "" : "";
		const classes = ["bk-card", (playing || next) && "current", justDone.has(m.id) && "just-done"];
		return `<div class="${classes.filter(Boolean).join(" ")} ${playing ? "cursor-pointer" : ""}" data-match="${m.id}" ${playing ? 'data-action="watch-match" title="Watch this match"' : ""} style="${style}--i:${Math.min(n, 30)}">
			<div class="bk-num"><span>${m.third ? "Third place" : `Match ${matchNumber(m.id)}`}</span>${note ? `<span class="${playing || next ? "text-blue-400" : ""}">${escHtml(note)}</span>` : ""}</div>
			${[0, 1].map((side) => rowHtml(m, side, arriving.has(`${m.id}:${side}`))).join("")}
		</div>`;
	};

	const bracket = el("stage-bracket");
	const tabs = el("stage-rounds");
	if (isNarrow()) {
		const current = matches.find((m) => m.id === phase.match_id) ?? matches.find((m) => m.status !== "done");
		const round = Math.min(shownRound ?? current?.round ?? state.rounds.length - 1, state.rounds.length - 1);
		tabs.classList.remove("hidden");
		tabs.innerHTML = state.rounds
			.map(
				(r, i) =>
					`<button class="m-chip" data-action="round" data-round="${i}" aria-pressed="${i === round}">${escHtml(r.name)}</button>`
			)
			.join("");
		const list = matches.filter((m) => m.round === round);
		bracket.innerHTML = `<div class="bk-list">${list.map((m, i) => card(m, "", i)).join("")}</div>
			<p class="text-center text-xs text-zinc-600 mt-3">${roundsText(state.rounds[round].match_rounds)} a match</p>`;
	} else {
		tabs.classList.add("hidden");
		const { tops, thirdTop, width, height } = layout();
		const x = (r) => r * (CARD_W + COL_GAP);
		const y = (m) => HEAD_H + (m.third ? thirdTop : tops[m.round][m.index]);
		const lines = [];
		for (const m of matches) {
			if (m.round === 0 || m.third) continue;
			for (const side of [0, 1]) {
				const from = matches.find((f) => !f.third && f.round === m.round - 1 && f.index === m.index * 2 + side);
				const x1 = x(m.round - 1) + CARD_W;
				const y1 = y(from) + CARD_H / 2;
				const x2 = x(m.round);
				const y2 = y(m) + CARD_H / 2;
				const mid = x1 + COL_GAP / 2;
				const decided = from.status === "done" && from.winner !== null;
				lines.push(
					`<path d="M${x1} ${y1}H${mid}V${y2}H${x2}" class="${decided ? "won" : ""} ${justDone.has(from.id) ? "drawing" : ""}" pathLength="1" />`
				);
			}
		}
		const thirdMatch = matches.find((m) => m.third);
		bracket.innerHTML = `<div class="bk-sizer"><div class="bk-inner" style="width:${width}px;height:${HEAD_H + height}px">
			${state.rounds
				.map(
					(round, r) =>
						`<div class="bk-head" style="left:${x(r)}px;width:${CARD_W}px"><span>${escHtml(round.name)}</span><span class="text-zinc-600 normal-case tracking-normal">${roundsText(round.match_rounds)}</span></div>`
				)
				.join("")}
			${thirdMatch ? `<div class="bk-head" style="left:${x(thirdMatch.round)}px;top:${thirdTop}px;width:${CARD_W}px"><span>Third place</span><span class="text-zinc-600 normal-case tracking-normal">${roundsText(thirdMatch.match_rounds)}</span></div>` : ""}
			<svg class="bk-lines" width="${width}" height="${HEAD_H + height}" aria-hidden="true">${lines.join("")}</svg>
			${matches.map((m, i) => card(m, `left:${x(m.round)}px;top:${y(m)}px;`, i)).join("")}
		</div></div>`;
		fitBracket();
	}

	if (!revealed) {
		revealed = true;
		if (!prefersReducedMotion()) {
			bracket.classList.add("bk-reveal");
			setTimeout(() => bracket.classList.remove("bk-reveal"), 2600);
		}
	}
	if (prev && (prev.phase.match_id !== phase.match_id || state.champion !== prev.champion)) {
		shownRound = null;
		const focus = bracket.querySelector(".bk-card.current");
		focus?.scrollIntoView({
			block: "nearest",
			inline: "center",
			behavior: prefersReducedMotion() ? "auto" : "smooth",
		});
	}
}

function rowHtml(m, side, arriving) {
	const userId = m.players[side];
	const done = m.status === "done";
	const win = done && userId !== null && m.winner === userId;
	const lose = done && userId !== null && m.winner !== userId;
	const label = userId !== null ? nameOf(userId) : m.closed[side] ? "Bye" : "To be decided";
	const classes = [
		"bk-row",
		win && "win",
		lose && "lose",
		userId === null && "empty",
		isMe(userId) && "me",
		arriving && "arrive",
	];
	const champion = win && isFinalRound(m) && !m.third;
	return `<div class="${classes.filter(Boolean).join(" ")}">
		${userId !== null ? avatarHtml(player(userId)?.avatar_url, "w-6 h-6") : '<span class="w-6 h-6 flex-shrink-0"></span>'}
		<span class="flex-1 min-w-0 truncate">${escHtml(label)}</span>
		${m.scores && userId !== null ? `<span class="font-mono text-xs ${win ? "text-yellow-400" : "text-zinc-500"}">${m.scores[side].toLocaleString()}</span>` : ""}
		${champion ? '<span class="material-symbols-outlined text-base text-yellow-400" style="font-variation-settings:\'FILL\' 1">emoji_events</span>' : ""}
	</div>`;
}

/** Shrinks a little to fit; anything wider scrolls sideways. */
function fitBracket() {
	const wrap = el("stage-bracket-wrap");
	const inner = wrap?.querySelector(".bk-inner");
	if (!inner || wrap.clientWidth === 0) return;
	const width = inner.offsetWidth;
	const height = inner.offsetHeight;
	const scale = Math.max(0.75, Math.min(1, wrap.clientWidth / width));
	inner.style.transform = scale === 1 ? "" : `scale(${scale})`;
	const sizer = inner.parentElement;
	sizer.style.width = `${width * scale}px`;
	sizer.style.height = `${height * scale}px`;
}

/** A sideways swipe moves between rounds. */
function swipeRounds(area) {
	let start = null;
	area.addEventListener("touchstart", (e) => (start = e.touches[0]), { passive: true });
	area.addEventListener("touchend", (e) => {
		const end = e.changedTouches[0];
		if (!start || !state || !isNarrow()) return;
		const dx = end.clientX - start.clientX;
		const dy = end.clientY - start.clientY;
		start = null;
		if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
		const current = Number(el("stage-rounds").querySelector('[aria-pressed="true"]')?.dataset.round ?? 0);
		shownRound = Math.max(0, Math.min(state.rounds.length - 1, current + (dx < 0 ? 1 : -1)));
		renderBracket(state);
	});
}

/* ---- Sounds and animations ---- */

function cues(prev, upNext) {
	if (!prev) return;
	if (prev.status === "announced" && state.status === "open") {
		banner("Check-in is open");
		return Sounds.play("chime");
	}
	const phase = state.phase;
	const changedPhase =
		prev.phase.kind !== phase.kind || prev.phase.match_id !== phase.match_id || prev.phase.label !== phase.label;
	if (
		changedPhase &&
		phase.kind === "break" &&
		(phase.label === "round" || phase.label === "final") &&
		(upNext || phase.round !== null)
	)
		banner(
			phase.label === "final" ? "The Final" : phase.round !== null ? state.rounds[phase.round].name : upNext.name
		);
	else if (changedPhase && phase.kind === "break" && phase.label === "start") banner(state.title);
	if (changedPhase && phase.kind === "break" && upNext && phase.label !== "round" && phase.label !== "final")
		Sounds.play("versus");

	if (upNext && prev.phase.match_id === phase.match_id && state.ready.length > prev.ready.length) Sounds.play("pin");

	if (
		upNext &&
		user &&
		upNext.players.includes(user.id) &&
		["break", "hold"].includes(phase.kind) &&
		!alerted.has(upNext.id)
	) {
		alerted.add(upNext.id);
		Sounds.play("alert");
		showToast("Your match is next. Press Ready when you're set.", "info");
	}
	const mineInRound =
		user && phase.kind === "break" && phase.round !== null
			? allMatches().find((m) => m.round === phase.round && m.status === "waiting" && m.players.includes(user.id))
			: null;
	if (mineInRound && !alerted.has(mineInRound.id)) {
		alerted.add(mineInRound.id);
		Sounds.play("alert");
		showToast("Your match starts with this round. Press Ready when you're set.", "info");
	}

	const before = new Map(prev.rounds.flatMap((r) => r.matches.map((m) => [m.id, m])));
	const newlyDone = allMatches().filter(
		(m) => before.get(m.id) && before.get(m.id).status !== "done" && m.status === "done" && m.decided !== "bye"
	);
	if (newlyDone.length && !inMatch && state.status !== "finished") Sounds.play("cheer");

	if (prev.status !== "finished" && state.status === "finished" && state.champion !== null) {
		Sounds.play("fanfare");
		celebrate({ duration: 4200, count: 160 });
	}
}

function banner(text) {
	if (prefersReducedMotion()) return;
	const box = el("stage-banner");
	box.textContent = text;
	box.classList.remove("sweep");
	void box.offsetWidth;
	box.classList.add("sweep");
	Sounds.play("whoosh");
}

/** Countdowns, with chimes as the start nears and ticks for the last ten seconds. */
/** On a match's end screen: how long until the next match or the bracket. */
function endCount() {
	const box = el("stage-end-count");
	if (!box || !state) return;
	const endsAt = lingerTimer
		? lingerUntil
		: state.phase.kind === "result" && inMatch
			? state.phase.ends_at - offset
			: null;
	const showing = endsAt !== null && !el("end-screen").classList.contains("hidden");
	box.classList.toggle("hidden", !showing);
	if (!showing) return;
	const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
	const more = lingerTimer && watchChoice !== "bracket" && liveMatches().some((m) => m.code !== inMatch);
	box.textContent = `${more ? "Next match" : "Back to the bracket"} in ${left}s`;
}

function tick() {
	endCount();
	if (!state || root.hidden) return;
	paintClocks();
	for (const node of root.querySelectorAll("[data-ends]")) {
		const left = Number(node.dataset.ends) - serverNow();
		node.textContent = clock(left);
		node.classList.toggle("text-red-400", left <= 10_000);
	}
	const phase = state.phase;
	if (phase.kind !== "break" || phase.paused_left !== null) return void (lastSecond = null);
	const second = Math.ceil((phase.ends_at - serverNow()) / 1000);
	if (second === lastSecond) return;
	if (lastSecond !== null) {
		if (CHIMES_AT.includes(second)) Sounds.play("chime");
		else if (second <= 10 && second > 0) Sounds.play("tick");
		/** In case the update that starts the match is late. */
		if (second === 0) setTimeout(refresh, 1500);
	}
	lastSecond = second;
}

/* ---- Buttons ---- */

async function onClick(e) {
	const target = e.target.closest("[data-action]");
	const action = target?.dataset.action;
	if (!action) return;
	if (action === "watch") {
		leftMatch = null;
		return state.phase.code && enterMatch(matchById(state.phase.match_id), false);
	}
	if (action === "switcher") {
		switcherOpen = !switcherOpen;
		if (switcherOpen) refresh(true);
		return renderSwitcher();
	}
	if (action === "auto") {
		watchChoice = null;
		leftMatch = null;
		switcherOpen = false;
		const next = pickWatch();
		return next ? enterMatch(next, true) : renderSwitcher();
	}
	if (action === "bracket") {
		watchChoice = "bracket";
		switcherOpen = false;
		return leaveMatch();
	}
	if (action === "watch-match") {
		const m = matchById(Number(target.dataset.match));
		if (!m || m.status !== "live" || liveMatches().some((x) => x.players.some(isMe))) return;
		watchChoice = state.phase.kind === "batch" ? m.id : null;
		leftMatch = null;
		return enterMatch(m, state.phase.kind === "batch");
	}
	if (action === "round") {
		shownRound = Number(target.dataset.round);
		return renderBracket(state);
	}
	if (action === "join") {
		e.preventDefault();
		const code = inviteCode() || target.closest("form")?.code.value || "";
		target.disabled = true;
		try {
			await api(`/api/tournaments/${id}/join`, { json: { code } });
			history.replaceState(null, "", location.pathname);
			Sounds.play("pin");
			showToast("You're in.", "success");
			refresh();
		} catch (err) {
			showToast(err.message, "error");
			target.disabled = false;
		}
		return;
	}
	const button = e.target.closest("button");
	if (button) button.disabled = true;
	try {
		if (action === "vote") {
			const side = Number(target.dataset.side);
			const matchId = state.phase.match_id;
			await api(`/api/tournaments/${id}/vote`, { json: { side } });
			state.my_votes = { ...state.my_votes, [matchId]: side };
			Sounds.play("pin");
			return render(state);
		}
		await api(`/api/tournaments/${id}/${action === "ready" ? "ready" : "checkin"}`, { method: "POST" });
		if (action === "ready") Sounds.play("pin");
		if (action === "checkin") {
			justCheckedIn = true;
			Sounds.play("good");
			celebrate({ count: 70, duration: 1800 });
		}
		refresh();
	} catch (err) {
		showToast(err.message, "error");
		if (button) button.disabled = false;
	}
}

function paintSound() {
	const button = el("stage-sound");
	button.querySelector("span").textContent = Sounds.enabled ? "volume_up" : "volume_off";
	button.title = Sounds.enabled ? "Mute" : "Unmute";
	button.setAttribute("aria-label", button.title);
	el("stage-sound-hint").classList.toggle("hidden", !Sounds.enabled || Sounds.unlocked);
}

function toggleSound() {
	Sounds.setEnabled(!Sounds.enabled);
	paintSound();
	if (Sounds.enabled) Sounds.play("chime");
	if (user) api("/api/settings", { json: { prefs: { sounds: Sounds.enabled } } }).catch(() => {});
}
