/** Helpers used on every page: DOM shortcuts, the API client, the account area and toasts. */

const el = (id) => document.getElementById(id);

const escHtml = (s) =>
	String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");

const locId = (id) => "LOC-" + String(id).padStart(4, "0");

/** True for a link to another site, rather than a page on this one or this site's own address. */
const isExternalLink = (link) => /^https:\/\//i.test(link || "") && !`${link}/`.startsWith(`${location.origin}/`);
/** A link to another site goes by way of the page that warns about leaving. */
const linkHref = (link) => (isExternalLink(link) ? `/leaving?to=${encodeURIComponent(link)}` : link);
/** The mark beside a link that leaves this site. */
const EXTERNAL_ICON =
	'<span class="material-symbols-outlined external-icon" role="img" aria-label="Goes to another site">open_in_new</span>';

/** Shows or hides an element by id. */
function show(id, visible = true) {
	el(id)?.classList.toggle("hidden", !visible);
}

/** Reads restart news from every response. A proxy error page has no "X-App" mark and must not count as "restart over". */
(function watchResponsesForRestart() {
	const original = window.fetch.bind(window);
	window.fetch = async (...args) => {
		const res = await original(...args);
		try {
			if (res.headers.get("X-App")) {
				noteRestarted(res.headers.get("X-Restarted"));
				/** Only API answers carry the countdown; a page or a script having none says nothing. */
				if (new URL(res.url, location.href).pathname.startsWith("/api/"))
					noteRestart(res.headers.get("X-Restart-In"));
			}
		} catch {}
		return res;
	};
})();

