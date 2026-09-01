// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Generates `packages/format/conformance/format-cases.json` by running the REAL `@repo/format`
 * implementation over the hand-curated inputs in `conformance/cases.ts`.
 *
 * The file it writes is the contract that `packages/core/format` (Go) is held to. Go cannot
 * write it, so Go has no way to make itself right: a Go-only change reds the Go table test, a
 * TS-only change reds the CI diff-gate here, and neither side can drift alone.
 *
 * Usage:
 *   node scripts/gen-conformance.ts            # check — non-zero if the committed file is stale
 *   node scripts/gen-conformance.ts --write     # regenerate
 *
 * ⚠️  REGENERATING REWRITES AN EXPECTATION, NOT A FORMATTING DETAIL.
 * `--write` is exactly what somebody runs when the Go test is red, and doing so makes the Go
 * test pass against a table describing a TS change nobody reviewed. Three things exist to stop
 * that being invisible: ids are semantic so a diff names the boundary that moved, this script
 * prints a changed-case summary, and `packages/format/conformance/**` is CODEOWNED.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as fmt from "../src/index.ts";
import { BYTES, DATE, DURATION, EXCLUDED, MINUTES, MONEY, MONTHLY_RATE, QUOTA } from "../conformance/cases.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../conformance/format-cases.json");
const REL = "packages/format/conformance/format-cases.json";

/** The table's schema version. Bump only for a shape change, never for a value change. */
const VERSION = 1;

/** `null` in a case file means "not a finite number" — the branch every formatter clamps. */
const num = (v: number | null): number => (v === null ? Number.NaN : v);

/**
 * Build the table. Each entry keeps its inputs beside its output so the Go test needs no
 * knowledge of this file's ordering, and a reviewer can read a row without cross-referencing.
 */
function build() {
	return {
		minutes: MINUTES.map((c) => ({ id: c.id, in: c.in, want: fmt.formatMinutes(num(c.in)) })),
		quota: QUOTA.map((c) => ({
			id: c.id,
			used: c.used,
			included: c.included,
			want: fmt.formatQuota(c.used, c.included),
		})),
		duration: DURATION.map((c) => ({ id: c.id, in: c.in, want: fmt.formatDuration(num(c.in)) })),
		date: DATE.map((c) => ({
			id: c.id,
			value: c.value,
			style: c.style,
			timeZone: c.timeZone,
			want: fmt.formatDate(c.value, c.style, c.timeZone),
		})),
		bytes: BYTES.map((c) => ({ id: c.id, in: c.in, want: fmt.formatBytes(num(c.in)) })),
		money: MONEY.map((c) => ({
			id: c.id,
			cents: c.cents,
			currency: c.currency,
			want: fmt.formatMoney(c.cents, c.currency),
		})),
		monthlyRate: MONTHLY_RATE.map((c) => ({
			id: c.id,
			amount: c.amount,
			style: c.style,
			currency: c.currency,
			want: fmt.formatMonthlyRate(c.amount, c.style, c.currency),
		})),
	};
}

/**
 * Every `format*` export must be either covered by the table or named in EXCLUDED with a
 * reason. Without this, adding a formatter and forgetting the table is silent — and the Go
 * side's vacuity check cannot see it, because Go would simply never know the function exists.
 */
function assertCoverage(cases: Record<string, unknown[]>): void {
	const exported = Object.entries(fmt)
		.filter(([name, v]) => typeof v === "function" && name.startsWith("format"))
		.map(([name]) => name);

	// `formatMinutes` -> `minutes`
	const keyFor = (name: string) => name.slice("format".length, "format".length + 1).toLowerCase() + name.slice("format".length + 1);

	const uncovered = exported.filter((name) => !(keyFor(name) in cases) && !(name in EXCLUDED));
	if (uncovered.length > 0) {
		console.error(
			`FAIL: ${uncovered.length} exported formatter(s) are neither in the table nor in EXCLUDED:\n` +
				uncovered.map((n) => `  - ${n}`).join("\n") +
				`\n\nAdd cases in conformance/cases.ts, or add an EXCLUDED entry saying why the two ` +
				`surfaces are allowed to differ. "n/a" is indistinguishable from an oversight.`,
		);
		process.exit(1);
	}

	// Vacuity: a section that exists but is empty is worse than one that is absent, because it
	// reads as covered. "Ran 0 cases" and "passed" must not share an exit code.
	const empty = Object.entries(cases).filter(([, v]) => v.length === 0);
	if (empty.length > 0) {
		console.error(`FAIL: ${empty.map(([k]) => k).join(", ")} — section(s) present but with zero cases`);
		process.exit(1);
	}

	const stale = Object.keys(EXCLUDED).filter((name) => !exported.includes(name));
	if (stale.length > 0) {
		console.error(
			`FAIL: EXCLUDED names ${stale.join(", ")}, which @repo/format no longer exports. ` +
				`Remove the entry — a stale exclusion is a reason nobody can check.`,
		);
		process.exit(1);
	}
}

