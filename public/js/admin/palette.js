/** Staff panel: the jump-to box (Ctrl+K). Finds tabs, players, locations and tickets. */

const PALETTE_CACHE_MS = 60_000;
const PALETTE_MAX = 8;
let _paletteData = null;
let _paletteResults = [];
let _paletteIndex = 0;

/** Players and locations to search, fetched once a minute at most. Helpers get no player list. */
async function paletteData() {
	if (_paletteData && Date.now() - _paletteData.at < PALETTE_CACHE_MS) return _paletteData;
	const [users, locations] = await Promise.all([
		isHelper() ? [] : api("/api/admin/users").catch(() => []),
		api("/api/admin/locations").catch(() => []),
	]);
	_paletteData = { users, locations, at: Date.now() };
	return _paletteData;
}

/** Opens a tab, then types into its search box once the tab has drawn. */
function jumpToSearch(tab, text) {
	switchTab(tab);
	let tries = 0;
	const fill = setInterval(() => {
		const input = el("panel-search");
		if (input) {
			input.value = text;
			input.dispatchEvent(new Event("input"));
		}
		if (input || ++tries > 40) clearInterval(fill);
	}, 50);
}

function paletteResults(query, { users, locations }) {
	const q = query.trim().toLowerCase();
	const has = (value) =>
		String(value ?? "")
			.toLowerCase()
			.includes(q);
	const results = [];

	for (const btn of document.querySelectorAll(".tab-btn:not(.hidden)")) {
		const label = btn.dataset.label || btn.textContent.trim();
		if (!q || has(label))
			results.push({
				icon: btn.dataset.icon || "tab",
				title: label,
				sub: "Tab",
				run: () => switchTab(btn.dataset.tab),
			});
	}
	if (!q) return results;

	const number = /^#?(\d+)$/.exec(q)?.[1];
	if (number && !isHelper())
		results.unshift({
			icon: "support_agent",
			title: `Ticket #${number}`,
			sub: "Open in Tickets",
			run: () => (location.hash = `tickets:${number}`),
		});
	for (const u of users
		.filter((u) => has(u.username) || has(u.display_name) || has(u.discord_id) || String(u.id) === number)
		.slice(0, 6)) {
		results.push({
			icon: "person",
			title: u.display_name || u.username,
			sub: `@${u.username} · player #${u.id}`,
			run: () => openUserPanel(u.id),
		});
	}
	for (const l of locations.filter((l) => has(l.label) || has(locId(l.id)) || String(l.id) === number).slice(0, 5)) {
		results.push({
			icon: "location_on",
			title: l.label || locId(l.id),
			sub: locId(l.id),
			run: () => jumpToSearch("locations", locId(l.id)),
		});
	}
	return results.slice(0, PALETTE_MAX + 4);
}

function renderPalette() {
	el("palette-results").innerHTML = _paletteResults.length
		? _paletteResults
				.map(
					(
						r,
						i
					) => `<button data-index="${i}" class="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left ${i === _paletteIndex ? "bg-zinc-800" : "hover:bg-zinc-800/60"}">
						<span class="material-symbols-outlined text-lg text-zinc-500">${r.icon}</span>
						<span class="flex-1 min-w-0 truncate text-sm">${escHtml(r.title)}</span>
						<span class="text-xs text-zinc-500 flex-shrink-0">${escHtml(r.sub)}</span>
					</button>`
				)
				.join("")
		: '<p class="text-sm text-zinc-600 px-3 py-4">Nothing matches.</p>';
	el("palette-results").querySelector(`[data-index="${_paletteIndex}"]`)?.scrollIntoView({ block: "nearest" });
}

function closePalette() {
	show("palette", false);
}

function runPaletteResult(index) {
	const result = _paletteResults[index];
	if (!result) return;
	closePalette();
	result.run();
}

async function openPalette() {
	if (!el("palette")) {
		const box = document.createElement("div");
		box.id = "palette";
		box.className =
			"hidden fixed inset-0 z-[80] bg-black/60 flex items-start justify-center px-4 pt-[14vh] modal-fade";
		box.innerHTML = `<div class="bg-zinc-900 border border-zinc-800 w-full max-w-lg p-2" role="dialog" aria-modal="true" aria-label="Jump to">
			<label class="relative block">
				<span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 text-lg">search</span>
				<input id="palette-input" type="search" autocomplete="off" placeholder="Tab, player, location or ticket number" class="w-full bg-zinc-800 rounded-xl pl-10 pr-4 py-2.5 text-sm focus:outline-none placeholder:text-zinc-600" />
			</label>
			<div id="palette-results" class="mt-2 max-h-[50vh] overflow-y-auto"></div>
		</div>`;
		document.body.appendChild(box);
		box.addEventListener("click", (e) => {
			if (e.target === box) return closePalette();
			const row = e.target.closest("[data-index]");
			if (row) runPaletteResult(Number(row.dataset.index));
		});
		el("palette-input").addEventListener("keydown", (e) => {
			if (e.key === "Escape") return closePalette();
			if (e.key === "Enter") return runPaletteResult(_paletteIndex);
			if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
			e.preventDefault();
			const step = e.key === "ArrowDown" ? 1 : -1;
			_paletteIndex = (_paletteIndex + step + _paletteResults.length) % Math.max(1, _paletteResults.length);
			renderPalette();
		});
		el("palette-input").addEventListener("input", async () => {
			_paletteIndex = 0;
			_paletteResults = paletteResults(el("palette-input").value, await paletteData());
			renderPalette();
		});
	}
	show("palette");
	const input = el("palette-input");
	input.value = "";
	input.focus();
	_paletteIndex = 0;
	_paletteResults = paletteResults("", _paletteData ?? { users: [], locations: [] });
	renderPalette();
	/** Fetched now so the first keystroke already has something to search. */
	paletteData();
}

document.addEventListener("keydown", (e) => {
	if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "k" || !currentUser?.role) return;
	e.preventDefault();
	openPalette();
});
KEYBIND_GROUPS.push({ title: "Staff panel", keys: [[["Ctrl", "K"], "Jump to a tab, player, location or ticket"]] });
