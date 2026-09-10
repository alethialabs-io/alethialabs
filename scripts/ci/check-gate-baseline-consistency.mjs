#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// THE RELEASE GATE'S LEDGER-CONSISTENCY HALF, ASKED OF THE TREE ALONE — no browser, no Postgres,
// no console. It answers exactly one question: does apps/console/e2e/gate-baseline.json name tests
// the spec files no longer contain?
//
//   node scripts/ci/check-gate-baseline-consistency.mjs
//   node scripts/ci/check-gate-baseline-consistency.mjs --list-json=<playwright --list json>
//   node scripts/ci/check-gate-baseline-consistency.mjs --self-test
//
// ── WHY IT EXISTS (#4460) ────────────────────────────────────────────────────────────────────
//
// A `wave:release-gate` lane rewrites a spec file, then regenerates its slice of the ledger with
// `--write --only=<file>` FROM THE GATE RUN'S OWN RESULTS. That ordering is unavoidable — the
// ledger is a recording of a real run — and it is a race the lane cannot win:
//
//   · draft   ⇒ release-gate.yml's `legs` job requires `draft == false`, so no leg runs at all,
//               and there is nothing to regenerate a slice FROM;
//   · non-draft ⇒ Mergify auto-queues it, and the `Release gate (…)` contexts are NOT in the dev
//               queue conditions (correctly — running Playwright on every dev PR is what #4440
//               exists to avoid). The `qa` leg takes ~34 minutes; the queue does not wait.
//
// So the only instrument that can catch an unregenerated slice — the ratchet's rule 4 — is a check
// that does not gate the branch the slice lands on. It has happened twice, measured:
//
//   · #4433 (merged 2026-09-09 14:42Z) rewrote flows/alerts.spec.ts and flows/alerts.negative.spec.ts
//     and lost the race by about fifteen minutes. The next PRs inherited the red; #4465 was the
//     remediation, and it was urgent rather than unnecessary.
//   · #4324 (merged 2026-09-09 17:36Z) rewrote architecture-canvas.spec.ts the same way. Nothing
//     reported it at all — it is still unregenerated on `dev` as this lands (see RECORDED_STALE).
//
// This check runs in the `guards` job, which IS required on dev, so the next one fails in seconds
// on the PR that causes it.
//
// ── WHAT IT DOES NOT DO ──────────────────────────────────────────────────────────────────────
//
// One direction only. A test the tree HAS and the ledger does not name is not a finding here: the
// ratchet's rule 2 already requires a new test to pass, and it can only know that from a run. This
// asks the cheaper, sound half — the half whose answer the tree alone contains.
//
// It also does not run any test. `playwright test --list` loads the spec files and reports the
// (project, file, title) triples it would run; Playwright starts no `webServer` and no
// `globalSetup` for a listing.
//
// ── THE IDENTITY IS THE RATCHET'S, NOT A COPY ────────────────────────────────────────────────
//
// A ledger entry is keyed by (project, root-suite file, describe titles + test title joined with
// " › "). Compute that even slightly differently here — drop a describe level, use the absolute
// path — and this check finds a stale record under every test in the repo, or none. `--self-test`
// therefore asserts, on one shared fixture, that `listedTests()` derives exactly the same keys as
// `scripts/e2e-ratchet.mjs`'s `flattenResults()`. If either walk drifts, that assertion fails
// rather than this check quietly changing what it means.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { flattenResults } from "../e2e-ratchet.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BASELINE = "apps/console/e2e/gate-baseline.json";
const CONSOLE = "apps/console";

/**
 * The floor under the listing. A `--list` that silently collapses — a config that threw after
 * emitting a partial report, a filter nobody meant to pass — names every ledger entry as stale,
 * which is indistinguishable from a real mass rename and is the loud failure. The floor exists for
 * the QUIET one: a listing small enough to be obviously broken must be reported as a broken
 * instrument, not compared. The ledger holds 571 entries and the tree lists 578 tests today
 * (2026-09-10); anything under a third of that is not a tree anyone shipped.
 */
