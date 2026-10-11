/** Duels: lobby, waiting room, live rounds over WebWire, results and rematches. */
import { WebWire } from "/webwire-client.js";

const SCREENS = ["login-gate", "lobby-screen", "waiting-screen", "round-screen", "end-screen"];
/** Material 400-weight colours, one per player. */
const PIN_COLORS = ["#42A5F5", "#FFA726", "#AB47BC", "#EC407A"];
const QUICKPLAY_ROUNDS = 5;
const QUIET_QUEUE_HINT_MS = 30_000;
/** How long to keep retrying a lost connection before giving up on the room. */
const RECONNECT_WINDOW_MS = 30_000;

let user = null;
let wire = null;
let view = null;
let roomCode = null;
let role = "player"; // or "spectator"
let isHost = false;
let isQuickPlay = false;
let busy = false;
let countdownTimer = null;
let nextRoundTimer = null;
let quietQueueTimer = null;
let reconnectTimer = null;
let overlayTimer = null;
let getRounds;

const isSpectator = () => role === "spectator";

function switchScreen(id) {
	for (const screen of SCREENS) show(screen, screen === id);
	if (id !== "round-screen") show("start-countdown", false);
}

function lobbyError(message) {
	el("lobby-error").textContent = message;
	show("lobby-error", !!message);
}

function showSpectatorCount(count) {
	const badge = el("spectator-count");
	badge.classList.toggle("hidden", !count);
	badge.innerHTML = `<span class="material-symbols-outlined text-sm leading-none">visibility</span> ${count} watching`;
}

let liveDuelsTimer = null;

function liveDuelRowHtml(duel) {
	const names = duel.players
		.map((p) => escHtml(p.display_name || p.username))
		.join(' <span class="text-zinc-600">vs</span> ');
	const score = duel.players.map((p) => p.total_score.toLocaleString()).join(" - ");
	const watching = duel.spectators ? ` · ${duel.spectators} watching` : "";
	return `<button data-watch="${escHtml(duel.code)}" class="flex items-center gap-3 text-left bg-zinc-800/60 hover:bg-zinc-800 transition rounded-2xl px-4 py-3">
		<div class="flex -space-x-2 flex-shrink-0">${duel.players.map((p) => avatarHtml(p.avatar_url, "w-8 h-8 border-2 border-zinc-900")).join("")}</div>
		<div class="flex-1 min-w-0">
			<div class="text-sm font-semibold truncate">${names}</div>
			<div class="text-xs text-zinc-500">${duel.quickplay ? "Quick Play" : "Room"} · Round ${duel.round}/${duel.rounds} · ${score}${watching}</div>
		</div>
		<span class="text-xs font-semibold text-blue-300 flex items-center gap-1 flex-shrink-0"><span class="material-symbols-outlined text-base leading-none">visibility</span> Watch</span>
	</button>`;
}

/** Loads the duels anyone can watch. Updates the lobby button, and the dialog when it is open. */
async function loadLiveDuels() {
	let duels = [];
	try {
		duels = await api("/api/duels/live");
	} catch {}
	el("live-duels-summary").textContent = duels.length
		? `${duels.length} duel${duels.length === 1 ? "" : "s"} in progress`
		: "Nobody is playing right now";
	if (el("live-duels-dialog").classList.contains("hidden")) return;
	el("live-duels-list").innerHTML = duels.length
		? duels.map(liveDuelRowHtml).join("")
		: `<div class="text-center py-10">
			<span class="material-symbols-outlined text-4xl text-zinc-700">sports_esports</span>
			<p class="text-zinc-500 text-sm mt-2">No duels are being played right now.</p>
			<p class="text-zinc-600 text-xs mt-1">Start one with Quick Play and it will appear here.</p>
		</div>`;
}

function openLiveDuels() {
	show("live-duels-dialog");
	el("live-duels-list").innerHTML = skeletonRows(3, "h-16");
	loadLiveDuels();
	clearInterval(liveDuelsTimer);
	// Scores and rounds move quickly, so keep the open list fresh.
	liveDuelsTimer = setInterval(loadLiveDuels, 4000);
}

function closeLiveDuels() {
	show("live-duels-dialog", false);
	clearInterval(liveDuelsTimer);
}

