import { WebWire } from "/webwire-client.js";

let currentUser = null;
let wire = null;
let mapCanvas = null;
let roomCode = null;
let isHost = false;
let isSpectator = false;
let isQuickPlay = false;
let timerInterval = null;
let pinWorld = null;
let hasGuessed = false;
let roundStartTime = 0;
let startCountdownInterval = null;

function setGuessBtnDisabled(disabled) {
	const btn = el("guess-btn");
	btn.disabled = disabled;
	btn.className = disabled
		? "pointer-events-auto bg-zinc-700 text-zinc-500 pl-4 pr-5 py-2.5 rounded-full font-semibold text-sm whitespace-nowrap cursor-not-allowed transition flex items-center gap-2"
		: "pointer-events-auto bg-blue-600 hover:bg-blue-500 active:scale-95 transition pl-4 pr-5 py-2.5 rounded-full font-semibold text-sm shadow-sm whitespace-nowrap cursor-pointer flex items-center gap-2";
}

async function init() {
	currentUser = await fetchUser();
	renderAuthArea();
	setupPhotoLens(document.getElementById("round-photo"));

	const _duelPathMatch = location.pathname.match(/^\/duel\/([A-Z0-9]+)/i);
	const _duelPathCode = _duelPathMatch ? _duelPathMatch[1].toUpperCase() : null;
	const params = new URLSearchParams(location.search);
	const joinCode = _duelPathCode && params.get("spectate") === null ? _duelPathCode : params.get("join");
	const spectateCode = _duelPathCode && params.get("spectate") !== null ? _duelPathCode : params.get("spectate");

	if (!currentUser) {
		if (spectateCode) {
			roomCode = spectateCode.toUpperCase();
			isSpectator = true;
			el("login-gate").classList.add("hidden");
			el("spectator-banner").classList.remove("hidden");
			await spectateRoom(roomCode);
			return;
		}
		if (joinCode) {
			const redirect = encodeURIComponent(location.pathname + location.search);
			el("login-link").href = `/api/auth/login?redirect=${redirect}`;
			el("login-gate").classList.remove("hidden");
			const spectateBtn = document.createElement("button");
			spectateBtn.className = "mt-3 text-sm text-zinc-500 hover:text-zinc-300 transition underline";
			spectateBtn.textContent = "Spectate without logging in";
			spectateBtn.onclick = async () => {
				el("login-gate").classList.add("hidden");
				roomCode = joinCode.toUpperCase();
				isSpectator = true;
				el("spectator-banner").classList.remove("hidden");
				await spectateRoom(roomCode);
			};
			el("login-gate").querySelector(".text-center")?.appendChild(spectateBtn);
			return;
		}
		const redirect = encodeURIComponent(location.pathname + location.search);
		el("login-link").href = `/api/auth/login?redirect=${redirect}`;
		el("login-gate").classList.remove("hidden");
		return;
	}

	el("login-gate").classList.add("hidden");

	el("create-btn").addEventListener("click", createRoom);
	el("join-btn").addEventListener("click", joinRoom);
	el("join-code").addEventListener("keydown", (e) => {
		if (e.key === "Enter") joinRoom();
	});
	el("start-duel-btn").addEventListener("click", sendStart);
	el("ready-btn").addEventListener("click", sendReady);
	el("leave-btn").addEventListener("click", leaveRoom);
	el("spectate-instead-btn").addEventListener("click", () => spectateInstead(roomCode));
	el("quickplay-btn").addEventListener("click", quickPlay);
	el("guess-btn").addEventListener("click", submitGuess);
	el("play-again-btn").addEventListener("click", () => {
		el("end-screen").classList.add("hidden");
		el("lobby-screen").classList.remove("hidden");
		if (wire) {
			const w = wire;
			wire = null;
			w.disconnect();
		}
		roomCode = null;
		isHost = false;
		isSpectator = false;
		isQuickPlay = false;
		clearRoomUrl();
	});

	if (joinCode) {
		el("join-code").value = joinCode.toUpperCase();
		el("lobby-screen").classList.remove("hidden");
		joinRoom();
	} else if (spectateCode) {
		roomCode = spectateCode.toUpperCase();
		isSpectator = true;
		el("lobby-screen").classList.remove("hidden");
		await spectateRoom(roomCode);
	} else {
		el("lobby-screen").classList.remove("hidden");
	}
}