/** Calls the API and returns the parsed body. Throws an Error with a showable message and a `status` (0 when unreachable). */
async function api(path, { method, json, body } = {}) {
	let res;
	try {
		res = await fetch(path, {
			method: method || (json !== undefined || body ? "POST" : "GET"),
			headers: json !== undefined ? { "Content-Type": "application/json" } : undefined,
			body: json !== undefined ? JSON.stringify(json) : body,
		});
	} catch {
		throw Object.assign(new Error("Can't reach the server. Check your connection and try again."), { status: 0 });
	}
	const raw = await res.text();
	if (!res.ok) {
		const message = raw && raw.length < 300 && !raw.startsWith("<") && !raw.startsWith("{") ? raw : "";
		throw Object.assign(new Error(message || `Something went wrong (${res.status}).`), { status: res.status });
	}
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

let _userPromise = null;

/** The logged-in user, or null. Fetched once per page and shared by everything that asks. */
function fetchUser() {
	_userPromise ??= loadUser();
	return _userPromise;
}

/** Asks who is logged in. Null means logged out; a failed request is retried first. */
async function loadUser() {
	for (let attempt = 0; ; attempt++) {
		try {
			return await api("/api/auth/me");
		} catch (err) {
			const worthRetrying = !err.status || err.status >= 500 || err.status === 429;
			if (!worthRetrying || attempt >= 3) return null;
			await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
		}
	}
}

function loginUrl(redirect = location.pathname + location.search) {
	return `/api/auth/login?redirect=${encodeURIComponent(redirect)}`;
}

function avatarHtml(url, sizeClass = "w-7 h-7") {
	return url
		? `<img src="${escHtml(url)}" alt="" class="${sizeClass} rounded-full" />`
		: `<div class="${sizeClass} rounded-full bg-zinc-700 flex items-center justify-center"><span class="material-symbols-outlined text-sm">person</span></div>`;
}

/** Fills every `data-auth-area`: avatar, profile, settings and logout, or a login button. */
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

/* ---- Attention: unread notifications and, for staff, what is waiting for review ---- */

let _attention = null;
let _attentionUser = null;
const STAFF_QUEUE_SEEN_KEY = "staff_queue_seen";
const STAFF_QUEUES = [
	["submissions", "submission", "/admin#submissions"],
	["suggestions", "suggestion", "/admin#suggestions"],
	["tickets", "ticket", "/admin#tickets"],
];
const ATTENTION_POLL_MS = 60_000;
const LAST_ANNOUNCED_KEY = "last_notification";

function countBadgeHtml(count, tone = "bg-red-500") {
	return `<span class="attention-badge absolute -top-0.5 -right-0.5 min-w-[1rem] h-4 px-1 rounded-full ${tone} text-white text-[10px] font-bold leading-4 text-center pointer-events-none">${count > 99 ? "99+" : count}</span>`;
}

/** Puts counts on the settings and staff panel buttons when something needs a look. */
function renderAttentionBadges() {
	for (const old of document.querySelectorAll("[data-auth-area] .attention-badge")) old.remove();
	if (!_attention) return;
	const mark = (name, count, tone, describe) => {
		for (const link of document.querySelectorAll(`[data-auth-area] [data-badge="${name}"]`)) {
			if (count > 0) {
				link.insertAdjacentHTML("beforeend", countBadgeHtml(count, tone));
				link.title = describe;
			}
			if (name === "settings") link.href = count > 0 ? "/settings#notifications" : "/settings";
		}
	};
	const unread = _attention.unread;
	const unreadText = `${unread} unread notification${unread === 1 ? "" : "s"}`;
	mark("settings", unread, "bg-red-500", `Settings · ${unreadText}`);
	const staff = _attentionUser?.prefs?.staff_badges ? _attention.staff : null;
	const chat = _attention.staff_chat || 0;
	const waiting = staff
		? `${staff.submissions} submissions, ${staff.suggestions} suggestions, ${staff.tickets} tickets waiting${staff.users ? `, ${staff.users} possible ban evasion` : ""}`
		: "";
	const unseen = chat ? `${chat} new in the staff chat` : "";
	mark(
		"staff",
		(staff?.total ?? 0) + chat,
		"bg-blue-500",
		`Staff panel · ${[waiting, unseen].filter(Boolean).join(", ")}`
	);
}

/** Announces a notification once per browser: a chime, a toast and, if enabled, a desktop notification. */
function announceNotification(latest, user) {
	if (!latest) return;
	let lastSeen = 0;
	try {
		lastSeen = Number(localStorage.getItem(LAST_ANNOUNCED_KEY)) || 0;
		localStorage.setItem(LAST_ANNOUNCED_KEY, String(Math.max(lastSeen, latest.id)));
	} catch {}
	if (latest.id <= lastSeen) return;
	/** An achievement announces itself with its own animation, not a plain toast. */
	if (latest.category === "achievements") return void checkAchievements();

	Sounds.play("notify");
	if (user.prefs?.toasts !== false)
		showToast(latest.title, "info", { href: latest.link || "/settings#notifications" });
	/** With push set up the service worker shows the desktop notification; otherwise do it from here. */
	let pushed = false;
	try {
		pushed = localStorage.getItem(PUSH_ON_KEY) === "1";
	} catch {}
	if (
		user.prefs?.desktop &&
		!pushed &&
		"Notification" in window &&
		Notification.permission === "granted" &&
		document.hidden
	) {
		try {
			const popup = new Notification(latest.title, {
				body: latest.body || "",
				icon: "/favicon.ico",
				tag: `dgg-${latest.id}`,
			});
			popup.onclick = () => {
				window.focus();
				location.href = latest.link || "/settings#notifications";
			};
		} catch {}
	}
}

/** True while a round is on screen; nobody wants a pop-up over the map mid-guess. */
function isMidRound() {
	return ["round-screen", "game-screen"].some((id) => el(id) && !el(id).classList.contains("hidden"));
}

/** For staff: a toast when something new lands in a review queue. Once per item per browser. */
function announceStaffQueue(staff, user) {
	if (!staff || !user.prefs?.staff_alerts || user.prefs?.toasts === false || isMidRound()) return;
	let seen = null;
	try {
		seen = JSON.parse(localStorage.getItem(STAFF_QUEUE_SEEN_KEY) || "null");
		localStorage.setItem(STAFF_QUEUE_SEEN_KEY, JSON.stringify(staff));
	} catch {}
	/** On the staff panel itself the sidebar counts already say it. */
	if (location.pathname === "/admin") return;

	const fresh = STAFF_QUEUES.map(([key, noun, href]) => ({
		noun,
		href,
		count: staff[key] - (seen ? seen[key] || 0 : 0),
	})).filter((q) => q.count > 0);
	if (!fresh.length) return;
	Sounds.play("notify");
	for (const q of fresh) {
		showToast(`${q.count} new ${q.noun}${q.count === 1 ? "" : "s"} waiting for review`, "info", { href: q.href });
	}
}

let _staffChatHeard = null;

/** For staff who chose the badge and sound: a chime when the count of unseen chat messages goes up. */
function announceStaffChat(unseen = 0, user) {
	const heard = _staffChatHeard;
	_staffChatHeard = unseen;
	if (user.prefs?.staff_chat === "badge" && heard !== null && unseen > heard && !isMidRound()) Sounds.play("notify");
}

/** Fetches the latest counts and updates every badge. Pages call this after acting on something. */
async function refreshAttention(attention) {
	const user = await fetchUser();
	if (!user) return null;
	try {
		_attention = attention || (await api("/api/attention"));
	} catch {
		return _attention;
	}
	_attentionUser = user;
	renderAttentionBadges();
	announceNotification(_attention.latest, user);
	announceStaffQueue(_attention.staff, user);
	announceStaffChat(_attention.staff_chat, user);
	document.dispatchEvent(new CustomEvent("attention", { detail: _attention }));
	return _attention;
}

/* ---- Service worker and push: notifications that arrive even when the site is closed ---- */

const PUSH_ON_KEY = "push_on";

function registerServiceWorker() {
	if (!("serviceWorker" in navigator)) return Promise.resolve(null);
	return navigator.serviceWorker.register("/sw.js").catch(() => null);
}

function pushKeyBytes(base64) {
	const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
	return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
}

/** Subscribes this browser to push. Returns false when the server or browser does not support it. */
async function enablePush() {
	try {
		const registration = await registerServiceWorker();
		const { push_key } = await api("/api/meta");
		if (!registration?.pushManager || !push_key) return false;
		const subscription =
			(await registration.pushManager.getSubscription()) ||
			(await registration.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: pushKeyBytes(push_key),
			}));
		await api("/api/push/subscribe", { json: subscription.toJSON() });
		localStorage.setItem(PUSH_ON_KEY, "1");
		return true;
	} catch {
		return false;
	}
}

async function disablePush() {
	try {
		localStorage.removeItem(PUSH_ON_KEY);
		const registration = await navigator.serviceWorker?.getRegistration();
		const subscription = await registration?.pushManager?.getSubscription();
		if (!subscription) return;
		await api("/api/push/subscribe", { method: "DELETE", json: { endpoint: subscription.endpoint } });
		await subscription.unsubscribe();
	} catch {}
}

/** Fallback while the live stream is not connected. */
function startAttentionPolling() {
	whenNotLive(refreshAttention);
	setInterval(() => document.hidden || live.connected || refreshAttention(), ATTENTION_POLL_MS);
	document.addEventListener("visibilitychange", () => document.hidden || live.connected || refreshAttention());
}

