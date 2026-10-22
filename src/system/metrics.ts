const MAX_REQUESTS = 5000;
const WINDOW_MS = 5 * 60 * 1000;
const SAMPLE_MS = 1000;
/** Seconds of CPU and event-loop samples kept. */
const SAMPLES = 60;

const requests: { at: number; ms: number; failed: boolean }[] = [];
const lagMs: number[] = [];
const cpu: { at: number; micros: number }[] = [];
let sampler: ReturnType<typeof setInterval> | null = null;

/** Streams and sockets are left out. */
export function recordRequest(ms: number, status: number) {
	requests.push({ at: Date.now(), ms, failed: status >= 500 });
	if (requests.length > MAX_REQUESTS) requests.splice(0, requests.length - MAX_REQUESTS);
}

/** Samples CPU and event-loop delay each second. */
export function startMetrics() {
	if (sampler) return;
	let expected = performance.now() + SAMPLE_MS;
	sampler = setInterval(() => {
		const now = performance.now();
		lagMs.push(Math.max(0, now - expected));
		expected = now + SAMPLE_MS;
		const { user, system } = process.cpuUsage();
		cpu.push({ at: now, micros: user + system });
		if (lagMs.length > SAMPLES) lagMs.shift();
		if (cpu.length > SAMPLES + 1) cpu.shift();
	}, SAMPLE_MS);
	sampler.unref?.();
}

const percentile = (sorted: number[], p: number) =>
	sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;

export function metricsSnapshot() {
	const since = Date.now() - WINDOW_MS;
	const recent = requests.filter((r) => r.at >= since);
	const times = recent.map((r) => r.ms).sort((a, b) => a - b);
	const lastMinute = recent.filter((r) => r.at >= Date.now() - 60_000).length;
	const first = cpu[0];
	const last = cpu.at(-1);
	const cpuPercent =
		first && last && last.at > first.at ? ((last.micros - first.micros) / 1000 / (last.at - first.at)) * 100 : null;
	return {
		requests_per_minute: lastMinute,
		requests_5m: recent.length,
		server_errors_5m: recent.filter((r) => r.failed).length,
		response_ms: { p50: percentile(times, 0.5), p95: percentile(times, 0.95), max: times.at(-1) ?? 0 },
		cpu_percent: cpuPercent === null ? null : Math.round(cpuPercent),
		loop_lag_ms: {
			avg: lagMs.length ? lagMs.reduce((a, b) => a + b, 0) / lagMs.length : null,
			max: lagMs.length ? Math.max(...lagMs) : null,
		},
	};
}
