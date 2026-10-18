import { Sounds } from "../sounds.js";
import { isMidRound } from "./dom.js";
import { api } from "./api.js";
import { showToast } from "./toast.js";
import { live, onLive } from "./live.js";

/** Reads restart news from every response. A proxy error page has no "X-App" mark and must not count as "restart over". */
(function watchResponsesForRestart() {
	const original = window.fetch.bind(window);
	window.fetch = async (...args) => {
		const res = await original(...args);
		try {
			if (res.headers.get("X-App")) {
				noteRestarted(res.headers.get("X-Restarted"));
				if (new URL(res.url, location.href).pathname.startsWith("/api/"))
					noteRestart(res.headers.get("X-Restart-In"));
			}
		} catch {}
		return res;
	};
})();

onLive("hello", (state) => {
	noteRestart(state.restart_in);
	noteRestarted(state.restarted);
});
onLive("restart", (state) => noteRestart(state.restart_in));

const RESTART_POLL_MS = 20_000;
let _restartAt = 0;
let _restartTimer = null;

/** Takes the server's restart countdown in seconds. Nothing means it was called off or is over. */
export function noteRestart(seconds) {
	if (seconds === null || seconds === undefined || seconds === "") return clearRestartBanner();
	if (!Number.isFinite(Number(seconds))) return;
	const at = Date.now() + Number(seconds) * 1000;
	showRestartBanner(_restartAt ? Math.min(_restartAt, at) : at, true);
}

function showRestartBanner(at, announce) {
	_restartAt = at;
	try {
		sessionStorage.setItem(RESTART_AT_KEY, String(at));
	} catch {}
	if (!_restartTimer) {
		if (announce) Sounds.play("notify");
		_restartTimer = setInterval(tickRestartBanner, 1000);
	}
	tickRestartBanner();
}

const RESTART_SEEN_KEY = "restart_seen";
const RESTART_AT_KEY = "restart_at";

function noteRestarted(id) {
	if (!id) return;
	try {
		if (localStorage.getItem(RESTART_SEEN_KEY) === id) return;
		localStorage.setItem(RESTART_SEEN_KEY, id);
	} catch {
		return;
	}
	if (_restartTimer) return;
	showToast("The server just restarted. Open duels and team games have ended.");
}

function clearRestartBanner() {
	if (!_restartTimer) return;
	const calledOff = Date.now() < _restartAt - 2000;
	clearInterval(_restartTimer);
	_restartTimer = null;
	_restartAt = 0;
	try {
		sessionStorage.removeItem(RESTART_AT_KEY);
	} catch {}
	document.getElementById("restart-banner")?.remove();
	if (!document.getElementById("restart-overlay")) {
		return showToast(
			calledOff ? "The restart was called off." : "The server is back. Reload the page if anything looks off.",
			"success"
		);
	}
	restartOverlay("back");
	setTimeout(() => {
		if ([...document.querySelectorAll("textarea, input[type=text]")].some((field) => field.value.trim())) {
			dismissRestartOverlay();
			return showToast("The server is back. Reload the page if anything looks off.", "success");
		}
		try {
			sessionStorage.setItem(RESTART_RELOADED_KEY, "1");
		} catch {}
		location.reload();
	}, RESTART_BACK_MS);
}

/** Set just before reloading after a restart, so the next page fades in from the same screen. */
const RESTART_RELOADED_KEY = "restart_reloaded";
const RESTART_BACK_MS = 1200;

/** Puts the restart screen up, or moves it on: "down" while the server is away, "back" once it answers. */
function restartOverlay(state) {
	let overlay = document.getElementById("restart-overlay");
	if (!overlay) {
		overlay = document.createElement("div");
		overlay.id = "restart-overlay";
		overlay.className = "restart-overlay";
		overlay.setAttribute("role", "status");
		overlay.innerHTML = `<svg class="restart-rack" viewBox="0 0 96 96" aria-hidden="true">
			<rect x="16" y="14" width="64" height="20" rx="5" /><circle cx="27" cy="24" r="3" /><path d="M44 24h26" />
			<rect x="16" y="38" width="64" height="20" rx="5" /><circle cx="27" cy="48" r="3" /><path d="M44 48h26" />
			<rect x="16" y="62" width="64" height="20" rx="5" /><circle cx="27" cy="72" r="3" /><path d="M44 72h26" />
		</svg>
		<div class="restart-overlay-title"></div>
		<p></p>
		<button class="m-btn m-btn-tonal m-btn-sm" data-on-click="location.reload()">Reload now</button>`;
		document.body.appendChild(overlay);
	}
	const back = state === "back";
	overlay.dataset.state = state;
	overlay.querySelector(".restart-overlay-title").textContent = back ? "Back online" : "Restarting the server";
	overlay.querySelector("p").textContent = back ? "" : "Back in a moment.";
	return overlay;
}

function dismissRestartOverlay() {
	const overlay = document.getElementById("restart-overlay");
	overlay?.classList.add("leaving");
	setTimeout(() => overlay?.remove(), 400);
}

(function arriveFromRestart() {
	try {
		if (sessionStorage.getItem(RESTART_RELOADED_KEY) !== "1") return;
		sessionStorage.removeItem(RESTART_RELOADED_KEY);
	} catch {
		return;
	}
	restartOverlay("back").classList.add("arrived");
	setTimeout(dismissRestartOverlay, 700);
})();

function tickRestartBanner() {
	let banner = document.getElementById("restart-banner");
	if (!banner) {
		banner = document.createElement("div");
		banner.id = "restart-banner";
		banner.setAttribute("role", "alert");
		banner.className = "restart-banner";
		banner.innerHTML = `<span class="material-symbols-outlined">restart_alt</span><span></span>`;
		document.body.appendChild(banner);
	}
	const left = Math.ceil((_restartAt - Date.now()) / 1000);
	banner.lastElementChild.textContent =
		left > 0
			? `Server restarting in ${left >= 60 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : `${left}s`}. Open duels and team games will be closed.`
			: "Server restarting... back in a moment.";
	if (left <= 0 && !isMidRound() && location.pathname !== "/admin" && !document.getElementById("restart-overlay"))
		restartOverlay("down");
	if (left <= 0 && left % 2 === 0) api("/api/status").catch(() => {});
}

(function resumeRestartBanner() {
	let at = 0;
	try {
		at = Number(sessionStorage.getItem(RESTART_AT_KEY)) || 0;
	} catch {}
	if (at && Date.now() - at < 60_000) showRestartBanner(at, false);
})();

const checkForRestart = () => document.hidden || live.connected || api("/api/status").catch(() => {});
setInterval(checkForRestart, RESTART_POLL_MS);
document.addEventListener("visibilitychange", checkForRestart);