export const MIN_LISTED_TESTS = 200;

/**
 * Slices that are ALREADY unregenerated on `dev` when this check first lands, with the reason each
 * one cannot be fixed from a checkout.
 *
 * SHRINK-ONLY, AND CHECKED IN BOTH DIRECTIONS. An undeclared stale entry fails loudly — that is the
 * point of the check. An entry here that has OUTLIVED its subject fails too, and that is the
 * direction that would otherwise rot: once the slice is regenerated, this row would go on
 * suppressing a finding about a title nobody records any more, forever and silently.
 *
 * Every row must be repaired the same way, and it is not a repair this or any other checkout can
 * make — the replacement entries have to come from a real run:
 *
 *     gh workflow run "Release gate" --ref <branch> -f legs=canvas
 *     node scripts/e2e-ratchet.mjs --project=canvas --results=<results.json> \
 *          --write --only=architecture-canvas.spec.ts
 *
 * A dispatch is not a PR check, so it neither gates nor races the merge queue. #4465 is the worked
 * precedent for the alerts slice.
 *
 * @type {{project: string, file: string, title: string, why: string}[]}
 */
export const RECORDED_STALE = [
	{
		project: "canvas",
		file: "architecture-canvas.spec.ts",
		title: "Architecture canvas › the board draws the VPC and cluster regions",
		why: "#4324 (merged 2026-09-09 17:36Z) rewrote this spec against the post-wave board and did not regenerate the canvas slice — the same race #4460 records. Needs a `Release gate (canvas)` run; the next canvas lane to land (#4279, #4445) regenerates it, and this row is then deleted.",
	},
	{
		project: "canvas",
		file: "architecture-canvas.spec.ts",
		title: "Architecture canvas › a region is a real container — drag it and its members follow; resize it and they don't",
		why: "#4324, as above. Regions left the board with the canvas wave; the ledger still records the test that drove them.",
	},
	{
		project: "canvas",
		file: "architecture-canvas.spec.ts",
		title: "Architecture canvas › the cluster can be sized portably (vCPU / memory), not just by a cloud SKU",
		why: "#4324, as above. The sizing assertion moved into the service-card test; the ledger still records it under its old title.",
	},
];

// ── the tree's own (project, file, title) triples ─────────────────────────────────────────────

/**
 * Flatten a Playwright report — `--list --reporter=json` or a real run — into what each project
 * would run.
 *
 * The key derivation is `flattenResults`' derivation, deliberately: the root suite's `file` (which
 * the JSON reporter emits relative to the test dir, exactly as the ledger records it), then the
 * describe titles above the spec joined to its own title with " › ". The root suite's title is NOT
 * part of the key — it is the file, which is already the outer map's key.
 *
 * @param {unknown} report parsed Playwright JSON
 * @returns {Map<string, Map<string, Set<string>>>} project → file → titles
 */
export function listedTests(report) {
	if (typeof report !== "object" || report === null || !Array.isArray(report.suites)) {
		throw new Error("listing: not a Playwright JSON report (no `suites` array). Was `--reporter=json` in effect?");
	}
	/** @type {Map<string, Map<string, Set<string>>>} */
	const out = new Map();
	const walk = (suite, file, titles) => {
		for (const spec of suite.specs ?? []) {
			for (const t of spec.tests ?? []) {
				if (typeof t.projectName !== "string" || t.projectName === "") continue;
				const key = [...titles, spec.title].join(" › ");
				let byFile = out.get(t.projectName);
				if (byFile === undefined) out.set(t.projectName, (byFile = new Map()));
				let titleSet = byFile.get(file);
				if (titleSet === undefined) byFile.set(file, (titleSet = new Set()));
				titleSet.add(key);
			}
		}
		for (const child of suite.suites ?? []) walk(child, file, [...titles, child.title]);
	};
	for (const root of report.suites) walk(root, root.file ?? root.title, []);
	return out;
}

