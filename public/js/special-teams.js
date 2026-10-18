import { WebWire } from "/webwire-client.js";
import "./lib/site.js";
import { Sounds } from "./sounds.js";
import { announce, avatarHtml, el, escHtml, show } from "./lib/dom.js";
import { api, fetchUser } from "./lib/api.js";
import { copyText, showToast } from "./lib/toast.js";
import { celebrate } from "./lib/effects.js";
import { RoundView, bindEmoteBar, renderEmoteBar, showEmoteBubble } from "./round.js";

const TEAM_INFO = {
	a: { name: "Blue team", color: "#42A5F5", text: "text-blue-300", bar: "bg-blue-500" },
	b: { name: "Amber team", color: "#FFB300", text: "text-amber-300", bar: "bg-amber-500" },
};
/** The newest reaction already shown, so each one pops up once however often the state is sent. */
let lastEmoteId = 0;

let me = null;
let room = null;
let roomCode = null;
let view = null;
let wire = null;
/** When the get-ready count or the reveal ends, by this browser's clock. */
let phaseEndsAt = 0;
let countdownTimer = null;
/** What is on screen, so each change of round or phase is handled exactly once. */
let shown = { status: null, phase: null, round: 0 };

const teamApi = (path, json) => api(`/api/teams/rooms/${roomCode}${path}`, json === undefined ? {} : { json });
const nameOf = (m) => m.display_name || m.username;
const memberById = (id) => room.members.find((m) => m.id === id);

function switchScreen(id) {
	for (const screen of ["lobby-screen", "round-screen", "final-screen"]) show(screen, screen === id);
}

function entryError(message) {
	el("team-error").textContent = message;
	show("team-error", !!message);
}

async function enterRoom(code) {
	roomCode = code.toUpperCase();
	try {
		await teamApi("/join", {});
		history.replaceState(null, "", `/specials/teams?room=${roomCode}`);
		show("teams-entry", false);
		show("teams-room");
		connect();
	} catch (err) {
		roomCode = null;
		entryError(err.message);
	}
}

function closeWire() {
	const old = wire;
	wire = null;
	old?.disconnect();
}

/** Sends to the room's socket, or drops it while reconnecting, since the next connect sends a fresh watch. */
function emit(event, data) {
	try {
		wire?.emit(event, data);
	} catch {}
}

function connect() {
	closeWire();
	const w = new WebWire("/api/teams/wire", { reconnect: { initialDelay: 500, maxDelay: 3000 } });
	wire = w;
	const on = (event, fn) => w.on(event, (data) => w === wire && fn(data || {}));
	on("connect", () => w.emit("team_watch", { room: roomCode, here: !document.hidden }));
	on("team_state", (state) => {
		room = state;
		render();
	});
	on("team_closed", (data) => leaveLocally(data.message));
	w.connect().catch(() => {});
}

function tickCountdown() {
	if (!room) return;
	const left = Math.max(0, Math.ceil((phaseEndsAt - Date.now()) / 1000));
	if (room.phase === "ready") el("click-hint").textContent = `Get ready... ${left}`;
	else if (room.phase === "reveal")
		el("reveal-next").textContent =
			room.round_number >= room.rounds ? `Final scores in ${left}s` : `Next round in ${left}s`;
}

function leaveLocally(message = "") {
	closeWire();
	clearInterval(countdownTimer);
	countdownTimer = null;
	roomCode = null;
	room = null;
	lastEmoteId = 0;
	shown = { status: null, phase: null, round: 0 };
	view?.stop();
	history.replaceState(null, "", "/specials/teams");
	switchScreen("lobby-screen");
	show("teams-room", false);
	show("teams-entry");
	entryError(message);
}

function memberRow(m) {
	return `<div class="flex items-center gap-2.5 py-1.5 ${m.away ? "opacity-50" : ""}">
		${avatarHtml(m.avatar_url, "w-8 h-8 flex-shrink-0")}
		<span class="text-sm font-medium truncate">${escHtml(nameOf(m))}</span>
		${m.id === room.host_id ? '<span class="m-tag">Host</span>' : ""}
		${m.id === me.id ? '<span class="m-tag info">You</span>' : ""}
	</div>`;
}

