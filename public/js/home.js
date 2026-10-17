import "./lib/site.js";
import { el, escHtml, prefersReducedMotion, show } from "./lib/dom.js";
import { api, fetchUser } from "./lib/api.js";
import { onLive } from "./lib/live.js";

const TOURNAMENT_LINES = {
	announced: "Tournament coming up. See when it starts.",
	open: "Tournament starting soon. Players, check in now.",
	live: "Tournament on now. Come and watch.",
	finished: "Tournament results. See who won.",
};
/** The newest summary, so the card always shows the latest name, even one that changed during the wait. */
let latestTournament = null;

function fillTournamentCard(summary) {
	const card = el("tournament-card");
	card.href = `/tournament/${summary.id}`;
	el("tournament-card-title").textContent = summary.title;
	el("tournament-card-sub").textContent = TOURNAMENT_LINES[summary.status] ?? "";
}

/** Shows the card and animates the elements it moves from their old places (FLIP). */
async function popIn(card) {
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	/** Waits for the intro and the cards' entrance, or a moment after load, so the animation is not missed. */
	await (window.introDone ? window.introDone.then(() => wait(900)) : wait(400));
	if (!card.classList.contains("hidden") || !latestTournament) return;
	/** Filled in before it shows, so it never animates in without its name. */
	fillTournamentCard(latestTournament);
	/** Its own entrance replaces the home cards' rise, which would restart when it is shown. */
	card.style.animation = "none";
	const neighbours = [...document.querySelectorAll("main .md-card, main h1, main > div > p, #site-footer")].filter(
		(node) => node !== card
	);
	const before = new Map(neighbours.map((node) => [node, node.getBoundingClientRect()]));
	card.classList.replace("hidden", "flex");
	if (prefersReducedMotion()) return;
	for (const node of neighbours) {
		const was = before.get(node);
		const now = node.getBoundingClientRect();
		const dx = was.left - now.left;
		const dy = was.top - now.top;
		if (dx || dy)
			node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
				duration: 500,
				easing: "cubic-bezier(0.2, 0, 0, 1)",
			});
	}
	const entrance = card.animate(
		[
			{ transform: "scale(1.15, 0.05)", opacity: 0 },
			{ transform: "scale(0.9, 1.18)", opacity: 1, offset: 0.3 },
			{ transform: "scale(1.06, 0.9)", offset: 0.45 },
			{ transform: "scale(0.98, 1.03) rotate(-1.6deg)", offset: 0.6 },
			{ transform: "scale(1.01, 0.99) rotate(1.2deg)", offset: 0.72 },
			{ transform: "rotate(-0.6deg)", offset: 0.84 },
			{ transform: "none", opacity: 1 },
		],
		{ duration: 900, delay: 120, easing: "ease-out", fill: "backwards" }
	);
	entrance.finished.then(() => {
		card.classList.add("glint");
		card.addEventListener("animationend", () => card.classList.remove("glint"), { once: true });
	});
}

/** While a tournament is on, it gets its own card above Specials. */
function showTournament(summary) {
	const card = el("tournament-card");
	latestTournament = summary;
	if (!summary) return card.classList.replace("flex", "hidden");
	fillTournamentCard(summary);
	if (card.classList.contains("hidden")) popIn(card);
}

const checkTournament = () =>
	api("/api/tournaments/current")
		.then(showTournament)
		.catch(() => {});
checkTournament();
/** Null also comes after a reconnect, so ask. */
onLive("tournament", (summary) => (summary ? showTournament(summary) : checkTournament()));

fetchUser().then((user) => {
	if (!user) return;
	for (const note of document.querySelectorAll("[data-guest-only]")) note.remove();
	el("profile-card").href = `/u/${encodeURIComponent(user.username)}`;
	el("profile-card-sub").textContent = "Your stats and streaks.";
	api("/api/specials")
		.then((specials) => {
			const live = specials.filter((s) => s.status === "live");
			if (live.length) el("specials-card-sub").textContent = `On now: ${live.map((s) => s.title).join(", ")}.`;
		})
		.catch(() => {});
});

const BAT =
	'<svg viewBox="0 0 64 32" aria-hidden="true"><path d="M32 9c1-3 2-5 4-6l1 4c5-4 12-5 19-3 4 1 7 4 8 8-4-2-7-2-9 1-3-2-6-1-7 3-3-2-6-1-8 3-1 3-4 6-8 9-4-3-7-6-8-9-2-4-5-5-8-3-1-4-4-5-7-3-2-3-5-3-9-1 1-4 4-7 8-8 7-2 14-1 19 3l1-4c2 1 3 3 4 6z"/></svg>';
const PUMPKIN =
	'<svg viewBox="0 0 64 60" aria-hidden="true"><path class="stem" d="M30 4c1-2 4-3 6-2l-2 9h-5z"/><ellipse class="skin" cx="32" cy="35" rx="29" ry="23"/><path class="rib" d="M32 12c-9 6-9 40 0 46M32 12c9 6 9 40 0 46M18 15c-11 9-11 31 0 40M46 15c11 9 11 31 0 40" fill="none"/><path class="face" d="M17 30l7-7 5 7zM35 30l5-7 7 7zM14 41c5 2 8 5 9 9l4-5 5 6 5-6 4 5c1-4 4-7 9-9-9 12-27 12-36 0z"/></svg>';

