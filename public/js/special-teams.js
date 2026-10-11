/**
 * Team Duels (Specials): two teams of up to two. The server runs the game on its own
 * clock; this page asks for the room's state about once a second and draws whatever
 * it says, so a dropped connection just picks up where the game is now.
 */

const TEAM_INFO = {
	a: { name: "Blue team", color: "#42A5F5", text: "text-blue-300", bar: "bg-blue-500" },
	b: { name: "Amber team", color: "#FFB300", text: "text-amber-300", bar: "bg-amber-500" },
};
const POLL_MS = 1000;
/** The newest reaction already shown, so each one pops up once however often the room is polled. */
let lastEmoteId = 0;

let me = null;
let room = null;
let roomCode = null;
let view = null;
let pollTimer = null;
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
		await poll();
		pollTimer = setInterval(poll, POLL_MS);
	} catch (err) {
		roomCode = null;
		entryError(err.message);
	}
}

async function poll() {
	if (!roomCode || document.hidden) return;
	try {
		room = await teamApi("");
	} catch (err) {
		// The room is gone (closed, or the server restarted): back to the start.
		if (err.status === 404 || err.status === 403) return leaveLocally(err.message);
		return;
	}
	render();
}

function leaveLocally(message = "") {
	clearInterval(pollTimer);
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

/* ---- Lobby ---- */

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
	el("room-hint").textContent = !bothTeams
		? "Share the code or invite link. Each team needs at least one player."
		: isHost
			? room.members.length < 4
				? "You can start now, or wait for a full two against two."
				: "Everyone is here. Start when you are ready."
			: "Waiting for the host to start.";
}

/* ---- Rounds ---- */

function renderScorebar() {
	el("team-scorebar").innerHTML = ["a", "b"]
		.map((team) => {
			const info = TEAM_INFO[team];
			const members = room.members.filter((m) => m.team === team);
			const dots = members
				.map(
					(m) =>
						`<span title="${escHtml(nameOf(m))}${m.guessed ? " has guessed" : ""}" class="material-symbols-outlined text-sm ${m.guessed ? info.text : "text-zinc-600"}">${m.guessed ? "check_circle" : "radio_button_unchecked"}</span>`
				)
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
	el("final-teams").innerHTML = ["a", "b"]
		.map((team) => {
			const info = TEAM_INFO[team];
			return `<div class="bg-zinc-900 rounded-2xl p-4 text-center ${room.winner === team ? "ring-1 ring-white/20" : ""}">
				<div class="font-semibold ${info.text}">${info.name}</div>
				<div class="font-mono text-3xl font-bold my-1">${room.totals[team].toLocaleString()}</div>
				<div class="text-xs text-zinc-500">${room.members
					.filter((m) => m.team === team)
					.map((m) => escHtml(nameOf(m)))
					.join(" and ")}</div>
			</div>`;
		})
		.join("");
	const isHost = room.host_id === me.id;
	show("team-again", isHost);
	show("final-wait", !isHost);
	Sounds.play(won ? "win" : room.winner === "tie" ? "good" : "lose");
	if (won) celebrate();
}

/** Shows any reactions that have arrived since the last poll, in each sender's team colour. */
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

/** Draws the room as the server last described it, acting once on each change. */
function render() {
	renderEmotes();
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
		el("click-hint").textContent = `Get ready… ${room.round.starts_in}`;
	} else if (room.phase === "guessing") {
		// Joined or reloaded mid-round: put the round up first.
		if (changed && (was.phase !== "ready" || was.round !== room.round_number)) startRoundOnScreen();
		if (changed) {
			view.go(room.round);
			if (room.you.guessed) {
				view.lock();
				el("click-hint").textContent = "Guess locked in. Waiting for the others";
			}
		}
		showTeammatePins();
	} else if (room.phase === "reveal") {
		if (changed) renderReveal();
		el("reveal-next").textContent =
			room.round_number >= room.rounds ? `Final scores in ${room.next_in}s` : `Next round in ${room.next_in}s`;
	}
}

async function submitGuess(pin) {
	el("click-hint").textContent = "Guess locked in. Waiting for the others";
	try {
		await teamApi("/guess", pin ?? {});
	} catch (err) {
		// 409 means the round moved on without us, which the next poll will show.
		if (err.status !== 409) showToast(err.message, "error");
	}
	poll();
}

async function init() {
	me = await fetchUser();
	if (!me) return location.replace("/specials");

	view = new RoundView({ onGuess: submitGuess });
	bindEmoteBar((emote) => roomCode && teamApi("/emote", { emote }).catch(() => {}));
	/** Tell the server where the pin is as it moves, so a teammate can see it. */
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
		poll();
	});
	el("team-start").addEventListener("click", () =>
		teamApi("/start", {})
			.then(poll)
			.catch((err) => showToast(err.message, "error"))
	);
	el("team-again").addEventListener("click", () =>
		teamApi("/again", {})
			.then(poll)
			.catch((err) => showToast(err.message, "error"))
	);
	el("team-leave").addEventListener("click", async () => {
		await teamApi("/leave", {}).catch(() => {});
		leaveLocally();
	});
	el("copy-invite").addEventListener("click", async () => {
		const copied = await copyText(`${location.origin}/specials/teams?room=${roomCode}`);
		showToast(copied ? "Invite link copied" : "Couldn't copy the link", copied ? "success" : "error");
	});
	document.addEventListener("visibilitychange", () => document.hidden || poll());

	const invited = new URLSearchParams(location.search).get("room");
	if (invited) enterRoom(invited);
}

init();