function renderAuthArea() {
	const html = currentUser
		? `<div class="flex items-center gap-2">
                ${currentUser.avatar_url ? `<img src="${escHtml(currentUser.avatar_url)}" class="w-7 h-7 rounded-full" />` : ""}
                <span class="text-sm text-zinc-300">${escHtml(currentUser.display_name || currentUser.username)}</span>
                <a href="/api/auth/logout" class="text-xs text-zinc-500 hover:text-zinc-300 transition ml-1">Logout</a>
           </div>`
		: `<a href="/api/auth/login?redirect=/duels" class="text-sm bg-zinc-700 hover:bg-zinc-600 transition px-3 py-1.5 rounded-lg">Login with Discord</a>`;
	["auth-area", "auth-area-lobby"].forEach((id) => {
		const a = el(id);
		if (a) a.innerHTML = html;
	});
}

function showError(msg) {
	el("lobby-error").textContent = msg;
	el("lobby-error").classList.remove("hidden");
}

async function createRoom() {
	el("lobby-error").classList.add("hidden");
	const rounds = parseInt(el("rounds-select").value);
	try {
		const r = await fetch("/api/duels/rooms", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ rounds }),
		});
		if (!r.ok) {
			showError(await r.text());
			return;
		}
		const data = await r.json();
		roomCode = data.code;
		isHost = true;
		setRoomUrl(roomCode);
		await connectWire(roomCode);
	} catch {
		showError("Failed to create room.");
	}
}

async function joinRoom() {
	el("lobby-error").classList.add("hidden");
	const code = el("join-code").value.trim().toUpperCase();
	if (code.length !== 6) {
		showError("Enter a 6-character room code.");
		return;
	}
	try {
		const r = await fetch("/api/duels/rooms/" + code + "/join", { method: "POST" });
		if (!r.ok) {
			if (r.status === 409) {
				roomCode = code;
				isSpectator = true;
				await spectateRoom(code);
				return;
			}
			showError(await r.text());
			return;
		}
		roomCode = code;
		isHost = false;
		setRoomUrl(roomCode);
		await connectWire(roomCode);
	} catch {
		showError("Failed to join room.");
	}
}

let _quickPlayNoPlayersTimer = null;
let _quickPlayInFlight = false;

async function quickPlay() {
	if (_quickPlayInFlight) return;
	if (wire) {
		const w = wire;
		wire = null;
		w.disconnect();
	}
	_quickPlayInFlight = true;
	el("lobby-error").classList.add("hidden");
	try {
		const r = await fetch("/api/duels/quickplay", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ rounds: 5 }),
		});
		if (!r.ok) {
			showError(await r.text());
			return;
		}
		const data = await r.json();
		roomCode = data.code;
		isHost = data.status === "waiting";
		isQuickPlay = true;
		setRoomUrl(roomCode);
		await connectWire(roomCode);
		_quickPlayNoPlayersTimer = setTimeout(() => {
			const hint = el("quickplay-no-players");
			if (hint) hint.classList.remove("hidden");
		}, 30_000);
	} catch {
		showError("Failed to find a match.");
	} finally {
		_quickPlayInFlight = false;
	}
}

function showErrorWithSpectate(code, msg) {
	const errEl = el("lobby-error");
	errEl.textContent = msg + " ";
	const btn = document.createElement("button");
	btn.className = "underline text-blue-400 hover:text-blue-300";
	btn.textContent = "Spectate instead";
	btn.addEventListener("click", () => spectateInstead(code));
	errEl.appendChild(btn);
	errEl.classList.remove("hidden");
}

async function spectateInstead(code) {
	el("lobby-error").classList.add("hidden");
	if (wire) {
		wire.emit("leave", {});
		const w = wire;
		wire = null;
		w.disconnect();
	}
	isHost = false;
	roomCode = code;
	isSpectator = true;
	await spectateRoom(code);
}

async function spectateRoom(code) {
	isSpectator = true;
	setRoomUrl(code, true);
	el("lobby-screen").classList.add("hidden");
	el("spectator-banner").classList.remove("hidden");
	await connectWire(code, true);
}

function setRoomUrl(code, spectate = false) {
	const url = spectate ? `/duel/${code}?spectate` : `/duel/${code}`;
	history.replaceState({ roomCode: code, spectate }, "", url);
	document.title = spectate ? `Spectating ${code} | Dovedale GeoGuesser` : `Duel ${code} | Dovedale GeoGuesser`;
}

function clearRoomUrl() {
	history.replaceState({}, "", "/duels");
	document.title = "Duels - Dovedale GeoGuesser";
}

