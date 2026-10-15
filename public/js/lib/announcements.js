import { EXTERNAL_ICON, escHtml, isMidRound } from "./dom.js";
import { api, fetchUser } from "./api.js";
import { live, onLive, whenNotLive } from "./live.js";

const ANNOUNCEMENT_DISMISSED_KEY = "announcement_dismissed";
const ANNOUNCEMENT_POLL_MS = 5 * 60 * 1000;

const ANNOUNCEMENT_ICONS = { info: "campaign", success: "celebration", warning: "warning" };

(async function acknowledgeAnnouncement() {
	const pending = (await fetchUser())?.pending_announcement;
	if (!pending || isMidRound()) return;
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

export async function checkAnnouncement() {
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

onLive("banner", (announcement) => showAnnouncement(announcement));
