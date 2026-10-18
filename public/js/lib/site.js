import "./icons.js";
import "./konami.js";
import "./restart.js";
import "./header.js";
import "./keys.js";
import "./notices.js";
import "./announcements.js";
import "./effects.js";
import "../tooltips.js";
import { whenIdle } from "./dom.js";
import { fetchUser } from "./api.js";
import { showToast } from "./toast.js";

/** A script of ours failing should not leave the page silently half-working. Said once per page. */
(function reportScriptErrors() {
	let told = false;
	const tell = (source) => {
		if (told || !String(source || "").startsWith(location.origin + "/js/")) return;
		told = true;
		showToast("Something on this page stopped working. Reloading usually fixes it.", "error");
	};
	window.addEventListener("error", (e) => tell(e.filename));
	window.addEventListener("unhandledrejection", (e) => tell(/https?:\/\/[^\s)]+/.exec(e.reason?.stack || "")?.[0]));
})();

whenIdle(async function fingerprint() {
	const user = await fetchUser();
	if (!user) return;
	const sentKey = `fp_sent:${user.id}`;
	const today = new Date().toISOString().slice(0, 10);
	try {
		if (localStorage.getItem(sentKey) === today) return;
		localStorage.setItem(sentKey, today);
	} catch {}
	try {
		const signals = [
			navigator.userAgent,
			navigator.language,
			`${screen.width}x${screen.height}x${screen.colorDepth}`,
			Intl.DateTimeFormat().resolvedOptions().timeZone,
			String(navigator.hardwareConcurrency || 0),
			navigator.platform || "",
		];
		try {
			const canvas = document.createElement("canvas");
			const ctx = canvas.getContext("2d");
			ctx.textBaseline = "top";
			ctx.font = "14px Arial";
			ctx.fillStyle = "#f60";
			ctx.fillRect(0, 0, 10, 10);
			ctx.fillStyle = "#069";
			ctx.fillText("Dovedale\u{1F682}", 2, 2);
			signals.push(canvas.toDataURL().slice(-64));
		} catch {}
		try {
			const gl = document.createElement("canvas").getContext("webgl");
			const ext = gl?.getExtension("WEBGL_debug_renderer_info");
			if (ext) signals.push(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
		} catch {}

		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signals.join("||")));
		const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
			.join("")
			.slice(0, 32);
		navigator.sendBeacon("/api/fp", new Blob([JSON.stringify({ h: hash })], { type: "application/json" }));
	} catch {}
});