/** Tears down the current room and returns to the lobby, optionally explaining why. */
function backToLobby(message = "") {
	closeWire();
	clearInterval(countdownTimer);
	clearInterval(nextRoundTimer);
	clearTimeout(quietQueueTimer);
	clearTimeout(reconnectTimer);
	hideOverlay();
	view?.stop();
	roomCode = null;
	shownRound = 0;
	role = "player";
	isHost = false;
	isQuickPlay = false;
	history.replaceState({}, "", "/duels");
	document.title = "Duels | Dovedale GeoGuesser";
	showSpectatorCount(0);
	if (user) {
		switchScreen("lobby-screen");
		lobbyError(message);
		loadLiveDuels();
	} else {
		switchScreen("login-gate");
		if (message) showToast(message, "error");
	}
}

function closeWire() {
	const old = wire;
	wire = null;
	old?.disconnect();
}

async function init() {
	getRounds = setupPills(".duel-rounds-pill");
	el("create-btn").addEventListener("click", createRoom);
	el("join-btn").addEventListener("click", () => joinRoom(el("join-code").value));
	el("join-code").addEventListener("keydown", (e) => e.key === "Enter" && joinRoom(el("join-code").value));
	el("join-code").addEventListener("input", (e) => {
		e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
	});
	el("quickplay-btn").addEventListener("click", quickPlay);
	el("start-duel-btn").addEventListener("click", () => wire?.emit("start", {}));
	el("ready-btn").addEventListener("click", () => wire?.emit("ready", {}));
	el("leave-btn").addEventListener("click", leaveRoom);
	el("spectate-instead-btn").addEventListener("click", () => spectate(roomCode, { leaveSeat: true }));
	el("copy-invite-btn").addEventListener("click", () => copyLink(`/duel/${roomCode}`, "Invite link copied"));
	el("copy-spectate-btn").addEventListener("click", () =>
		copyLink(`/duel/${roomCode}?spectate`, "Spectate link copied")
	);
	el("play-again-btn").addEventListener("click", () => {
		if (isSpectator()) return backToLobby();
		wire?.emit("play_again", {});
	});
	el("play-again-accept-btn").addEventListener("click", () => wire?.emit("play_again", {}));
	for (const id of ["play-again-cancel-btn", "play-again-decline-btn", "end-leave-btn"]) {
		el(id).addEventListener("click", (e) => {
			e.preventDefault();
			wire?.emit("play_again_decline", {});
			backToLobby();
		});
	}
	el("gate-spectate-btn").addEventListener("click", () => spectate(el("gate-spectate-btn").dataset.code));
	el("end-replay-again").addEventListener("click", playReplay);
	bindEmoteBar((emote) => wire?.emit("send_emote", { emote }));
	el("live-duels-btn").addEventListener("click", openLiveDuels);
	el("live-duels-close").addEventListener("click", closeLiveDuels);
	el("live-duels-refresh").addEventListener("click", loadLiveDuels);
	el("live-duels-dialog").addEventListener("click", (e) => e.target === e.currentTarget && closeLiveDuels());
	document.addEventListener("keydown", (e) => e.key === "Escape" && closeLiveDuels());
	el("live-duels-list").addEventListener("click", (e) => {
		const watch = e.target.closest("[data-watch]");
		if (!watch) return;
		closeLiveDuels();
		spectate(watch.dataset.watch);
	});
	setInterval(() => el("lobby-screen").classList.contains("hidden") || loadLiveDuels(), 15_000);

	// Built up front so the map tiles are already loaded when the duel starts.
	view = new RoundView({ onGuess: sendGuess });
	const visible = (id) => !el(id).classList.contains("hidden");
	const press = (id) => (visible(id) && !el(id).disabled ? el(id).click() : false);
	addKeybinds("Duels", [
		[["Q"], "Quick Play (in the lobby)", () => (visible("lobby-screen") ? press("quickplay-btn") : false)],
		[["W"], "Watch live duels (in the lobby)", () => (visible("lobby-screen") ? press("live-duels-btn") : false)],
		[
			["R"],
			"Ready up, or start as host",
			() =>
				visible("waiting-screen")
					? press("ready-btn") === false
						? press("start-duel-btn")
						: undefined
					: false,
		],
		[
			["P"],
			"Play again (after a duel)",
			() => (visible("end-screen") && visible("end-actions") ? press("play-again-btn") : false),
		],
	]);
	user = await fetchUser();
	el("login-link").href = loginUrl();

	const params = new URLSearchParams(location.search);
	const pathCode = location.pathname.match(/^\/duel\/([A-Z0-9]+)/i)?.[1];
	const wantsSpectate = params.get("spectate") !== null;
	const code = (pathCode || params.get("join") || params.get("spectate") || "").toUpperCase();

	if (code && (wantsSpectate || params.get("spectate"))) return spectate(code);
	if (!user) {
		switchScreen("login-gate");
		// An invite link still lets a logged-out visitor watch.
		if (code) {
			el("gate-spectate-btn").dataset.code = code;
			show("gate-spectate-btn");
		}
		return;
	}
	switchScreen("lobby-screen");
	el("lobby-rating").textContent = user.duel_rated_games
		? `Your rating: ${user.duel_rating.toLocaleString()}`
		: "Your first ranked duel sets your rating";
	show("lobby-rating");
	loadLiveDuels();
	if (code) {
		el("join-code").value = code;
		joinRoom(code);
	}
}

