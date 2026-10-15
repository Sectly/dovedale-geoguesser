import { Sounds } from "../sounds.js";
import { escHtml } from "./dom.js";
import { api, fetchUser } from "./api.js";

const ACHIEVEMENT_SHOWN_MS = 4500;
let _achievementQueue = [];
let _achievementShowing = false;
let _achievementCheck = null;

/** Plays the unlock animation for newly earned achievements. `delay` lets a result land first. */
export function checkAchievements(delay = 0) {
	clearTimeout(_achievementCheck);
	_achievementCheck = setTimeout(async () => {
		if (!(await fetchUser())) return;
		const unlocked = await api("/api/achievements/unseen").catch(() => []);
		if (!Array.isArray(unlocked) || !unlocked.length) return;
		_achievementQueue.push(...unlocked);
		showNextAchievement();
	}, delay);
}

async function showNextAchievement() {
	if (_achievementShowing) return;
	const achievement = _achievementQueue.shift();
	if (!achievement) return;
	_achievementShowing = true;
	const user = await fetchUser();

	const card = document.createElement("a");
	card.className = "achievement-pop";
	card.href = user ? `/u/${encodeURIComponent(user.username)}#achievements` : "#";
	card.setAttribute("role", "status");
	card.innerHTML = `<span class="achievement-icon" aria-hidden="true"><span class="material-symbols-outlined">${escHtml(achievement.icon)}</span></span>
		<span class="achievement-text">
			<span class="achievement-kicker">Achievement unlocked</span>
			<span class="achievement-title">${escHtml(achievement.title)}</span>
			<span class="achievement-desc">${escHtml(achievement.description)}</span>
		</span>`;
	document.body.appendChild(card);
	Sounds.play("good");
	setTimeout(() => card.classList.add("leaving"), ACHIEVEMENT_SHOWN_MS - 500);
	setTimeout(() => {
		card.remove();
		_achievementShowing = false;
		showNextAchievement();
	}, ACHIEVEMENT_SHOWN_MS);
}