/** How many (project, file, title) triples a listing holds. */
export function countListed(listed) {
	let n = 0;
	for (const byFile of listed.values()) for (const titles of byFile.values()) n += titles.size;
	return n;
}

// ── the comparison ───────────────────────────────────────────────────────────────────────────

/**
 * @typedef {{project: string, file: string, title: string}} Entry
 * @typedef {{project: string, file: string, title: string, why: string}} Row a RECORDED_STALE row
 */

/**
 * Every ledger entry the listing does not contain, plus the projects that vanished wholesale.
 *
 * A project the listing does not know at all is reported ONCE, as itself, rather than as one line
 * per entry under it: a renamed or deleted Playwright project makes all 384 of its records
 * unreachable at a stroke, and 384 identical-looking lines would bury the one fact that explains
 * them. Its entries are then not re-reported.
 *
 * @param {unknown} baselineDoc parsed apps/console/e2e/gate-baseline.json
 * @param {Map<string, Map<string, Set<string>>>} listed
 * @returns {{stale: Entry[], missingProjects: {project: string, entries: number}[], baselineCount: number}}
 */
export function compare(baselineDoc, listed) {
	if (typeof baselineDoc !== "object" || baselineDoc === null || typeof baselineDoc.projects !== "object" || baselineDoc.projects === null) {
		throw new Error(`${BASELINE}: no \`projects\` object. A ledger that cannot be read must not report clean.`);
	}
	/** @type {Entry[]} */
	const stale = [];
	/** @type {{project: string, entries: number}[]} */
	const missingProjects = [];
	let baselineCount = 0;
	for (const [project, files] of Object.entries(baselineDoc.projects)) {
		const byFile = listed.get(project);
		let entries = 0;
		for (const tests of Object.values(files)) entries += Object.keys(tests).length;
		baselineCount += entries;
		if (byFile === undefined) {
			missingProjects.push({ project, entries });
			continue;
		}
		for (const [file, tests] of Object.entries(files)) {
			const titles = byFile.get(file);
			for (const title of Object.keys(tests)) {
				if (titles === undefined || !titles.has(title)) stale.push({ project, file, title });
			}
		}
	}
	return { stale, missingProjects, baselineCount };
}

/** A ledger row and a finding are the same thing when all three fields match. */
const idOf = (e) => JSON.stringify([e.project, e.file, e.title]);

/**
 * Split findings into the ones RECORDED_STALE covers and the ones it does not, and report every
 * recorded row that is no longer a finding.
 *
 * THE THIRD BUCKET IS THE POINT, and it exists because the two-bucket version gave the BACKWARDS
 * instruction. `compare` short-circuits a project the listing does not hold into `missingProjects`
 * and pushes NONE of its entries into `stale` — so "recorded but not in `stale`" quietly reclassified
 * every row under a vanished project as `dead`, whose remediation is "delete the row; an exception
 * that outlives its subject suppresses a real finding forever". The subject had not been outlived.
 * It had gone FURTHER out of reach: deleting `apps/console/e2e/architecture-canvas.spec.ts` leaves
 * the `canvas` project defined but collecting zero tests, so it drops out of the listing, and all
 * three canvas rows below would then have been reported with an instruction that performs exactly
 * the silent suppression their own docstring warns against. Measured on this branch before the fix:
 * four error lines, three of them telling the reader to delete rows about titles that were more
 * stale than when they were written, not less.
 *
 * So a row whose project is absent from the LISTING is `suspended`: not a finding of its own, and
 * never an instruction to delete. The project's own error is the finding, and it is already red.
 *
 * `missingProjects` is REQUIRED rather than defaulted. A caller that forgot it would get the
 * two-bucket answer back — silently, and in the direction that dismisses a review.
 *
 * @param {Entry[]} stale
 * @param {Row[]} recorded
 * @param {{project: string, entries: number}[]} missingProjects `compare`'s vanished projects
 * @returns {{unrecorded: Entry[], dead: Row[], suspended: Row[]}}
 */