/* ---- Live updates: one event stream per page instead of polling ---- */

/** Wait after load before opening the stream, plus up to LIVE_JITTER_MS. */
const LIVE_DELAY_MS = 1500;
const LIVE_JITTER_MS = 2500;
/** A hidden tab closes its stream after this long and reopens it when shown again. */
const LIVE_HIDDEN_MS = 60_000;
/** Handlers rerun after a reconnect, in case an event was missed. */
const LIVE_CATCH_UP = ["ticket", "staff_chat"];

const live = {
	connected: false,
	source: null,
	opened: false,
	retries: 0,
	retryTimer: null,
	hiddenTimer: null,
	handlers: new Map(),
};

/** Returns a function that removes the handler. */
function onLive(event, fn) {
	if (!live.handlers.has(event)) {
		live.handlers.set(event, new Set());
		live.source?.addEventListener(event, (e) => deliverLive(event, e.data));
	}
	live.handlers.get(event).add(fn);
	return () => live.handlers.get(event)?.delete(fn);
}

function deliverLive(event, raw) {
	let data = null;
	try {
		data = JSON.parse(raw);
	} catch {
		return;
	}
	for (const fn of live.handlers.get(event) || []) {
		try {
			fn(data);
		} catch (err) {
			console.error(`[live] ${event} handler failed:`, err);
		}
	}
}

function openLive() {
	if (live.source || !("EventSource" in window) || document.hidden) return;
	clearTimeout(live.retryTimer);
	const source = new EventSource("/api/events");
	live.source = source;
	for (const event of live.handlers.keys()) source.addEventListener(event, (e) => deliverLive(event, e.data));
	source.addEventListener("open", () => {
		const reconnected = live.opened;
		live.connected = live.opened = true;
		live.retries = 0;
		if (reconnected) for (const event of LIVE_CATCH_UP) for (const fn of live.handlers.get(event) || []) fn(null);
	});
	source.addEventListener("error", () => {
		live.connected = false;
		/** Closed by an error status, such as maintenance: retry with a growing wait. */
		if (source.readyState !== EventSource.CLOSED) return;
		closeLive();
		const wait = Math.min(120_000, 5000 * 2 ** live.retries++);
		live.retryTimer = setTimeout(openLive, wait + Math.random() * 2000);
	});
}

function closeLive() {
	live.source?.close();
	live.source = null;
	live.connected = false;
}

/** Runs `fn` if the stream has not connected by the time it should have. */
function whenNotLive(fn) {
	setTimeout(() => live.connected || fn(), LIVE_DELAY_MS + LIVE_JITTER_MS + 2500);
}

onLive("hello", (state) => {
	noteRestart(state.restart_in);
	noteRestarted(state.restarted);
});
onLive("restart", (state) => noteRestart(state.restart_in));
onLive("attention", (attention) => refreshAttention(attention));
onLive("banner", (announcement) => showAnnouncement(announcement));

/** Opened after load and idle plus a random delay, to spread out page loads. */
window.addEventListener("load", () =>
	whenIdle(() => setTimeout(openLive, LIVE_DELAY_MS + Math.random() * LIVE_JITTER_MS))
);
document.addEventListener("visibilitychange", () => {
	clearTimeout(live.hiddenTimer);
	if (document.hidden) live.hiddenTimer = setTimeout(closeLive, LIVE_HIDDEN_MS);
	else if (!live.source && live.opened) setTimeout(openLive, 300 + Math.random() * 1200);
});

const NAV_LINKS = [
	["/play", "Solo", "explore"],
	["/daily", "Daily", "calendar_today"],
	["/duels", "Duels", "swords"],
	["/leaderboard", "Leaderboard", "leaderboard"],
	["/submit", "Submit", "add_photo_alternate"],
];

/** Sits in the header as an icon, and by name in the phone menu and the shortcuts dialog. */
const NEWS_LINK = ["/news", "News", "newspaper"];

/** The site header. Fills `<nav id="site-nav">`. */
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

/** The small-print footer shared by the scrolling pages. Fills `<footer id="site-footer">`. */
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
		<button onclick="toggleShortcuts(true)" class="hidden sm:flex items-center gap-1.5 hover:text-zinc-400 transition">Press <kbd class="kbd">?</kbd> for shortcuts</button>
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
	whenIdle(() => checkAchievements());
});

function showToast(message, type = "info", { href = "" } = {}) {
	let container = el("toast-container");
	if (!container) {
		container = document.createElement("div");
		container.id = "toast-container";
		container.className =
			"fixed bottom-5 inset-x-4 sm:inset-x-auto sm:right-5 flex flex-col items-end gap-2 z-[100] pointer-events-none";
		container.setAttribute("role", "status");
		document.body.appendChild(container);
	}
	const colors = {
		info: "bg-zinc-800 text-zinc-100",
		success: "bg-green-900 text-green-200",
		error: "bg-red-900/90 text-red-200",
	};
	/** A toast with somewhere to go is a link; otherwise it is just a message. */
	const toast = document.createElement(href ? "a" : "div");
	if (href) toast.href = href;
	toast.className = `pointer-events-auto flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm shadow-lg ${colors[type] || colors.info} opacity-0 transition-opacity duration-200 ${href ? "underline-offset-2 hover:underline" : ""}`;
	toast.dataset.type = type;
	const icon = { success: "check_circle", error: "error" }[type];
	if (icon) toast.innerHTML = `<span class="toast-icon material-symbols-outlined" aria-hidden="true">${icon}</span>`;
	toast.append(message);
	container.appendChild(toast);
	requestAnimationFrame(() => toast.classList.remove("opacity-0"));
	setTimeout(
		() => {
			/** It closes the gap it leaves as it goes, so the toasts around it do not jump. */
			toast.style.setProperty("--toast-height", `${toast.offsetHeight}px`);
			toast.classList.add("leaving");
			setTimeout(() => toast.remove(), 250);
		},
		type === "error" || href ? 6000 : 3500
	);
}

