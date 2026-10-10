(async () => {
	try {
		const r = await fetch("/api/auth/me");
		if (!r.ok) return;
		const user = await r.json();
		if (!user || !user.is_banned) return;

		const expiry =
			user.ban_type === "temp" && user.ban_expires_at
				? `<p class="text-red-200/60 text-sm mt-1">Expires: ${new Date(user.ban_expires_at * 1000).toLocaleString()}</p>`
				: '<p class="text-red-200/60 text-sm mt-1">This ban is permanent.</p>';

		const overlay = document.createElement("div");
		overlay.style.cssText =
			"position:fixed;inset:0;background:#09090b;z-index:9999;display:flex;align-items:center;justify-content:center;font-family:Inter,sans-serif;";
		overlay.innerHTML = `
      <div style="max-width:400px;width:100%;margin:0 16px;text-align:center;">
        <div style="font-family:'Material Symbols Outlined';font-size:48px;font-variation-settings:'FILL' 1;margin-bottom:12px;color:#fca5a5;">block</div>
        <h1 style="color:#fca5a5;font-size:1.5rem;font-weight:700;margin-bottom:8px;">Account Banned</h1>
        ${expiry}
        <p style="color:#71717a;font-size:.875rem;margin-top:12px;line-height:1.6;">
          You can appeal this ban by submitting a support ticket from the settings page.
        </p>
        <a href="/settings" style="display:inline-block;margin-top:20px;background:#1d4ed8;color:#fff;padding:10px 24px;border-radius:12px;font-weight:600;font-size:.875rem;text-decoration:none;">
          Go to Settings &amp; Appeal
        </a>
        <div style="margin-top:14px;">
          <a href="/" style="display:inline-block;background:#27272a;color:#d4d4d8;padding:9px 22px;border-radius:12px;font-weight:600;font-size:.875rem;text-decoration:none;">Return Home</a>
        </div>
        <div style="margin-top:12px;">
          <a href="/api/auth/logout" style="color:#52525b;font-size:.75rem;text-decoration:none;">Log out</a>
        </div>
      </div>`;
		document.body.appendChild(overlay);
	} catch {}
})();
