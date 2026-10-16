/**
 * Icons are font ligatures, so a screen reader would read out their names ("refresh", "all_inclusive").
 * Each one is hidden from it, unless it has a title: then the title is read instead.
 */

const SELECTOR = ".material-symbols-outlined:not([aria-hidden]):not([aria-label])";

function label(icon) {
	const title = icon.getAttribute("title");
	if (title) {
		icon.setAttribute("role", "img");
		icon.setAttribute("aria-label", title);
	} else icon.setAttribute("aria-hidden", "true");
}

function labelAll(root) {
	if (root.matches?.(SELECTOR)) label(root);
	for (const icon of root.querySelectorAll?.(SELECTOR) ?? []) label(icon);
}

labelAll(document);
new MutationObserver((changes) => {
	for (const change of changes) for (const node of change.addedNodes) if (node.nodeType === 1) labelAll(node);
}).observe(document.documentElement, { childList: true, subtree: true });
