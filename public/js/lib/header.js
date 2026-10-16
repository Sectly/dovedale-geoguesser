import { Sounds } from "../sounds.js";
import { avatarHtml, el, escHtml, whenIdle } from "./dom.js";
import { fetchUser, loginUrl } from "./api.js";
import { registerServiceWorker } from "./push.js";
import { checkAchievements } from "./achievements.js";
import { renderAttentionBadges, startAttentionPolling } from "./attention.js";

function renderAuthAreas(user) {
	const iconLink = (href, icon, label, badge = "") =>
		`<a href="${href}" title="${label}" aria-label="${label}" ${badge ? `data-badge="${badge}"` : ""} class="relative w-8 h-8 rounded-full flex items-center justify-center text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition">
			<span class="material-symbols-outlined text-xl leading-none">${icon}</span>
		</a>`;
	const html = user
		? `<div class="flex items-center gap-1">
			<a href="/u/${encodeURIComponent(user.username)}" class="flex items-center gap-2 hover:opacity-80 transition mr-1" title="Your profile">
				${avatarHtml(user.avatar_url)}
				<span class="hidden sm:inline text-sm text-zinc-300 max-w-[9rem] truncate">${escHtml(user.display_name || user.username)}</span>
			</a>
			${user.role ? iconLink("/admin", "shield_person", "Staff panel", "staff") : ""}
			${iconLink("/settings", "settings", "Settings", "settings")}
			${iconLink("/api/auth/logout", "logout", "Log out")}
		</div>`
		: `<a href="${escHtml(loginUrl())}" class="m-btn m-btn-tonal m-btn-sm">Log in with Discord</a>`;
	for (const area of document.querySelectorAll("[data-auth-area]")) area.innerHTML = html;
	renderAttentionBadges();
}

export const NAV_LINKS = [
	["/play", "Solo", "explore"],
	["/daily", "Daily", "calendar_today"],
	["/duels", "Duels", "swords"],
	["/leaderboard", "Leaderboard", "leaderboard"],
	["/submit", "Submit", "add_photo_alternate"],
];

export const NEWS_LINK = ["/news", "News", "newspaper"];

function renderSiteNav() {
	const nav = el("site-nav");
	if (!nav) return;
	const here = location.pathname;
	const link = ([href, label, icon], mobile) => {
		const active = here === href || (href === "/duels" && here.startsWith("/duel/"));
		/** On desktop the highlight is its own layer, so it can slide between sections (shared.css). */
		const tone = !active
			? "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60"
			: mobile
				? "text-white bg-zinc-800 font-semibold"
				: "relative text-white font-semibold";
		return `<a href="${href}" ${active ? 'aria-current="page"' : ""} class="flex items-center gap-2 rounded-lg text-sm transition ${
			mobile ? "px-3 py-2.5" : "px-2.5 py-1.5"
		} ${tone}">
			${mobile ? `<span class="material-symbols-outlined text-lg leading-none">${icon}</span>` : ""}${active && !mobile ? '<span class="nav-active-pill"></span>' : ""}${label}
		</a>`;
	};
	const keep = [...nav.querySelectorAll("[data-keep]")];
	nav.className =
		"relative flex-shrink-0 bg-zinc-900 border-b border-zinc-800 flex items-center gap-2 px-3 sm:px-4 h-12 z-30";
	nav.setAttribute("aria-label", "Main");
	nav.innerHTML = `
		<a href="/" class="flex items-center gap-2 text-zinc-200 hover:text-white transition mr-1 sm:mr-3" title="Home">
			<span class="material-symbols-outlined text-xl leading-none text-blue-400" style="font-variation-settings:'FILL' 1">explore</span>
			<span class="font-bold text-sm whitespace-nowrap hidden sm:inline">Dovedale GeoGuesser</span>
		</a>
		<div class="hidden md:flex items-center gap-1">${NAV_LINKS.map((l) => link(l, false)).join("")}</div>
		<div class="ml-auto flex items-center gap-1">
			<a href="/news" title="News" aria-label="News" ${here === "/news" ? 'aria-current="page"' : ""} class="w-8 h-8 rounded-full flex items-center justify-center transition ${here === "/news" ? "text-white bg-zinc-800" : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"}">
				<span class="material-symbols-outlined text-xl leading-none">newspaper</span>
			</a>
			<div data-auth-area></div>
			<button id="site-nav-toggle" aria-label="Menu" aria-expanded="false" class="md:hidden w-8 h-8 rounded-full flex items-center justify-center text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition">
				<span class="material-symbols-outlined text-xl leading-none">menu</span>
			</button>
		</div>
		<div id="site-nav-menu" class="hidden md:hidden absolute top-full inset-x-0 bg-zinc-900 border-b border-zinc-800 shadow-xl p-2 flex-col gap-0.5">
			${[...NAV_LINKS, NEWS_LINK].map((l) => link(l, true)).join("")}
		</div>`;
	nav.prepend(...keep);

	const toggle = el("site-nav-toggle");
	const menu = el("site-nav-menu");
	const setOpen = (open) => {
		menu.classList.toggle("hidden", !open);
		menu.classList.toggle("flex", open);
		toggle.setAttribute("aria-expanded", String(open));
	};
	toggle.addEventListener("click", (e) => {
		e.stopPropagation();
		setOpen(menu.classList.contains("hidden"));
	});
	document.addEventListener("click", () => setOpen(false));
}

function renderSiteFooter() {
	const footer = el("site-footer");
	if (!footer) return;
	footer.className = "w-full flex flex-col items-center gap-2 px-4 py-6 mt-auto text-xs text-zinc-600";
	footer.innerHTML = `
		<div class="flex flex-wrap justify-center gap-x-4 gap-y-1">
			${[
				["/news", "News"],
				["/tos", "Terms of Service"],
				["/privacy", "Privacy Policy"],
				["/fairplay", "Fair Play"],
				["/guidelines", "Upload Guidelines"],
				["/settings?ticket=other", "Support"],
			]
				.map(([href, label]) => `<a href="${href}" class="hover:text-zinc-400 transition">${label}</a>`)
				.join("")}
		</div>
		<button data-on-click="toggleShortcuts(true)" class="hidden sm:flex items-center gap-1.5 hover:text-zinc-400 transition">Press <kbd class="kbd">?</kbd> for shortcuts</button>
		<p class="text-center text-zinc-700">Dovedale GeoGuesser is in <span class="text-yellow-700 font-medium">beta</span>. Not an official Dovedale Railway project.</p>`;
}

renderSiteNav();
renderSiteFooter();
for (const area of document.querySelectorAll("[data-auth-area]")) {
	area.innerHTML = '<div class="skeleton h-8 w-36 rounded-full"></div>';
}
fetchUser().then((user) => {
	renderAuthAreas(user);
	/** For everyone, logged in or not: it also stands in for the site while the server restarts. */
	whenIdle(registerServiceWorker);
	if (!user) return;
	/** The account's sound preference wins over whatever this browser remembered. */
	if (typeof user.prefs?.sounds === "boolean") Sounds.setEnabled(user.prefs.sounds);
	startAttentionPolling();
	if (user.unseen_achievements) whenIdle(() => checkAchievements());
});
