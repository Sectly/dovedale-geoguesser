(async () => {
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
			const c = document.createElement("canvas");
			const ctx = c.getContext("2d");
			ctx.textBaseline = "top";
			ctx.font = "14px Arial";
			ctx.fillStyle = "#f60";
			ctx.fillRect(0, 0, 10, 10);
			ctx.fillStyle = "#069";
			ctx.fillText("Dovedale\u{1F682}", 2, 2);
			signals.push(c.toDataURL().slice(-64));
		} catch {}

		try {
			const gl = document.createElement("canvas").getContext("webgl");
			if (gl) {
				const ext = gl.getExtension("WEBGL_debug_renderer_info");
				if (ext) signals.push(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
			}
		} catch {}

		const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signals.join("||")));
		const hash = Array.from(new Uint8Array(buf))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("")
			.slice(0, 32);

		navigator.sendBeacon("/api/fp", JSON.stringify({ h: hash }));
	} catch {}
})();
