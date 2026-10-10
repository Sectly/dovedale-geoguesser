const el = (id) => document.getElementById(id);

function setupPhotoLens(imgEl) {
	if (!imgEl) return;
	const container = imgEl.parentElement;
	const lens = document.createElement("div");
	lens.style.cssText =
		"position:absolute;width:200px;height:200px;border-radius:50%;border:2px solid rgba(255,255,255,0.35);box-shadow:0 4px 24px rgba(0,0,0,0.6);pointer-events:none;display:none;background-repeat:no-repeat;z-index:20;transform:translate(-50%,-50%);";
	container.appendChild(lens);

	const MIN_SIZE = 80;
	const MAX_SIZE = 360;
	const MIN_ZOOM = 1.5;
	const MAX_ZOOM = 8;
	let lensSize = 200;
	let zoom = 3;
	let lastClientX = 0;
	let lastClientY = 0;
	let lensVisible = false;
	let sizeDirty = false;

	function updateLens(clientX, clientY) {
		const rect = imgEl.getBoundingClientRect();
		const x = clientX - rect.left;
		const y = clientY - rect.top;
		const nw = imgEl.naturalWidth || rect.width;
		const nh = imgEl.naturalHeight || rect.height;
		const scale = Math.min(rect.width / nw, rect.height / nh);
		const rw = nw * scale;
		const rh = nh * scale;
		const ox = (rect.width - rw) / 2;
		const oy = (rect.height - rh) / 2;
		if (x < ox || x > ox + rw || y < oy || y > oy + rh) {
			lensVisible = false;
			lens.style.display = "none";
			return;
		}
		if (sizeDirty) {
			lens.style.width = `${lensSize}px`;
			lens.style.height = `${lensSize}px`;
			sizeDirty = false;
		}
		const ix = (x - ox) / rw;
		const iy = (y - oy) / rh;
		const bgW = rw * zoom;
		const bgH = rh * zoom;
		lens.style.backgroundSize = `${bgW}px ${bgH}px`;
		lens.style.backgroundPosition = `-${ix * bgW - lensSize / 2}px -${iy * bgH - lensSize / 2}px`;
		lens.style.left = `${x}px`;
		lens.style.top = `${y}px`;
		lensVisible = true;
		lens.style.display = "block";
	}

	imgEl.addEventListener("mouseenter", () => {
		if (!imgEl.src || imgEl.naturalWidth === 0) return;
		lens.style.backgroundImage = `url('${imgEl.src}')`;
	});
	imgEl.addEventListener("mouseleave", () => {
		lensVisible = false;
		lens.style.display = "none";
	});
	imgEl.addEventListener("mousemove", (e) => {
		lastClientX = e.clientX;
		lastClientY = e.clientY;
		updateLens(e.clientX, e.clientY);
	});
	imgEl.addEventListener(
		"wheel",
		(e) => {
			if (!lensVisible) return;
			e.preventDefault();
			const step = e.deltaY < 0 ? 1.1 : 1 / 1.1;
			lensSize = Math.min(MAX_SIZE, Math.max(MIN_SIZE, lensSize * step));
			zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * step));
			sizeDirty = true;
			updateLens(lastClientX, lastClientY);
		},
		{ passive: false }
	);
}
const escHtml = (s) =>
	String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

async function fetchUser() {
	try {
		const r = await fetch("/api/auth/me");
		if (r.ok) return await r.json();
	} catch {}
	return null;
}

function showToast(message, type = "info") {
	let container = document.getElementById("toast-container");
	if (!container) {
		container = document.createElement("div");
		container.id = "toast-container";
		container.className = "fixed bottom-5 right-5 flex flex-col gap-2 z-[100] pointer-events-none";
		document.body.appendChild(container);
	}
	const colors = {
		info: "bg-zinc-800 text-zinc-100",
		success: "bg-green-900 text-green-200",
		error: "bg-red-900/90 text-red-200",
	};
	const toast = document.createElement("div");
	toast.className = `pointer-events-auto px-4 py-2.5 rounded-xl text-sm shadow-lg ${colors[type] || colors.info} opacity-0 transition-opacity duration-200`;
	toast.textContent = message;
	container.appendChild(toast);
	requestAnimationFrame(() => toast.classList.remove("opacity-0"));
	setTimeout(() => {
		toast.classList.add("opacity-0");
		setTimeout(() => toast.remove(), 250);
	}, 3500);
}

(function () {
	if (localStorage.getItem("beta_acknowledged")) return;
	const modal = document.createElement("div");
	modal.innerHTML = `<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
    <div class="bg-zinc-900 border border-zinc-700 rounded-2xl p-8 max-w-sm w-full mx-4 shadow-2xl">
      <div class="flex items-center gap-3 mb-4">
        <span class="material-symbols-outlined text-yellow-500 text-3xl" style="font-variation-settings:'FILL' 1">science</span>
        <h2 class="text-xl font-bold">Early Beta</h2>
      </div>
      <p class="text-zinc-400 text-sm mb-3">Dovedale GeoGuesser is in beta. Some things may be broken, incomplete, or change without notice.</p>
      <p class="text-zinc-500 text-sm mb-6">If you run into issues, please report them via the support ticket system in <a href="/settings" class="text-blue-400 hover:text-blue-300 underline">Settings</a>.</p>
      <button class="w-full bg-blue-600 hover:bg-blue-500 transition py-2.5 rounded-xl font-semibold text-sm">Got it</button>
    </div>
  </div>`;
	modal.querySelector("button").addEventListener("click", function () {
		localStorage.setItem("beta_acknowledged", "1");
		modal.remove();
	});
	function mount() {
		document.body.appendChild(modal);
	}
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", mount);
	} else {
		mount();
	}
})();
