module.exports = {
	name: "dovedale-geoguesser",
	script: "/home/debian/.bun/bin/bun",
	args: "run server.ts",
	interpreter: "none",
	env: {
		PATH: `/home/debian/.bun/bin:${process.env.PATH}`,
	},
	max_memory_restart: "1G",
	/**
	 * A server that cannot start (a damaged database, a full disk) is retried ever more slowly, not in a tight loop.
	 */
	exp_backoff_restart_delay: 1000,
};
