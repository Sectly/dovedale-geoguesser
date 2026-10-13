/** The news page: announcements made to all players and the changelog, newest first. */

let _news = [];
let _newsKind = "";

function newsItemHtml(item) {
	const update = item.kind === "update";
	const date = new Date(item.at * 1000).toLocaleDateString(undefined, {
		day: "numeric",
		month: "long",
		year: "numeric",
	});
	const body = update
		? `<ul class="text-sm text-zinc-300 list-disc pl-5 mt-2 flex flex-col gap-0.5">${item.body
				.split("\n")
				.filter((line) => line.trim())
				.map((line) => `<li>${escHtml(line.replace(/^[-*]\s*/, ""))}</li>`)
				.join("")}</ul>`
		: `<p class="text-sm text-zinc-300 mt-1 break-words">${escHtml(item.body)}</p>`;
	return `<article class="bg-zinc-900 rounded-2xl p-5">
		<div class="flex items-center gap-2 flex-wrap">
			<span class="m-tag ${update ? "success" : "info"}">${update ? "Update" : "Announcement"}</span>
			<span class="text-xs text-zinc-500">${date}</span>
		</div>
		<h2 class="font-bold text-lg mt-2 break-words">${escHtml(item.title)}</h2>
		${body}
		${item.link ? `<a href="${escHtml(item.link)}" class="inline-block text-sm text-blue-400 hover:underline mt-3">Take a look</a>` : ""}
	</article>`;
}

function renderNews() {
	const shown = _news.filter((item) => !_newsKind || item.kind === _newsKind);
	el("news-list").innerHTML = shown.length
		? `<div class="stagger flex flex-col gap-3">${shown.map(newsItemHtml).join("")}</div>`
		: '<p class="text-zinc-500 text-sm text-center py-10">Nothing here yet.</p>';
}

for (const chip of document.querySelectorAll("#news-filters [data-kind]"))
	chip.addEventListener("click", () => {
		_newsKind = chip.dataset.kind;
		for (const other of document.querySelectorAll("#news-filters [data-kind]"))
			other.setAttribute("aria-pressed", other === chip);
		renderNews();
	});

api("/api/news")
	.then((news) => {
		_news = news;
		renderNews();
	})
	.catch((err) => (el("news-list").innerHTML = errorStateHtml(err.message || "Couldn't load the news.")));
