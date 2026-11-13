// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Scrubbing a large console breadcrumb costs time in proportion to its size (#6668). A breadcrumb
// is not normalized before `beforeBreadcrumb`, so a `console.error` of 20,000 rows reaches the
// scrub whole; reading `process.env` once per string made that block the event loop for about a
// second. What is pinned is the CAUSE, deterministically: one scrub enumerates `process.env` once,
// however many strings it walks. A wall-clock bound is kept only as a loose backstop, because a
// loaded CI runner has run this folder's timing checks about 80x slower than a laptop.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scrubBreadcrumb } from "@/lib/observability/scrub";

/** A secret env value planted for the test; it must not survive the scrub. */
const SECRET = "zz-perf-secret-value-7c1e";
/** A second secret, set only between two scrubs, to show the list is not cached across calls. */
const LATE_SECRET = "zz-late-secret-value-2b9d";
/** How many rows the logged table has: the size #6668 measured. */
const ROWS = 20_000;
/**
 * A backstop for one scrub of ROWS rows: about 45 ms on a developer machine with the fix, about
 * 3.2 s there without it. Far above both, so only a pathological slowdown crosses it; the
 * enumeration count below is the real check.
 */
const BOUND_MS = 15_000;

/**
 * Runs `fn` with `process.env` replaced by a proxy that counts how many times its keys are
 * enumerated, and returns that count. The real environment object is restored afterwards.
 */
function countEnvEnumerations(fn: () => void): number {
	const real = process.env;
	let count = 0;
	process.env = new Proxy(real, {
		ownKeys(target) {
			count += 1;
			return Reflect.ownKeys(target);
		},
	});
	try {
		fn();
	} finally {
		process.env = real;
	}
	return count;
}

/** One row of a logged query result, with the secret echoed into every hundredth row. */
interface Row {
	id: number;
	name: string;
	email: string;
	note: string;
}

/** Builds ROWS rows; every hundredth row's `note` carries SECRET. */
function rows(): Row[] {
	const out: Row[] = [];
	for (let i = 0; i < ROWS; i++) {
		out.push({
			id: i,
			name: `row-${i}`,
			email: `user${i}@example.test`,
			note: i % 100 === 0 ? `echoed ${SECRET} here` : `plain note ${i}`,
		});
	}
	return out;
}

/** A breadcrumb shaped as Sentry's console integration builds one for `console.error(rows)`. */
function consoleBreadcrumb(data: Row[]): {
	category: string;
	level: string;
	message: string;
	data: { arguments: unknown[]; logger: string };
} {
	return {
		category: "console",
		level: "error",
		message: "[object Object]",
		data: { arguments: [data], logger: "console" },
	};
}

describe("scrubbing a 20,000-row console breadcrumb", () => {
	beforeEach(() => {
		process.env.ZZ_PERF_API_KEY = SECRET;
	});

	afterEach(() => {
		delete process.env.ZZ_PERF_API_KEY;
		delete process.env.ZZ_LATE_TOKEN;
	});

	it("reads process.env once per scrub, however many strings it walks", () => {
		const crumb = consoleBreadcrumb(rows());
		let out: unknown;
		const reads = countEnvEnumerations(() => {
			out = scrubBreadcrumb(crumb);
		});
		expect(reads).toBe(1);
		expect(JSON.stringify(out)).not.toContain(SECRET);
	}, 30_000);

	it(
		"finishes under the backstop and still redacts every secret",
		() => {
			const crumb = consoleBreadcrumb(rows());
			const t0 = performance.now();
			const out = scrubBreadcrumb(crumb);
			const elapsed = performance.now() - t0;

			const text = JSON.stringify(out);
			expect(text).not.toContain(SECRET);
			// Every hundredth row carried it, so the redaction marker appears ROWS / 100 times.
			expect(text.split("[REDACTED]").length - 1).toBe(ROWS / 100);
			expect(elapsed).toBeLessThan(BOUND_MS);
		},
		60_000,
	);

	it(
		"redacts a secret set in process.env after an earlier scrub",
		() => {
			scrubBreadcrumb(consoleBreadcrumb(rows()));
			process.env.ZZ_LATE_TOKEN = LATE_SECRET;
			const crumb = consoleBreadcrumb([
				{ id: 1, name: "late", email: "late@example.test", note: `has ${LATE_SECRET}` },
			]);
			expect(JSON.stringify(scrubBreadcrumb(crumb))).not.toContain(LATE_SECRET);
		},
		30_000,
	);
});
