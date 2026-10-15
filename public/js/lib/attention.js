import { Sounds } from "../sounds.js";
import { isMidRound } from "./dom.js";
import { api, fetchUser } from "./api.js";
import { showToast } from "./toast.js";
import { live, onLive, whenNotLive } from "./live.js";
import { PUSH_ON_KEY } from "./push.js";
import { checkAchievements } from "./achievements.js";

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

export function renderAttentionBadges() {
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

export function announceStaffChat(unseen = 0, user) {
	const heard = _staffChatHeard;
	_staffChatHeard = unseen;
	if (user.prefs?.staff_chat === "badge" && heard !== null && unseen > heard && !isMidRound()) Sounds.play("notify");
}

export async function refreshAttention(attention) {
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

export function startAttentionPolling() {
	whenNotLive(refreshAttention);
	setInterval(() => document.hidden || live.connected || refreshAttention(), ATTENTION_POLL_MS);
	document.addEventListener("visibilitychange", () => document.hidden || live.connected || refreshAttention());
}

onLive("attention", (attention) => refreshAttention(attention));
