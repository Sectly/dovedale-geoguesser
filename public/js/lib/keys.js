import { Sounds } from "../sounds.js";
import { el, escHtml, isMidRound } from "./dom.js";
import { api, fetchUser } from "./api.js";
import { showToast } from "./toast.js";
import { NAV_LINKS, NEWS_LINK } from "./header.js";

/** Shortcuts that work everywhere. Pages add their own with `addKeybinds`. */
export const KEYBIND_GROUPS = [
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
export const _pageKeys = new Map();

export function addKeybinds(title, binds) {
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

/** Called from inline handlers in the markup. */
Object.assign(window, { toggleShortcuts });
