import { el } from "./dom.js";

export function showToast(message, type = "info", { href = "" } = {}) {
	let container = el("toast-container");
	if (!container) {
		container = document.createElement("div");
		container.id = "toast-container";
		container.className =
			"fixed bottom-5 inset-x-4 sm:inset-x-auto sm:right-5 flex flex-col items-end gap-2 z-[100] pointer-events-none";
		container.setAttribute("role", "status");
		document.body.appendChild(container);
	}
	const colors = {
		info: "bg-zinc-800 text-zinc-100",
		success: "bg-green-900 text-green-200",
		error: "bg-red-900/90 text-red-200",
	};
	const toast = document.createElement(href ? "a" : "div");
	if (href) toast.href = href;
	toast.className = `pointer-events-auto flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm shadow-lg ${colors[type] || colors.info} opacity-0 transition-opacity duration-200 ${href ? "underline-offset-2 hover:underline" : ""}`;
	toast.dataset.type = type;
	const icon = { success: "check_circle", error: "error" }[type];
	if (icon) toast.innerHTML = `<span class="toast-icon material-symbols-outlined" aria-hidden="true">${icon}</span>`;
	toast.append(message);
	container.appendChild(toast);
	requestAnimationFrame(() => toast.classList.remove("opacity-0"));
	setTimeout(
		() => {
			toast.style.setProperty("--toast-height", `${toast.offsetHeight}px`);
			toast.classList.add("leaving");
			setTimeout(() => toast.remove(), 250);
		},
		type === "error" || href ? 6000 : 3500
	);
}

export async function copyText(text) {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {}
	const field = document.createElement("textarea");
	field.value = text;
	field.setAttribute("readonly", "");
	field.style.cssText = "position:fixed;top:0;left:0;opacity:0";
	document.body.appendChild(field);
	field.select();
	let copied = false;
	try {
		copied = document.execCommand("copy");
	} catch {}
	field.remove();
	if (!copied) showToast(`Couldn't copy automatically. The link is: ${text}`, "error");
	return copied;
}
