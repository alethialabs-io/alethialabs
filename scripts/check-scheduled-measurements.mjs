#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// check-scheduled-measurements — one invariant, enforced:
//
//   "A scheduled measurement declares which tree it runs, and the branch that actually runs it
//    still publishes the evidence something in this repo reads."
//
// WHY THIS EXISTS. GitHub fires `schedule:` from the DEFAULT BRANCH. That governs the workflow YAML
// *and*, for a job whose checkout is unpinned, the whole tree it executes — so every repo file the
// job invokes is the default branch's version too. The repo can therefore believe an instrument
// exists while the instrument actually running is an older, different program that measures
// nothing, and nothing anywhere goes red.
//
// This has now happened twice.
//
//   #3252 — a scheduled run used a DIFFERENT constant, because `main` was ~30 commits behind.
//           `.github/workflows/workflow-health.yml` still carries the write-up in its header.
//   #4395 — `e2e-orphan-reaper.yml` ran on schedule and SUCCEEDED eight days running while
//           producing zero artifacts. `docs/testing/programme-snapshot.json` held
//           `orphan_reaper_observations: []`, PROGRAMME.md's reaper table read "0 of 5 clouds
//           verified clean · no durable reclaim result" for every cloud, and MVP predicate 6 was
//           therefore unsatisfiable — silently, with a green check every morning. `main` had
//           neither the capture step nor `scripts/e2e/reaper-result.mjs` at all.
//
// Both times the prose existed and the check did not. `workflow-health.yml` has described this
// exact class since #3252 and it did not stop #4395, because a comment asking the next author to
// think does not survive the next author.
//
// ── WHAT THIS GUARD MAY SOUNDLY ASK ──
//
// NOT "the default branch must match dev". `main` is legitimately behind for the entire length of
// every promotion window — measured while writing this, the standing staging→main PR had been open
// three days — so a blocking branch-comparison would red every unrelated PR for days at a time and
// be routed around within a week. That is the same argument check-exclusion-issues.mjs makes for
// its own split, and the remedy is the same: a hermetic half that BLOCKS, and a cross-branch half
// that only ANNOTATES.
//
// NOT "a scheduled measurement must pin its checkout to dev" either, which is the rule this guard
// was originally specified with (#4396, closed as wrong). Pinning is the correct choice ONLY for a
// low-privilege workflow. `programme.yml` pins `ref: dev` safely because it holds no cloud
// credential and only reads and opens a PR. `e2e-orphan-reaper.yml` holds `id-token: write` plus
// five clouds' credentials and DELETES resources; pinning it to `dev` would let any dev commit run
// destructive code with those credentials. PROGRAMME.md §2 D1 records the same reasoning for the
// nightly: "the cron keeps its `main`-only ref subject, so scheduled spend does not widen at all."
//
// Both of this repo's only two measurements therefore declare `runsTree: "default"` — so a guard
// built to the original rule would have demanded the unsafe change in BOTH of its cases. The guard
// would have been the vulnerability.
//
// So S4 checks CONSISTENCY, in both directions: declare which tree you run and why, and the
// declaration must match what the file actually does. It never prefers a direction.
//
// ── The rules ──
//
//   S1  Completeness, both directions. Every scheduled workflow is in exactly one ledger, and every
//       ledger key still names a file that exists and still has a `schedule:`.
//   S2  Each measurement's declared artifact prefix really is uploaded by that workflow.
//   S3  The same prefix appears literally in its declared consumer — this is what catches a rename
//       on one side silently orphaning the pipeline.
//   S4  `runsTree` matches reality, both ways: "dev" requires a pinned checkout, "default" requires
//       an unpinned one.
//   S5  Vacuity tripwires. Zero scheduled workflows found, zero uploads across all measurements, a
//       declared path that does not exist, or a declared marker string that is absent — each is a
//       hard failure, because a guard whose failure mode is silence is worse than a noisy one.
//   D1  (cross-branch, annotating) The default branch's copy of the workflow still publishes the
//       declared artifact.
//   D2  (cross-branch, annotating) Its `producedBy` files exist there and carry their markers.
//
// ── WHAT THIS CANNOT CATCH — read this before trusting it ──
//
//   * PRESENCE IS NOT EXECUTION. S2/D1 read for an `upload-artifact` name. A step behind an
//     always-false `if:`, a step whose predecessor failed, or `if-no-files-found` flipped from
//     `error` to `warn`, all pass. #4347 is a live instance of that last one.
//   * SEMANTIC DRIFT BEHIND A STABLE FILENAME is invisible. This is the LARGEST blind spot and it
//     is precisely the shape of #4395's second half: `reaper-result.mjs` present on both refs but
//     its log regexes no longer matching the sweeper's output, so artifacts arrive and every row
//     renders `indeterminate` forever. Only `markers` closes it, and only for strings a human
//     thought to list.
//   * NON-ARTIFACT MEASUREMENTS are declared, not weakly checked. `programme.yml` emits a PR and
//     `workflow-health.yml` emits an issue; grepping for `gh issue create` would read as coverage
//     without being it.
//   * REUSABLE-WORKFLOW AND COMPOSITE-ACTION INDIRECTION is invisible to a line scan.
//   * THE INSTRUMENT BEING RIGHT ON BOTH REFS AND WRONG IN THE WORLD — revoked credentials, a
//     changed cloud API. That is the reaper's own job, and workflow-health.yml's.
//
// Cron divergence between the two refs is REPORTED, never gated: `programme.yml` genuinely differs
// (main 07:07 vs dev 08:47) and that is a real ordering defect, but cron churn during a normal
// promotion window would make the rule noisy, and a noisy rule takes the useful ones down with it.
//
// Run:  node scripts/check-scheduled-measurements.mjs --self-test    (no network)
//       node scripts/check-scheduled-measurements.mjs --scan-only    (no network, BLOCKS)
//       node scripts/check-scheduled-measurements.mjs                (reads the default branch)
// Wired in .github/workflows/ci.yml, job `guards`, as three steps — only the last is
// continue-on-error.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = path.join(ROOT, ".github", "workflows");