/**
 * Index a previously-generated file as `section/id -> want`, narrowing from `unknown` without a
 * cast (CLAUDE.md §6). A malformed or absent previous file yields an empty index, which makes
 * every case read as "new" rather than "changed" — the honest answer when there is nothing to
 * compare against.
 */
function previousWants(before: unknown): Map<string, string> {
	const index = new Map<string, string>();
	if (before === null || typeof before !== "object") return index;
	const doc: Record<string, unknown> = { ...before };
	if (doc.cases === null || typeof doc.cases !== "object") return index;
	for (const [section, rows] of Object.entries({ ...doc.cases })) {
		if (!Array.isArray(rows)) continue;
		for (const row of rows) {
			if (row === null || typeof row !== "object") continue;
			const entry: Record<string, unknown> = { ...row };
			if (typeof entry.id === "string" && typeof entry.want === "string") {
				index.set(`${section}/${entry.id}`, entry.want);
			}
		}
	}
	return index;
}

/** Cases whose `want` moved between the committed table and this run, by id. */
function changedIds(before: unknown, after: Record<string, { id: string; want: string }[]>): string[] {
	const prev = previousWants(before);
	const changed: string[] = [];
	for (const [section, rows] of Object.entries(after)) {
		for (const r of rows) {
			const was = prev.get(`${section}/${r.id}`);
			if (was !== undefined && was !== r.want) changed.push(`${r.id}: ${was} -> ${r.want}`);
		}
	}
	return changed;
}

function main(): void {
	const write = process.argv.includes("--write");
	const cases = build();
	assertCoverage(cases);

	const total = Object.values(cases).reduce((n, rows) => n + rows.length, 0);
	const doc = {
		_doc:
			`GENERATED by packages/format/scripts/gen-conformance.ts from packages/format/src/index.ts. ` +
			`DO NOT EDIT. Regenerate: pnpm -F @repo/format gen:conformance. Consumed by ` +
			`packages/format/tests/conformance.test.ts and packages/core/format/conformance_test.go. ` +
			`Regenerating rewrites an EXPECTATION — read the diff, do not skim it.`,
		version: VERSION,
		excluded: EXCLUDED,
		cases,
	};
	// Two-space JSON with a trailing newline: one line per field, so a diff is reviewable.
	const next = `${JSON.stringify(doc, null, 2)}\n`;

	let current: string | null = null;
	try {
		current = readFileSync(OUT, "utf8");
	} catch {
		current = null;
	}

	const sections = Object.keys(cases).length;
	if (current === next) {
		console.log(`conformance: ${total} cases across ${sections} functions — up to date`);
		return;
	}

	let parsedCurrent: unknown = null;
	if (current !== null) {
		try {
			parsedCurrent = JSON.parse(current);
		} catch {
			parsedCurrent = null;
		}
	}
	const changed = changedIds(parsedCurrent, cases);

	if (!write) {
		console.error(
			`FAIL: ${REL} is stale — the implementation and the committed table disagree.\n` +
				`Regenerate with:  pnpm -F @repo/format gen:conformance`,
		);
		if (changed.length > 0) {
			console.error(`\n${changed.length} expectation(s) would change:`);
			changed.forEach((c) => console.error(`  ${c}`));
		}
		process.exit(1);
	}

	writeFileSync(OUT, next, "utf8");
	console.log(`conformance: ${total} cases across ${sections} functions; ${changed.length} changed`);
	if (changed.length > 0) {
		console.log("\nEXPECTATIONS CHANGED — each of these is a user-visible output moving:");
		changed.forEach((c) => console.log(`  ${c}`));
	}
	console.log(`\nwrote ${REL}`);
}

main();
