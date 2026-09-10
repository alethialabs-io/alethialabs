#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// MUTATION-TEST check-upload-aggregate.mjs: revert each fix, one at a time, and require the
// self-test to go RED and name the case that fix exists for.
//
// WHY THIS IS A COMMITTED FILE AND NOT A SCRATCH SCRIPT. A guard shipped alongside its own fix
// passes trivially and proves nothing, so the only evidence that its self-test is testing anything
// is that the test FAILS when the implementation is broken. That evidence has to be re-runnable by
// the next person, or it is a claim in a PR description that decays the moment the file is edited.
//
// AND WHY EVERY MUTATION ASSERTS THAT IT APPLIED. A mutation whose anchor no longer matches leaves
// the file untouched and produces a PASSING run — indistinguishable from "this case is not
// load-bearing", and identical in shape to the defect the guard itself is about. The first harness
// written for this was bash + perl and reported four cases as not load-bearing when in fact its own
// escaping had failed to apply the edit. So: literal string anchors, each required to match exactly
// once, and a non-zero exit if any of that is untrue.
//
// AND WHY "RED" IS NOT ENOUGH ON ITS OWN. A mutation that makes the self-test THROW is red without
// having been caught: the assertions after the crash never ran, and a mutation that fails its own
// case and then throws prints a plausible-looking couple of FAIL lines while a hundred others went
// unevaluated. `selfTest` therefore requires the self-test's own summary line — printed only on the
// orderly failure path — and requires its count to agree with the FAIL lines seen. Without that,
// exit 0 on a partial run is the harness telling you it verified something it did not.
//
//   node scripts/ci/check-upload-aggregate.mutations.mjs
//
// NOT wired into CI: it rewrites the guard's source in place (restoring after each case), which is
// safe to run alone and unsafe to run beside anything else reading that file.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(HERE, "check-upload-aggregate.mjs");

/**
 * Each entry reverts ONE fix to the shape it had before, and names the self-test case that must
 * then fail. `expect` is matched against the failing assertion names.
 */
const MUTATIONS = [
	{
		name: "M1  `uses:` read from its own written line (E5, P3)",
		from: "if (!UPLOAD.test(usesVal.value.trim())) continue;",
		to: 'if (!UPLOAD.test(usesAt.text.replace(/^uses:\\s*/, "").trim())) continue;',
		expect: /E5|P3/,
	},
	{
		name: "M2  `- ` assumed after the sequence dash (E4)",
		from: "lines[j].slice(childCol)",
		to: "lines[j].slice(indent + 2)",
		expect: /E4/,
	},
	// Both M3 cases keep the regex's FOUR capture groups. A replacement with a different group
	// count makes `scanUploads` throw, and a self-test that dies is red for the wrong reason — the
	// harness reports that separately, which is how this was caught.
	{
		name: "M3  `with:` children pinned to two columns (E3)",
		from: 'const m = t.match(/^\\s+(?:"([A-Za-z0-9_-]+)"|\'([A-Za-z0-9_-]+)\'|([A-Za-z0-9_-]+)):\\s*(.*)$/);',
		to: 'const m = t.match(/^ {2}(?:"([A-Za-z0-9_-]+)"|\'([A-Za-z0-9_-]+)\'|([A-Za-z0-9_-]+)):\\s*(.*)$/);',
		expect: /E3/,
	},
	{
		name: "M3b a quoted `with:` key not read (N2)",
		from: 'const m = t.match(/^\\s+(?:"([A-Za-z0-9_-]+)"|\'([A-Za-z0-9_-]+)\'|([A-Za-z0-9_-]+)):\\s*(.*)$/);',
		to: "const m = t.match(/^\\s+([A-Za-z0-9_-]+)()():\\s*(.*)$/);",
		expect: /N2/,
	},
	{
		name: "M4  a quoted `path:` scalar taken as one entry (E1, E2)",
		from: "\tif (quoted) {",
		to: "\tif (false) {",
		expect: /E1|E2/,
	},
	{
		name: "M5  a folded block trimmed line-by-line (N1 — the narrowing regression)",
		from: "\t\treturn { value: foldBlock(contRaw, digit === null ? null : keyCol + Number(digit[1])), kind: \"folded\", readable: true };",
		to: '\t\treturn { value: fold(cont), kind: "folded", readable: true };',
		expect: /N1/,
	},
	{
		name: "M6  `if-no-files-found:` read from its own line only (E6)",
		from: "const inff = inffKey === undefined ? undefined : resolveValue(lines, inffKey.raw, inffKey.inline);",
		to: "const inff = inffKey === undefined ? undefined : { value: inffKey.inline, kind: \"raw\", readable: true };",
		expect: /E6/,
	},
	{
		name: "M7  a `#` line inside `path: |` counted as a pattern (P1)",
		from: 'const patterns = entries.filter((e) => !e.startsWith("#"));',
		to: "const patterns = entries;",
		expect: /P1/,
	},
	{
		name: "M8  a trailing comment left on a plain scalar (P2)",
		from: 'const stripComment = (s) => s.replace(/(?:^|\\s)#.*$/, "").trimEnd();',
		to: "const stripComment = (s) => s;",
		expect: /P2/,
	},
	{
		name: "M9  an unmodelled escape identity-mapped (P4)",
		from: "if (!(c in SIMPLE)) return { value: out, ok: false };",
		to: "if (!(c in SIMPLE)) { out += c; continue; }",
		expect: /P4|escape/,
	},
	{
		name: "M10 `jobs:` refusing a trailing comment (P5)",
		from: "const jobsAt = lines.findIndex((l) => /^jobs:\\s*(#.*)?$/.test(l));",
		to: "const jobsAt = lines.findIndex((l) => /^jobs:\\s*$/.test(l));",
		expect: /P5/,
	},
	{
		name: "M11 CRLF left in place (P6)",
		from: 'const lines = text.split("\\n").map((l) => l.replace(/\\r$/, ""));',
		to: 'const lines = text.split("\\n");',
		expect: /P6/,
	},
	{
		name: "M13 a folded block's DECLARED indentation discarded (F1)",
		from: "return { value: foldBlock(contRaw, digit === null ? null : keyCol + Number(digit[1])), kind: \"folded\", readable: true };",
		to: 'return { value: foldBlock(contRaw, null), kind: "folded", readable: true };',
		expect: /F1/,
	},
	{
		name: "M14 a bare `-` requiring content after it (F2)",
		from: "const bare = lines[i].match(/^(\\s+)-\\s*(#.*)?$/);",
		to: "const bare = null;",
		expect: /F2/,
	},
	{
		name: "M16 a quoted scalar below its key read as plain (F3)",
		from: "\t\tif (first.startsWith(\"'\") || first.startsWith('\"')) {",
		to: "\t\tif (false) {",
		expect: /F3/,
	},
	{
		name: "M17 the `steps` owner rule removed (F7)",
		from: 'if (owner !== "steps") continue;',
		to: "if (false) continue;",
		expect: /F7/,
	},
	{
		name: "M12 the rule itself — stop reporting entirely",
		from: 'if (inffValue !== "error" || includes.length < 2) continue;',
		to: "if (true) continue;",
		expect: /caught|reported|refused/i,
	},
];