export function reconcile(stale, recorded, missingProjects) {
	if (!Array.isArray(missingProjects)) {
		throw new Error("reconcile: `missingProjects` is required — without it a row under a vanished project is misreported as dead, and the printed fix is to DELETE it.");
	}
	const found = new Set(stale.map(idOf));
	const known = new Set(recorded.map(idOf));
	const vanished = new Set(missingProjects.map((p) => p.project));
	const notFound = recorded.filter((e) => !found.has(idOf(e)));
	return {
		unrecorded: stale.filter((e) => !known.has(idOf(e))),
		dead: notFound.filter((e) => !vanished.has(e.project)),
		suspended: notFound.filter((e) => vanished.has(e.project)),
	};
}

// ── the listing ──────────────────────────────────────────────────────────────────────────────

/**
 * Ask Playwright what it would run, as JSON.
 *
 * The output goes to a file via PLAYWRIGHT_JSON_OUTPUT_NAME rather than being parsed off stdout:
 * `--list` also prints a human list, and a parser that has to find JSON inside that is a parser
 * that can silently find nothing. A non-zero exit, a missing file or an unparseable one all THROW
 * — "playwright would not list" is never an answer this check treats as clean.
 *
 * @returns {unknown} parsed report
 */
function listFromPlaywright() {
	const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gate-baseline-")), "list.json");
	const res = spawnSync("pnpm", ["-C", CONSOLE, "exec", "playwright", "test", "--list", "--reporter=json"], {
		cwd: ROOT,
		encoding: "utf8",
		env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: out },
		maxBuffer: 64 * 1024 * 1024,
	});
	if (res.error) throw new Error(`playwright --list could not be started: ${res.error.message}`);
	if (res.status !== 0) {
		throw new Error(
			`playwright --list exited ${res.status}. The spec files did not load, so the tree's test set is unknown.\n` +
				`${(res.stderr || res.stdout || "").trim().slice(-4000)}`,
		);
	}
	if (!fs.existsSync(out)) throw new Error(`playwright --list wrote no JSON to ${out} — PLAYWRIGHT_JSON_OUTPUT_NAME was not honoured.`);
	return JSON.parse(fs.readFileSync(out, "utf8"));
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────

const USAGE = [
	"usage:",
	"  node scripts/ci/check-gate-baseline-consistency.mjs",
	"  node scripts/ci/check-gate-baseline-consistency.mjs --list-json=<playwright --list json>",
	"  node scripts/ci/check-gate-baseline-consistency.mjs --self-test",
].join("\n");

/**
 * @param {string[]} argv
 * @returns {number} process exit code
 */
export function main(argv) {
	if (argv.includes("--self-test")) return selfTest();
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log(USAGE);
		return 0;
	}
	const listArg = argv.find((a) => a.startsWith("--list-json="));
	const unknown = argv.filter((a) => a !== listArg);
	if (unknown.length) {
		console.error(`check-gate-baseline-consistency: unrecognised argument(s): ${unknown.join(", ")}\n${USAGE}`);
		return 2;
	}

	const report = listArg ? JSON.parse(fs.readFileSync(path.resolve(listArg.slice("--list-json=".length)), "utf8")) : listFromPlaywright();
	if (Array.isArray(report.errors) && report.errors.length > 0) {
		// A spec file that throws on import contributes ZERO tests and no exit code of its own in
		// some Playwright versions. Every entry under it would then read as a deleted test.
		const first = report.errors[0];
		throw new Error(
			`playwright --list reported ${report.errors.length} load error(s); the listing is incomplete and cannot be compared.\n` +
				`  ${typeof first?.message === "string" ? first.message.split("\n")[0] : JSON.stringify(first)}`,
		);
	}
	const listed = listedTests(report);
	const listedCount = countListed(listed);
	if (listedCount < MIN_LISTED_TESTS) {
		throw new Error(
			`playwright --list reported ${listedCount} tests, below the floor of ${MIN_LISTED_TESTS}. ` +
				"Found-nothing is not nothing-wrong: a collapsed listing would name every ledger entry as stale.",
		);
	}

	const baselineDoc = JSON.parse(fs.readFileSync(path.join(ROOT, BASELINE), "utf8"));
	const { stale, missingProjects, baselineCount } = compare(baselineDoc, listed);
	const { unrecorded, dead, suspended } = reconcile(stale, RECORDED_STALE, missingProjects);

	console.log(
		`check-gate-baseline-consistency: ${baselineCount} ledger entries against ${listedCount} listed tests ` +
			`in ${listed.size} projects; ${stale.length} stale (${RECORDED_STALE.length} recorded).`,
	);

	const errors = renderFindings({ missingProjects, unrecorded, dead, suspended });
	for (const line of errors) console.error(line);

	if (errors.length === 0) {
		console.log("check-gate-baseline-consistency: the ledger names no test the tree has lost.");
		return 0;
	}
	return 1;
}