/** A failed load, shown in place of the content. `retry` is the code its "Try again" button runs. */
function errorStateHtml(message, retry = "") {
	return `<div class="error-state" role="alert">
		<span class="error-state-icon" aria-hidden="true"><span class="material-symbols-outlined">cloud_off</span></span>
		<p>${escHtml(message)}</p>
		${retry ? `<button class="m-btn m-btn-tonal m-btn-sm" onclick="${escHtml(retry)}"><span class="err-retry material-symbols-outlined">refresh</span>Try again</button>` : ""}
	</div>`;
}

/** Copies text to the clipboard, falling back to the selection trick. Says so if both fail. */
async function copyText(text) {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {}
	const field = document.createElement("textarea");
	field.value = text;
	field.setAttribute("readonly", "");
	field.style.cssText = "position:fixed;top:0;left:0;opacity:0";
	document.body.appendChild(field);
	field.select();
	let copied = false;
	try {
		copied = document.execCommand("copy");
	} catch {}
	field.remove();
	if (!copied) showToast(`Couldn't copy automatically. The link is: ${text}`, "error");
	return copied;
}

/** Placeholder rows shown while a list loads, shaped like the cards that will replace them. */
function skeletonRows(count = 5, heightClass = "h-16") {
	return Array.from({ length: count }, () => `<div class="skeleton ${heightClass} rounded-2xl mb-2"></div>`).join("");
}

/** Runs low-priority work once the page has had a chance to become usable. */
function whenIdle(fn) {
	if ("requestIdleCallback" in window) requestIdleCallback(fn, { timeout: 4000 });
	else setTimeout(fn, 1500);
}

const prefersReducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** For scrollIntoView and scrollTo: smooth, unless the visitor asked for less motion. */
const scrollBehavior = () => (prefersReducedMotion() ? "auto" : "smooth");

/** How long a dialog takes to close (.modal-fade in shared.css). */
const DIALOG_CLOSE_MS = 200;

/** Rolls a number up to its final value. `format` turns the running number into text. */
function countUp(target, to, { from = 0, duration = 700, format = (n) => n.toLocaleString() } = {}) {
	if (!target) return;
	if (prefersReducedMotion() || to === from) return void (target.textContent = format(to));
	const start = performance.now();
	const step = (now) => {
		const t = Math.min(1, (now - start) / duration);
		target.textContent = format(Math.round(from + (to - from) * (1 - Math.pow(1 - t, 3))));
		if (t < 1) requestAnimationFrame(step);
	};
	requestAnimationFrame(step);
}

/** A short burst of confetti over the page, for a win. Cleans itself up. */
function celebrate({ duration = 2600, count = 110 } = {}) {
	if (prefersReducedMotion()) return;
	const canvas = document.createElement("canvas");
	canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:150";
	document.body.appendChild(canvas);
	/** Capped: at a phone's 3x a full-screen canvas is nine times the pixels to fill every frame. */
	const dpr = Math.min(window.devicePixelRatio || 1, 2);
	canvas.width = innerWidth * dpr;
	canvas.height = innerHeight * dpr;
	const ctx = canvas.getContext("2d");
	ctx.scale(dpr, dpr);
	const colors = ["#42A5F5", "#66BB6A", "#FFCA28", "#EF5350", "#AB47BC", "#fff"];
	const pieces = Array.from({ length: count }, (_, i) => ({
		x: i % 2 ? innerWidth * 0.12 : innerWidth * 0.88,
		y: innerHeight * 0.75,
		vx: (i % 2 ? 1 : -1) * (2 + Math.random() * 7),
		vy: -(9 + Math.random() * 9),
		size: 5 + Math.random() * 5,
		spin: Math.random() * Math.PI,
		spinSpeed: (Math.random() - 0.5) * 0.4,
		color: colors[i % colors.length],
	}));
	const start = performance.now();
	const frame = (now) => {
		const age = now - start;
		ctx.clearRect(0, 0, innerWidth, innerHeight);
		ctx.globalAlpha = Math.max(0, 1 - Math.max(0, age - duration * 0.6) / (duration * 0.4));
		for (const p of pieces) {
			p.vy += 0.32;
			p.vx *= 0.99;
			p.x += p.vx;
			p.y += p.vy;
			p.spin += p.spinSpeed;
			ctx.save();
			ctx.translate(p.x, p.y);
			ctx.rotate(p.spin);
			ctx.fillStyle = p.color;
			ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
			ctx.restore();
		}
		if (age < duration) requestAnimationFrame(frame);
		else canvas.remove();
	};
	requestAnimationFrame(frame);
}

/** Colour classes for a score out of a maximum, shared by every result screen. */
function scoreTone(score, max = 5000) {
	const pct = max ? score / max : 0;
	if (pct >= 0.6) return { text: "text-green-400", bar: "bg-green-500" };
	if (pct >= 0.3) return { text: "text-yellow-400", bar: "bg-yellow-500" };
	return { text: "text-red-400", bar: "bg-red-500" };
}

