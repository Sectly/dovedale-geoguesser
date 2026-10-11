/** Tailwind scans the pages and the scripts that build markup, and emits only the classes they use. */
module.exports = {
	content: ["./public/**/*.html", "./public/js/**/*.js"],
	theme: { extend: {} },
	plugins: [],
};