// ───────────────────────────── the ledger ─────────────────────────────

/**
 * Scheduled workflows that publish evidence a repo file consumes to derive a verdict.
 *
 * `runsTree` is the DECLARATION, not a preference:
 *   "default" — the schedule runs the default branch's reviewed tree. Correct for anything holding
 *               credentials or mutating cloud state; its staleness remedy is promotion, not a pin.
 *   "dev"     — the checkout is pinned to `dev`. Only safe for a workflow that cannot do damage
 *               with an unreviewed tree.
 *
 * @type {Record<string, {
 *   publishes: string,
 *   consumedBy: string[],
 *   producedBy: string[],
 *   markers: {file: string, contains: string}[],
 *   runsTree: "default" | "dev",
 *   why: string,
 *   issue: string,
 * }>}
 */
export const SCHEDULED_MEASUREMENTS = {
	"e2e-orphan-reaper.yml": {
		publishes: "orphan-reaper-result-",
		consumedBy: ["scripts/programme-fetch.sh"],
		producedBy: ["scripts/e2e/reaper-result.mjs", "scripts/e2e/lib/sweep-probe.sh"],
		markers: [{ file: "scripts/e2e/lib/sweep-probe.sh", contains: "probe_report_discovery" }],
		runsTree: "default",
		why:
			"Holds id-token: write plus all five clouds' credentials (including secrets.HCLOUD_TOKEN) and " +
			"DELETES cloud resources, so it must run the reviewed default-branch tree. Pinning it to dev " +
			"would let any dev commit run destructive code with those credentials — see #4396, closed as wrong.",
		issue: "#4395",
	},
	"e2e-nightly.yml": {
		publishes: "e2e-proof-",
		consumedBy: ["scripts/e2e/commit-proof.sh", "scripts/e2e/nightly-rollup.sh"],
		producedBy: ["scripts/e2e/nightly-rollup.sh", "scripts/e2e/resolve-dimension.sh"],
		markers: [{ file: "scripts/e2e/nightly-rollup.sh", contains: "teardown_outcome" }],
		runsTree: "default",
		why:
			"PROGRAMME.md D1: the cron keeps its main-only OIDC ref subject so that scheduled spend does " +
			"not widen. Running an unreviewed tree with the credentials that provision real infrastructure " +
			"is the thing that decision exists to prevent.",
		issue: "#2385",
	},
};

/**
 * Scheduled workflows that are deliberately NOT measurements, each with the reason. A weak check
 * that reads as coverage is worse than an honest declaration — that is why these are listed rather
 * than approximated.
 * @type {Record<string, {why: string, issue: string}>}
 */