/** Runs one lobby action at a time so double clicks cannot create two rooms. */
async function lobbyAction(fn) {
	if (busy) return;
	busy = true;
	lobbyError("");
	try {
		await fn();
	} catch (err) {
		lobbyError(err.message);
	} finally {
		busy = false;
	}
}

function createRoom() {
	return lobbyAction(async () => {
		const { code } = await api("/api/duels/rooms", {
			json: { rounds: getRounds(), listed: el("listed-check").checked },
		});
		await enterRoom(code, { host: true });
	});
}

function joinRoom(input) {
	return lobbyAction(async () => {
		const code = String(input || "")
			.trim()
			.toUpperCase();
		if (code.length !== 6) throw new Error("Enter a 6-character room code.");
		try {
			await api(`/api/duels/rooms/${code}/join`, { method: "POST" });
		} catch (err) {
			// Full or already under way: watching is the next best thing.
			if (err.status === 409) return spectate(code);
			throw err;
		}
		await enterRoom(code, { host: false });
	});
}

function quickPlay() {
	return lobbyAction(async () => {
		const match = await api("/api/duels/quickplay", { json: { rounds: QUICKPLAY_ROUNDS } });
		await enterRoom(match.code, { host: match.status === "waiting", quickplay: true });
		quietQueueTimer = setTimeout(() => show("quickplay-no-players"), QUIET_QUEUE_HINT_MS);
	});
}

async function enterRoom(code, { host, quickplay = false }) {
	roomCode = code;
	role = "player";
	isHost = host;
	isQuickPlay = quickplay;
	setRoomUrl();
	await connect("join");
}

async function spectate(code, { leaveSeat = false } = {}) {
	if (leaveSeat) wire?.emit("leave", {});
	closeWire();
	roomCode = code;
	role = "spectator";
	isHost = false;
	isQuickPlay = false;
	setRoomUrl();
	await connect("spectate");
}

function setRoomUrl() {
	history.replaceState({}, "", isSpectator() ? `/duel/${roomCode}?spectate` : `/duel/${roomCode}`);
	document.title = `${isSpectator() ? "Spectating" : "Duel"} ${roomCode} | Dovedale GeoGuesser`;
}

async function copyLink(path, message) {
	if (roomCode && (await copyText(location.origin + path))) showToast(message, "success");
}

function leaveRoom() {
	if (isQuickPlay) api("/api/duels/quickplay", { method: "DELETE" }).catch(() => {});
	wire?.emit("leave", {});
	backToLobby();
}

/** Full-screen notice over the game: connection trouble, a paused duel, the countdown back in. */
function showOverlay(title, detail = "", countdown = 0) {
	clearInterval(overlayTimer);
	el("overlay-title").textContent = title;
	el("overlay-detail").textContent = detail;
	show("overlay-count", countdown > 0);
	show("overlay-spinner", countdown <= 0);
	show("game-overlay");
	if (countdown > 0) {
		let left = countdown;
		el("overlay-count").textContent = left;
		overlayTimer = setInterval(() => {
			left--;
			if (left <= 0) clearInterval(overlayTimer);
			else el("overlay-count").textContent = left;
		}, 1000);
	}
}

function hideOverlay() {
	clearInterval(overlayTimer);
	show("game-overlay", false);
}

