// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The TS half of the cross-surface formatter contract.
 *
 * `conformance/format-cases.json` is the table `packages/core/format` (Go) is held to. This
 * suite asserts the TS implementation still produces it, which is what makes that file a
 * MIRROR OF TS rather than a third opinion that drifted from both sides.
 *
 * The three layers, and how they fail:
 *   1. this suite            — TS changed and the table did not
 *   2. the CI diff-gate      — the table is stale (`pnpm -F console gen:format-conformance:check`)
 *   3. conformance_test.go   — Go disagrees with the table
 *
 * Go cannot write the file, so it has no way to make itself right. Neither side drifts alone.
 */

import { describe, expect, it } from "vitest";

// Imported rather than read off disk. `node:fs` would drag `@types/node` into this leaf package,
// and adding a devDependency here re-resolved the lockfile and bumped @better-auth/utils, which
// broke the console's type-check in an unrelated file. A JSON import needs nothing.
import caseFile from "../conformance/format-cases.json";
import { EXCLUDED } from "../conformance/cases.ts";
import * as fmt from "../src/index.ts";

const FILE = "packages/format/conformance/format-cases.json";

/**
 * A case id must NAME the boundary it pins, because the id is what a diff shows when an
 * expectation moves. `minutes/HALF-ROUNDS-UP-ACROSS-THE-HOUR-BOUNDARY` tells a reviewer what
 * changed; `minutes/3` tells them nothing and would let a regenerate-to-go-green slip past.
 *
 * The lookahead is the whole point: the name after the slash must contain at least one LETTER,
 * so a bare index cannot masquerade as a name.
 */
const SEMANTIC_ID = /^[a-zA-Z]+\/(?=[a-zA-Z0-9/.-]*[a-zA-Z])[a-zA-Z0-9/.-]+$/;

/**
 * A case row. Inputs vary per section, so the shared shape is the id and the expectation; the
 * per-section driver reads the inputs it needs.
 */
interface Row {
	id: string;
	want: string;
	[key: string]: unknown;
}

/** `null` in the table means "not a finite number" — the branch every formatter clamps. */
function n(v: unknown): number {
	if (v === null) return Number.NaN;
	if (typeof v !== "number") throw new TypeError(`expected a number or null, got ${typeof v}`);
	return v;
}

function s(v: unknown): string {
	if (typeof v !== "string") throw new TypeError(`expected a string, got ${typeof v}`);
	return v;
}

/** `formatDate`'s first parameter accepts a string or null; anything else is a bad table. */
function nullableString(v: unknown): string | null {
	if (v === null) return null;
	return s(v);
}

function dateStyle(v: unknown): fmt.DateStyle {
	const style = s(v);
	if (style === "date" || style === "datetime" || style === "month" || style === "time") return style;
	throw new TypeError(`unknown DateStyle ${JSON.stringify(style)}`);
}

function rateStyle(v: unknown): fmt.MonthlyRateStyle {
	const style = s(v);
	if (style === "estimate" || style === "exact") return style;
	throw new TypeError(`unknown MonthlyRateStyle ${JSON.stringify(style)}`);
}

/**
 * What this suite knows how to drive. Cross-checked against the table AND against the
 * package's exports below, so a formatter added to one and not the others is a failure rather
 * than a silent skip — the failure mode a table-driven suite is otherwise most prone to.
 */
const DRIVERS: Record<string, { fn: string; run: (r: Row) => string }> = {
	minutes: { fn: "formatMinutes", run: (r) => fmt.formatMinutes(n(r.in)) },
	quota: { fn: "formatQuota", run: (r) => fmt.formatQuota(n(r.used), n(r.included)) },
	duration: { fn: "formatDuration", run: (r) => fmt.formatDuration(n(r.in)) },
	date: { fn: "formatDate", run: (r) => fmt.formatDate(nullableString(r.value), dateStyle(r.style), s(r.timeZone)) },
	bytes: { fn: "formatBytes", run: (r) => fmt.formatBytes(n(r.in)) },
	money: { fn: "formatMoney", run: (r) => fmt.formatMoney(n(r.cents), s(r.currency)) },
	monthlyRate: {
		fn: "formatMonthlyRate",
		run: (r) => fmt.formatMonthlyRate(n(r.amount), rateStyle(r.style), s(r.currency)),
	},
};

/** Narrow the imported file without an `any` escaping or a cast. */
function loadTable(): { version: number; cases: Record<string, Row[]> } {
	const parsed: unknown = caseFile;
	if (parsed === null || typeof parsed !== "object") throw new TypeError(`${FILE} is not an object`);
	const doc: Record<string, unknown> = { ...parsed };

	const version = doc.version;
	if (typeof version !== "number") throw new TypeError(`${FILE} has no numeric \`version\``);

	const rawCases = doc.cases;
	if (rawCases === null || typeof rawCases !== "object") throw new TypeError(`${FILE} has no \`cases\` object`);

	const cases: Record<string, Row[]> = {};
	for (const [section, value] of Object.entries({ ...rawCases })) {
		if (!Array.isArray(value)) throw new TypeError(`section ${section} is not an array`);
		cases[section] = value.map((entry, i) => {
			if (entry === null || typeof entry !== "object") throw new TypeError(`${section}[${i}] is not an object`);
			const row: Record<string, unknown> = { ...entry };
			return { ...row, id: s(row.id), want: s(row.want) };
		});
	}
	return { version, cases };
}

const table = loadTable();

