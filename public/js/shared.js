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

/** Shows or hides an element by id. */
function show(id, visible = true) {
	el(id)?.classList.toggle("hidden", !visible);
}

/**
 * Calls the API and returns the parsed JSON body. On any failure it throws an
 * Error whose message is safe to show the player and whose `status` is the HTTP
 * status (0 when the server could not be reached).
 */
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
	_userPromise ??= api("/api/auth/me").catch(() => null);
	return _userPromise;
}

function loginUrl(redirect = location.pathname + location.search) {
	return `/api/auth/login?redirect=${encodeURIComponent(redirect)}`;
}

function avatarHtml(url, sizeClass = "w-7 h-7") {
	return url
		? `<img src="${escHtml(url)}" alt="" class="${sizeClass} rounded-full" />`
		: `<div class="${sizeClass} rounded-full bg-zinc-700 flex items-center justify-center"><span class="material-symbols-outlined text-sm">person</span></div>`;
}

/**
 * The account area: avatar, profile, settings and logout when logged in (plus the
 * staff panel for staff), otherwise a login button that returns to this page.
 * Every element marked with `data-auth-area` gets one.
 */
function renderAuthAreas(user) {
	const iconLink = (href, icon, label, badge = "") =>
		`<a href="${href}" title="${label}" aria-label="${label}" ${badge ? `data-badge="${badge}"` : ""} class="relative w-8 h-8 rounded-full flex items-center justify-center text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition">
			<span class="material-symbols-outlined text-xl leading-none">${icon}</span>
		</a>`;
	const html = user
		? `<div class="flex items-center gap-1">
			<a href="/u/${encodeURIComponent(user.username)}" data-badge="profile" class="relative flex items-center gap-2 hover:opacity-80 transition mr-1" title="Your profile">
				${avatarHtml(user.avatar_url)}
				<span class="hidden sm:inline text-sm text-zinc-300 max-w-[9rem] truncate">${escHtml(user.display_name || user.username)}</span>
			</a>
			${user.role ? iconLink("/admin", "shield_person", "Staff panel", "staff") : ""}
			${iconLink("/settings", "settings", "Settings", "settings")}
			${iconLink("/api/auth/logout", "logout", "Log out")}
		</div>`
		: `<a href="${escHtml(loginUrl())}" class="text-sm bg-zinc-700 hover:bg-zinc-600 transition px-3 py-1.5 rounded-lg whitespace-nowrap">Login with Discord</a>`;
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

/** Puts counts on the profile, settings and staff panel buttons when something needs a look. */
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
	mark("profile", unread, "bg-red-500", `Your profile · ${unreadText}`);
	mark("settings", unread, "bg-red-500", `Settings · ${unreadText}`);
	const staff = _attention.staff;
	if (staff && _attentionUser?.prefs?.staff_badges) {
		mark(
			"staff",
			staff.total,
			"bg-blue-500",
			`Staff panel · ${staff.submissions} submissions, ${staff.suggestions} suggestions, ${staff.tickets} tickets waiting${staff.users ? `, ${staff.users} possible ban evasion` : ""}`
		);
	}
}