const HEART =
	'<svg viewBox="0 0 32 30" aria-hidden="true"><path d="M16 29C4 20 0 14 0 8.5 0 3.8 3.6 0 8 0c3 0 5.6 1.6 8 4.6C18.400 1.6 21 0 24 0c4.400 0 8 3.800 8 8.500C32 14 28 20 16 29z"/></svg>';
const EGG = (shell, band) =>
	`<svg viewBox="0 0 48 60" aria-hidden="true"><defs><clipPath id="egg-${shell.slice(1)}"><path d="M24 2C12 2 3 22 3 37c0 12 9 21 21 21s21-9 21-21C45 22 36 2 24 2z"/></clipPath></defs><g clip-path="url(#egg-${shell.slice(1)})"><rect width="48" height="60" fill="${shell}"/><path d="M0 24l6-5 6 5 6-5 6 5 6-5 6 5 6-5 6 5v9l-6-5-6 5-6-5-6 5-6-5-6 5-6-5-6 5z" fill="${band}"/><rect y="42" width="48" height="5" fill="${band}" opacity="0.7"/></g></svg>`;

const SEASON_DECOR = {
	halloween: () =>
		[0, 1, 2].map((i) => `<span class="season-bat season-bat-${i}">${BAT}</span>`).join("") +
		`<span class="season-corner season-corner-left">${PUMPKIN}</span><span class="season-corner season-corner-right">${PUMPKIN}</span>`,
	christmas: () =>
		Array.from({ length: 28 }, (_, i) => {
			const size = 3 + ((i * 7) % 5);
			return `<span class="season-flake" style="left:${(i * 37) % 100}%;width:${size}px;height:${size}px;animation-duration:${9 + ((i * 5) % 9)}s;animation-delay:-${(i * 13) % 17}s"></span>`;
		}).join(""),
	valentines: () =>
		Array.from(
			{ length: 9 },
			(_, i) =>
				`<span class="season-heart" style="left:${6 + ((i * 41) % 88)}%;width:${14 + ((i * 5) % 12)}px;animation-duration:${14 + ((i * 3) % 9)}s;animation-delay:-${(i * 7) % 19}s">${HEART}</span>`
		).join(""),
	easter: () =>
		`<span class="season-corner season-corner-left season-egg">${EGG("#F8BBD0", "#F06292")}</span>
		<span class="season-corner season-egg season-egg-second">${EGG("#B3E5FC", "#4FC3F7")}</span>
		<span class="season-corner season-corner-right season-egg">${EGG("#FFF59D", "#AED581")}</span>`,
	fireworks: () =>
		Array.from({ length: 7 }, (_, i) => {
			const colour = ["#FFD54F", "#4FC3F7", "#F06292", "#AED581"][i % 4];
			return `<span class="season-burst" style="left:${8 + ((i * 29) % 84)}%;top:${8 + ((i * 17) % 34)}%;color:${colour};animation-delay:-${(i * 1.3).toFixed(1)}s;animation-duration:${4.5 + (i % 3)}s"></span>`;
		}).join(""),
};
SEASON_DECOR.newyear = SEASON_DECOR.bonfire = SEASON_DECOR.fireworks;

function applySeason(season) {
	if (!season || !SEASON_DECOR[season.theme]) return;
	document.body.dataset.season = season.theme;
	const layer = document.createElement("div");
	layer.className = "season-layer";
	layer.setAttribute("aria-hidden", "true");
	layer.innerHTML = SEASON_DECOR[season.theme]();
	document.body.appendChild(layer);

	if (season.splash) {
		el("season-splash").textContent = season.splash;
		show("season-splash");
	}
	const event = season.event;
	if (!event) return;
	const card = el("season-card");
	const ends = event.ends_at
		? new Date(new Date(event.ends_at).getTime() - 1).toLocaleDateString(undefined, {
				day: "numeric",
				month: "long",
			})
		: "";
	card.href = event.href;
	card.innerHTML = `
		<span class="material-symbols-outlined text-4xl flex-shrink-0 season-accent" style="font-variation-settings:'FILL' 1">${escHtml(event.icon)}</span>
		<div class="flex-1 min-w-0">
			<div class="font-bold text-xl mb-1">${escHtml(event.title)}${ends ? ` <span class="m-tag season-tag ml-1 align-middle">Until ${escHtml(ends)}</span>` : ""}</div>
			<div class="text-zinc-400 text-sm">${escHtml(event.blurb)}</div>
		</div>
		<span class="material-symbols-outlined text-zinc-500 flex-shrink-0">chevron_right</span>`;
	card.classList.replace("hidden", "flex");
}

/** "/?season=easter" (or any other theme) previews that season on any day. */
const seasonPreview = new URLSearchParams(location.search).get("season");

api(`/api/meta${seasonPreview ? `?season=${encodeURIComponent(seasonPreview)}` : ""}`)
	.then((meta) => {
		applySeason(meta?.season);
		if (meta?.upcoming) {
			const { title, days } = meta.upcoming;
			el("upcoming-tag").textContent = `${title} ${days <= 1 ? "starts tomorrow" : `in ${days} days`}`;
			show("upcoming-tag");
		}
		if (!meta?.repo) return;
		const link = document.createElement("a");
		link.href = meta.repo;
		link.target = "_blank";
		link.rel = "noopener noreferrer";
		link.className = "underline underline-offset-2 hover:text-zinc-400 transition";
		link.textContent = "Contribute on GitHub";
		el("footer-map-credit").append(" · ", link);
	})
	.catch(() => {});