async function connect(joinEvent) {
	closeWire();
	roundHistory = [];
	introShown = false;
	pinColors.clear();
	view?.map.restoreView();
	clearTimeout(reconnectTimer);
	const w = new WebWire("/api/duels/wire", { reconnect: { initialDelay: 500, maxDelay: 3000 } });
	wire = w;
	/** Events from a connection we have already replaced must not touch the page. */
	const on = (event, fn) => w.on(event, (data) => w === wire && fn(data || {}));

	on("room_state", (state) => {
		if (state.players?.length) lastPlayers = state.players;
		// Colours go by seat, so a player keeps theirs from round to round and into the replay.
		for (const p of lastPlayers) pinColor(p.user_id);
		renderEmoteBar(state.emotes, !isSpectator());
		showSpectatorCount(state.spectators);
		showWaitingRoom(state);
	});
	on("spectators", (data) => showSpectatorCount(data.count));
	on("start_countdown", (data) => showStartCountdown(data.seconds));
	on("countdown_cancelled", () => {
		clearInterval(countdownTimer);
		show("start-countdown", false);
	});
	on("round_loading", (round) => showRound(round).then(() => w === wire && w.emit("loaded", {})));
	on("round_start", startRound);
	on("paused", (data) => {
		if (el("game-overlay").classList.contains("hidden")) Sounds.play("pause");
		view?.pause();
		const names = (data.players || []).map((p) => p.display_name || p.username);
		const mine = (data.players || []).some((p) => p.user_id === user?.id);
		showOverlay(
			"Duel paused",
			mine || !names.length
				? "Reconnecting you to the duel…"
				: `${names.join(" and ")} lost connection. Waiting up to ${data.timeout}s for them to come back…`
		);
	});
	on("resuming", (data) => showOverlay("Everyone's back", "Resuming in…", data.seconds));
	on("resumed", (data) => {
		hideOverlay();
		if (data.round) view?.resume(data.round.time_remaining, { guessed: data.guessed });
		else if (data.next_in !== undefined) runNextRoundCountdown(data.next_in);
	});
	on("opponent_guessed", () => {
		Sounds.play("opponent");
		setOpponentBadge("check_circle", "Opponent guessed");
	});
	on("player_pin", (data) => {
		if (isSpectator()) {
			view?.map.setNamePin(
				data.user_id,
				data.world_x,
				data.world_y,
				pinColor(data.user_id),
				data.display_name || data.username,
				data.avatar_url,
				{ ripple: true }
			);
		}
	});
	on("emote", showEmote);
	on("round_result", showRoundResult);
	on("game_end", (data) => showGameEnd(data));
	on("opponent_disconnected", (data) => showGameEnd(data, { forfeit: true }));
	on("notice", (data) => showToast(data.message || "Something went wrong.", "error"));
	on("server_restarting", (data) => noteRestart(data.seconds));
	on("server_restart_cancelled", () => noteRestart(null));
	on("server_restart", (data) => {
		// On the end screen the result stands; there is just nobody left to rematch.
		if (!el("end-screen").classList.contains("hidden")) {
			closeWire();
			return rematchUnavailable("Server restarting");
		}
		noteRestart(0);
		backToLobby(data.message || "The server is restarting.");
	});
	on("rejected", (data) => {
		if (!el("end-screen").classList.contains("hidden")) return closeWire();
		backToLobby(data.message || "Something went wrong.");
	});

	on("play_again_waiting", () => showEndPanel("end-waiting"));
	on("play_again_incoming", () => showEndPanel("end-incoming"));
	on("play_again_declined", () => rematchUnavailable("Opponent left"));
	on("play_again_expired", () => rematchUnavailable("No response"));
	on("play_again_match", (data) => enterRoom(data.code, { host: data.is_host, quickplay: isQuickPlay }));
	on("play_again_available", (data) => {
		if (!isSpectator()) return;
		show("spectate-new-game-btn");
		el("spectate-new-game-btn").onclick = () => spectate(data.code);
	});

	// WebWire reconnects by itself; each time we rejoin and get a snapshot of the room.
	on("connect", () => {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
		hideOverlay();
		w.emit(joinEvent, { room: roomCode });
	});
	on("disconnect", () => {
		if (!el("end-screen").classList.contains("hidden")) return rematchUnavailable("Disconnected");
		view?.pause();
		showOverlay("Connection lost", "Trying to reconnect…");
		reconnectTimer ??= setTimeout(
			() => backToLobby("Couldn't reconnect to the duel. Check your connection and try again."),
			RECONNECT_WINDOW_MS
		);
	});

	showOverlay("Connecting…");
	reconnectTimer = setTimeout(
		() => backToLobby("Couldn't connect to the duel server. Please try again."),
		RECONNECT_WINDOW_MS
	);
	w.connect().catch(() => {});
}