async function connectWire(code, spectate = false) {
	wire = new WebWire("/api/duels/wire");
	const w = wire;

	wire.on("room_state", (data) => showWaitingRoom(data));
	wire.on("start_countdown", (data) => showStartCountdown(data.seconds));
	wire.on("countdown_cancelled", () => {
		clearInterval(startCountdownInterval);
		el("start-countdown").classList.add("hidden");
	});
	wire.on("round_start", (data) => startRound(data));
	wire.on("opponent_guessed", () => {
		const badge = el("opponent-guessed-badge");
		badge.innerHTML =
			'<span class="material-symbols-outlined text-xs leading-none" style="font-variation-settings:\'FILL\' 1">check_circle</span> Opponent guessed';
		badge.classList.remove("hidden");
	});
	wire.on("opponent_disconnected", (data) => {
		clearInterval(timerInterval);
		el("round-screen").classList.add("hidden");
		el("result-screen").classList.add("hidden");
		el("start-countdown").classList.add("hidden");
		el("end-screen").classList.remove("hidden");
		const headline = el("end-headline");
		headline.textContent =
			data.winner?.user_id === currentUser?.id ? "Opponent disconnected - You Win!" : "A player disconnected";
		el("end-scores").innerHTML = "";
	});
	wire.on("round_result", (data) => showRoundResult(data));
	wire.on("game_end", (data) => showGameEnd(data));
	wire.on("error", (data) => showError(data.message || "Unknown error"));

	w.on("disconnect", () => {
		// Ignore closes from a wire that is no longer the active connection.
		// WebWire emits "disconnect" twice on an intentional close: once
		// synchronously from disconnect(), then again when the underlying
		// transport's close event lands. Nulling `wire` first makes both a no-op.
		if (w !== wire) return;
		const inRound = !el("round-screen").classList.contains("hidden");
		const inEnd = !el("end-screen").classList.contains("hidden");
		if (!inEnd) {
			showError(
				inRound
					? "Connection lost mid-game - the server may have restarted. Please return to the lobby."
					: "Connection lost. Please try again."
			);
			el("round-screen").classList.add("hidden");
			el("waiting-screen").classList.add("hidden");
			el("spectator-banner").classList.add("hidden");
			el("lobby-screen").classList.remove("hidden");
			clearRoomUrl();
		}
	});

	try {
		await w.connect();
		if (spectate) {
			w.emit("spectate", { room: code });
		} else {
			w.emit("join", { room: code });
		}
	} catch {
		if (w === wire) showError("Failed to connect to server.");
	}
}