function renderLobby() {
	el("room-code").textContent = room.code;
	el("team-columns").innerHTML = ["a", "b"]
		.map((team) => {
			const info = TEAM_INFO[team];
			const members = room.members.filter((m) => m.team === team);
			const canSwitch = room.you.team !== team && members.length < 2;
			return `<div class="bg-zinc-800/60 rounded-2xl p-4">
				<div class="flex items-center justify-between mb-2">
					<span class="font-semibold ${info.text}">${info.name}</span>
					<span class="text-xs text-zinc-500">${members.length}/2</span>
				</div>
				${members.map(memberRow).join("") || '<p class="text-zinc-600 text-sm py-1.5">Nobody yet</p>'}
				${canSwitch ? `<button data-team="${team}" class="m-btn m-btn-text m-btn-sm mt-2 -ml-2">Join this team</button>` : ""}
			</div>`;
		})
		.join("");
	const isHost = room.host_id === me.id;
	const bothTeams = ["a", "b"].every((team) => room.members.some((m) => m.team === team));
	show("team-start", isHost);
	el("team-start").disabled = !bothTeams;
	show("room-rounds-host", isHost);
	show("room-rounds-text", !isHost);
	el("room-rounds-text").textContent = `${room.rounds} rounds`;
	if (document.activeElement !== el("room-rounds")) el("room-rounds").value = room.rounds;
	el("room-hint").textContent = !bothTeams
		? "Share the code or invite link. Each team needs at least one player."
		: isHost
			? room.members.length < 4
				? "You can start now, or wait for a full two against two."
				: "Everyone is here. Start when you are ready."
			: "Waiting for the host to start.";
}

function renderScorebar() {
	el("team-scorebar").innerHTML = ["a", "b"]
		.map((team) => {
			const info = TEAM_INFO[team];
			const members = room.members.filter((m) => m.team === team);
			const dots = members
				.map((m) => {
					const state = m.guessed ? "has guessed" : m.away ? "is away" : "is still guessing";
					const icon = m.guessed ? "check_circle" : m.away ? "do_not_disturb_on" : "radio_button_unchecked";
					return `<span title="${escHtml(nameOf(m))} ${state}" class="material-symbols-outlined text-sm ${m.guessed ? info.text : "text-zinc-600"}">${icon}</span>`;
				})
				.join("");
			return `<div class="bg-black/70 rounded-full pl-3 pr-2.5 py-1.5 text-xs flex items-center gap-2 ${room.you.team === team ? "ring-1 ring-white/20" : ""}">
				<span class="font-semibold ${info.text}">${info.name}</span>
				<span class="font-mono font-bold">${room.totals[team].toLocaleString()}</span>
				<span class="flex items-center">${dots}</span>
			</div>`;
		})
		.join("");
}

function showTeammatePins() {
	view.map.clearNamePins();
	for (const pin of room.team_pins) {
		const mate = memberById(pin.id);
		if (mate)
			view.map.setNamePin(
				pin.id,
				pin.x,
				pin.y,
				TEAM_INFO[room.you.team].color,
				nameOf(mate),
				mate.avatar_url || ""
			);
	}
}

function startRoundOnScreen() {
	switchScreen("round-screen");
	show("team-reveal", false);
	el("round-num").textContent = room.round_number;
	el("round-total").textContent = room.rounds;
	view.map.clearPin();
	view.show(room.round, { canGuess: !!room.you.team });
	Sounds.play("start");
}

