(function showDestination() {
	const byId = (id) => document.getElementById(id);
	let target = null;
	try {
		const url = new URL(new URLSearchParams(location.search).get("to") || "");
		if (url.protocol === "https:" && !url.username && !url.password) target = url;
	} catch {}

	if (target?.origin === location.origin) return location.replace(target.href);

	const back = byId("leaving-back");
	if (history.length > 1)
		back.addEventListener("click", (e) => {
			e.preventDefault();
			history.back();
		});
	else back.innerHTML = '<span class="material-symbols-outlined">home</span>Return home';

	if (!target) {
		byId("leaving-icon").textContent = "link_off";
		byId("leaving-title").textContent = "This link doesn't work";
		byId("leaving-message").textContent = "It doesn't lead to an address we can send you to.";
		return;
	}
	byId("leaving-host").textContent = target.host;
	const host = document.createElement("span");
	host.className = "text-zinc-100 font-semibold";
	host.textContent = target.host;
	byId("leaving-url").append(`${target.protocol}//`, host, target.href.slice(target.origin.length));
	byId("leaving-target").classList.remove("hidden");
	const onward = document.createElement("a");
	onward.href = target.href;
	onward.rel = "noopener noreferrer";
	onward.className = "m-btn m-btn-filled";
	onward.innerHTML = '<span class="material-symbols-outlined">open_in_new</span>Continue';
	back.after(onward);
})();
