module.exports = {
	name: "dovedale-geoguesser",
	script: "/home/debian/.bun/bin/bun",
	args: "run server.ts",
	interpreter: "none",
	env: {
		PATH: `/home/debian/.bun/bin:${process.env.PATH}`,
	},
	max_memory_restart: "1G",
};