function showWaitingRoom(msg) {
	el("lobby-screen").classList.add("hidden");
	el("waiting-screen").classList.remove("hidden");
	el("room-code-display").textContent = roomCode;

	// Sync isHost from server state so host-transfers work correctly
	if (!isSpectator) {
		const me = msg.players.find((p) => p.user_id === currentUser?.id);
		if (me) isHost = me.is_host;
	}

	if (isSpectator && msg.status === "waiting") {
		el("quickplay-searching").classList.add("hidden");
		el("normal-waiting-header").classList.add("hidden");
		el("start-duel-btn").classList.add("hidden");
		el("ready-btn").classList.add("hidden");
		el("spectate-instead-btn").classList.add("hidden");
		el("waiting-hint").textContent = "Waiting for the duel to start…";
		const playersDiv = el("waiting-players");
		playersDiv.innerHTML = "";
		for (const p of msg.players) {
			playersDiv.innerHTML += `
            <div class="flex flex-col items-center gap-2">
                ${p.avatar_url ? `<img src="${escHtml(p.avatar_url)}" class="w-12 h-12 rounded-full border-2 border-zinc-600" />` : `<div class="w-12 h-12 rounded-full bg-zinc-700 flex items-center justify-center"><span class="material-symbols-outlined">person</span></div>`}
                <span class="text-sm">${escHtml(p.display_name || p.username)}</span>
                ${p.is_host ? '<span class="text-xs text-blue-400">Host</span>' : (p.is_ready ? '<span class="text-xs text-green-400">Ready</span>' : '<span class="text-xs text-zinc-500">Not ready</span>')}
            </div>`;
		}
		return;
	}

	const searchingEl = el("quickplay-searching");
	const normalHeader = el("normal-waiting-header");
	const searching = isQuickPlay && msg.players.length < 2;
	searchingEl.classList.toggle("hidden", !searching);
	normalHeader.classList.toggle("hidden", searching);
	if (!searching && _quickPlayNoPlayersTimer) {
		clearTimeout(_quickPlayNoPlayersTimer);
		_quickPlayNoPlayersTimer = null;
		const hint = el("quickplay-no-players");
		if (hint) hint.classList.add("hidden");
	}

	const playersDiv = el("waiting-players");
	playersDiv.innerHTML = "";
	for (const p of msg.players) {
		playersDiv.innerHTML += `
            <div class="flex flex-col items-center gap-2">
                ${p.avatar_url ? `<img src="${escHtml(p.avatar_url)}" class="w-12 h-12 rounded-full border-2 border-zinc-600" />` : `<div class="w-12 h-12 rounded-full bg-zinc-700 flex items-center justify-center"><span class="material-symbols-outlined">person</span></div>`}
                <span class="text-sm">${escHtml(p.display_name || p.username)}</span>
                ${p.is_host ? '<span class="text-xs text-blue-400">Host</span>' : (p.is_ready ? '<span class="text-xs text-green-400">Ready</span>' : '<span class="text-xs text-zinc-500">Not ready</span>')}
            </div>`;
	}

	if (msg.players.length < 2) {
		playersDiv.innerHTML += `
            <div class="flex flex-col items-center gap-2 opacity-40">
                <div class="w-12 h-12 rounded-full bg-zinc-700 border-2 border-dashed border-zinc-600 flex items-center justify-center">
                    <span class="material-symbols-outlined">person_add</span>
                </div>
                <span class="text-sm">Waiting...</span>
            </div>`;
		el("start-duel-btn").classList.add("hidden");
		el("ready-btn").classList.add("hidden");
		el("spectate-instead-btn").classList.add("hidden");
		el("waiting-hint").textContent = isQuickPlay
			? "Searching for an opponent…"
			: "Waiting for another player to join...";
	} else if (isHost && !isSpectator && !isQuickPlay) {
		const joiner = msg.players.find((p) => !p.is_host);
		const joinerReady = !joiner || joiner.is_ready;
		const startBtn = el("start-duel-btn");
		startBtn.classList.remove("hidden");
		startBtn.disabled = !joinerReady;
		startBtn.className = joinerReady
			? "bg-green-700 hover:bg-green-600 transition px-8 py-3 rounded-full font-bold text-sm shadow-sm mb-3"
			: "bg-zinc-700 text-zinc-500 transition px-8 py-3 rounded-full font-bold text-sm shadow-sm mb-3 cursor-not-allowed";
		el("ready-btn").classList.add("hidden");
		el("spectate-instead-btn").classList.add("hidden");
		el("waiting-hint").textContent = joinerReady
			? "Opponent is ready. Start when ready!"
			: "Waiting for opponent to ready up…";
	} else if (!isHost && !isSpectator && !isQuickPlay) {
		el("start-duel-btn").classList.add("hidden");
		el("spectate-instead-btn").classList.remove("hidden");
		const me = msg.players.find((p) => p.user_id === currentUser?.id);
		const readyBtn = el("ready-btn");
		if (me && !me.is_ready) {
			readyBtn.classList.remove("hidden");
			readyBtn.disabled = false;
			readyBtn.className = "bg-green-700 hover:bg-green-600 transition px-8 py-3 rounded-full font-bold text-sm shadow-sm mb-3";
			readyBtn.textContent = "Ready";
			el("waiting-hint").textContent = "Press Ready when you're set to play!";
		} else {
			readyBtn.classList.remove("hidden");
			readyBtn.disabled = true;
			readyBtn.className = "bg-zinc-700 text-green-400 transition px-8 py-3 rounded-full font-bold text-sm shadow-sm mb-3 cursor-not-allowed";
			readyBtn.textContent = "Ready ✓";
			el("waiting-hint").textContent = "Waiting for the host to start...";
		}
	} else {
		// quickplay
		el("start-duel-btn").classList.add("hidden");
		el("ready-btn").classList.add("hidden");
		el("spectate-instead-btn").classList.add("hidden");
		el("waiting-hint").textContent = isQuickPlay ? "Match found! Starting…" : "Waiting for the host to start...";
	}
}

function sendStart() {
	wire?.emit("start", {});
}

function sendReady() {
	wire?.emit("ready", {});
}

