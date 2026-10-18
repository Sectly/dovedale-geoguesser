import { Sounds } from "../sounds.js";
import { DIALOG_CLOSE_MS, avatarHtml, escHtml } from "./dom.js";
import { fetchUser } from "./api.js";

const BETA_KEY = "beta_acknowledged";
/** Whether the beta notice is still to come on this page. It then carries the greeting itself. */
const betaNoticeDue = (() => {
	if (["/tos", "/privacy", "/fairplay", "/guidelines"].includes(location.pathname)) return false;
	try {
		return !localStorage.getItem(BETA_KEY);
	} catch {
		return false;
	}
})();
/** Set by the server right after a login: "new" for a first one, "back" otherwise. */
const welcomeKind = document.cookie.match(/(?:^|; )welcome=(new|back)/)?.[1];
if (welcomeKind) document.cookie = "welcome=; Path=/; Max-Age=0";

(async function welcome() {
	const kind = welcomeKind;
	if (!kind || betaNoticeDue) return;
	const user = await fetchUser();
	if (!user || user.is_banned) return;
	await window.introDone;

	const card = document.createElement("div");
	card.className = "welcome-card";
	card.setAttribute("role", "status");
	card.innerHTML = `${avatarHtml(user.avatar_url, "w-12 h-12 flex-shrink-0")}
		<div class="min-w-0">
			<div class="text-xs text-zinc-400">${kind === "new" ? "Welcome to Dovedale GeoGuesser" : "Welcome back"}</div>
			<div class="font-bold truncate">${escHtml(user.display_name || user.username)}</div>
		</div>`;
	document.body.appendChild(card);
	Sounds.play("good");
	setTimeout(() => card.classList.add("leaving"), 2600);
	setTimeout(() => card.remove(), 3100);
})();

(function betaNotice() {
	const KEY = BETA_KEY;
	if (!betaNoticeDue) return;
	const modal = document.createElement("div");
	modal.innerHTML = `<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 modal-fade">
		<div class="bg-zinc-900 border border-zinc-700 rounded-2xl p-8 max-w-sm w-full mx-4 shadow-2xl" role="dialog" aria-modal="true" aria-label="Early beta">
			<div class="flex items-center gap-3 mb-4">
				<span class="material-symbols-outlined text-yellow-500 text-3xl" style="font-variation-settings:'FILL' 1">science</span>
				<h2 class="text-xl font-bold" id="beta-title">Early Beta</h2>
			</div>
			<p class="text-zinc-400 text-sm mb-3">Dovedale GeoGuesser is in beta, so some things may break or change.</p>
			<p class="text-zinc-500 text-sm mb-6">Found a problem? Open a ticket in <a href="/settings" class="text-blue-400 hover:text-blue-300 underline">Settings</a>.</p>
			<button class="m-btn m-btn-filled w-full">Got it</button>
		</div>
	</div>`;
	modal.querySelector("button").addEventListener("click", () => {
		localStorage.setItem(KEY, "1");
		modal.firstElementChild.classList.add("hidden");
		setTimeout(() => modal.remove(), DIALOG_CLOSE_MS);
	});
	if (welcomeKind)
		fetchUser().then((user) => {
			if (!user || user.is_banned) return;
			modal.querySelector("#beta-title").textContent =
				`${welcomeKind === "new" ? "Welcome" : "Welcome back"}, ${user.display_name || user.username}`;
		});
	const mount = () => (window.introDone || Promise.resolve()).then(() => document.body.appendChild(modal));
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
	else mount();
})();

/** Banned accounts see only the ban notice, except on Settings and the documents. */
(async function banNotice() {
	const user = await fetchUser();
	const open = ["/settings", "/tos", "/privacy", "/guidelines", "/fairplay"];
	if (!user?.is_banned || open.includes(location.pathname)) return;

	const expiry =
		user.ban_type === "temp" && user.ban_expires_at
			? `Your ban ends ${new Date(user.ban_expires_at * 1000).toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" })}.`
			: "This ban is permanent.";
	const escaped = escHtml(user.ban_reason || "");
	const { linkRuleCodes } = await import("../rules.js");
	const reason = linkRuleCodes(escaped);
	const overlay = document.createElement("div");
	overlay.className =
		"fixed inset-0 z-[9999] bg-zinc-950 flex items-center justify-center px-4 text-center overflow-y-auto";
	overlay.setAttribute("role", "alertdialog");
	overlay.setAttribute("aria-label", "Account banned");
	overlay.innerHTML = `<div class="max-w-sm w-full py-8">
		<span class="material-symbols-outlined text-5xl text-red-300 mb-3" style="font-variation-settings:'FILL' 1">block</span>
		<h1 class="text-2xl font-bold mb-2">Your account is banned</h1>
		<p class="text-zinc-400 text-sm">${escHtml(expiry)}</p>
		${reason ? `<div class="bg-zinc-900 rounded-2xl px-4 py-3 mt-4 text-left"><div class="m-label">Reason</div><p class="text-sm text-zinc-200 break-words">${reason}</p></div>` : ""}
		<p class="text-zinc-500 text-sm mt-4 leading-relaxed">Think this is a mistake? Appeal and a member of staff will review it.</p>
		<div class="flex flex-col items-center gap-2 mt-5">
			<a href="/settings?ticket=ban_appeal#support" class="m-btn m-btn-filled">Appeal this ban</a>
			<a href="/api/auth/logout" class="m-btn m-btn-text">Log out</a>
		</div>
	</div>`;
	document.body.appendChild(overlay);
})();

/** Staff are the only ones who can see the site during maintenance, so they are told it is on. */
export function renderMaintenanceBanner(state) {
	document.getElementById("maintenance-banner")?.remove();
	if (!state) return;
	const banner = document.createElement("div");
	banner.id = "maintenance-banner";
	banner.setAttribute("role", "status");
	banner.className =
		"fixed bottom-3 left-1/2 -translate-x-1/2 z-[60] max-w-[calc(100vw-1.5rem)] bg-amber-300 text-zinc-950 rounded-full pl-3.5 pr-4 py-2 text-sm font-semibold shadow-lg flex items-center gap-2";
	banner.innerHTML = `<span class="material-symbols-outlined text-lg flex-shrink-0">construction</span>
		<span class="truncate">Maintenance mode is on: players are locked out</span>
		<a href="/admin#system" class="underline flex-shrink-0">Manage</a>`;
	document.body.appendChild(banner);
}
fetchUser().then((user) => renderMaintenanceBanner(user?.maintenance));