/**
 * The rows that are the REASON this table exists, by id.
 *
 * A total-count floor is not enough on its own: at 82 cases a floor of 60 lets twenty-two rows be
 * deleted with every layer still green — including the half-cent and hour-boundary rows, which are
 * the two that actually catch Go. So the cases carrying a known cross-language divergence are
 * named, and deleting one is a failure rather than a smaller number.
 */
const REQUIRED_IDS = [
	// JS rounds half away from zero; Go's %.0f rounds half to EVEN.
	"monthlyRate/estimate/HALF-CENT-ROUNDS-AWAY-FROM-ZERO",
	"monthlyRate/exact/HALF-CENT-ROUNDS-AWAY-FROM-ZERO",
	// Rounding happens once, BEFORE the hour test.
	"minutes/HALF-ROUNDS-UP-ACROSS-THE-HOUR-BOUNDARY",
	// The bug @repo/format was written to end, still live in the CLI.
	"minutes/the-0.943-bug",
	// The used side humanises; the allowance never does. And it keeps its separator.
	"quota/used-exceeds-allowance-is-not-clamped",
	"quota/ALLOWANCE-KEEPS-THOUSANDS-SEPARATOR",
	// Duration ROLLS into hours and drops the seconds. The disagreement with cmd/jobs_list.go is
	// settled the CLI's way, so what needs pinning is the boundary in both directions: one second
	// under the hour still reads in minutes, one hour exactly does not.
	"duration/TWO-HOURS-ROLLS-INTO-HOURS",
	"duration/JUST-UNDER-AN-HOUR-DOES-NOT-ROLL",
	"duration/EXACTLY-AN-HOUR",
	// hourCycle h23, not hour12:false.
	"date/MIDNIGHT-IS-00-NOT-24",
];

/** Per-section floors, so one section cannot be gutted while the total still clears. */
const SECTION_FLOOR: Record<string, number> = {
	minutes: 12,
	quota: 6,
	duration: 8,
	date: 10,
	bytes: 8,
	money: 6,
	monthlyRate: 15,
};

describe("format conformance table", () => {
	// ── Vacuity. A suite that ran nothing must not look like a suite that found nothing wrong.
	it("is not empty", () => {
		expect(Object.keys(table.cases).length).toBeGreaterThan(0);
		const total = Object.values(table.cases).reduce((acc, rows) => acc + rows.length, 0);
		expect(total).toBeGreaterThanOrEqual(60);
	});

	it("meets a floor in every section, not just in total", () => {
		for (const [section, floor] of Object.entries(SECTION_FLOOR)) {
			expect(table.cases[section]?.length ?? 0, `section ${section} fell below its floor`).toBeGreaterThanOrEqual(
				floor,
			);
		}
		// And the floors themselves cover every section, so adding a section without a floor is
		// not a silent exemption.
		expect(Object.keys(SECTION_FLOOR).sort()).toEqual(Object.keys(table.cases).sort());
	});

	it("still carries every case that exists because Go disagrees", () => {
		const ids = new Set(Object.values(table.cases).flatMap((rows) => rows.map((r) => r.id)));
		expect(REQUIRED_IDS.filter((id) => !ids.has(id))).toEqual([]);
	});

	it("has a driver for every section, and a section for every driver", () => {
		expect(Object.keys(table.cases).sort()).toEqual(Object.keys(DRIVERS).sort());
	});

	it("covers every formatter @repo/format exports, or excludes it with a reason", () => {
		const exported = Object.entries(fmt)
			.filter(([name, v]) => typeof v === "function" && name.startsWith("format"))
			.map(([name]) => name)
			.sort();
		const driven = Object.values(DRIVERS).map((d) => d.fn);
		const accountedFor = new Set([...driven, ...Object.keys(EXCLUDED)]);
		expect(exported.filter((name) => !accountedFor.has(name))).toEqual([]);

		// And the reasons are sentences somebody can disagree with, not "n/a".
		for (const [name, reason] of Object.entries(EXCLUDED)) {
			expect(reason.length, `${name}'s exclusion reason is too short to be a reason`).toBeGreaterThan(40);
		}
	});

	it("has no section with zero cases", () => {
		for (const [section, rows] of Object.entries(table.cases)) {
			expect(rows.length, `section ${section} is present but empty`).toBeGreaterThan(0);
		}
	});

	it("has unique, semantic ids", () => {
		const ids = Object.values(table.cases).flatMap((rows) => rows.map((r) => r.id));
		expect(new Set(ids).size, "duplicate case ids").toBe(ids.length);
		for (const id of ids) expect(id, `${id} is not a section/name id`).toMatch(SEMANTIC_ID);
	});

	// The rule above is only worth as much as its regex, and the first version of that regex
	// ACCEPTED `minutes/3` — the exact example the comment beside it offered as the thing to
	// reject. So the regex is tested in both directions, here, rather than trusted.
	it("its own id rule rejects an index-shaped id", () => {
		for (const good of ["minutes/the-0.943-bug", "monthlyRate/estimate/JPY-HAS-NO-MINOR-UNIT", "date/plain"]) {
			expect(good, `${good} should be a valid id`).toMatch(SEMANTIC_ID);
		}
		for (const bad of ["minutes/3", "minutes/0", "minutes/1.2", "minutes/", "minutes", "3/minutes"]) {
			expect(bad, `${bad} should NOT be a valid id`).not.toMatch(SEMANTIC_ID);
		}
	});

	// ── The contract itself.
	for (const [section, driver] of Object.entries(DRIVERS)) {
		describe(section, () => {
			const rows = table.cases[section] ?? [];
			for (const row of rows) {
				it(row.id, () => {
					expect(driver.run(row)).toBe(row.want);
				});
			}
		});
	}
});
