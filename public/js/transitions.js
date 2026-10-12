/**
 * Gives page transitions a direction: sideways between header sections, in or out for depth.
 * Loaded in the <head> so it listens before the page shows.
 */
(function pageTransitions() {
	/** The header's sections in order (see NAV_LINKS in shared.js). */
	const SECTIONS = ["/play", "/daily", "/duels", "/leaderboard", "/submit"];

	/** Home is 0, a section 1, a duel, profile or special 2. */
	const depth = (path) => path.split("/").filter(Boolean).length;

	function direction(from, to) {
		if (depth(from) !== depth(to)) return depth(to) > depth(from) ? "deeper" : "shallower";
		const was = SECTIONS.indexOf(from);
		const is = SECTIONS.indexOf(to);
		if (was < 0 || is < 0 || was === is) return null;
		return is > was ? "forward" : "back";
	}

	addEventListener("pagereveal", (e) => {
		if (!e.viewTransition) return;
		/** The title screen (intro.js) plays instead. */
		if (document.documentElement.classList.contains("intro-hold")) return e.viewTransition.skipTransition();
		const from = window.navigation?.activation?.from?.url;
		if (!from) return;
		const type = direction(new URL(from).pathname, location.pathname);
		if (type) e.viewTransition.types.add(type);
	});

	/** Grows a home card's icon into the mode page's own (.hero-icon) and back. Only one card is named at a time. */
	const cardIcon = (url) =>
		url &&
		document.querySelector(`a.md-card[href="${CSS.escape(new URL(url).pathname)}"] > .material-symbols-outlined`);
	const nameIcon = (icon) => icon && (icon.style.viewTransitionName = "hero-icon");
	addEventListener("pageswap", (e) => {
		if (e.viewTransition) nameIcon(cardIcon(e.activation?.entry?.url));
	});
	addEventListener("pagereveal", (e) => {
		/** A page brought back by the Back button may still carry the name it left with. */
		for (const named of document.querySelectorAll("a.md-card > .material-symbols-outlined"))
			named.style.viewTransitionName = "";
		if (!e.viewTransition) return;
		const icon = cardIcon(window.navigation?.activation?.from?.url);
		if (!nameIcon(icon)) return;
		e.viewTransition.finished.finally(() => (icon.style.viewTransitionName = ""));
	});

	/** Prefetches a page when its link is hovered. Never /api links: following one does something. */
	if (HTMLScriptElement.supports?.("speculationrules")) {
		const rules = document.createElement("script");
		rules.type = "speculationrules";
		rules.textContent = JSON.stringify({
			prefetch: [
				{
					where: { and: [{ href_matches: "/*" }, { not: { href_matches: "/api/*" } }] },
					eagerness: "moderate",
				},
			],
		});
		document.head.appendChild(rules);
	}
})();