function renderReveal() {
	const reveal = room.reveal;
	view.stop();
	view.map.clearPin();
	view.map.showResult(reveal.correct_x, reveal.correct_y);
	let arrives = 0;
	for (const guess of reveal.guesses) {
		if (guess.x === null) continue;
		const who = memberById(guess.user_id);
		const color = TEAM_INFO[guess.team].color;
		view.map.setNamePin(guess.user_id, guess.x, guess.y, color, who ? nameOf(who) : "?", who?.avatar_url || "");
		arrives = Math.max(arrives, view.map.addGuessLine(guess.x, guess.y, reveal.correct_x, reveal.correct_y, color));
	}
	if (arrives) view.map.revealAnswerAt(arrives);

	const [a, b] = [reveal.team_scores.a, reveal.team_scores.b];
	el("reveal-title").textContent =
		a === b ? "Round drawn" : `${TEAM_INFO[a > b ? "a" : "b"].name} takes round ${reveal.round}`;
	el("reveal-teams").innerHTML = ["a", "b"]
		.map((team) => {
			const info = TEAM_INFO[team];
			const rows = reveal.guesses
				.filter((g) => g.team === team)
				.map((g) => {
					const who = memberById(g.user_id);
					const counted = g.score === reveal.team_scores[team] && g.score > 0;
					return `<div class="flex items-center justify-between gap-2 text-xs ${counted ? "text-zinc-200" : "text-zinc-500"}">
						<span class="truncate">${escHtml(who ? nameOf(who) : "?")}</span>
						<span class="font-mono flex-shrink-0">${g.x === null ? "no guess" : g.score.toLocaleString()}</span>
					</div>`;
				})
				.join("");
			return `<div class="bg-zinc-900/60 rounded-2xl p-3">
				<div class="flex items-center justify-between mb-1.5">
					<span class="font-semibold text-sm ${info.text}">${info.name}</span>
					<span class="font-mono font-bold">+${reveal.team_scores[team].toLocaleString()}</span>
				</div>
				${rows}
			</div>`;
		})
		.join("");
	show("team-reveal");
	view.fitResult(
		reveal,
		reveal.guesses.filter((g) => g.x !== null),
		el("team-reveal")
	);
	el("click-hint").textContent = reveal.label || "";
	announce(
		`${el("reveal-title").textContent}. ${TEAM_INFO.a.name} ${a.toLocaleString()}, ${TEAM_INFO.b.name} ${b.toLocaleString()} points.`
	);
	const mine = reveal.team_scores[room.you.team] ?? 0;
	const theirs = reveal.team_scores[room.you.team === "a" ? "b" : "a"] ?? 0;
	Sounds.play(mine > theirs ? "great" : mine === theirs ? "good" : "poor");
}

function renderFinal() {
	switchScreen("final-screen");
	const won = room.winner === room.you.team;
	el("final-title").textContent =
		room.winner === "tie" ? "It's a tie" : `${TEAM_INFO[room.winner].name} wins${won ? "!" : ""}`;
	el("final-icon").textContent = room.winner === "tie" ? "handshake" : won ? "emoji_events" : "sentiment_neutral";
	const taken = room.summary?.rounds_won ?? { a: 0, b: 0 };
	const drawn = room.rounds - taken.a - taken.b;
	el("final-rounds").textContent =
		`Rounds: ${TEAM_INFO.a.name} ${taken.a}, ${TEAM_INFO.b.name} ${taken.b}` +
		(drawn > 0 ? `, drawn ${drawn}` : "");
	el("final-teams").innerHTML = ["a", "b"]
		.map((team) => {
			const info = TEAM_INFO[team];
			const players = room.members
				.filter((m) => m.team === team)
				.map((m) => {
					const stats = room.summary?.players.find((p) => p.id === m.id);
					return `<div class="mt-2 text-left">
						<div class="text-sm font-medium truncate">${escHtml(nameOf(m))}</div>
						${stats ? `<div class="text-xs text-zinc-500">Best round ${stats.best.toLocaleString()} · scored for the team in ${stats.counted} of ${room.rounds}</div>` : ""}
					</div>`;
				})
				.join("");
			return `<div class="bg-zinc-900 rounded-2xl p-4 ${room.winner === team ? "ring-1 ring-white/20" : ""}">
				<div class="text-center">
					<div class="font-semibold ${info.text}">${info.name}</div>
					<div class="font-mono text-3xl font-bold my-1">${room.totals[team].toLocaleString()}</div>
				</div>
				${players}
			</div>`;
		})
		.join("");
	const isHost = room.host_id === me.id;
	show("team-again", isHost);
	show("final-wait", !isHost);
	Sounds.play(won ? "win" : room.winner === "tie" ? "good" : "lose");
	if (won) celebrate();
}

function renderEmotes() {
	renderEmoteBar(room.emote_list, !!room.you.team);
	for (const sent of room.emotes || []) {
		if (sent.id <= lastEmoteId) continue;
		lastEmoteId = sent.id;
		const who = memberById(sent.user_id);
		if (!who) continue;
		showEmoteBubble(sent.emote, {
			name: who.id === me.id ? "You" : nameOf(who),
			avatarUrl: who.avatar_url,
			color: TEAM_INFO[who.team]?.color ?? "#a1a1aa",
		});
	}
}

