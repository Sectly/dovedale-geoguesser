import "./lib/site.js";
import { el, escHtml, skeletonRows } from "./lib/dom.js";
import { api, fetchUser, loginUrl } from "./lib/api.js";

const SPECIAL_KINDS = {
	mode: ["Game mode", ""],
	minigame: ["Mini-game", ""],
	experiment: ["Experimental", "warn"],
	event: ["Event", "info"],
};

function timeUntil(iso) {
	const minutes = Math.max(1, Math.round((Date.parse(iso) - Date.now()) / 60000));
	const [n, unit] =
		minutes >= 2880
			? [Math.round(minutes / 1440), "day"]
			: minutes >= 120
				? [Math.round(minutes / 60), "hour"]
				: [minutes, "minute"];
	return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

function specialCard(special) {
	const [kind, tone] = SPECIAL_KINDS[special.kind] || SPECIAL_KINDS.mode;
	const upcoming = special.status === "upcoming";
	const tags = [
		`<span class="m-tag ${tone}">${kind}</span>`,
		upcoming ? `<span class="m-tag">Starts in ${timeUntil(special.startsAt)}</span>` : "",
		!upcoming && special.endsAt ? `<span class="m-tag warn">Ends in ${timeUntil(special.endsAt)}</span>` : "",
		special.staffOnly || special.preview ? '<span class="m-tag info">Staff preview</span>' : "",
	].join("");
	const inner = `
		<span class="material-symbols-outlined text-3xl text-[var(--md-primary-bright)] flex-shrink-0" style="font-variation-settings:'FILL' 1">${escHtml(special.icon)}</span>
		<div class="flex-1 min-w-0">
			<div class="font-bold text-lg">${escHtml(special.title)}</div>
			<div class="text-zinc-400 text-sm mt-0.5">${escHtml(special.blurb)}</div>
			<div class="flex gap-1.5 flex-wrap mt-2.5">${tags}</div>
		</div>
		${upcoming && !special.preview ? "" : '<span class="material-symbols-outlined text-zinc-500 flex-shrink-0">chevron_right</span>'}`;
	return upcoming && !special.preview
		? `<div class="md-card p-5 text-left flex items-center gap-4 opacity-60 pointer-events-none">${inner}</div>`
		: `<a href="${escHtml(special.href)}" class="md-card p-5 text-left flex items-center gap-4">${inner}</a>`;
}

const TOURNAMENT_LINES = {
	announced: "Tournament coming up. See when it starts.",
	open: "Tournament starting soon. Players, check in now.",
	live: "Tournament on now. Come and watch.",
	finished: "Tournament results. See who won.",
};

/** Shown logged in or not. */
api("/api/tournaments/past")
	.then((past) => {
		if (!past.length) return;
		el("past-tournaments").innerHTML =
			`<div class="text-xs text-zinc-500 uppercase tracking-widest font-medium mt-10 mb-3">Past tournaments</div>
			<div class="flex flex-col gap-2">${past
				.map((t) => {
					const winner = t.winner_display_name || t.winner_username;
					const when = t.finished_at
						? new Date(t.finished_at * 1000).toLocaleDateString(undefined, {
								day: "numeric",
								month: "short",
								year: "numeric",
							})
						: "";
					return `<a href="/tournament/${t.id}" class="md-card px-5 py-3 text-left flex items-center gap-4">
						<span class="material-symbols-outlined text-2xl text-zinc-500 flex-shrink-0">trophy</span>
						<div class="flex-1 min-w-0">
							<div class="font-semibold truncate">${escHtml(t.title)}</div>
							<div class="text-zinc-500 text-xs mt-0.5">${[winner ? `Won by ${escHtml(winner)}` : "", `${t.players} players`, when].filter(Boolean).join(" · ")}</div>
						</div>
						<span class="material-symbols-outlined text-zinc-500 flex-shrink-0">chevron_right</span>
					</a>`;
				})
				.join("")}</div>`;
	})
	.catch(() => {});

/** A tournament that is on, or has just finished, goes first. */
api("/api/tournaments/current")
	.then((t) => {
		if (!t) return;
		el("tournament-feature").innerHTML =
			`<a href="/tournament/${t.id}" class="md-card specials-tournament p-5 mb-6 text-left flex items-center gap-4">
			<span class="material-symbols-outlined text-4xl flex-shrink-0" style="font-variation-settings:'FILL' 1">trophy</span>
			<div class="flex-1 min-w-0">
				<div class="font-bold text-lg">${escHtml(t.title)}</div>
				<div class="text-zinc-400 text-sm mt-0.5">${TOURNAMENT_LINES[t.status] ?? ""}</div>
			</div>
			<span class="material-symbols-outlined text-zinc-500 flex-shrink-0">chevron_right</span>
		</a>`;
	})
	.catch(() => {});

(async function loadSpecials() {
	const list = el("specials-list");
	list.innerHTML = skeletonRows(2);
	const user = await fetchUser();
	if (!user) {
		list.innerHTML = `<div class="bg-zinc-900 rounded-2xl p-8 text-center">
			<span class="material-symbols-outlined text-4xl text-zinc-500 mb-2">lock</span>
			<p class="text-zinc-300 font-semibold mb-1">Log in to see what's on</p>
			<p class="text-zinc-500 text-sm mb-5">Specials are for logged-in players.</p>
			<a href="${escHtml(loginUrl())}" class="m-btn m-btn-filled">Log in with Discord</a>
			<p class="text-zinc-600 text-xs mt-4">By logging in you agree to our <a href="/tos" class="underline hover:text-zinc-400">Terms of Service</a> and <a href="/privacy" class="underline hover:text-zinc-400">Privacy Policy</a>.</p>
		</div>`;
		return;
	}
	try {
		const specials = await api("/api/specials");
		list.innerHTML = specials.length
			? `<div class="stagger flex flex-col gap-3">${specials.map(specialCard).join("")}</div>`
			: '<p class="text-zinc-500 text-center py-12">Nothing is running right now. Check back soon.</p>';
	} catch (err) {
		list.innerHTML = `<p class="text-red-300 text-center py-12">${escHtml(err.message)}</p>`;
	}
})();