/** Announces a notification the first time this browser sees it: a chime, a toast and, if enabled, a desktop notification. */
function announceNotification(latest, user) {
	if (!latest) return;
	let lastSeen = 0;
	try {
		lastSeen = Number(localStorage.getItem(LAST_ANNOUNCED_KEY)) || 0;
		localStorage.setItem(LAST_ANNOUNCED_KEY, String(Math.max(lastSeen, latest.id)));
	} catch {}
	if (latest.id <= lastSeen) return;

	Sounds.play("notify");
	if (user.prefs?.toasts !== false)
		showToast(latest.title, "info", { href: latest.link || "/settings#notifications" });
	/** With push set up the service worker shows the desktop notification; otherwise do it from here. */
	const pushed = localStorage.getItem(PUSH_ON_KEY) === "1";
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

/**
 * For staff: a toast when something new lands in a review queue, on whatever page
 * they happen to be on. Each new item is announced once per browser.
 */
function announceStaffQueue(staff, user) {
	if (!staff || !user.prefs?.staff_alerts || user.prefs?.toasts === false || isMidRound()) return;
	let seen = null;
	try {
		seen = JSON.parse(localStorage.getItem(STAFF_QUEUE_SEEN_KEY) || "null");
		localStorage.setItem(STAFF_QUEUE_SEEN_KEY, JSON.stringify(staff));
	} catch {}
	// On the staff panel itself the sidebar counts already say it.
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

/**
 * Subscribes this browser to push notifications. Returns false when the server
 * has no push keys or the browser does not support it, in which case desktop
 * notifications still work while a tab is open.
 */
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
	localStorage.removeItem(PUSH_ON_KEY);
	try {
		const registration = await navigator.serviceWorker?.getRegistration();
		const subscription = await registration?.pushManager?.getSubscription();
		if (!subscription) return;
		await api("/api/push/subscribe", { method: "DELETE", json: { endpoint: subscription.endpoint } });
		await subscription.unsubscribe();
	} catch {}
}

function startAttentionPolling() {
	refreshAttention();
	setInterval(() => document.hidden || refreshAttention(), ATTENTION_POLL_MS);
	document.addEventListener("visibilitychange", () => document.hidden || refreshAttention());
}

const NAV_LINKS = [
	["/play", "Solo", "explore"],
	["/daily", "Daily", "calendar_today"],
	["/duels", "Duels", "swords"],
	["/leaderboard", "Leaderboard", "leaderboard"],
	["/submit", "Submit", "add_photo_alternate"],
];

/**
 * The site header, the same on every page that is not a full-screen game:
 * home, the main sections, then the account area. Fills `<nav id="site-nav">`.
 */
function renderSiteNav() {
	const nav = el("site-nav");
	if (!nav) return;
	const here = location.pathname;
	const link = ([href, label, icon], mobile) => {
		const active = here === href || (href === "/duels" && here.startsWith("/duel/"));
		return `<a href="${href}" ${active ? 'aria-current="page"' : ""} class="flex items-center gap-2 rounded-lg text-sm transition ${
			mobile ? "px-3 py-2.5" : "px-2.5 py-1.5"
		} ${active ? "text-white bg-zinc-800 font-semibold" : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60"}">
			${mobile ? `<span class="material-symbols-outlined text-lg leading-none">${icon}</span>` : ""}${label}
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
			<div data-auth-area></div>
			<button id="site-nav-toggle" aria-label="Menu" aria-expanded="false" class="md:hidden w-8 h-8 rounded-full flex items-center justify-center text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition">
				<span class="material-symbols-outlined text-xl leading-none">menu</span>
			</button>
		</div>
		<div id="site-nav-menu" class="hidden md:hidden absolute top-full inset-x-0 bg-zinc-900 border-b border-zinc-800 shadow-xl p-2 flex-col gap-0.5">
			${NAV_LINKS.map((l) => link(l, true)).join("")}
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
	if (!user) return;
	// The account's sound preference wins over whatever this browser remembered.
	if (typeof user.prefs?.sounds === "boolean") Sounds.setEnabled(user.prefs.sounds);
	startAttentionPolling();
	whenIdle(registerServiceWorker);
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
	toast.className = `pointer-events-auto px-4 py-2.5 rounded-xl text-sm shadow-lg ${colors[type] || colors.info} opacity-0 transition-opacity duration-200 ${href ? "underline-offset-2 hover:underline" : ""}`;
	toast.textContent = message;
	container.appendChild(toast);
	requestAnimationFrame(() => toast.classList.remove("opacity-0"));
	setTimeout(
		() => {
			toast.classList.add("opacity-0");
			setTimeout(() => toast.remove(), 250);
		},
		type === "error" || href ? 6000 : 3500
	);
}

/**
 * Copies text to the clipboard. Where the modern API is blocked it falls back to
 * the old selection trick, and if even that fails it says so rather than opening
 * a browser dialog.
 */
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
	const dpr = window.devicePixelRatio || 1;
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

/**
 * Buttons answer a press with a faint ripple from the point that was touched.
 * The ripple lives in its own layer placed over the button, so the button itself
 * is never changed: scripts that rewrite a button's classes or contents mid-press
 * cannot leave a stray circle behind, and nothing inside the button gets clipped.
 */
document.addEventListener("pointerdown", (e) => {
	if (e.button > 0 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
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
	ripple.addEventListener("animationend", () => layer.remove());
	// A safety net in case the animation never runs (e.g. the tab is hidden).
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
			[["0"], "Home"],
		],
	},
];
const QUICK_LINKS = { 1: "/play", 2: "/daily", 3: "/duels", 4: "/leaderboard", 5: "/submit", 0: "/" };
const _pageKeys = new Map();

/** Registers shortcuts for the current page: a title for the help dialog and key handlers. */
function addKeybinds(title, binds) {
	KEYBIND_GROUPS.push({ title, keys: binds.map(([keys, label]) => [keys, label]) });
	for (const [keys, , handler] of binds) {
		// Handlers sharing a key each say whether they applied; the first that does wins.
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
		...NAV_LINKS.map(([href, label, icon]) => [href, icon, label]),
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
	// Keep the account's setting in step when logged in.
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
	// While the help is open, keys belong to it.
	if (el("shortcuts-dialog") && !el("shortcuts-dialog").classList.contains("hidden")) return;

	const key = e.key.toLowerCase();
	for (const handler of _pageKeys.get(key === " " ? "space" : key) || []) {
		if (handler(e) !== false) return e.preventDefault();
	}
	if (key === "m") return toggleSoundsShortcut();
	if (key in QUICK_LINKS && !isMidRound() && location.pathname !== QUICK_LINKS[key]) location.href = QUICK_LINKS[key];
});

/** A brief greeting right after logging in. The server leaves a short-lived cookie to say it just happened. */
(async function welcome() {
	const kind = document.cookie.match(/(?:^|; )welcome=(new|back)/)?.[1];
	if (!kind) return;
	document.cookie = "welcome=; Path=/; Max-Age=0";
	const user = await fetchUser();
	if (!user || user.is_banned) return;

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
	const KEY = "beta_acknowledged";
	// Not over the documents people are sent to read.
	if (["/tos", "/privacy", "/fairplay", "/guidelines"].includes(location.pathname)) return;
	try {
		if (localStorage.getItem(KEY)) return;
	} catch {
		return;
	}
	const modal = document.createElement("div");
	modal.innerHTML = `<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
		<div class="bg-zinc-900 border border-zinc-700 rounded-2xl p-8 max-w-sm w-full mx-4 shadow-2xl" role="dialog" aria-modal="true" aria-label="Early beta">
			<div class="flex items-center gap-3 mb-4">
				<span class="material-symbols-outlined text-yellow-500 text-3xl" style="font-variation-settings:'FILL' 1">science</span>
				<h2 class="text-xl font-bold">Early Beta</h2>
			</div>
			<p class="text-zinc-400 text-sm mb-3">Dovedale GeoGuesser is in beta, so some things may break or change.</p>
			<p class="text-zinc-500 text-sm mb-6">Found a problem? Open a ticket in <a href="/settings" class="text-blue-400 hover:text-blue-300 underline">Settings</a>.</p>
			<button class="w-full bg-blue-600 hover:bg-blue-500 transition py-2.5 rounded-xl font-semibold text-sm">Got it</button>
		</div>
	</div>`;
	modal.querySelector("button").addEventListener("click", () => {
		localStorage.setItem(KEY, "1");
		modal.remove();
	});
	const mount = () => document.body.appendChild(modal);
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
	else mount();
})();

/** Banned accounts see only the ban notice, except where they appeal and on the documents the ban refers to. */
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

/** Browser details for logged-in users, used to flag possible ban evasion for staff (see the privacy policy). */
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
