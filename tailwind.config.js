module.exports = {
	content: ["./public/**/*.html", "./public/js/**/*.js"],
	theme: {
		extend: {
			/** Grey text light enough for WCAG AA (4.5:1) on the zinc-800 to zinc-950 backgrounds. Borders and fills keep the stock greys. */
			textColor: { zinc: { 500: "#8f8f98", 600: "#84848c" } },
		},
	},
	plugins: [],
};
