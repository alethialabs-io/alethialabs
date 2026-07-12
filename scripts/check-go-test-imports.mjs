// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Go-side anti-"bullshit-test" guard — the parity partner of scripts/check-test-imports.mjs
// (which only scans TypeScript). The elench verify engine (packages/core/verify) and the runner
// (apps/runner) are the fail-closed security path; a vacuous Go test there (a `_test.go` that only
// `t.Skip`s, or asserts nothing, or lives with no package to exercise) is exactly the golden-theater
// this corpus work exists to prevent. So, for every `*_test.go` under the scanned roots:
//
//   1. If it declares a test entry point (Test*/Benchmark*/Fuzz*), it MUST contain a real assertion
//      — a `t.Error*`/`t.Fatal*`/`t.Fail*`, a testify `require.`/`assert.`, or a `b.Fatal`/`f.Fatal`.
//      A test that can never fail (only t.Skip/t.Log/empty body) is flagged.
//   2. It MUST sit beside real source: its directory contains at least one non-`_test.go` `.go` file
//      (the package under test). A test with no package to exercise cannot be testing real code.
//
// Mutation testing + the labeled corpus + the mutation gate are the deep checks; this is the cheap,
// instant tripwire that runs in the CI `guards` job. Usage: node scripts/check-go-test-imports.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOTS = ["packages/core/verify", "apps/runner"];

/** Recursively collect *_test.go files under a dir. */
function goTestFiles(dir) {
	let out = [];
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const name of entries) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out = out.concat(goTestFiles(p));
		else if (/_test\.go$/.test(name)) out.push(p);
	}
	return out;
}

/** True if the directory holds at least one non-test .go source file (the package under test). */
function hasSourceSibling(dir) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return false;
	}
	return entries.some((n) => /\.go$/.test(n) && !/_test\.go$/.test(n));
}

// A file declares a test entry point.
const TEST_FUNC_RE = /func\s+(Test|Benchmark|Fuzz|Example)[A-Z_0-9]/;
// A file contains a real, failing assertion (the thing that makes a test able to fail).
const ASSERT_RE =
	/\b[tbf]\.(Error|Errorf|Fatal|Fatalf|Fail|FailNow)\b|\b(require|assert)\.[A-Z]/;

const offenders = [];
for (const root of ROOTS) {
	for (const file of goTestFiles(root)) {
		const src = readFileSync(file, "utf8");
		if (!hasSourceSibling(dirname(file))) {
			offenders.push([file, "no non-test .go source in its package (nothing real to exercise)"]);
			continue;
		}
		if (TEST_FUNC_RE.test(src) && !ASSERT_RE.test(src)) {
			offenders.push([file, "declares a test but contains no assertion (t.Error*/t.Fatal*/require/assert) — it can never fail"]);
		}
	}
}

if (offenders.length > 0) {
	console.error(`✗ ${offenders.length} Go test file(s) look vacuous:`);
	for (const [f, why] of offenders) console.error(`   ${f} — ${why}`);
	console.error(
		"\nA real Go test must live beside the package it tests and contain at least one assertion that can fail.",
	);
	process.exit(1);
}

console.log("✓ check-go-test-imports: every Go test file exercises a real package and can fail.");
