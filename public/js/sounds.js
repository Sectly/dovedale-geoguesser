/**
 * Sound effects, generated in the browser so there are no audio files to load.
 * On by default; the choice is remembered on this device and, when logged in,
 * follows the account's preference from the settings page.
 */
const Sounds = (() => {
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
		play(name) {
			if (!enabled || !LIBRARY[name]) return;
			const audio = context();
			if (audio) for (const n of LIBRARY[name]) note(audio, n);
		},
		/** The sound for a round score out of its maximum. */
		forScore(score, max = 5000) {
			this.play(score / max >= 0.8 ? "great" : score / max >= 0.4 ? "good" : "poor");
		},
	};
})();