function leaveRoom() {
	if (_quickPlayNoPlayersTimer) {
		clearTimeout(_quickPlayNoPlayersTimer);
		_quickPlayNoPlayersTimer = null;
	}
	if (isQuickPlay) fetch("/api/duels/quickplay", { method: "DELETE" }).catch(() => {});
	wire?.emit("leave", {});
	const w = wire;
	wire = null;
	w?.disconnect();
	roomCode = null;
	isHost = false;
	isSpectator = false;
	isQuickPlay = false;
	clearRoomUrl();
	el("waiting-screen").classList.add("hidden");
	el("spectator-banner").classList.add("hidden");
	el("lobby-screen").classList.remove("hidden");
}

function showStartCountdown(seconds) {
	clearInterval(startCountdownInterval);
	const overlay = el("start-countdown");
	overlay.classList.remove("hidden");
	let remaining = seconds;
	el("start-countdown-value").textContent = remaining;
	startCountdownInterval = setInterval(() => {
		remaining--;
		if (remaining <= 0) {
			clearInterval(startCountdownInterval);
			startCountdownInterval = null;
			overlay.classList.add("hidden");
		} else {
			el("start-countdown-value").textContent = remaining;
		}
	}, 1000);
}

function startRound(msg) {
	clearInterval(startCountdownInterval);
	startCountdownInterval = null;
	el("start-countdown").classList.add("hidden");
	el("waiting-screen").classList.add("hidden");
	el("result-screen").classList.remove("shown");
	el("round-screen").classList.remove("hidden");
	el("opponent-guessed-badge").classList.add("hidden");

	el("round-num").textContent = msg.round;
	el("round-total").textContent = msg.total_rounds;
	el("round-photo").src = msg.image_url;
	setGuessBtnDisabled(true);

	if (isSpectator) {
		el("click-hint").textContent = "Spectating";
	} else {
		el("click-hint").textContent = "Click the map to place your pin";
	}

	hasGuessed = false;
	pinWorld = null;
	roundStartTime = Date.now();

	if (!mapCanvas) {
		const canvas = el("map-canvas");
		mapCanvas = new MapCanvas(canvas, {
			onPinPlaced: (wx, wy) => {
				if (hasGuessed || isSpectator) return;
				pinWorld = { x: wx, y: wy };
				setGuessBtnDisabled(false);
				el("click-hint").textContent = "Pin placed - submit or move it";
			},
		});
	} else {
		mapCanvas.clearPin();
	}
	mapCanvas.setPinEnabled(!isSpectator);

	if (!isSpectator) {
		startTimer(msg.time_limit);
	}
}

function setTimerColor(remaining, limit) {
	const d = el("timer-display");
	d.classList.remove("text-green-400", "text-yellow-400", "text-orange-400", "text-red-400", "timer-urgent");
	const pct = remaining / limit;
	if (pct > 0.5) d.classList.add("text-green-400");
	else if (pct > 0.25) d.classList.add("text-yellow-400");
	else if (pct > 0.1) d.classList.add("text-orange-400");
	else d.classList.add("text-red-400");
	if (remaining <= 10) d.classList.add("timer-urgent");
}

function startTimer(limit) {
	clearInterval(timerInterval);
	let remaining = limit;
	el("timer-val").textContent = remaining;
	setTimerColor(remaining, limit);

	timerInterval = setInterval(() => {
		remaining--;
		el("timer-val").textContent = remaining;
		setTimerColor(remaining, limit);
		if (remaining <= 0) {
			clearInterval(timerInterval);
			if (!hasGuessed) submitGuess();
		}
	}, 1000);
}

function submitGuess() {
	if (hasGuessed || isSpectator) return;
	hasGuessed = true;
	clearInterval(timerInterval);
	setGuessBtnDisabled(true);
	mapCanvas?.setPinEnabled(false);
	const badge = el("opponent-guessed-badge");
	badge.innerHTML =
		'<span class="material-symbols-outlined text-xs leading-none">pause_circle</span> Timer paused · waiting for opponent…';
	badge.classList.remove("hidden");

	const timeTaken = Math.min(60, (Date.now() - roundStartTime) / 1000);
	wire?.emit("guess", {
		world_x: pinWorld?.x ?? null,
		world_y: pinWorld?.y ?? null,
		time_taken: timeTaken,
	});
}