/** Pops a player's reaction up beside the screenshot. Spectators see them too. */
function showEmote(data) {
	const player = lastPlayers.find((p) => p.user_id === data.user_id);
	if (!player) return;
	const mine = data.user_id === user?.id;
	showEmoteBubble(data.emote, {
		name: mine ? "You" : player.display_name || player.username,
		avatarUrl: player.avatar_url,
		color: mine ? MapCanvas.GUESS_COLOR : pinColor(data.user_id),
	});
}

const pinColors = new Map();
function pinColor(userId) {
	if (!pinColors.has(userId)) pinColors.set(userId, PIN_COLORS[pinColors.size % PIN_COLORS.length]);
	return pinColors.get(userId);
}

function playerCardHtml(player) {
	const status = player.is_host
		? '<span class="text-xs text-blue-400">Host</span>'
		: player.is_ready
			? '<span class="text-xs text-green-400">Ready</span>'
			: '<span class="text-xs text-zinc-500">Not ready</span>';
	return `<div class="flex flex-col items-center gap-2 w-28">
		${avatarHtml(player.avatar_url, "w-12 h-12 border-2 border-zinc-600")}
		<span class="text-sm max-w-full truncate">${escHtml(player.display_name || player.username)}</span>
		${status}
	</div>`;
}

const EMPTY_SEAT_HTML = `<div class="flex flex-col items-center gap-2 w-28 opacity-40">
	<div class="w-12 h-12 rounded-full bg-zinc-700 border-2 border-dashed border-zinc-600 flex items-center justify-center">
		<span class="material-symbols-outlined">person_add</span>
	</div>
	<span class="text-sm">Waiting...</span>
</div>`;

function showWaitingRoom(state) {
	hideOverlay();
	if (state.status !== "waiting") return;
	switchScreen("waiting-screen");
	el("room-code-display").textContent = roomCode;
	isQuickPlay = !!state.quickplay && !isSpectator();

	const me = state.players.find((p) => p.user_id === user?.id);
	if (!isSpectator() && me) isHost = me.is_host;
	const opponent = state.players.find((p) => p.user_id !== user?.id);
	const full = state.players.length >= 2;
	const searching = isQuickPlay && !full;

	show("quickplay-searching", searching);
	show("normal-waiting-header", !isQuickPlay);
	show("waiting-rounds", !isQuickPlay);
	el("waiting-rounds").textContent = `${state.rounds} round${state.rounds === 1 ? "" : "s"} · 60 seconds each`;
	if (full) {
		clearTimeout(quietQueueTimer);
		show("quickplay-no-players", false);
	}
	el("waiting-players").innerHTML = state.players.map(playerCardHtml).join("") + (full ? "" : EMPTY_SEAT_HTML);

	const canStart = !isSpectator() && !isQuickPlay && isHost && full;
	const canReady = !isSpectator() && !isQuickPlay && !isHost && full;
	const opponentReady = !!opponent?.is_ready;

	const startBtn = el("start-duel-btn");
	startBtn.disabled = !opponentReady;
	startBtn.className = `${canStart ? "" : "hidden "}transition px-8 py-3 rounded-full font-bold text-sm shadow-sm mb-3 ${
		opponentReady ? "bg-green-700 hover:bg-green-600" : "bg-zinc-700 text-zinc-500 cursor-not-allowed"
	}`;

	const readyBtn = el("ready-btn");
	readyBtn.disabled = !!me?.is_ready;
	readyBtn.textContent = me?.is_ready ? "You are ready" : "Ready";
	readyBtn.className = `${canReady ? "" : "hidden "}transition px-8 py-3 rounded-full font-bold text-sm shadow-sm mb-3 ${
		me?.is_ready ? "bg-zinc-700 text-green-400 cursor-not-allowed" : "bg-green-700 hover:bg-green-600"
	}`;

	show("spectate-instead-btn", canReady);
	el("leave-btn").textContent = isSpectator() ? "Stop spectating" : isQuickPlay ? "Cancel" : "Leave room";
	el("waiting-hint").textContent = isSpectator()
		? "Waiting for the duel to start…"
		: isQuickPlay
			? full
				? "Match found! Starting…"
				: ""
			: !full
				? "Share the code or invite link with your opponent"
				: isHost
					? opponentReady
						? "Your opponent is ready. Start when you are."
						: "Waiting for your opponent to ready up…"
					: me?.is_ready
						? "Waiting for the host to start…"
						: "Press Ready when you're set to play";
}