/**
 * Every finding, rendered, as the lines `main` prints.
 *
 * Pure, exported and asserted directly by `--self-test`, because THE INSTRUCTION IS THE PRODUCT here
 * and a bucket count does not carry one. `dead` and `suspended` hold the same shape; what tells a
 * reader them apart is that one says "delete the row" and the other says do not. A self-test that
 * only counted the buckets would pass on a render that printed the wrong sentence over the right
 * bucket, which is the defect this seam already had once.
 *
 * @param {object} f
 * @param {{project: string, entries: number}[]} f.missingProjects
 * @param {Entry[]} f.unrecorded
 * @param {Row[]} f.dead
 * @param {Row[]} f.suspended
 * @returns {string[]} one `::error::` line per finding; empty means clean
 */
export function renderFindings({ missingProjects, unrecorded, dead, suspended }) {
	/** @type {string[]} */
	const errors = [];
	const self = path.relative(ROOT, fileURLToPath(import.meta.url));
	for (const { project, entries } of missingProjects) {
		errors.push(
			`::error::${BASELINE} records ${entries} entries under project "${project}", which apps/console/playwright.config.ts ` +
				"no longer defines. Every one of them is unreachable — rename the slice, or delete it.",
		);
		// The rows under it, named HERE and not as a finding of their own. See `reconcile`.
		const held = suspended.filter((e) => e.project === project);
		if (held.length > 0) {
			errors.push(
				`::error::  · ${held.length} RECORDED_STALE row(s) in ${self} sit under "${project}". They are NOT dead and must NOT ` +
					"be deleted on their own: their subjects went further out of reach, not back into the tree, so each row still " +
					"covers a real finding. Deleting them changes nothing this check reports — the line above is already the failure — " +
					"and loses the only written record of why those titles are stale. Resolve the project; the rows go with the slice.",
			);
		}
	}
	// Grouped by slice, because the slice is the unit of repair: one `--write --only=<file>` fixes
	// every line under it, and a flat list of forty titles hides that they are four commands.
	const bySlice = new Map();
	for (const e of unrecorded) {
		const k = JSON.stringify([e.project, e.file]);
		if (!bySlice.has(k)) bySlice.set(k, []);
		bySlice.get(k).push(e.title);
	}
	for (const [k, titles] of bySlice) {
		const [project, file] = JSON.parse(k);
		errors.push(
			`::error::${BASELINE} names ${titles.length} test(s) that ${file} no longer contains under project "${project}" — ` +
				"a renamed or deleted test. The gate's `Release gate (" +
				project +
				")` leg fails on this (ratchet rule 4), and it fails on the NEXT PR, not on the one that caused it. " +
				`Regenerate the slice from a real run: \`gh workflow run "Release gate" --ref <branch> -f legs=${project}\`, then ` +
				`\`node scripts/e2e-ratchet.mjs --project=${project} --results=<results.json> --write --only=${file}\`.`,
		);
		for (const t of titles) errors.push(`::error::  · ${t}`);
	}
	for (const e of dead) {
		errors.push(
			`::error::RECORDED_STALE in ${self} still records ` +
				`"${e.project} › ${e.file} › ${e.title}", which is no longer stale — the slice was regenerated, or the test came back. ` +
				"Delete the row. An exception that outlives its subject suppresses a real finding forever, silently.",
		);
	}
	return errors;
}