function showRoundResult(msg) {
	clearInterval(timerInterval);
	el("opponent-guessed-badge").classList.add("hidden");
	mapCanvas?.showResult(msg.correct_x, msg.correct_y);

	const sorted = [...msg.results].sort((a, b) => b.total_score - a.total_score);
	const rows = el("result-rows");
	rows.innerHTML = "";
	for (const r of sorted) {
		const isMe = r.user_id === currentUser?.id;
		const isFirst = r === sorted[0];
		rows.innerHTML += `
            <div class="flex items-center gap-3 ${isMe ? "text-white" : "text-zinc-400"}">
                ${r.avatar_url ? `<img src="${escHtml(r.avatar_url)}" class="w-8 h-8 rounded-full" />` : `<div class="w-8 h-8 rounded-full bg-zinc-700"></div>`}
                <div class="flex-1">
                    <div class="text-sm font-semibold">${escHtml(r.display_name || r.username)} ${isMe ? "(you)" : ""}</div>
                    <div class="text-xs text-zinc-500">${r.distance !== null ? `~${r.distance.toLocaleString()} units` : "No guess"}</div>
                </div>
                <div class="text-right">
                    <div class="font-mono font-bold ${isFirst ? "text-yellow-400" : ""}">${r.score.toLocaleString()}</div>
                    <div class="text-xs text-zinc-500">total: ${r.total_score.toLocaleString()}</div>
                </div>
            </div>`;
	}

	el("result-screen").classList.add("shown");

	const nextBtn = el("next-round-btn");
	if (!isSpectator) {
		nextBtn.classList.remove("hidden");
		let countdown = 7;
		const countEl = el("next-round-countdown");
		if (countEl) countEl.textContent = countdown;
		const cd = setInterval(() => {
			countdown--;
			if (countEl) countEl.textContent = countdown;
			if (countdown <= 0) clearInterval(cd);
		}, 1000);
	} else {
		nextBtn.classList.add("hidden");
	}
}

function showGameEnd(msg) {
	clearInterval(timerInterval);
	el("round-screen").classList.add("hidden");
	el("result-screen").classList.add("hidden");
	el("spectator-banner").classList.add("hidden");
	el("end-screen").classList.remove("hidden");

	const headline = el("end-headline");
	if (msg.is_tie) {
		headline.textContent = "It's a Tie!";
	} else if (isSpectator) {
		headline.textContent = `${msg.winner?.username || "Player"} Wins`;
	} else if (msg.winner?.user_id === currentUser?.id) {
		headline.textContent = "You Win!";
	} else {
		headline.textContent = `${msg.winner?.username || "Opponent"} Wins`;
	}

	const scoresDiv = el("end-scores");
	scoresDiv.innerHTML = "";
	msg.scores.forEach((p, i) => {
		const isMe = p.user_id === currentUser?.id;
		const isFirst = i === 0;
		const rankIcons = ["emoji_events", "military_tech", "workspace_premium"];
		const rankColors = ["text-yellow-400", "text-zinc-300", "text-amber-600"];
		scoresDiv.innerHTML += `
            <div class="flex items-center gap-4 bg-zinc-900 rounded-2xl px-5 py-4 ${isMe ? "ring-2 ring-blue-500" : ""}${isFirst ? " ring-2 ring-yellow-500/40" : ""}">
                ${i < 3 ? `<span class="material-symbols-outlined text-2xl ${rankColors[i]}" style="font-variation-settings:'FILL' 1">${rankIcons[i]}</span>` : `<span class="text-2xl font-bold text-zinc-600">#${i + 1}</span>`}
                ${p.avatar_url ? `<img src="${escHtml(p.avatar_url)}" class="w-10 h-10 rounded-full" />` : `<div class="w-10 h-10 rounded-full bg-zinc-700"></div>`}
                <div class="flex-1">
                    <div class="font-semibold">${escHtml(p.display_name || p.username)} ${isMe ? "(you)" : ""}</div>
                </div>
                <div class="text-2xl font-bold font-mono ${isFirst ? "text-yellow-400" : ""}">${p.total_score.toLocaleString()}</div>
            </div>`;
	});
}

function copyInviteLink() {
	if (!roomCode) return;
	const url = `${location.origin}/duel/${roomCode}`;
	navigator.clipboard
		.writeText(url)
		.then(() => {
			const lbl = el("copy-invite-label");
			lbl.textContent = "Copied!";
			setTimeout(() => {
				lbl.textContent = "Copy invite link";
			}, 2000);
		})
		.catch(() => {
			prompt("Copy this link:", url);
		});
}

function copySpectateLink() {
	if (!roomCode) return;
	const url = `${location.origin}/duel/${roomCode}?spectate`;
	navigator.clipboard.writeText(url).catch(() => {
		prompt("Copy this link:", url);
	});
}

window.copyInviteLink = copyInviteLink;
window.copySpectateLink = copySpectateLink;

init();