function render() {
	renderEmotes();
	phaseEndsAt = Date.now() + (room.phase_ms_left ?? 0);
	clearInterval(countdownTimer);
	countdownTimer = room.phase === "ready" || room.phase === "reveal" ? setInterval(tickCountdown, 250) : null;
	const changed = shown.status !== room.status || shown.phase !== room.phase || shown.round !== room.round_number;
	const was = shown;
	shown = { status: room.status, phase: room.phase, round: room.round_number };

	if (room.status === "lobby") {
		if (changed) switchScreen("lobby-screen");
		return renderLobby();
	}
	if (room.status === "finished") {
		if (changed) renderFinal();
		return;
	}

	renderScorebar();
	if (room.phase === "ready") {
		if (changed) startRoundOnScreen();
		tickCountdown();
	} else if (room.phase === "guessing") {
		if (changed && (was.phase !== "ready" || was.round !== room.round_number)) startRoundOnScreen();
		if (changed) {
			view.go(room.round);
			if (room.you.guessed) view.lock();
		}
		if (room.you.guessed) el("click-hint").textContent = lockedHint();
		showTeammatePins();
	} else if (room.phase === "reveal") {
		if (changed) renderReveal();
		tickCountdown();
	}
}

/** Shown once a player's guess is in. Away players are not waited for, so they are left out. */
function lockedHint() {
	const waiting = room.members.filter((m) => m.team && !m.guessed && !m.away && m.id !== me.id).map(nameOf);
	if (!waiting.length) return "Guess locked in";
	const names = waiting.length > 2 ? `${waiting.length} players` : waiting.join(" and ");
	return `Guess locked in. Waiting for ${names}`;
}

async function submitGuess(pin) {
	el("click-hint").textContent = lockedHint();
	try {
		await teamApi("/guess", pin ?? {});
	} catch (err) {
		if (err.status !== 409) showToast(err.message, "error");
	}
}

async function init() {
	me = await fetchUser();
	if (!me) return location.replace("/specials");

	view = new RoundView({ onGuess: submitGuess });
	bindEmoteBar((emote) => roomCode && teamApi("/emote", { emote }).catch(() => {}));
	const placed = view.map.onPinPlaced;
	view.map.onPinPlaced = (x, y) => {
		placed(x, y);
		if (roomCode) teamApi("/pin", { x, y }).catch(() => {});
	};

	el("team-create").addEventListener("click", async () => {
		entryError("");
		try {
			const made = await api("/api/teams/rooms", { json: { rounds: Number(el("team-rounds").value) } });
			await enterRoom(made.code);
		} catch (err) {
			entryError(err.message);
		}
	});
	const join = () => {
		const code = el("team-code").value.trim();
		if (code.length !== 6) return entryError("Enter the 6-character room code.");
		entryError("");
		enterRoom(code);
	};
	el("team-join").addEventListener("click", join);
	el("team-code").addEventListener("keydown", (e) => e.key === "Enter" && join());
	el("team-columns").addEventListener("click", async (e) => {
		const team = e.target.closest("[data-team]")?.dataset.team;
		if (!team) return;
		await teamApi("/team", { team }).catch((err) => showToast(err.message, "error"));
	});
	el("team-start").addEventListener("click", () =>
		teamApi("/start", {}).catch((err) => showToast(err.message, "error"))
	);
	el("team-again").addEventListener("click", () =>
		teamApi("/again", {}).catch((err) => showToast(err.message, "error"))
	);
	el("room-rounds").addEventListener("change", async (e) => {
		await teamApi("/rounds", { rounds: Number(e.target.value) }).catch((err) => showToast(err.message, "error"));
		e.target.blur();
	});
	addEventListener("pagehide", () => {
		if (!roomCode || room?.status === "playing") return;
		fetch(`/api/teams/rooms/${roomCode}/leave`, { method: "POST", keepalive: true }).catch(() => {});
	});
	el("team-leave").addEventListener("click", async () => {
		await teamApi("/leave", {}).catch(() => {});
		leaveLocally();
	});
	el("room-code").addEventListener("click", async () => {
		if (roomCode && (await copyText(roomCode))) showToast("Room code copied", "success");
	});
	el("copy-invite").addEventListener("click", async () => {
		const copied = await copyText(`${location.origin}/specials/teams?room=${roomCode}`);
		showToast(copied ? "Invite link copied" : "Couldn't copy the link", copied ? "success" : "error");
	});
	document.addEventListener("visibilitychange", () => emit("team_here", { here: !document.hidden }));

	const invited = new URLSearchParams(location.search).get("room");
	if (invited) enterRoom(invited);
}

init();