function streakBadgeHtml(streak, { best = false } = {}) {
	if (!streak) return "";
	return `<div class="streak-pop inline-flex items-center gap-1.5 bg-orange-900/40 border border-orange-700/40 px-3 py-1 rounded-full text-orange-300 text-xs">
		<span class="material-symbols-outlined text-sm leading-none text-orange-400" style="font-variation-settings:'FILL' 1">local_fire_department</span>
		${streak === 1 ? "Streak started" : `${streak}-day streak`}${best && streak > 1 ? ' <span class="text-orange-400">(personal best)</span>' : ""}
	</div>`;
}

/** A ripple from where a button was pressed, in its own layer so it survives the button being rewritten. */
document.addEventListener("pointerdown", (e) => {
	if (e.button > 0 || prefersReducedMotion()) return;
	/** Buttons, plus links that are styled as buttons (pills, round icon links, cards). */
	const target = e.target.closest?.('button:not(:disabled), a.md-card, a[class*="rounded"]');
	if (!target) return;
	const rect = target.getBoundingClientRect();
	if (!rect.width || !rect.height) return;

	const layer = document.createElement("span");
	layer.className = "ripple-layer";
	layer.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;border-radius:${getComputedStyle(target).borderRadius}`;
	/** Just large enough to reach the farthest corner from the press. */
	const x = e.clientX - rect.left;
	const y = e.clientY - rect.top;
	const radius = Math.hypot(Math.max(x, rect.width - x), Math.max(y, rect.height - y));
	const ripple = document.createElement("span");
	ripple.className = "ripple";
	ripple.style.cssText = `width:${radius * 2}px;height:${radius * 2}px;left:${x - radius}px;top:${y - radius}px`;
	layer.appendChild(ripple);
	document.body.appendChild(layer);
	/** Keeps the layer on its button if anything scrolls mid-ripple. */
	const follow = () => {
		if (!layer.isConnected) return;
		const now = target.getBoundingClientRect();
		layer.style.left = `${now.left}px`;
		layer.style.top = `${now.top}px`;
		requestAnimationFrame(follow);
	};
	requestAnimationFrame(follow);
	ripple.addEventListener("animationend", () => layer.remove());
	/** A safety net in case the animation never runs (e.g. the tab is hidden). */
	setTimeout(() => layer.remove(), 1000);
});

/* ---- Keyboard shortcuts ---- */

/** Shortcuts that work everywhere. Pages add their own with `addKeybinds`. */
const KEYBIND_GROUPS = [
	{
		title: "Anywhere",
		keys: [
			[["?", "/", "F1"], "Show shortcuts and quick links"],
			[["M"], "Sound effects on or off"],
			[["Esc"], "Close a dialog"],
		],
	},
	{
		title: "Go to (when not mid-round)",
		keys: [
			[["1"], "Solo"],
			[["2"], "Daily challenge"],
			[["3"], "Duels"],
			[["4"], "Leaderboard"],
			[["5"], "Submit a location"],
			[["6"], "News"],
			[["0"], "Home"],
		],
	},
];
const QUICK_LINKS = { 1: "/play", 2: "/daily", 3: "/duels", 4: "/leaderboard", 5: "/submit", 6: "/news", 0: "/" };
const _pageKeys = new Map();

/** Registers shortcuts for the current page: a title for the help dialog and key handlers. */
function addKeybinds(title, binds) {
	KEYBIND_GROUPS.push({ title, keys: binds.map(([keys, label]) => [keys, label]) });
	for (const [keys, , handler] of binds) {
		/** Handlers sharing a key each say whether they applied; the first that does wins. */
		for (const key of keys)
			_pageKeys.set(key.toLowerCase(), [...(_pageKeys.get(key.toLowerCase()) || []), handler]);
	}
}

const isTyping = () =>
	/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "") ||
	document.activeElement?.isContentEditable;

function shortcutsDialog() {
	let dialog = el("shortcuts-dialog");
	if (dialog) return dialog;
	dialog = document.createElement("div");
	dialog.id = "shortcuts-dialog";
	dialog.className = "hidden fixed inset-0 z-[110] bg-black/60 flex items-center justify-center px-4 modal-fade";
	dialog.addEventListener("click", (e) => e.target === dialog && toggleShortcuts(false));
	document.body.appendChild(dialog);
	return dialog;
}

async function toggleShortcuts(open) {
	const dialog = shortcutsDialog();
	open ??= dialog.classList.contains("hidden");
	dialog.classList.toggle("hidden", !open);
	if (!open) return;
	const user = await fetchUser();
	const key = (k) => `<kbd class="kbd">${escHtml(k)}</kbd>`;
	const links = [
		["/", "home", "Home"],
		...[...NAV_LINKS, NEWS_LINK].map(([href, label, icon]) => [href, icon, label]),
		...(user
			? [
					[`/u/${encodeURIComponent(user.username)}`, "person", "Profile"],
					["/settings", "settings", "Settings"],
				]
			: []),
		...(user?.role ? [["/admin", "shield_person", "Staff panel"]] : []),
	];
	dialog.innerHTML = `<div class="bg-zinc-900 border border-zinc-800 rounded-3xl w-full max-w-2xl max-h-[85vh] flex flex-col" role="dialog" aria-modal="true" aria-label="Shortcuts">
		<div class="flex items-center gap-3 px-6 py-4 border-b border-zinc-800 flex-shrink-0">
			<span class="material-symbols-outlined text-xl text-zinc-400">keyboard</span>
			<h2 class="font-bold flex-1">Shortcuts</h2>
			<button onclick="toggleShortcuts(false)" aria-label="Close" class="w-8 h-8 rounded-full flex items-center justify-center text-zinc-400 hover:text-white hover:bg-zinc-800 transition">
				<span class="material-symbols-outlined text-xl leading-none">close</span>
			</button>
		</div>
		<div class="overflow-y-auto p-6">
			<div class="text-xs text-zinc-500 uppercase tracking-wider font-medium mb-2">Quick access</div>
			<div class="grid grid-cols-3 sm:grid-cols-4 gap-2 mb-6">
				${links
					.map(
						([
							href,
							icon,
							label,
						]) => `<a href="${href}" class="flex flex-col items-center gap-1.5 rounded-2xl bg-zinc-800/60 hover:bg-zinc-800 transition px-2 py-3 text-xs text-zinc-300">
							<span class="material-symbols-outlined text-xl text-zinc-400">${icon}</span>${escHtml(label)}
						</a>`
					)
					.join("")}
			</div>
			<div class="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-5">
				${KEYBIND_GROUPS.map(
					(group) => `<div>
						<div class="text-xs text-zinc-500 uppercase tracking-wider font-medium mb-2">${escHtml(group.title)}</div>
						${group.keys
							.map(
								([keys, label]) =>
									`<div class="flex items-center justify-between gap-3 py-1 text-sm text-zinc-300"><span>${escHtml(label)}</span><span class="flex gap-1 flex-shrink-0">${keys.map(key).join("")}</span></div>`
							)
							.join("")}
					</div>`
				).join("")}
			</div>
		</div>
	</div>`;
}

async function toggleSoundsShortcut() {
	const on = !Sounds.enabled;
	Sounds.setEnabled(on);
	if (on) Sounds.play("good");
	showToast(on ? "Sound effects on" : "Sound effects off");
	if (await fetchUser()) api("/api/settings", { json: { prefs: { sounds: on } } }).catch(() => {});
}

document.addEventListener("keydown", (e) => {
	if (e.ctrlKey || e.metaKey || e.altKey) return;
	if (e.key === "Escape") return toggleShortcuts(false);
	if (e.key === "F1") {
		e.preventDefault();
		return toggleShortcuts();
	}
	if (isTyping()) return;
	if (e.key === "?" || e.key === "/") {
		e.preventDefault();
		return toggleShortcuts();
	}
	/** While the help is open, keys belong to it. */
	if (el("shortcuts-dialog") && !el("shortcuts-dialog").classList.contains("hidden")) return;

	const key = e.key.toLowerCase();
	for (const handler of _pageKeys.get(key === " " ? "space" : key) || []) {
		if (handler(e) !== false) return e.preventDefault();
	}
	if (key === "m") return toggleSoundsShortcut();
	if (key in QUICK_LINKS && !isMidRound() && location.pathname !== QUICK_LINKS[key]) location.href = QUICK_LINKS[key];
});

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

/** A brief greeting right after logging in. */
(async function welcome() {
	const kind = welcomeKind;
	if (!kind || betaNoticeDue) return;
	const user = await fetchUser();
	if (!user || user.is_banned) return;
	/** Not under the title screen (intro.js), where it would come and go unseen. */
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

/** One-time notice that the site is in beta. */
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
	/** Someone who has just logged in is greeted here instead of by a card of its own. */
	if (welcomeKind)
		fetchUser().then((user) => {
			if (!user || user.is_banned) return;
			modal.querySelector("#beta-title").textContent =
				`${welcomeKind === "new" ? "Welcome" : "Welcome back"}, ${user.display_name || user.username}`;
		});
	/** Waits for the title screen (intro.js) when that is playing. */
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
	/** Rule codes link to the rule where the rules script is on the page. */
	const reason = typeof linkRuleCodes === "function" ? linkRuleCodes(escaped) : escaped;
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
function renderMaintenanceBanner(state) {
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

/* ---- Announcements: a message from the operators pinned to every page for a while ---- */

const ANNOUNCEMENT_DISMISSED_KEY = "announcement_dismissed";
const ANNOUNCEMENT_POLL_MS = 5 * 60 * 1000;

/** Shows the pinned announcement, unless there is none or this visitor has closed it. */
const ANNOUNCEMENT_ICONS = { info: "campaign", success: "celebration", warning: "warning" };

/** An announcement the player must acknowledge: a dialog until they press OK, which marks it read. Never mid-round. */
(async function acknowledgeAnnouncement() {
	if (!(await fetchUser()) || isMidRound()) return;
	const pending = await api("/api/announcement/pending").catch(() => null);
	if (!pending) return;
	await (window.introDone || Promise.resolve());
	const box = document.createElement("div");
	box.className = "fixed inset-0 z-[96] flex items-center justify-center bg-black/70 modal-fade px-4";
	box.innerHTML = `<div class="bg-zinc-900 border border-zinc-700 rounded-2xl p-6 max-w-sm w-full" role="alertdialog" aria-modal="true" aria-label="Announcement">
		<div class="flex items-center gap-3 mb-3">
			<span class="material-symbols-outlined text-3xl text-[var(--md-primary-bright)]" style="font-variation-settings:'FILL' 1">campaign</span>
			<h2 class="text-lg font-bold break-words">${escHtml(pending.title)}</h2>
		</div>
		<p class="text-zinc-300 text-sm mb-5 break-words">${escHtml(pending.body)}</p>
		<div class="flex gap-2 justify-end">
			${pending.link && pending.link !== "/settings#notifications" ? `<a href="${escHtml(pending.link)}" data-ok class="m-btn m-btn-tonal">${pending.external ? '<span class="material-symbols-outlined" role="img" aria-label="Goes to another site">open_in_new</span>' : ""}Read more</a>` : ""}
			<button data-ok class="m-btn m-btn-filled">OK</button>
		</div>
	</div>`;
	box.addEventListener("click", (e) => {
		if (!e.target.closest("[data-ok]")) return;
		api("/api/notifications/read", { json: { ids: [pending.notification_id] } }).catch(() => {});
		box.remove();
	});
	document.body.appendChild(box);
	box.querySelector("button").focus();
})();

async function checkAnnouncement() {
	const announcement = await api("/api/announcement").catch(() => undefined);
	/** A failed request says nothing either way; leave whatever is on screen alone. */
	if (announcement !== undefined) showAnnouncement(announcement);
}

function showAnnouncement(announcement) {
	const shown = document.getElementById("site-announcement");
	let dismissed = "";
	try {
		dismissed = localStorage.getItem(ANNOUNCEMENT_DISMISSED_KEY) || "";
	} catch {}
	if (!announcement || dismissed === String(announcement.id)) return void shown?.remove();
	if (shown?.dataset.id === String(announcement.id)) return;
	shown?.remove();

	const card = document.createElement("aside");
	card.id = "site-announcement";
	card.className = "site-announcement";
	card.dataset.id = announcement.id;
	card.dataset.style = announcement.style || "info";
	card.setAttribute("aria-label", "Announcement");
	card.innerHTML = `<span class="site-announcement-icon" aria-hidden="true"><span class="material-symbols-outlined">${ANNOUNCEMENT_ICONS[announcement.style] || ANNOUNCEMENT_ICONS.info}</span></span>
		<div class="site-announcement-text">
			<div class="site-announcement-title">${escHtml(announcement.title)}</div>
			<div class="site-announcement-body">${escHtml(announcement.body)}</div>
			${announcement.link ? `<a href="${escHtml(announcement.link)}" class="site-announcement-link">Take a look${announcement.external ? EXTERNAL_ICON : ""}</a>` : ""}
		</div>
		<button class="m-icon-btn" aria-label="Dismiss this announcement"><span class="material-symbols-outlined">close</span></button>`;
	card.querySelector("button").addEventListener("click", () => {
		try {
			localStorage.setItem(ANNOUNCEMENT_DISMISSED_KEY, String(announcement.id));
		} catch {}
		card.remove();
	});
	document.body.appendChild(card);
}
whenNotLive(checkAnnouncement);
setInterval(() => document.hidden || live.connected || checkAnnouncement(), ANNOUNCEMENT_POLL_MS);

/* ---- Achievements: the unlock animation ---- */

const ACHIEVEMENT_SHOWN_MS = 4500;
let _achievementQueue = [];
let _achievementShowing = false;
let _achievementCheck = null;

/** Plays the unlock animation for newly earned achievements. `delay` lets a result land first. */
function checkAchievements(delay = 0) {
	clearTimeout(_achievementCheck);
	_achievementCheck = setTimeout(async () => {
		if (!(await fetchUser())) return;
		const unlocked = await api("/api/achievements/unseen").catch(() => []);
		if (!Array.isArray(unlocked) || !unlocked.length) return;
		_achievementQueue.push(...unlocked);
		showNextAchievement();
	}, delay);
}

async function showNextAchievement() {
	if (_achievementShowing) return;
	const achievement = _achievementQueue.shift();
	if (!achievement) return;
	_achievementShowing = true;
	const user = await fetchUser();

	const card = document.createElement("a");
	card.className = "achievement-pop";
	card.href = user ? `/u/${encodeURIComponent(user.username)}#achievements` : "#";
	card.setAttribute("role", "status");
	card.innerHTML = `<span class="achievement-icon" aria-hidden="true"><span class="material-symbols-outlined">${escHtml(achievement.icon)}</span></span>
		<span class="achievement-text">
			<span class="achievement-kicker">Achievement unlocked</span>
			<span class="achievement-title">${escHtml(achievement.title)}</span>
			<span class="achievement-desc">${escHtml(achievement.description)}</span>
		</span>`;
	document.body.appendChild(card);
	Sounds.play("good");
	/** Same pacing as the welcome card, held a little longer because there is more to read. */
	setTimeout(() => card.classList.add("leaving"), ACHIEVEMENT_SHOWN_MS - 500);
	setTimeout(() => {
		card.remove();
		_achievementShowing = false;
		showNextAchievement();
	}, ACHIEVEMENT_SHOWN_MS);
}

/* ---- Planned restarts: everyone is warned, then told when the server is back ---- */

const RESTART_POLL_MS = 20_000;
let _restartAt = 0;
let _restartTimer = null;

/** Takes the server's restart countdown in seconds. Nothing means it was called off or is over. */
function noteRestart(seconds) {
	if (seconds === null || seconds === undefined || seconds === "") return clearRestartBanner();
	if (!Number.isFinite(Number(seconds))) return;
	const at = Date.now() + Number(seconds) * 1000;
	/** Keep the earliest deadline heard, so the countdown never jumps backwards. */
	showRestartBanner(_restartAt ? Math.min(_restartAt, at) : at, true);
}

/** Puts the countdown up. The deadline is remembered, so a reloaded page shows it at once. */
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

/** Tells whoever reloaded during a restart, or arrived just after, that it happened. Once per restart. */
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
	/** With time still on the clock the server cannot have restarted yet, so it was called off. */
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
		/** A reload would throw away something half-written, so that page is left as it is. */
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

/* ---- The restart itself: a screen over the page while the server is away ---- */

/** Set just before reloading after a restart, so the next page fades in from the same screen. */
const RESTART_RELOADED_KEY = "restart_reloaded";
/** How long "Back online" shows before the page reloads or the screen clears. */
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
		<button class="m-btn m-btn-tonal m-btn-sm" onclick="location.reload()">Reload now</button>`;
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

/** A page that reloaded itself after a restart opens on the same screen and fades out of it. */
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
	/** Not over a round or the staff panel's own progress view. */
	if (left <= 0 && !isMidRound() && location.pathname !== "/admin" && !document.getElementById("restart-overlay"))
		restartOverlay("down");
	/** Past the deadline, keep knocking until the new server answers without mentioning a restart. */
	if (left <= 0 && left % 2 === 0) api("/api/status").catch(() => {});
}

/** A page reloaded mid-countdown shows it straight away, without waiting to hear it again. */
(function resumeRestartBanner() {
	let at = 0;
	try {
		at = Number(sessionStorage.getItem(RESTART_AT_KEY)) || 0;
	} catch {}
	/** Long past its deadline it is stale: the restart came and went while this tab was elsewhere. */
	if (at && Date.now() - at < 60_000) showRestartBanner(at, false);
})();

const checkForRestart = () => document.hidden || live.connected || api("/api/status").catch(() => {});
setInterval(checkForRestart, RESTART_POLL_MS);
/** A tab coming back to the front asks at once rather than waiting out the interval. */
document.addEventListener("visibilitychange", checkForRestart);

/** A script of ours failing should not leave the page silently half-working. Said once per page. */
(function reportScriptErrors() {
	let told = false;
	const tell = (source) => {
		if (told || !String(source || "").startsWith(location.origin + "/js/")) return;
		told = true;
		showToast("Something on this page stopped working. Reloading usually fixes it.", "error");
	};
	window.addEventListener("error", (e) => tell(e.filename));
	window.addEventListener("unhandledrejection", (e) => tell(/https?:\/\/[^\s)]+/.exec(e.reason?.stack || "")?.[0]));
})();

/** Browser details for logged-in users, used to flag possible ban evasion. */
whenIdle(async function fingerprint() {
	if (!(await fetchUser())) return;
	try {
		const signals = [
			navigator.userAgent,
			navigator.language,
			`${screen.width}x${screen.height}x${screen.colorDepth}`,
			Intl.DateTimeFormat().resolvedOptions().timeZone,
			String(navigator.hardwareConcurrency || 0),
			navigator.platform || "",
		];
		try {
			const canvas = document.createElement("canvas");
			const ctx = canvas.getContext("2d");
			ctx.textBaseline = "top";
			ctx.font = "14px Arial";
			ctx.fillStyle = "#f60";
			ctx.fillRect(0, 0, 10, 10);
			ctx.fillStyle = "#069";
			ctx.fillText("Dovedale\u{1F682}", 2, 2);
			signals.push(canvas.toDataURL().slice(-64));
		} catch {}
		try {
			const gl = document.createElement("canvas").getContext("webgl");
			const ext = gl?.getExtension("WEBGL_debug_renderer_info");
			if (ext) signals.push(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
		} catch {}

		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signals.join("||")));
		const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
			.join("")
			.slice(0, 32);
		navigator.sendBeacon("/api/fp", new Blob([JSON.stringify({ h: hash })], { type: "application/json" }));
	} catch {}
});

/** A magnifying lens that follows the mouse over the screenshot; scroll to resize it. */
function setupPhotoLens(img) {
	if (!img) return;
	const lens = document.createElement("div");
	lens.className = "photo-lens";
	lens.style.cssText =
		"position:absolute;width:200px;height:200px;border-radius:50%;border:2px solid rgba(255,255,255,0.35);box-shadow:0 4px 24px rgba(0,0,0,0.6);pointer-events:none;display:none;background-repeat:no-repeat;z-index:20;transform:translate(-50%,-50%);";
	img.parentElement.appendChild(lens);

	let size = 200;
	let zoom = 3;
	let last = null;

	const hide = () => {
		last = null;
		lens.style.display = "none";
	};
	const update = (clientX, clientY) => {
		const rect = img.getBoundingClientRect();
		const naturalW = img.naturalWidth || rect.width;
		const naturalH = img.naturalHeight || rect.height;
		const scale = Math.min(rect.width / naturalW, rect.height / naturalH);
		const w = naturalW * scale;
		const h = naturalH * scale;
		const left = (rect.width - w) / 2;
		const top = (rect.height - h) / 2;
		const x = clientX - rect.left;
		const y = clientY - rect.top;
		/** The image is letterboxed inside its box; only magnify the picture itself. */
		if (!img.naturalWidth || x < left || x > left + w || y < top || y > top + h) return hide();

		last = { clientX, clientY };
		lens.style.width = lens.style.height = `${size}px`;
		lens.style.backgroundImage = `url("${img.currentSrc || img.src}")`;
		lens.style.backgroundSize = `${w * zoom}px ${h * zoom}px`;
		lens.style.backgroundPosition = `-${((x - left) / w) * w * zoom - size / 2}px -${((y - top) / h) * h * zoom - size / 2}px`;
		lens.style.left = `${x}px`;
		lens.style.top = `${y}px`;
		lens.style.display = "block";
	};

	img.addEventListener("mousemove", (e) => update(e.clientX, e.clientY));
	img.addEventListener("mouseleave", hide);
	img.addEventListener(
		"wheel",
		(e) => {
			if (!last) return;
			e.preventDefault();
			const step = e.deltaY < 0 ? 1.1 : 1 / 1.1;
			size = Math.min(360, Math.max(80, size * step));
			zoom = Math.min(8, Math.max(1.5, zoom * step));
			update(last.clientX, last.clientY);
		},
		{ passive: false }
	);
}