const ORIGINAL = fs.readFileSync(GUARD, "utf8");
let bad = 0;

/**
 * Run the self-test and read its result — including whether it RAN TO THE END.
 *
 * A self-test that THREW is not a self-test that failed. If the throw happens before any `FAIL`
 * line, `fails` is empty and that is visible; but a mutation that fails its own case and THEN
 * throws prints a couple of `FAIL` lines, dies before the remaining hundred assertions run, and is
 * indistinguishable from a clean load-bearing catch. So the self-test's own summary line is the
 * evidence: it is printed only on the orderly failure path, and it states the count, which must
 * agree with the lines seen. That is what makes "RED" mean "red for the reason claimed".
 *
 * @returns {{rc: number, fails: string[], orderly: boolean, why: string}}
 */
function selfTest() {
	let text;
	let rc = 0;
	try {
		text = execFileSync(process.execPath, [GUARD, "--self-test"], { encoding: "utf8" });
	} catch (e) {
		rc = e.status ?? 1;
		text = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
	}
	const fails = text.split("\n").filter((l) => l.startsWith("FAIL")).map((l) => l.replace(/ \{.*$/, "").replace(/^FAIL - /, ""));
	if (rc === 0) return { rc, fails, orderly: true, why: "" };
	const summary = /check-upload-aggregate self-test: (\d+) failure\(s\)/.exec(text);
	if (summary === null) {
		return { rc, fails, orderly: false, why: `the self-test DIED instead of failing — it never printed its summary line, so ${fails.length} FAIL line(s) is a floor, not a count` };
	}
	if (Number(summary[1]) !== fails.length) {
		return { rc, fails, orderly: false, why: `the self-test reported ${summary[1]} failure(s) but ${fails.length} were printed` };
	}
	return { rc, fails, orderly: true, why: "" };
}

const control = selfTest();
if (control.rc !== 0) {
	console.error("the UNMUTATED self-test is already failing — fix that before reading anything below.");
	process.exit(1);
}
console.log("control: self-test GREEN\n");

for (const m of MUTATIONS) {
	const hits = ORIGINAL.split(m.from).length - 1;
	if (hits !== 1) {
		console.error(`!! ${m.name}\n   ANCHOR MATCHED ${hits} TIME(S), not 1 — the mutation was NOT applied, and a run that passes now means nothing. Fix the anchor.`);
		bad += 1;
		continue;
	}
	fs.writeFileSync(GUARD, ORIGINAL.replace(m.from, m.to));
	const { rc, fails, orderly, why } = selfTest();
	fs.writeFileSync(GUARD, ORIGINAL);
	if (rc === 0) {
		console.error(`!! ${m.name}\n   SELF-TEST STILL PASSED — this fix is not load-bearing, or nothing tests it.`);
		bad += 1;
		continue;
	}
	if (!orderly) {
		console.error(`!! ${m.name}\n   RED FOR THE WRONG REASON: ${why}. A mutation must make assertions FAIL, not make the run crash — otherwise the assertions after the crash were never evaluated and this proves nothing about them. Rewrite the mutation so the code still runs.`);
		bad += 1;
		continue;
	}
	const named = fails.some((f) => m.expect.test(f));
	console.log(`== ${m.name}\n   RED, ${fails.length} assertion(s)${named ? "" : "  ⚠ but NOT the one this fix exists for"}`);
	for (const f of fails.slice(0, 3)) console.log(`      ${f}`);
	if (fails.length > 3) console.log(`      … and ${fails.length - 3} more`);
	if (!named) bad += 1;
}

const after = selfTest();
console.log(`\nrestored: self-test ${after.rc === 0 ? "GREEN" : "RED — THE RESTORE FAILED"}`);
if (after.rc !== 0) bad += 1;
if (bad > 0) {
	console.error(`\n${bad} mutation(s) did not behave as a load-bearing fix should.`);
	process.exit(1);
}
console.log(`\nall ${MUTATIONS.length} mutations turned the self-test red and named their own case.`);
