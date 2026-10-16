import "./handlers.js";

export const el = (id) => document.getElementById(id);

export const escHtml = (s) =>
	String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");

export const locId = (id) => "LOC-" + String(id).padStart(4, "0");

export const isExternalLink = (link) =>
	/^https:\/\//i.test(link || "") && !`${link}/`.startsWith(`${location.origin}/`);
export const linkHref = (link) => (isExternalLink(link) ? `/leaving?to=${encodeURIComponent(link)}` : link);
export const EXTERNAL_ICON =
	'<span class="material-symbols-outlined external-icon" role="img" aria-label="Goes to another site">open_in_new</span>';

export function show(id, visible = true) {
	el(id)?.classList.toggle("hidden", !visible);
}

/** The smallest Discord avatar WebP that stays sharp at `px` on this screen. */
export function avatarSrc(url, px) {
	const discord = /^(https:\/\/cdn\.discordapp\.com\/avatars\/[^?]+)\.(?:png|jpg|webp|gif)(?:\?.*)?$/.exec(url || "");
	if (!discord) return url;
	const wanted = px * Math.min(window.devicePixelRatio || 1, 2);
	return `${discord[1]}.webp?size=${[32, 64, 128, 256].find((size) => size >= wanted) ?? 256}`;
}

export function avatarHtml(url, sizeClass = "w-7 h-7") {
	const px = Math.max(28, ...[...sizeClass.matchAll(/\bw-(\d+)\b/g)].map((m) => Number(m[1]) * 4));
	return url
		? `<img src="${escHtml(avatarSrc(url, px))}" alt="" loading="lazy" decoding="async" class="${sizeClass} rounded-full" />`
		: `<div class="${sizeClass} rounded-full bg-zinc-700 flex items-center justify-center"><span class="material-symbols-outlined text-sm">person</span></div>`;
}

export function isMidRound() {
	return ["round-screen", "game-screen"].some((id) => el(id) && !el(id).classList.contains("hidden"));
}

/** A failed load, shown in place of the content. `retry` is the code its "Try again" button runs. */
export function errorStateHtml(message, retry = "") {
	return `<div class="error-state" role="alert">
		<span class="error-state-icon" aria-hidden="true"><span class="material-symbols-outlined">cloud_off</span></span>
		<p>${escHtml(message)}</p>
		${retry ? `<button class="m-btn m-btn-tonal m-btn-sm" data-on-click="${escHtml(retry)}"><span class="err-retry material-symbols-outlined">refresh</span>Try again</button>` : ""}
	</div>`;
}

export function skeletonRows(count = 5, heightClass = "h-16") {
	return Array.from({ length: count }, () => `<div class="skeleton ${heightClass} rounded-2xl mb-2"></div>`).join("");
}

export function whenIdle(fn) {
	if ("requestIdleCallback" in window) requestIdleCallback(fn, { timeout: 4000 });
	else setTimeout(fn, 1500);
}

export const prefersReducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export const scrollBehavior = () => (prefersReducedMotion() ? "auto" : "smooth");

/** How long a dialog takes to close (.modal-fade in shared.css). */
export const DIALOG_CLOSE_MS = 200;

export function countUp(target, to, { from = 0, duration = 700, format = (n) => n.toLocaleString() } = {}) {
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

export function scoreTone(score, max = 5000) {
	const pct = max ? score / max : 0;
	if (pct >= 0.6) return { text: "text-green-400", bar: "bg-green-500" };
	if (pct >= 0.3) return { text: "text-yellow-400", bar: "bg-yellow-500" };
	return { text: "text-red-400", bar: "bg-red-500" };
}

export function streakBadgeHtml(streak, { best = false } = {}) {
	if (!streak) return "";
	return `<div class="streak-pop inline-flex items-center gap-1.5 bg-orange-900/40 border border-orange-700/40 px-3 py-1 rounded-full text-orange-300 text-xs">
		<span class="material-symbols-outlined text-sm leading-none text-orange-400" style="font-variation-settings:'FILL' 1">local_fire_department</span>
		${streak === 1 ? "Streak started" : `${streak}-day streak`}${best && streak > 1 ? ' <span class="text-orange-400">(personal best)</span>' : ""}
	</div>`;
}

/** Called from inline handlers in the markup. */
/** Read out by screen readers, for results that only appear on screen. */
export function announce(text) {
	let region = el("sr-announcer");
	if (!region) {
		region = document.createElement("div");
		region.id = "sr-announcer";
		region.className = "sr-only";
		region.setAttribute("aria-live", "polite");
		document.body.appendChild(region);
	}
	/** Cleared first, so the same words twice in a row are still read. */
	region.textContent = "";
	setTimeout(() => (region.textContent = text), 50);
}

Object.assign(window, { el });
