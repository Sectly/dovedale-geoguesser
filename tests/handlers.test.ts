import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { PUBLIC_DIR } from "../src/config";
// @ts-expect-error The page script has no type declarations.
import { parse } from "../public/js/lib/handlers.js";

/** Every data-on-* value in the pages and scripts, with `${...}` read as one value. Ones built elsewhere are left out. */
function handlerValues(): { where: string; src: string }[] {
	const files = [...new Bun.Glob("*.html").scanSync(PUBLIC_DIR), ...new Bun.Glob("js/**/*.js").scanSync(PUBLIC_DIR)];
	const found: { where: string; src: string }[] = [];
	for (const file of files) {
		const text = readFileSync(join(PUBLIC_DIR, file), "utf8");
		for (const match of text.matchAll(/data-on-[a-z]+="/g)) {
			let i = match.index + match[0].length;
			let depth = 0;
			let value = "";
			for (; i < text.length; i++) {
				if (text.startsWith("${", i)) depth++;
				else if (text[i] === "}" && depth) depth--;
				else if (text[i] === '"' && !depth) break;
				value += text[i];
			}
			if (/^\$\{[^}]*\}$/.test(value.trim()) || value.includes("`")) continue;
			found.push({
				where: `${file}:${text.slice(0, match.index).split("\n").length}`,
				src: value.replace(/\$\{[^}]*\}/g, "1"),
			});
		}
	}
	return found;
}

describe("inline handlers", () => {
	test("there are no on* attributes left, since the page policy blocks them", () => {
		for (const file of [
			...new Bun.Glob("*.html").scanSync(PUBLIC_DIR),
			...new Bun.Glob("js/**/*.js").scanSync(PUBLIC_DIR),
		]) {
			const text = readFileSync(join(PUBLIC_DIR, file), "utf8");
			expect({
				file,
				found: text.match(/\son(click|change|input|submit|keydown|keyup|toggle|error|load)=["'$]/g),
			}).toEqual({
				file,
				found: null,
			});
		}
	});

	test("every data-on-* handler is one the dispatcher can read", () => {
		const values = handlerValues();
		expect(values.length).toBeGreaterThan(150);
		for (const { where, src } of values)
			expect({ where, ok: (() => (parse(src), true))() }).toEqual({ where, ok: true });
	});

	test("reads calls, chains, literals and objects", () => {
		expect(parse("openUserPanel(12)")).toHaveLength(1);
		expect(parse("event.stopPropagation(); el('x').classList.add('hidden'); return false")).toHaveLength(3);
		expect(parse("setStaffChat({ slow_seconds: Number(this.value), on: !false })")).toHaveLength(1);
		expect(() => parse("a = 1")).toThrow();
		expect(() => parse("if (x) y()")).toThrow();
	});
});
