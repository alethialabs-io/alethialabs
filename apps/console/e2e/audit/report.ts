// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// One verdict record per (route, predicate), written to `test-results/ui-audit.json`.
//
// The scoreboard generator does not exist yet (`apps/console/docs/ui-conformance/RUBRIC.md` says
// so, in the future tense, on purpose). This file is the shape it will read, and it enforces the
// rubric's N/A rules at the point a verdict is recorded rather than at the point one is reported:
//
//   · every N/A carries a machine-readable reason from the predicate's DECLARED set — a reason
//     outside that set is an ERROR, not an N/A;
//   · N/A is counted per predicate as a first-class number, because a predicate whose N/A count
//     grows is a predicate being escaped, and the rubric's whole warning is that escaping one makes
//     a page's score go UP with nothing red anywhere.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type Verdict = "PASS" | "FAIL" | "N/A";

/**
 * The live predicates this project owns, and the N/A reasons each one may use.
 *
 * Copied from the rubric's own per-predicate "N/A when" column, EXACTLY — including the three that
 * declare no reason at all. R5, R6 and R7 are "never N/A" there, and that is honoured even for the
 * four redirect-only routes: hitting one of those URLs is a navigation a person really makes, so
 * the console errors it produces, the responses it fires and the time it takes to land are all real
 * and all measurable. What is NOT measurable on them is geometry (R1/R3/R4) and the states
 * (T5/T6/T7), and each of those declares its own reason below.
 *
 * A reason that is not in a predicate's list is an ERROR, not an N/A — `record()` enforces it.
 */
export const NA_REASONS = {
	R1: ["redirect-only"],
	R2: ["opens-no-overlay"],
	R3: ["redirect-only"],
	R4: ["redirect-only"],
	R5: [],
	R6: [],
	R7: [],
	T5: ["no-empty-state"],
	T6: ["redirect-only"],
	T7: ["no-restricted-surface"],
} as const;

export type PredicateId = keyof typeof NA_REASONS;

export interface VerdictRecord {
	route: string;
	url: string;
	predicate: PredicateId;
	verdict: Verdict;
	/** Required for N/A, forbidden otherwise. */
	reason?: string;
	/** Whatever the measurement saw — the diagnostic a reader acts on. */
	evidence?: unknown;
}

const records: VerdictRecord[] = [];

/**
 * Record one verdict.
 *
 * Raises on an N/A with no reason, on an N/A whose reason the predicate has not declared, and on a
 * PASS/FAIL carrying one — the three ways the rubric says a rubric goes wrong.
 */
export function record(entry: VerdictRecord): VerdictRecord {
	const allowed: readonly string[] = NA_REASONS[entry.predicate];
	if (entry.verdict === "N/A") {
		if (!entry.reason) {
			throw new Error(`${entry.predicate} on ${entry.route}: an N/A with no reason is not an N/A.`);
		}
		if (!allowed.includes(entry.reason)) {
			const declared = allowed.length ? allowed.join(", ") : "none — this predicate is never N/A";
			throw new Error(
				`${entry.predicate} on ${entry.route}: "${entry.reason}" is not a declared N/A reason for ` +
					`${entry.predicate} (declared: ${declared}). Change the rubric, or the verdict — not the reason.`,
			);
		}
	} else if (entry.reason) {
		throw new Error(`${entry.predicate} on ${entry.route}: a ${entry.verdict} must not carry an N/A reason.`);
	}
	records.push(entry);
	return entry;
}

export function allRecords(): readonly VerdictRecord[] {
	return records;
}

/** PASS ÷ (PASS + FAIL) per predicate, plus the N/A count the rubric wants as its own column. */
export function summarise(
	over: readonly VerdictRecord[] = records,
): Record<string, { pass: number; fail: number; na: number; score: number | null }> {
	const out: Record<string, { pass: number; fail: number; na: number; score: number | null }> = {};
	for (const r of over) {
		const row = (out[r.predicate] ??= { pass: 0, fail: 0, na: 0, score: null });
		if (r.verdict === "PASS") row.pass++;
		else if (r.verdict === "FAIL") row.fail++;
		else row.na++;
	}
	for (const row of Object.values(out)) {
		const denom = row.pass + row.fail;
		row.score = denom === 0 ? null : row.pass / denom;
	}
	return out;
}

/**
 * Write the run's records where a scoreboard generator (and a CI artifact) can read them.
 *
 * MERGES with what is already there when `runKey` matches. Playwright discards a worker after a
 * test times out and starts the next test in a fresh one, and each worker holds its own copy of
 * this module — so a plain overwrite would hand the reader the LAST worker's records and silently
 * drop everything measured before the restart. The key is the run's org slug (a new org per run),
 * so a file left over from a previous run is replaced rather than merged into.
 */
export function writeReport(
	runKey: string,
	filename = "ui-audit.json",
	outDir: string = path.join(process.cwd(), "test-results"),
): string {
	mkdirSync(outDir, { recursive: true });
	const file = path.join(outDir, filename);
	let carried: VerdictRecord[] = [];
	if (existsSync(file)) {
		const prior: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (
			typeof prior === "object" &&
			prior !== null &&
			"runKey" in prior &&
			prior.runKey === runKey &&
			"records" in prior &&
			Array.isArray(prior.records)
		) {
			carried = prior.records;
		}
	}
	// This worker's verdict wins for a (route, predicate) it measured; anything it did not measure
	// is carried forward from the worker that did.
	const merged = new Map<string, VerdictRecord>();
	for (const r of [...carried, ...records]) merged.set(`${r.route}\u0000${r.predicate}`, r);
	const all = [...merged.values()];
	writeFileSync(
		file,
		`${JSON.stringify(
			{ runKey, generatedAt: new Date().toISOString(), summary: summarise(all), records: all },
			null,
			2,
		)}\n`,
	);
	return file;
}
