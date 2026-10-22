import { describe, expect, test } from "bun:test";
import { GAME } from "../src/config";
import { parseOpenFileLimit, spectatorCap, spectatorCapNote } from "../src/system/limits";

const listing = (soft: string) =>
	`Limit                     Soft Limit           Hard Limit           Units     \nMax open files            ${soft.padEnd(21)}1048576              files     \n`;

describe("open file limit", () => {
	test("reads the soft limit from /proc/<pid>/limits", () => {
		expect(parseOpenFileLimit(listing("1024"))).toBe(1024);
		expect(parseOpenFileLimit(listing("unlimited"))).toBe(Infinity);
		expect(parseOpenFileLimit("nothing here")).toBeNull();
	});

	test("a low limit lowers the spectator cap; a high or unknown one leaves the configured cap", () => {
		const full = GAME.tournament.maxSpectators;
		expect(spectatorCap(1024)).toBe(384);
		expect(spectatorCap(200)).toBe(0);
		expect(spectatorCap(65535)).toBe(full);
		expect(spectatorCap(Infinity)).toBe(full);
		expect(spectatorCap(null)).toBe(full);
		expect(spectatorCapNote(1024)?.title).toBe("Up to 384 spectators per tournament");
		expect(spectatorCapNote(65535)).toBeNull();
		expect(spectatorCapNote(null)).toBeNull();
	});
});
