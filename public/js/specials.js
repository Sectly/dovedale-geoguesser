/** Specials hub: lists what is running for the logged-in player. */

const SPECIAL_KINDS = {
	mode: ["Game mode", ""],
	minigame: ["Mini-game", ""],
	experiment: ["Experimental", "warn"],
	event: ["Event", "info"],
};

/** "3 days", "5 hours", "20 minutes": how long until a date. */
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

(async function loadSpecials() {
	const list = el("specials-list");
	list.innerHTML = skeletonRows(2);
	const user = await fetchUser();
	if (!user) {
		list.innerHTML = `<div class="bg-zinc-900 rounded-2xl p-8 text-center">
			<span class="material-symbols-outlined text-4xl text-zinc-500 mb-2">lock</span>
			<p class="text-zinc-300 font-semibold mb-1">Log in to see what's on</p>
			<p class="text-zinc-500 text-sm mb-5">Specials are for logged-in players.</p>
			<a href="${escHtml(loginUrl("/specials"))}" class="m-btn m-btn-filled">Login with Discord</a>
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