function showStartCountdown(seconds) {
	clearInterval(countdownTimer);
	let left = seconds;
	introShown = true;
	el("versus").innerHTML = versusHtml(lastPlayers);
	el("start-countdown-label").textContent = "Get ready";
	el("start-countdown-value").textContent = left;
	Sounds.play("versus");
	show("start-countdown");
	countdownTimer = setInterval(() => {
		left--;
		if (left <= 0) {
			clearInterval(countdownTimer);
			show("start-countdown", false);
		} else {
			el("start-countdown-value").textContent = left;
			Sounds.play("countdown");
		}
	}, 1000);
}

function setOpponentBadge(icon, text) {
	const badge = el("opponent-guessed-badge");
	if (!icon) return badge.classList.add("hidden");
	badge.innerHTML = `<span class="material-symbols-outlined text-xs leading-none" style="font-variation-settings:'FILL' 1">${icon}</span> ${escHtml(text)}`;
	badge.classList.remove("hidden");
}

let shownRound = 0;

/** Puts a round on screen ahead of its clock, so both players can load it first. */
function showRound(round) {
	// The round can arrive a moment before the countdown's last tick, so take the countdown down with its timer.
	clearInterval(countdownTimer);
	show("start-countdown", false);
	clearInterval(nextRoundTimer);
	switchScreen("round-screen");
	el("result-screen").classList.remove("shown");
	setOpponentBadge(null);
	el("round-num").textContent = round.round;
	el("round-total").textContent = round.total_rounds;
	shownRound = round.round;
	if (!isSpectator()) el("click-hint").textContent = "Get ready…";
	return view.show(round, { canGuess: !isSpectator() });
}

function startRound(round) {
	// Joining mid-round: the round is not on screen yet, so show it first.
	if (shownRound !== round.round || !view.loaded) showRound(round);
	showJoinIntro();
	Sounds.play("start");
	view.go(round);
	/** Rejoining a round we already answered: the guess stands, so just wait for the other player. */
	if (round.guessed) {
		view.lock();
		el("click-hint").textContent = "Guess locked in";
		setOpponentBadge("hourglass_top", "Waiting for your opponent…");
	} else if (!isSpectator() && round.guessed_ids?.length) {
		setOpponentBadge("check_circle", "Opponent guessed");
	}
}

function sendGuess(pin) {
	// The clock keeps running: the round only ends when both players are in or time is up.
	el("click-hint").textContent = pin ? "Guess locked in" : "Time's up. No pin placed";
	setOpponentBadge("hourglass_top", "Waiting for your opponent…");
	wire?.emit("guess", { world_x: pin?.x ?? null, world_y: pin?.y ?? null });
}

