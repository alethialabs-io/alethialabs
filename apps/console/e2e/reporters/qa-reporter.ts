// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Custom Playwright reporter that rolls up the per-test qa-perf + qa-console-errors attachments (set
// by e2e/fixtures/qa.ts) into a single test-results/qa-report.json — the machine-readable feed for the
// performance + findings docs. Also prints a compact latency + error summary at the end of a run.

import type { FullConfig, FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import fs from "node:fs";
import path from "node:path";
import type { PerfRecord } from "../helpers/perf";
import type { CapturedError } from "../helpers/console-errors";

interface TestEntry {
	title: string;
	file: string;
	status: string;
	durationMs: number;
	perf: PerfRecord[];
	consoleErrors: (CapturedError & { persona?: string })[];
	errorMessage?: string;
}

function readAttachment<T>(result: TestResult, name: string): T | null {
	const att = result.attachments.find((a) => a.name === name);
	if (!att) return null;
	try {
		const raw = att.body ? att.body.toString("utf8") : att.path ? fs.readFileSync(att.path, "utf8") : "";
		return raw ? (JSON.parse(raw) as T) : null;
	} catch {
		return null;
	}
}

/** percentile of a numeric array (0..100). */
function pct(values: number[], p: number): number {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[idx];
}

export default class QaReporter implements Reporter {
	private entries: TestEntry[] = [];
	private outDir = "test-results";

	onBegin(config: FullConfig): void {
		this.outDir = config.rootDir ? path.join(config.rootDir, "test-results") : "test-results";
	}

	onTestEnd(test: TestCase, result: TestResult): void {
		const perf = readAttachment<PerfRecord[]>(result, "qa-perf") ?? [];
		const consoleErrors = readAttachment<(CapturedError & { persona?: string })[]>(result, "qa-console-errors") ?? [];
		this.entries.push({
			title: test.titlePath().slice(1).join(" › "),
			file: path.relative(process.cwd(), test.location.file),
			status: result.status,
			durationMs: result.duration,
			perf,
			consoleErrors,
			errorMessage: result.error?.message,
		});
	}

	onEnd(result: FullResult): void {
		// Aggregate latency by normalized path+kind across every test.
		const byPath = new Map<string, number[]>();
		for (const e of this.entries) {
			for (const r of e.perf) {
				if (r.durationMs < 0) continue;
				const key = `${r.kind} ${r.method} ${r.path}`;
				const arr = byPath.get(key) ?? [];
				arr.push(r.durationMs);
				byPath.set(key, arr);
			}
		}
		const latency = [...byPath.entries()]
			.map(([key, vals]) => ({
				key,
				count: vals.length,
				p50: pct(vals, 50),
				p95: pct(vals, 95),
				max: Math.max(...vals),
			}))
			.sort((a, b) => b.p95 - a.p95);

		const allErrors = this.entries.flatMap((e) =>
			e.consoleErrors.map((c) => ({ test: e.title, file: e.file, ...c })),
		);

		const report = {
			generatedAt: new Date().toISOString(),
			status: result.status,
			totals: {
				tests: this.entries.length,
				passed: this.entries.filter((e) => e.status === "passed").length,
				failed: this.entries.filter((e) => e.status === "failed" || e.status === "timedOut").length,
				skipped: this.entries.filter((e) => e.status === "skipped").length,
			},
			latency,
			consoleErrors: allErrors,
			tests: this.entries.map((e) => ({
				title: e.title,
				file: e.file,
				status: e.status,
				durationMs: e.durationMs,
				errorMessage: e.errorMessage,
				requestCount: e.perf.length,
				consoleErrorCount: e.consoleErrors.length,
			})),
		};

		fs.mkdirSync(this.outDir, { recursive: true });
		const outPath = path.join(this.outDir, "qa-report.json");
		fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

		// Console summary — the slowest 10 endpoints + error count.
		console.log(`\n[qa-reporter] ${report.totals.passed} passed, ${report.totals.failed} failed, ${report.totals.skipped} skipped`);
		console.log(`[qa-reporter] wrote ${outPath}`);
		if (latency.length) {
			console.log("[qa-reporter] slowest endpoints (p95 ms):");
			for (const l of latency.slice(0, 10)) {
				console.log(`  ${String(l.p95).padStart(6)}  p50=${String(l.p50).padStart(5)}  n=${String(l.count).padStart(3)}  ${l.key}`);
			}
		}
		if (allErrors.length) console.log(`[qa-reporter] ${allErrors.length} console/network errors captured (see qa-report.json)`);
	}
}