export const NOT_A_MEASUREMENT = {
	"e2e-ai-nightly.yml": {
		why:
			"Uploads playwright-report-elench-live, but NO repo file consumes it — verified by grep across " +
			"scripts/, .github/ and apps/. It is a human-read report, so there is no producer/consumer pair " +
			"for S3 to check and no verdict derived from it to go stale.",
		issue: "#4397",
	},
	"programme.yml": {
		why:
			"Its output is a pull request, not an artifact. It is also already immune to this defect class: " +
			"it pins ref: dev, so the fetcher that executes is dev's even though the timer is the default " +
			"branch's. Grepping for a PR-opening step would be a far weaker proxy than an artifact name.",
		issue: "#4397",
	},
	"workflow-health.yml": {
		why:
			"Its output is an upserted issue, not an artifact. Grepping for `gh issue create` would read as " +
			"coverage without being it. Its header is also where #3252 — this guard's first incident — is " +
			"written up, so it is the class's historian rather than an instance of it.",
		issue: "#4397",
	},
	"ci.yml": {
		why:
			"A pull-request workflow that also carries a schedule. Its uploads are PR-scoped reports and " +
			"coverage floors consumed within the same run, not durable evidence any later derivation reads.",
		issue: "#4397",
	},
	"codeql.yml": {
		why:
			"Publishes to GitHub's code-scanning surface rather than to an artifact this repo reads. Nothing " +
			"in the tree derives a verdict from it.",
		issue: "#4397",
	},
	"catalog-drift.yml": {
		why: "Drift detector: it fails in place or opens an issue, and uploads no artifact any repo file reads.",
		issue: "#4397",
	},
	"compat-drift.yml": {
		why: "Drift detector: it fails in place or opens an issue, and uploads no artifact any repo file reads.",
		issue: "#4397",
	},
	"merge-signal-health.yml": {
		why:
			"Reports on whether the observe-only heavy E2Es are reliable enough to promote to required. It " +
			"emits a report rather than an artifact a derivation consumes.",
		issue: "#4397",
	},
	"posthog-error-issues.yml": {
		why: "Opens issues from PostHog errors. Its output is issues, not an artifact this repo reads back.",
		issue: "#4397",
	},
};

// ───────────────────────────── parsing ─────────────────────────────
//
// Line-based, deliberately. `yaml` is a dependency of apps/console and NOT of the root, and this
// runs under plain `node` — scripts/check-workflow-shape.mjs records the same reason.