function showRoundResult(result) {
	if (!roundHistory.some((r) => r.round === result.round)) roundHistory.push(result);
	shownRound = 0;
	view.stop();
	setOpponentBadge(null);
	view.map.clearPin();
	view.map.showResult(result.correct_x, result.correct_y);
	for (const r of result.results) {
		if (r.guessed_x === null) continue;
		const mine = r.user_id === user?.id;
		const color = mine ? MapCanvas.GUESS_COLOR : pinColor(r.user_id);
		view.map.setNamePin(
			r.user_id,
			r.guessed_x,
			r.guessed_y,
			color,
			mine ? "You" : r.display_name || r.username,
			r.avatar_url
		);
		view.map.revealAnswerAt(
			view.map.addGuessLine(r.guessed_x, r.guessed_y, result.correct_x, result.correct_y, color)
		);
	}

	const best = Math.max(...result.results.map((r) => r.score));
	const mine = result.results.find((r) => r.user_id === user?.id);
	if (mine) Sounds.forScore(mine.score, 6000);
	el("round-score-display").textContent = result.label || locId(result.location_id);
	el("result-rows").innerHTML =
		[...result.results]
			.sort((a, b) => b.score - a.score)
			.map((r) => {
				const mine = r.user_id === user?.id;
				return `<div class="flex items-center gap-3 ${mine ? "text-white" : "text-zinc-400"}">
					${avatarHtml(r.avatar_url, "w-8 h-8")}
					<div class="flex-1 min-w-0">
						<div class="text-sm font-semibold truncate">${escHtml(r.display_name || r.username)}${mine ? " (you)" : ""}</div>
						<div class="text-xs text-zinc-500">${r.distance !== null ? `~${r.distance.toLocaleString()} units · ${r.time_taken}s` : "No guess"}</div>
					</div>
					<div class="text-right">
						<div class="score-pop font-mono font-bold ${r.score === best && best > 0 ? "text-yellow-400" : ""}">+<span data-count="${r.score}">0</span></div>
						<div class="text-xs text-zinc-500">total <span data-count="${r.total_score}" data-from="${r.total_score - r.score}">${(r.total_score - r.score).toLocaleString()}</span></div>
					</div>
				</div>`;
			})
			.join("") +
		`<div class="flex items-center justify-between mt-2 pt-2 border-t border-zinc-700">
			<span class="text-xs font-mono text-zinc-500">${[locId(result.location_id), difficultyText(result.difficulty)].filter(Boolean).join(" · ")}</span>
			<a href="${reportLocationUrl(result.location_id)}" target="_blank" rel="noopener" class="text-xs text-zinc-500 hover:text-zinc-300 transition underline">Report location</a>
		</div>`;

	for (const node of el("result-rows").querySelectorAll("[data-count]")) {
		countUp(node, Number(node.dataset.count), { from: Number(node.dataset.from || 0), duration: 900 });
	}
	lastRoundWasFinal = !!result.is_last;
	if (!isSpectator()) checkAchievements(1500);
	runNextRoundCountdown(result.next_in);
	switchScreen("round-screen");
	el("result-screen").classList.add("shown");
	// The sheet covers the bottom of the map, so bring the answer and every guess into what is left.
	view.fitResult(
		result,
		result.results.filter((r) => r.guessed_x !== null).map((r) => ({ x: r.guessed_x, y: r.guessed_y }))
	);
}

let lastRoundWasFinal = false;

/** Every round seen in this duel, kept for the replay on the end screen. */
let roundHistory = [];
let lastPlayers = [];
let introShown = false;
let replayMap = null;

function versusHtml(players) {
	const card = (p) => `<div class="flex flex-col items-center gap-2 w-32 sm:w-40">
		${avatarHtml(p.avatar_url, "w-16 h-16 sm:w-20 sm:h-20 border-4 border-zinc-800")}
		<span class="font-bold text-sm sm:text-base max-w-full truncate">${escHtml(p.display_name || p.username)}</span>
	</div>`;
	return players.length === 2
		? `${card(players[0])}<span class="versus-mark text-2xl sm:text-3xl font-black text-zinc-500">VS</span>${card(players[1])}`
		: "";
}

/** The versus card shown to someone who joins a duel already under way, e.g. a spectator. */
function showJoinIntro() {
	if (introShown || lastPlayers.length !== 2) return;
	introShown = true;
	el("versus").innerHTML = versusHtml(lastPlayers);
	el("start-countdown-label").textContent = isSpectator() ? "Now watching" : "Back in the duel";
	el("start-countdown-value").textContent = "";
	Sounds.play("versus");
	show("start-countdown");
	setTimeout(() => show("start-countdown", false), 1600);
}

/** Plays the whole duel back on the end-screen map, one round after another. */
function playReplay() {
	show("end-replay", roundHistory.length > 0);
	if (!roundHistory.length) return;
	replayMap ??= new MapCanvas(el("replay-canvas"), {});
	replayMap.clearPin();
	const colors = new Map();
	for (const round of roundHistory) {
		replayMap.addReplayRound(
			round.round,
			round.correct_x,
			round.correct_y,
			round.results
				.filter((r) => r.guessed_x !== null)
				.map((r) => {
					colors.set(r.user_id, [
						r.user_id === user?.id ? MapCanvas.GUESS_COLOR : pinColor(r.user_id),
						r.user_id === user?.id ? "You" : r.display_name || r.username,
					]);
					return { x: r.guessed_x, y: r.guessed_y, color: colors.get(r.user_id)[0] };
				})
		);
	}
	el("end-replay-legend").innerHTML =
		[...colors.values()]
			.map(
				([color, name]) =>
					`<span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full" style="background:${color}"></span>${escHtml(name)}</span>`
			)
			.join("") +
		`<span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full" style="background:${MapCanvas.ANSWER_COLOR}"></span>Answer</span>`;
}