// ── self-test ────────────────────────────────────────────────────────────────────────────────

/**
 * Hermetic, and it MUTATES rather than re-implements. Every rule is asserted in both directions:
 * the clean pair reports nothing, and the pair with one thing broken reports exactly that thing.
 * A check whose fixture always fails would pass a one-directional suite.
 */
function selfTest() {
	let failures = 0;
	const ok = (label, cond) => {
		console.log(`${cond ? "ok  " : "FAIL"} - ${label}`);
		if (!cond) failures++;
	};

	/** One spec node in the JSON reporter's shape, in `projects`. */
	const spec = (title, projects) => ({
		title,
		tests: projects.map((projectName) => ({ projectName, status: "skipped", annotations: [] })),
	});
	const report = () => ({
		suites: [
			{
				title: "flows/alerts.spec.ts",
				file: "flows/alerts.spec.ts",
				specs: [spec("a bare test outside any describe", ["qa"])],
				suites: [
					{
						title: "Alerts",
						specs: [spec("a rule can be created", ["qa"]), spec("a rule can be deleted", ["qa"])],
						suites: [{ title: "negative", specs: [spec("a bad payload is refused", ["qa"])] }],
					},
				],
			},
			{ title: "hero-happy-path.spec.ts", file: "hero-happy-path.spec.ts", specs: [spec("sign in → deploy", ["hero"])] },
		],
	});

	// ── the identity, pinned against the ratchet's own derivation ──────────────────────────────
	const listed = listedTests(report());
	ok(
		"a nested describe joins into the ledger's key with ' › '",
		listed.get("qa")?.get("flows/alerts.spec.ts")?.has("Alerts › negative › a bad payload is refused") === true,
	);
	ok(
		"a test outside any describe is keyed by its own title alone",
		listed.get("qa")?.get("flows/alerts.spec.ts")?.has("a bare test outside any describe") === true,
	);
	ok(
		"the identity is e2e-ratchet's: same keys, same files, for the same project",
		(() => {
			const mine = listed.get("qa");
			const theirs = flattenResults(report(), "qa");
			const a = [...mine].flatMap(([file, titles]) => [...titles].map((t) => `${file} › ${t}`)).sort();
			const b = Object.entries(theirs)
				.flatMap(([file, tests]) => Object.keys(tests).map((t) => `${file} › ${t}`))
				.sort();
			return a.length === 4 && JSON.stringify(a) === JSON.stringify(b);
		})(),
	);
	ok("a project's tests are not leaked into another project's map", listed.get("hero")?.get("flows/alerts.spec.ts") === undefined);
	ok(
		"listedTests refuses a document that is not a Playwright report",
		(() => {
			try {
				listedTests({ nope: true });
				return false;
			} catch (err) {
				return err instanceof Error && /no `suites` array/.test(err.message);
			}
		})(),
	);
	ok("countListed counts every triple, across projects", countListed(listed) === 5);

	// ── the comparison, in both directions ─────────────────────────────────────────────────────
	const clean = {
		version: 1,
		projects: {
			qa: {
				"flows/alerts.spec.ts": {
					"a bare test outside any describe": "passed",
					"Alerts › a rule can be created": "passed",
					"Alerts › a rule can be deleted": "failed",
					"Alerts › negative › a bad payload is refused": "passed",
				},
			},
			hero: { "hero-happy-path.spec.ts": { "sign in → deploy": "passed" } },
		},
	};
	// The CONTROL. Without it, every mutation below would "pass" on a fixture that never agreed.
	ok("control: a ledger that matches the listing reports nothing", (() => {
		const r = compare(clean, listed);
		return r.stale.length === 0 && r.missingProjects.length === 0 && r.baselineCount === 5;
	})());
	ok("a test the tree no longer contains is reported, and named", (() => {
		const doc = structuredClone(clean);
		doc.projects.qa["flows/alerts.spec.ts"]["Alerts › a rule can be RENAMED"] = "passed";
		const r = compare(doc, listed);
		return r.stale.length === 1 && r.stale[0].title === "Alerts › a rule can be RENAMED" && r.stale[0].file === "flows/alerts.spec.ts";
	})());
	ok("a whole spec FILE the tree no longer contains is reported per entry", (() => {
		const doc = structuredClone(clean);
		doc.projects.qa["flows/deleted.spec.ts"] = { one: "passed", two: "failed" };
		const r = compare(doc, listed);
		return r.stale.length === 2 && r.stale.every((e) => e.file === "flows/deleted.spec.ts") && r.missingProjects.length === 0;
	})());
	ok("a whole PROJECT the config no longer defines is reported ONCE, with its entry count", (() => {
		const doc = structuredClone(clean);
		doc.projects.gone = { "a.spec.ts": { one: "passed", two: "passed", three: "passed" } };
		const r = compare(doc, listed);
		return r.missingProjects.length === 1 && r.missingProjects[0].project === "gone" && r.missingProjects[0].entries === 3 && r.stale.length === 0;
	})());
	ok("a test the TREE has and the ledger does not name is NOT a finding (one direction only)", (() => {
		const doc = structuredClone(clean);
		delete doc.projects.qa["flows/alerts.spec.ts"]["Alerts › a rule can be created"];
		return compare(doc, listed).stale.length === 0;
	})());
	ok("a title that differs only in its describe path is stale, not matched loosely", (() => {
		const doc = structuredClone(clean);
		delete doc.projects.qa["flows/alerts.spec.ts"]["Alerts › negative › a bad payload is refused"];
		doc.projects.qa["flows/alerts.spec.ts"]["a bad payload is refused"] = "passed";
		return compare(doc, listed).stale.length === 1;
	})());
	ok(
		"a ledger with no `projects` object throws rather than reporting clean",
		(() => {
			try {
				compare({ version: 1 }, listed);
				return false;
			} catch (err) {
				return err instanceof Error && /no `projects` object/.test(err.message);
			}
		})(),
	);

	// ── the exception ledger, in BOTH directions ───────────────────────────────────────────────
	const one = [{ project: "qa", file: "flows/alerts.spec.ts", title: "Alerts › a rule can be RENAMED" }];
	const row = { ...one[0], why: "a reason" };
	ok("a recorded stale entry is suppressed", reconcile(one, [row], []).unrecorded.length === 0);
	ok("control: with NOTHING recorded, the same finding is reported", reconcile(one, [], []).unrecorded.length === 1);
	ok("a recorded entry that is no longer stale is itself a failure", reconcile([], [row], []).dead.length === 1);
	ok("a recorded entry is matched on all three fields, not on the title alone", reconcile(one, [{ ...row, project: "console" }], []).unrecorded.length === 1);

	// ── a recorded row under a project the LISTING lost ────────────────────────────────────────
	// Driven through `compare` rather than hand-assembled, because the defect lived in the SEAM: the
	// project short-circuits, NOTHING of it reaches `stale`, and it was that emptiness the two-bucket
	// reconcile read as "no longer a finding" — printing "delete the row" over a subject that had
	// gone further out of reach. Reachable without renaming anything: delete
	// apps/console/e2e/architecture-canvas.spec.ts and `canvas` stays defined but collects no tests.
	const vanishedDoc = structuredClone(clean);
	vanishedDoc.projects.canvas = { "architecture-canvas.spec.ts": { "Architecture canvas › regions": "passed", "Architecture canvas › sizing": "passed" } };
	const vanishedRow = { project: "canvas", file: "architecture-canvas.spec.ts", title: "Architecture canvas › regions", why: "#4324, a reason long enough to read as one" };
	const vc = compare(vanishedDoc, listed);
	const vr = reconcile(vc.stale, [vanishedRow], vc.missingProjects);
	ok(
		"the vanished project short-circuits, so NONE of its entries reach `stale`",
		vc.stale.length === 0 && vc.missingProjects.length === 1 && vc.missingProjects[0].project === "canvas",
	);
	ok("a recorded row under a vanished project is SUSPENDED, not dead", vr.dead.length === 0 && vr.suspended.length === 1 && vr.suspended[0].project === "canvas");
	ok(
		"...and nothing rendered about it tells the reader to delete the row",
		(() => {
			const lines = renderFindings({ missingProjects: vc.missingProjects, unrecorded: vr.unrecorded, dead: vr.dead, suspended: vr.suspended });
			return (
				lines.length === 2 &&
				/no longer defines/.test(lines[0]) &&
				/must NOT be deleted on their own/.test(lines[1]) &&
				!lines.some((l) => /Delete the row/.test(l))
			);
		})(),
	);
	// THE CONTROL for the pair above. "Never renders `Delete the row`" would also pass on a render
	// that had lost the sentence altogether, which is the direction that silently stops reporting.
	ok(
		"control: a row whose project is still listed and whose subject came back IS dead, and the render does say to delete it",
		(() => {
			const r = reconcile([], [row], []);
			const lines = renderFindings({ missingProjects: [], unrecorded: [], dead: r.dead, suspended: r.suspended });
			return r.dead.length === 1 && lines.length === 1 && /Delete the row/.test(lines[0]);
		})(),
	);
	ok(
		"reconcile refuses to answer at all without the vanished-project set",
		(() => {
			try {
				reconcile([], [row]);
				return false;
			} catch (err) {
				return err instanceof Error && /`missingProjects` is required/.test(err.message);
			}
		})(),
	);
	ok("RECORDED_STALE has no duplicate rows", new Set(RECORDED_STALE.map(idOf)).size === RECORDED_STALE.length);
	ok(
		"every RECORDED_STALE row states a reason that names its cause",
		RECORDED_STALE.every((e) => typeof e.why === "string" && e.why.trim().length > 40 && /#\d+/.test(e.why)),
	);

	// ── the floors ─────────────────────────────────────────────────────────────────────────────
	// Against the REAL ledger, not a literal. A floor typed above the ledger's own size would
	// refuse every honest tree, and `571` written here as a number goes stale the first time a
	// lane regenerates a slice — the assertion would then be about a fact nobody re-measured.
	ok(
		"the floor sits under the ledger it is meant to protect",
		(() => {
			const doc = JSON.parse(fs.readFileSync(path.join(ROOT, BASELINE), "utf8"));
			let entries = 0;
			for (const files of Object.values(doc.projects)) for (const tests of Object.values(files)) entries += Object.keys(tests).length;
			return MIN_LISTED_TESTS > 0 && MIN_LISTED_TESTS < entries;
		})(),
	);
	ok(
		"a listing that collapsed is refused, not compared",
		(() => {
			const tiny = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gbc-selftest-")), "list.json");
			fs.writeFileSync(tiny, JSON.stringify({ suites: [{ title: "a.spec.ts", file: "a.spec.ts", specs: [spec("one", ["qa"])] }] }));
			try {
				main([`--list-json=${tiny}`]);
				return false;
			} catch (err) {
				return err instanceof Error && /below the floor/.test(err.message);
			}
		})(),
	);
	ok(
		"a listing that reported load errors is refused, not compared",
		(() => {
			const broken = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gbc-selftest-")), "list.json");
			fs.writeFileSync(broken, JSON.stringify({ suites: [], errors: [{ message: "Cannot find module './helpers/x'" }] }));
			try {
				main([`--list-json=${broken}`]);
				return false;
			} catch (err) {
				return err instanceof Error && /load error/.test(err.message);
			}
		})(),
	);
	ok(
		"an unrecognised argument exits 2 rather than checking something else",
		main(["--all-of-them"]) === 2,
	);

	console.log(failures === 0 ? "\nself-test: all passed" : `\nself-test: ${failures} FAILED`);
	return failures === 0 ? 0 : 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	try {
		process.exit(main(process.argv.slice(2)));
	} catch (err) {
		console.error(`::error::check-gate-baseline-consistency: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
}