/** Does this workflow declare a `schedule:` trigger? Comments never count. */
export function hasSchedule(text) {
	return text
		.split("\n")
		.filter((l) => !/^\s*#/.test(l))
		.some((l) => /^\s{0,4}schedule:\s*$/.test(l));
}

/** Every `actions/upload-artifact` `name:` in the file, as raw strings. */
export function uploadedArtifactNames(text) {
	const lines = text.split("\n").filter((l) => !/^\s*#/.test(l));
	const names = [];
	let countdown = 0;
	for (const line of lines) {
		if (/uses:\s*actions\/upload-artifact/.test(line)) {
			countdown = 8;
			continue;
		}
		if (countdown > 0) {
			const m = line.match(/^\s*name:\s*(.+?)\s*$/);
			if (m) {
				names.push(m[1]);
				countdown = 0;
				continue;
			}
			countdown -= 1;
		}
	}
	return names;
}

/**
 * Is the FIRST `actions/checkout` in this workflow pinned to an explicit ref?
 * An unpinned checkout takes the tree of the ref that triggered the run — for a schedule, the
 * default branch's.
 */
export function checkoutIsPinned(text) {
	const lines = text.split("\n").filter((l) => !/^\s*#/.test(l));
	let countdown = 0;
	for (const line of lines) {
		if (/uses:\s*actions\/checkout/.test(line)) {
			countdown = 6;
			continue;
		}
		if (countdown > 0) {
			if (/^\s*ref:\s*\S/.test(line)) return true;
			// a new step began before any ref: — unpinned
			if (/^\s*-\s+(uses|name|run):/.test(line)) return false;
			countdown -= 1;
		}
	}
	return false;
}

// ───────────────────────────── analysis ─────────────────────────────

/**
 * Evaluate the rules against already-read inputs. Pure — it never touches `fs`, so `--self-test`
 * drives it with fixtures and the cross-branch mode drives it with `git show` output through the
 * very same code path.
 *
 * @param {object} input
 * @param {Record<string,string>} input.workflows        basename -> text (the scheduled ones)
 * @param {Record<string,string|null>} input.files       repo-relative path -> text, or null if absent
 * @param {Record<string,object>} input.measurements
 * @param {Record<string,object>} input.notMeasurements
 * @param {"tree"|"cross"} input.mode                    which rule family to run
 * @param {string} [input.ref]                           label for the branch, cross mode only
 * @returns {{failures: string[], notes: string[]}}
 */
export function analyse({ workflows, files, measurements, notMeasurements, mode, ref = "" }) {
	const failures = [];
	const notes = [];
	const scheduled = Object.keys(workflows).sort();

	// S5 — vacuity, first, because every rule below is meaningless if the scan found nothing.
	if (mode === "tree" && scheduled.length === 0) {
		failures.push("S5: found ZERO scheduled workflows. The scan is blind, not clean.");
		return { failures, notes };
	}

	if (mode === "tree") {
		// S1 — completeness, both directions.
		for (const name of scheduled) {
			const inM = Object.hasOwn(measurements, name);
			const inN = Object.hasOwn(notMeasurements, name);
			if (!inM && !inN) {
				failures.push(
					`S1: ${name} has a schedule: but is in neither ledger. Decide whether it publishes evidence ` +
						`something reads, and declare it — an undeclared scheduled workflow is one nobody has asked ` +
						`the question about.`,
				);
			}
			if (inM && inN) {
				failures.push(`S1: ${name} is in BOTH ledgers. Pick one.`);
			}
		}
		for (const name of [...Object.keys(measurements), ...Object.keys(notMeasurements)]) {
			if (!Object.hasOwn(workflows, name)) {
				failures.push(
					`S1: the ledger names ${name}, which either does not exist or no longer has a schedule:. ` +
						`Delete its entry — a ledger that outlives its subject suppresses a real finding forever.`,
				);
			}
		}

		// Reason and issue hygiene, on both ledgers.
		for (const [name, e] of [...Object.entries(measurements), ...Object.entries(notMeasurements)]) {
			if (!/^#\d+$/.test(e.issue ?? "")) {
				failures.push(`S1: ${name} has no issue reference (got ${JSON.stringify(e.issue ?? null)}).`);
			}
			if ((e.why ?? "").trim().length < 40) {
				failures.push(
					`S1: ${name}'s reason is too short to be one. A thin reason reads as a site awaiting conversion.`,
				);
			}
		}

		let uploadsSeen = 0;
		for (const [name, m] of Object.entries(measurements)) {
			const text = workflows[name];
			if (text === undefined) continue; // already reported by S1

			// S2 — the declared artifact really is uploaded here.
			const uploads = uploadedArtifactNames(text);
			uploadsSeen += uploads.length;
			if (!uploads.some((u) => u.includes(m.publishes))) {
				failures.push(
					`S2: ${name} declares it publishes "${m.publishes}" but no actions/upload-artifact name in it ` +
						`contains that prefix. Uploads found: ${uploads.length ? uploads.join(", ") : "(none)"}.`,
				);
			}

			// S3 — producer and consumer agree on the prefix.
			for (const consumer of m.consumedBy) {
				const c = files[consumer];
				if (c === null || c === undefined) {
					failures.push(`S5: ${name} names consumer ${consumer}, which does not exist.`);
					continue;
				}
				if (!c.includes(m.publishes)) {
					failures.push(
						`S3: ${consumer} does not mention "${m.publishes}", so ${name}'s artifact reaches nothing. ` +
							`A rename on either side orphans the pipeline with nothing red.`,
					);
				}
			}

			// S4 — the declaration matches reality, both ways. Never prefers a direction.
			const pinned = checkoutIsPinned(text);
			if (m.runsTree === "dev" && !pinned) {
				failures.push(`S4: ${name} declares runsTree "dev" but its checkout is not pinned.`);
			}
			if (m.runsTree === "default" && pinned) {
				failures.push(
					`S4: ${name} declares runsTree "default" but its checkout IS pinned. Either the pin is new and ` +
						`the declaration is stale, or the pin is wrong — and if this workflow holds credentials, a pin ` +
						`means an unreviewed tree runs with them.`,
				);
			}
			if (m.runsTree !== "dev" && m.runsTree !== "default") {
				failures.push(`S4: ${name} has no valid runsTree declaration (got ${JSON.stringify(m.runsTree)}).`);
			}

			// S5 — declared paths and markers exist.
			for (const p of m.producedBy) {
				if (files[p] === null || files[p] === undefined) {
					failures.push(`S5: ${name} names producer ${p}, which does not exist.`);
				}
			}
			for (const mk of m.markers ?? []) {
				const t = files[mk.file];
				if (t === null || t === undefined) {
					failures.push(`S5: ${name}'s marker names ${mk.file}, which does not exist.`);
				} else if (!t.includes(mk.contains)) {
					failures.push(
						`S5: ${mk.file} no longer contains "${mk.contains}". The marker is how semantic drift behind ` +
							`a stable filename is caught at all; a marker that stopped matching is either drift or a ` +
							`stale declaration, and both need a human.`,
					);
				}
			}
		}

		if (Object.keys(measurements).length > 0 && uploadsSeen === 0) {
			failures.push(
				"S5: not one actions/upload-artifact was found across every declared measurement. The upload " +
					"matcher has stopped matching — that is blindness, not cleanliness.",
			);
		}

		if (Object.values(measurements).every((m) => m.runsTree === "default")) {
			notes.push(
				'S4 is currently VACUOUS in one direction: every measurement declares runsTree "default", so the ' +
					'"declared dev but not pinned" arm cannot fire. Kept because the arm that CAN fire is the one ' +
					"that catches somebody pinning a credential-holding workflow.",
			);
		}
		return { failures, notes };
	}

	// ── cross-branch: D1/D2. These ANNOTATE. They are expected to be red while a promotion is
	//    in flight, and the message must say so rather than implying somebody broke something.
	const remedy = `This is inert until dev → staging → main reaches ${ref || "the default branch"}.`;
	for (const [name, m] of Object.entries(measurements)) {
		const text = workflows[name];
		if (text === undefined || text === null) {
			failures.push(`D1: ${name} does not exist on ${ref}. ${remedy}`);
			continue;
		}
		const uploads = uploadedArtifactNames(text);
		if (!uploads.some((u) => u.includes(m.publishes))) {
			failures.push(
				`D1: on ${ref}, ${name} does not publish "${m.publishes}" — so the scheduled run measures nothing ` +
					`durable, however green it goes. ${remedy}`,
			);
		}
		for (const p of m.producedBy) {
			if (files[p] === null || files[p] === undefined) {
				failures.push(
					`D2: on ${ref}, ${name} invokes ${p}, which DOES NOT EXIST there. A workflow-only fix would ` +
						`still publish nothing. ${remedy}`,
				);
			}
		}
		for (const mk of m.markers ?? []) {
			const t = files[mk.file];
			if (t !== null && t !== undefined && !t.includes(mk.contains)) {
				failures.push(
					`D2: on ${ref}, ${mk.file} lacks "${mk.contains}" — evidence would arrive and still never be ` +
						`readable as clean. ${remedy}`,
				);
			}
		}
	}
	return { failures, notes };
}

// ───────────────────────────── readers ─────────────────────────────

function readWorkingTree() {
	const workflows = {};
	for (const f of fs.readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith(".yml"))) {
		const text = fs.readFileSync(path.join(WORKFLOW_DIR, f), "utf8");
		if (hasSchedule(text)) workflows[f] = text;
	}
	const files = {};
	for (const m of Object.values(SCHEDULED_MEASUREMENTS)) {
		for (const p of [...m.consumedBy, ...m.producedBy, ...(m.markers ?? []).map((x) => x.file)]) {
			if (Object.hasOwn(files, p)) continue;
			const abs = path.join(ROOT, p);
			files[p] = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
		}
	}
	return { workflows, files };
}

function defaultBranchName() {
	const out = execFileSync("gh", ["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return out.trim();
}

function showAtRef(ref, relPath) {
	try {
		return execFileSync("git", ["show", `${ref}:${relPath}`], {
			encoding: "utf8",
			cwd: ROOT,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		return null;
	}
}

function readRef(ref) {
	const workflows = {};
	for (const name of Object.keys(SCHEDULED_MEASUREMENTS)) {
		workflows[name] = showAtRef(ref, `.github/workflows/${name}`);
	}
	const files = {};
	for (const m of Object.values(SCHEDULED_MEASUREMENTS)) {
		for (const p of [...m.producedBy, ...(m.markers ?? []).map((x) => x.file)]) {
			if (Object.hasOwn(files, p)) continue;
			files[p] = showAtRef(ref, p);
		}
	}
	return { workflows, files };
}

// ───────────────────────────── self-test ─────────────────────────────

function fixture({ schedule = true, upload = "orphan-reaper-result-${{ matrix.provider }}", pinned = false } = {}) {
	return [
		"on:",
		...(schedule ? ["  schedule:", '    - cron: "17 7 * * *"'] : []),
		"jobs:",
		"  reap:",
		"    steps:",
		"      - uses: actions/checkout@v7",
		...(pinned ? ["        with:", "          ref: dev"] : []),
		"      - name: Publish",
		"        uses: actions/upload-artifact@v7",
		"        with:",
		...(upload ? [`          name: ${upload}`] : []),
		"          path: /tmp/x.json",
	].join("\n");
}

const LEDGER_ONE = {
	"e2e-orphan-reaper.yml": {
		publishes: "orphan-reaper-result-",
		consumedBy: ["scripts/programme-fetch.sh"],
		producedBy: ["scripts/e2e/reaper-result.mjs"],
		markers: [{ file: "scripts/e2e/lib/sweep-probe.sh", contains: "probe_report_discovery" }],
		runsTree: "default",
		why: "x".repeat(60),
		issue: "#4395",
	},
};
const HEALTHY_FILES = {
	"scripts/programme-fetch.sh": 'name == "orphan-reaper-result-${provider}"',
	"scripts/e2e/reaper-result.mjs": "export function capture() {}",
	"scripts/e2e/lib/sweep-probe.sh": "probe_report_discovery() { :; }",
};

function runSelfTest() {
	let fails = 0;
	const assert = (name, ok, detail = "") => {
		if (ok) {
			console.log(`  ok   - ${name}`);
		} else {
			fails += 1;
			console.error(`FAIL - ${name}${detail ? `: ${detail}` : ""}`);
		}
	};

	const tree = (workflows, files, ledger = LEDGER_ONE, notM = {}) =>
		analyse({ workflows, files, measurements: ledger, notMeasurements: notM, mode: "tree" });

	// Healthy shape passes.
	const healthy = tree({ "e2e-orphan-reaper.yml": fixture() }, HEALTHY_FILES);
	assert("today's shape passes cleanly", healthy.failures.length === 0, healthy.failures.join(" | "));
	assert(
		"...and the vacuous S4 arm announces itself rather than reading as coverage",
		healthy.notes.some((n) => n.includes("VACUOUS")),
	);

	// S1 both directions.
	const undeclared = tree({ "e2e-orphan-reaper.yml": fixture(), "mystery.yml": fixture() }, HEALTHY_FILES);
	assert(
		"an undeclared scheduled workflow FAILS",
		undeclared.failures.some((f) => f.startsWith("S1") && f.includes("mystery.yml")),
	);
	// The outlived-entry case must be posed with OTHER scheduled workflows still present: an empty
	// scan is blindness (S5) and returns early, which is correct but would mask this rule. Getting
	// that wrong is how a ledger's silent direction ends up untested.
	const outlived = tree({ "other.yml": fixture() }, HEALTHY_FILES, LEDGER_ONE, {
		"other.yml": { why: "z".repeat(60), issue: "#1" },
	});
	assert(
		"a ledger entry that OUTLIVED its workflow FAILS — the silent direction",
		outlived.failures.some((f) => f.startsWith("S1") && f.includes("does not exist")),
		outlived.failures.join(" | "),
	);
	const bothLedgers = tree({ "e2e-orphan-reaper.yml": fixture() }, HEALTHY_FILES, LEDGER_ONE, {
		"e2e-orphan-reaper.yml": { why: "y".repeat(60), issue: "#1" },
	});
	assert(
		"a workflow in BOTH ledgers FAILS",
		bothLedgers.failures.some((f) => f.includes("BOTH ledgers")),
	);

	// S2.
	const noUpload = tree({ "e2e-orphan-reaper.yml": fixture({ upload: "" }) }, HEALTHY_FILES);
	assert(
		"a measurement that uploads nothing FAILS S2",
		noUpload.failures.some((f) => f.startsWith("S2")),
	);

	// S3 — the rename case.
	const renamed = tree({ "e2e-orphan-reaper.yml": fixture() }, {
		...HEALTHY_FILES,
		"scripts/programme-fetch.sh": 'name == "reaper-result-${provider}"',
	});
	assert(
		"a consumer that no longer names the prefix FAILS S3 (the rename-orphan case)",
		renamed.failures.some((f) => f.startsWith("S3")),
	);

	// S4 — both directions, and it prefers neither.
	const pinnedButDefault = tree({ "e2e-orphan-reaper.yml": fixture({ pinned: true }) }, HEALTHY_FILES);
	assert(
		'declaring "default" while actually pinned FAILS',
		pinnedButDefault.failures.some((f) => f.startsWith("S4")),
	);
	const devLedger = { "e2e-orphan-reaper.yml": { ...LEDGER_ONE["e2e-orphan-reaper.yml"], runsTree: "dev" } };
	const devNotPinned = tree({ "e2e-orphan-reaper.yml": fixture() }, HEALTHY_FILES, devLedger);
	assert(
		'declaring "dev" while NOT pinned FAILS',
		devNotPinned.failures.some((f) => f.startsWith("S4")),
	);
	const devPinned = tree({ "e2e-orphan-reaper.yml": fixture({ pinned: true }) }, HEALTHY_FILES, devLedger);
	assert(
		"a correctly-declared pin passes — the rule prefers NO direction",
		devPinned.failures.filter((f) => f.startsWith("S4")).length === 0,
		devPinned.failures.join(" | "),
	);

	// S5.
	const noMarker = tree({ "e2e-orphan-reaper.yml": fixture() }, {
		...HEALTHY_FILES,
		"scripts/e2e/lib/sweep-probe.sh": "nothing here",
	});
	assert(
		"a marker that stopped matching FAILS rather than reporting a clean tree",
		noMarker.failures.some((f) => f.startsWith("S5") && f.includes("probe_report_discovery")),
	);
	const missingProducer = tree({ "e2e-orphan-reaper.yml": fixture() }, {
		...HEALTHY_FILES,
		"scripts/e2e/reaper-result.mjs": null,
	});
	assert(
		"a declared producer that does not exist FAILS",
		missingProducer.failures.some((f) => f.startsWith("S5")),
	);
	const empty = analyse({
		workflows: {},
		files: {},
		measurements: {},
		notMeasurements: {},
		mode: "tree",
	});
	assert(
		"a scan that finds ZERO scheduled workflows FAILS rather than reporting clean",
		empty.failures.some((f) => f.startsWith("S5") && f.includes("ZERO")),
	);
	const shortReason = tree({ "e2e-orphan-reaper.yml": fixture() }, HEALTHY_FILES, {
		"e2e-orphan-reaper.yml": { ...LEDGER_ONE["e2e-orphan-reaper.yml"], why: "too short" },
	});
	assert(
		"a thin reason FAILS — it reads as a site awaiting conversion",
		shortReason.failures.some((f) => f.includes("too short")),
	);

	// ── THE REGRESSION. The actual world of 2026-09-09: main's copy had neither the upload step
	//    nor reaper-result.mjs, and eight scheduled runs went green publishing nothing.
	const regression = analyse({
		workflows: { "e2e-orphan-reaper.yml": fixture({ upload: "" }) },
		files: { "scripts/e2e/reaper-result.mjs": null, "scripts/e2e/lib/sweep-probe.sh": "no marker" },
		measurements: LEDGER_ONE,
		notMeasurements: {},
		mode: "cross",
		ref: "main",
	});
	assert(
		"THE REGRESSION (#4395): main publishing nothing is caught by D1",
		regression.failures.some((f) => f.startsWith("D1")),
	);
	assert(
		"THE REGRESSION (#4395): main missing reaper-result.mjs is caught by D2",
		regression.failures.some((f) => f.startsWith("D2") && f.includes("DOES NOT EXIST")),
	);
	assert(
		"...and the message names the promotion as the remedy, not a culprit",
		regression.failures.every((f) => f.includes("dev → staging → main")),
	);

	// A promoted world clears with NO code change — the end-to-end proof.
	const promoted = analyse({
		workflows: { "e2e-orphan-reaper.yml": fixture() },
		files: {
			"scripts/e2e/reaper-result.mjs": "export function capture() {}",
			"scripts/e2e/lib/sweep-probe.sh": "probe_report_discovery() { :; }",
		},
		measurements: LEDGER_ONE,
		notMeasurements: {},
		mode: "cross",
		ref: "main",
	});
	assert("after promotion the same inputs go clean with no code change", promoted.failures.length === 0);

	// ── VACUITY. A guard whose failure mode is silence is worse than a noisy one: seed everything
	//    wrong at once and assert it reports a pile spanning every rule, not zero.
	const allWrong = tree(
		{ "e2e-orphan-reaper.yml": fixture({ upload: "", pinned: true }), "mystery.yml": fixture() },
		{ "scripts/programme-fetch.sh": "unrelated", "scripts/e2e/reaper-result.mjs": null, "scripts/e2e/lib/sweep-probe.sh": null },
	);
	assert("VACUITY: everything wrong reports a pile", allWrong.failures.length >= 5, `got ${allWrong.failures.length}`);
	for (const rule of ["S1", "S2", "S3", "S4", "S5"]) {
		assert(
			`VACUITY: ${rule} fires when its subject is broken`,
			allWrong.failures.some((f) => f.startsWith(rule)),
			allWrong.failures.join(" | "),
		);
	}

	// Parser controls — the matchers must not be trivially true.
	assert("hasSchedule ignores a commented-out schedule", !hasSchedule("# schedule:\non:\n  push:"));
	assert("hasSchedule finds a real one", hasSchedule("on:\n  schedule:\n    - cron: \"1 2 * * *\""));
	assert("uploadedArtifactNames finds none when there is no upload step", uploadedArtifactNames("jobs:\n  a:\n").length === 0);
	assert("checkoutIsPinned is false for a bare checkout", !checkoutIsPinned("steps:\n  - uses: actions/checkout@v7\n  - run: x"));
	assert(
		"checkoutIsPinned is true for a ref: that follows",
		checkoutIsPinned("steps:\n  - uses: actions/checkout@v7\n    with:\n      ref: dev"),
	);

	if (fails > 0) {
		console.error(`\nself-test: ${fails} failure(s).`);
		process.exit(1);
	}
	console.log("\nOK: self-test passed");
}

// ───────────────────────────── main ─────────────────────────────

// Only when EXECUTED, never on import: the helpers above are exported so a test can drive them with
// fixtures, and a module whose import reads the workflow tree and can call process.exit is not
// importable.
const executedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${fs.realpathSync(process.argv[1])}`;

if (!executedDirectly) {
	// imported — expose the helpers and do nothing else.
} else if (process.argv.includes("--self-test")) {
	runSelfTest();
} else if (process.argv.includes("--scan-only")) {
	const { workflows, files } = readWorkingTree();
	const { failures, notes } = analyse({
		workflows,
		files,
		measurements: SCHEDULED_MEASUREMENTS,
		notMeasurements: NOT_A_MEASUREMENT,
		mode: "tree",
	});
	console.log(
		`scheduled measurements: ${Object.keys(workflows).length} scheduled workflow(s) — ` +
			`${Object.keys(SCHEDULED_MEASUREMENTS).length} measurement(s), ${Object.keys(NOT_A_MEASUREMENT).length} declared not.`,
	);
	for (const n of notes) console.log(`note: ${n}`);
	if (failures.length > 0) {
		for (const f of failures) console.error(`::error::scheduled measurements: ${f}`);
		console.error(`\nscheduled measurements: ${failures.length} failure(s).`);
		process.exit(1);
	}
	console.log("\nscheduled measurements: OK");
} else {
	const ref = `origin/${defaultBranchName()}`;
	const { workflows, files } = readRef(ref);
	const { failures } = analyse({
		workflows,
		files,
		measurements: SCHEDULED_MEASUREMENTS,
		notMeasurements: NOT_A_MEASUREMENT,
		mode: "cross",
		ref,
	});
	console.log(`scheduled measurements: comparing against ${ref} (the branch a schedule: actually runs).`);
	if (failures.length > 0) {
		for (const f of failures) console.error(`::error::scheduled measurements: ${f}`);
		console.error(
			`\nscheduled measurements: ${failures.length} finding(s) on ${ref}. This step ANNOTATES and does not ` +
				`block — see the header for why a branch-comparison must never gate a PR.`,
		);
		process.exit(1);
	}
	console.log(`\nscheduled measurements: ${ref} publishes every declared artifact. OK`);
}