function runNextRoundCountdown(seconds) {
	let left = seconds;
	const label = () =>
		(el("next-round-btn").textContent =
			`${lastRoundWasFinal ? "Final results" : "Next round"} in ${Math.max(0, left)}s…`);
	label();
	clearInterval(nextRoundTimer);
	nextRoundTimer = setInterval(() => {
		left--;
		label();
		if (left <= 0) clearInterval(nextRoundTimer);
	}, 1000);
}

function showEndPanel(id) {
	for (const panel of ["end-actions", "end-waiting", "end-incoming"]) {
		el(panel).classList.toggle("hidden", panel !== id);
		el(panel).classList.toggle("flex", panel === id);
	}
}

function rematchUnavailable(reason) {
	showEndPanel("end-actions");
	const btn = el("play-again-btn");
	if (isSpectator()) return;
	btn.disabled = true;
	btn.textContent = reason;
	btn.className = btn.className.replace(
		"bg-blue-600 hover:bg-blue-500",
		"bg-zinc-700 text-zinc-400 cursor-not-allowed"
	);
}

function showGameEnd(result, { forfeit = false } = {}) {
	// The server's record covers rounds played before we joined or reloaded.
	if (result.rounds?.length) roundHistory = result.rounds;
	clearInterval(nextRoundTimer);
	hideOverlay();
	view?.stop();
	el("result-screen").classList.remove("shown");
	switchScreen("end-screen");
	showEndPanel("end-actions");
	show("spectate-new-game-btn", false);

	const btn = el("play-again-btn");
	btn.disabled = false;
	btn.textContent = isSpectator() ? "Back to Duels" : "Play Again";
	btn.className = btn.className.replace(
		"bg-zinc-700 text-zinc-400 cursor-not-allowed",
		"bg-blue-600 hover:bg-blue-500"
	);
	show("end-leave-btn", !isSpectator());
	if (forfeit && !isSpectator()) rematchUnavailable("Opponent left");

	const winnerName = result.winner?.display_name || result.winner?.username || "Opponent";
	const iWon = !isSpectator() && result.winner?.user_id === user?.id;
	el("end-headline").textContent = result.is_tie ? "It's a Tie!" : iWon ? "You Win!" : `${winnerName} Wins`;
	Sounds.play(iWon || result.is_tie || isSpectator() ? "win" : "lose");
	if (iWon) celebrate();
	el("end-subline").textContent = forfeit ? (iWon ? "Your opponent left the duel." : "A player left the duel.") : "";

	const medals = [
		["emoji_events", "text-yellow-400"],
		["military_tech", "text-zinc-300"],
	];
	/** The winner goes on top even when they won by forfeit with fewer points. */
	const winnerId = result.winner?.user_id;
	el("end-scores").innerHTML = [...(result.scores || [])]
		.sort((a, b) => (b.user_id === winnerId) - (a.user_id === winnerId))
		.map((p, i) => {
			const mine = p.user_id === user?.id;
			const leads = i === 0 && !result.is_tie && !!winnerId;
			const rated = result.ratings?.find((r) => r.user_id === p.user_id);
			const ratingHtml = rated
				? `<div class="text-xs text-zinc-500 font-normal">Rating ${rated.rating.toLocaleString()} <span class="font-mono ${rated.change >= 0 ? "text-green-400" : "text-red-400"}">${rated.change >= 0 ? "+" : ""}${rated.change}</span></div>`
				: "";
			return `<div class="flex items-center gap-4 bg-zinc-900 rounded-2xl px-5 py-4 ${mine ? "ring-2 ring-blue-500" : leads ? "ring-2 ring-yellow-500/40" : ""}">
				<span class="material-symbols-outlined text-2xl ${medals[result.is_tie ? 1 : i]?.[1] ?? "text-zinc-600"}" style="font-variation-settings:'FILL' 1">${medals[result.is_tie ? 1 : i]?.[0] ?? "person"}</span>
				${avatarHtml(p.avatar_url, "w-10 h-10")}
				<div class="flex-1 min-w-0 text-left font-semibold"><div class="truncate">${escHtml(p.display_name || p.username)}${mine ? " (you)" : ""}</div>${ratingHtml}</div>
				<div class="text-2xl font-bold font-mono flex-shrink-0 ${leads ? "text-yellow-400" : ""}" data-count="${p.total_score}">0</div>
			</div>`;
		})
		.join("");
	for (const node of el("end-scores").querySelectorAll("[data-count]"))
		countUp(node, Number(node.dataset.count), { duration: 1200 });
	if (!isSpectator()) checkAchievements(1800);
	playReplay();
}

init();
