/** Sound effects, generated in the browser. On by default; remembered per device and account. */
export const Sounds = (() => {
	const STORAGE_KEY = "sounds";
	let enabled = true;
	try {
		enabled = localStorage.getItem(STORAGE_KEY) !== "0";
	} catch {}
	let ctx = null;

	/** Browsers only allow audio after the visitor has interacted with the page. */
	function context() {
		try {
			ctx ??= new (window.AudioContext || window.webkitAudioContext)();
			if (ctx.state === "suspended") ctx.resume();
			return ctx.state === "running" ? ctx : null;
		} catch {
			return null;
		}
	}

	/** One note: [frequency Hz, start offset s, length s, waveform, volume]. */
	function note(audio, [freq, at, length, wave = "sine", volume = 0.07]) {
		const osc = audio.createOscillator();
		const gain = audio.createGain();
		const start = audio.currentTime + at;
		osc.type = wave;
		osc.frequency.setValueAtTime(freq, start);
		gain.gain.setValueAtTime(0, start);
		gain.gain.linearRampToValueAtTime(volume, start + 0.01);
		gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
		osc.connect(gain).connect(audio.destination);
		osc.start(start);
		osc.stop(start + length + 0.02);
	}

	const LIBRARY = {
		pin: [[620, 0, 0.08, "triangle"]],
		submit: [
			[440, 0, 0.09, "triangle"],
			[660, 0.07, 0.12, "triangle"],
		],
		hint: [
			[880, 0, 0.1],
			[1175, 0.08, 0.16],
		],
		tick: [[900, 0, 0.04, "square", 0.025]],
		countdown: [[523, 0, 0.12, "triangle"]],
		start: [
			[523, 0, 0.1, "triangle"],
			[784, 0.09, 0.2, "triangle"],
		],
		great: [
			[659, 0, 0.12],
			[784, 0.1, 0.12],
			[1047, 0.2, 0.28],
		],
		good: [
			[587, 0, 0.12],
			[740, 0.1, 0.22],
		],
		poor: [
			[330, 0, 0.14, "triangle"],
			[262, 0.12, 0.26, "triangle"],
		],
		opponent: [[740, 0, 0.1, "sine", 0.05]],
		win: [
			[523, 0, 0.12],
			[659, 0.11, 0.12],
			[784, 0.22, 0.12],
			[1047, 0.33, 0.4],
		],
		lose: [
			[392, 0, 0.16, "triangle"],
			[330, 0.15, 0.16, "triangle"],
			[262, 0.3, 0.4, "triangle"],
		],
		pause: [
			[440, 0, 0.12, "triangle"],
			[349, 0.12, 0.2, "triangle"],
		],
		versus: [
			[196, 0, 0.18, "sawtooth", 0.04],
			[294, 0.12, 0.18, "sawtooth", 0.04],
			[392, 0.24, 0.3, "triangle", 0.06],
		],
		reveal: [[523, 0, 0.07, "triangle", 0.05]],
		notify: [
			[988, 0, 0.1],
			[1319, 0.09, 0.24],
		],
		/* Reactions: one short phrase each, named after its icon. `emote` covers any without its own. */
		emote: [[784, 0, 0.1, "sine", 0.05]],
		emote_waving_hand: [
			[659, 0, 0.09, "sine", 0.05],
			[880, 0.08, 0.14, "sine", 0.05],
		],
		emote_thumb_up: [
			[784, 0, 0.07, "triangle", 0.06],
			[1047, 0.06, 0.14, "triangle", 0.06],
		],
		emote_handshake: [
			[523, 0, 0.1, "triangle", 0.06],
			[523, 0.13, 0.16, "triangle", 0.06],
		],
		emote_celebration: [
			[523, 0, 0.08, "sine", 0.05],
			[659, 0.07, 0.08, "sine", 0.05],
			[784, 0.14, 0.08, "sine", 0.05],
			[1047, 0.21, 0.24, "sine", 0.06],
		],
		emote_local_fire_department: [
			[330, 0, 0.09, "sawtooth", 0.03],
			[494, 0.07, 0.09, "sawtooth", 0.03],
			[740, 0.14, 0.2, "sawtooth", 0.035],
		],
		emote_favorite: [
			[698, 0, 0.16, "sine", 0.05],
			[880, 0.13, 0.3, "sine", 0.05],
		],
		emote_sentiment_very_satisfied: [
			[659, 0, 0.07, "triangle", 0.05],
			[523, 0.07, 0.07, "triangle", 0.05],
			[784, 0.14, 0.18, "triangle", 0.06],
		],
		emote_sentiment_dissatisfied: [
			[392, 0, 0.14, "triangle", 0.06],
			[294, 0.13, 0.28, "triangle", 0.06],
		],
		emote_psychology_alt: [
			[330, 0, 0.16, "sine", 0.06],
			[311, 0.15, 0.1, "sine", 0.06],
			[370, 0.26, 0.2, "sine", 0.05],
		],
		emote_bolt: [
			[1400, 0, 0.04, "square", 0.025],
			[1000, 0.04, 0.05, "square", 0.025],
			[1700, 0.09, 0.09, "square", 0.025],
		],
		emote_rocket_launch: [
			[262, 0, 0.08, "sawtooth", 0.03],
			[392, 0.07, 0.08, "sawtooth", 0.03],
			[587, 0.14, 0.08, "sawtooth", 0.03],
			[880, 0.21, 0.26, "triangle", 0.05],
		],
		emote_skull: [
			[220, 0, 0.14, "sawtooth", 0.035],
			[185, 0.13, 0.14, "sawtooth", 0.035],
			[139, 0.26, 0.34, "sawtooth", 0.04],
		],
	};

	return {
		get enabled() {
			return enabled;
		},
		setEnabled(value) {
			enabled = !!value;
			try {
				localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
			} catch {}
		},
		has: (name) => !!LIBRARY[name],
		play(name) {
			if (!enabled || !LIBRARY[name]) return;
			const audio = context();
			if (audio) for (const n of LIBRARY[name]) note(audio, n);
		},
		forScore(score, max = 5000) {
			this.play(score / max >= 0.8 ? "great" : score / max >= 0.4 ? "good" : "poor");
		},
	};
})();
