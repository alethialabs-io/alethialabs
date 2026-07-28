// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The tripwire for ./timeouts.ts. That module derives the per-test budget from the per-wait one, so
// the two numbers cannot be edited apart — but the derivation rests on MAX_SEQUENTIAL_WAITS actually
// bounding the tests. This file checks that premise, because the failure it prevents (#1236 → #1402)
// is invisible until it reds the required TypeScript job on somebody else's unrelated PR.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	ASYNC_UTIL_TIMEOUT_MS,
	MAX_SEQUENTIAL_WAITS,
	TEST_TIMEOUT_MS,
} from "./timeouts";

/**
 * This directory, resolved from vitest's own state rather than `import.meta.url` (the jsdom
 * environment hands back a non-`file:` URL) or `process.cwd()` (which depends on where the runner
 * was invoked from). Must be called inside a test — the state is populated per running test.
 */
function testsDir(): string {
	const { testPath } = expect.getState();
	if (!testPath) throw new Error("vitest did not report a testPath");
	return dirname(testPath);
}

// An `await`ed RTL async utility: `await waitFor(`, `await screen.findByRole(`,
// `await within(el).findByText(`. Deliberately shallow — a tripwire for the shape we actually write,
// not a parser. Waits reached through a helper function are invisible to it, which is why
// phone-input.test.tsx keeps its waits in the `it()` body (see `pasteQuery` there).
const WAIT_PATTERN =
	/await\s+(?:waitFor\s*\(|(?:screen|within\s*\([^)]*\))\s*\.\s*find[A-Za-z]*\s*\()/g;

/** Every `*.test.tsx` in this directory (the `.ts` unit tests drive no DOM waits). */
function testFiles(dir: string): string[] {
	return readdirSync(dir)
		.filter((f) => f.endsWith(".test.tsx"))
		.sort();
}

/**
 * Splits a test file into one chunk per `it(` / `test(` block and counts the awaited RTL waits in
 * each. Chunks are delimited by the next block's opening call, so a chunk holds that block's body
 * plus any trailing lines — close enough for a ceiling check, and it never UNDER-counts.
 */
function waitsPerBlock(source: string): { name: string; waits: number }[] {
	const blocks = [...source.matchAll(/\b(?:it|test)\s*\(\s*(["'`])(.*?)\1/gs)];
	return blocks.map((block, i) => {
		const start = block.index ?? 0;
		const end = i + 1 < blocks.length ? (blocks[i + 1].index ?? source.length) : source.length;
		const body = source.slice(start, end);
		return { name: block[2], waits: [...body.matchAll(WAIT_PATTERN)].length };
	});
}

describe("test timeout budgets", () => {
	it("gives every sequential wait room to fail with its own message", () => {
		// The invariant. Below it, vitest kills the test before a wait can report which assertion
		// never settled — the opaque `Test timed out in 15000ms` that made #1402 so expensive.
		expect(TEST_TIMEOUT_MS).toBeGreaterThan(
			ASYNC_UTIL_TIMEOUT_MS * MAX_SEQUENTIAL_WAITS,
		);
	});

	it("has no test chaining more waits than the budget accounts for", () => {
		const dir = testsDir();
		const offenders = testFiles(dir).flatMap((file) =>
			waitsPerBlock(readFileSync(join(dir, file), "utf8"))
				.filter((b) => b.waits > MAX_SEQUENTIAL_WAITS)
				.map((b) => `${file} › ${b.name} (${b.waits} waits)`),
		);

		expect(
			offenders,
			`These tests chain more than MAX_SEQUENTIAL_WAITS (${MAX_SEQUENTIAL_WAITS}) awaited RTL ` +
				`waits, so their worst case now exceeds the per-test budget:\n  ${offenders.join("\n  ")}\n\n` +
				`Fix: raise MAX_SEQUENTIAL_WAITS in tests/timeouts.ts (TEST_TIMEOUT_MS follows it ` +
				`automatically), or split the test so no single block chains that many waits.`,
		).toEqual([]);
	});
});
