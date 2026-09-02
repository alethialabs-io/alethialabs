#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// The console UI conformance scoreboard — `apps/console/docs/ui-conformance/RUBRIC.md`'s STATIC
// families, scored over the derived private route set and rendered into two generated artifacts:
//
//   apps/console/docs/ui-conformance/scoreboard.md   the report a person reads (marker-spliced)
//   apps/console/ui-conformance-baseline.json        the same view, machine-readable
//
//   pnpm -F console audit:report            check both are in sync with the tree; exit 2 if not
//   pnpm -F console audit:report --write    regenerate them
//   pnpm -F console audit:report --json     print the derived view, write nothing
//   pnpm -F console audit:report --self-test
//
//   node apps/console/scripts/audit-report.mjs --import-live=<dir> --run=<url> --commit=<sha>
//                                           refresh apps/console/ui-conformance-live.json from a
//                                           CI run's `ui-audit` artifact. See THE LIVE HALF below.
//
// Do NOT pipe it. `node scripts/audit-report.mjs | tail` reports TAIL's exit code.
//
// ── THIS IS A REPORT, NOT A THIRD BASELINE ───────────────────────────────────────────────────
//
// Two files in this repo are the source of truth for console conformance, and this is neither of
// them: `apps/console/route-states-baseline.yaml` (the S1–S4 / T1–T4 ratchet) and
// `apps/console/shared-surface-allowlist.yaml` (the H-family ledgers). Every number below is
// DERIVED from those two plus the tree. If you find yourself wanting to record a fact here that
// neither of them holds, that fact belongs in one of them.
//
// What the two generated files buy that the two ledgers do not: the ledgers are per-FILE and
// per-PREDICATE, and nothing joined them to a ROUTE. "Which pages are worst" was an impression.
// The rebuild lanes are supposed to be ranked by it.
//
// ── THE ORDERING THIS UNIT EXISTS FOR ────────────────────────────────────────────────────────
//
// The numbers committed alongside this file were measured on an unmodified `dev`, before any
// conformance lane changed a component. A guard shipped in the same commit as its fix is
// tautological, and this repo has paid for that more than once.
//
// ── WHAT IS SCORED, AND WHAT IS EXPLICITLY NOT ───────────────────────────────────────────────
//
// The rubric defines 34 predicates in five families. This file now scores 26 of them:
//
//   S1–S4, T1–T4     STATIC, `scripts/check-route-states.mjs`.
//   H1–H2, H4–H9     STATIC, `scripts/check-shared-surface.mjs`. Eight of the nine H rows.
//   T5–T7, R1–R7     LIVE. The Playwright `audit` project measures them in CI; this file joins
//                    its committed records to the same route set. Ten predicates — #3634.
//
// The remaining eight are rendered as `—` with the reason and the issue that owns them, NEVER
// omitted and never rendered as a pass:
//
//   H3             `StatusBadge`. There is no matcher and there cannot easily be one — a page
//                  that should have shown a status pill and showed a `<Badge>` has no negative
//                  form to grep for, which `check-shared-surface.mjs`'s own header records as
//                  the reason it stays prose.
//   F1–F7          the filter standard. Nothing in the tree implements this family at all, and
//                  F7 is a unit test by design (RUBRIC.md's own note).
//
// A report whose "nothing found" branch is indistinguishable from "nothing measured" is the
// dominant defect class in this repo, so the classification above is CHECKED rather than
// documented: `partitionPredicates()` raises unless every predicate the rubric defines is in
// exactly one of {scored statically, live, declared un-instrumented}, and unless every entry
// in the declared tables is a predicate the rubric actually defines. Add a row to the rubric and
// this file refuses to run until somebody says which of the three it is.
//
// ── THE RULE-ID → PREDICATE MAPPING, AND THE RULE THAT USED TO MAP TO NOTHING (#3798) ────────
//
// `check-shared-surface.mjs` names its rules after CLAUDE.md §6's table rows, not after the
// rubric: `format`, `page_title`, `section_header`, `type_scale`, `empty_state`, `stat_strip`,
// `layer_token`, `data_table`. Seven of those eight were an H row. `empty_state` was not — the
// rubric's H table had no empty-state row, because it files the empty state as **T5**, which it
// declares LIVE ("driven against an empty org, the rendered empty region resolves to
// `@repo/ui/empty`"). Its 18 occurrences were counted in the reconciliation and scored nowhere.
//
// #3798 asked for a decision, not a mechanical fix, and this is it: **the rubric gains H9** —
// "the empty state renders through `EmptyState`, statically" — and `empty_state` maps to it. The
// alternative was to fold the matcher into T5, and that is exactly what this file's reconciliation
// section refused to do: the static matcher asks "does this file hand-roll a centred empty
// region?" and T5 asks "against an empty org, what did the empty region resolve to?". They are two
// questions with two answers, and a page can fail either one while passing the other — it can
// import `EmptyState` and still render a blank region when the list is empty, and it can hand-roll
// a centred div that the audit's empty org never reaches. One predicate per question is the
// rubric's own structure, so the count moved 33 → 34 rather than one instrument being reported as
// another.
//
// `RULES_WITHOUT_A_PREDICATE` therefore stands EMPTY. It is kept, not deleted: it is the table a
// ninth matcher lands in, and `buildView()` still raises on a rule id that is in neither it nor
// `RULE_PREDICATE`.
//
// ── HOW AN H FINDING BECOMES A ROUTE'S VERDICT ───────────────────────────────────────────────
//
// The shared-surface guard is per FILE. A route is a page file. The join is the page's own module
// closure: every `@/…` or relative import reachable from `page.tsx`, transitively.
//
// The LAYOUT CHAIN IS DELIBERATELY NOT IN IT, and the reason is measured. Adding the layouts
// pulls in `AppShell` → the sidebar → the org switcher → very nearly the whole console: every
// route's closure lands between 477 and 563 files and the H column stops discriminating between
// pages entirely. Page-only closures run from 1 to 383. The S family already measures the shell,
// which is the half a layout owns.
//
// The cost of that choice, stated rather than left for a reader to discover: a defect that lives
// ONLY in the shared chrome is in no route's H column. It is not invisible — the reconciliation
// counts it under "reachable only from the shared layout chain" and names every file — but it is
// not scored, because attributing the sidebar's drift to all 40 routes would say the console is
// 40 times worse than it is and would move all 40 numbers when one file is fixed.
//
// An occurrence is a defect unless a `reason:` entry in the allowlist covers it. A `lifts:` entry
// does NOT excuse it: `lifts:` is measured drift a named lane will remove, and RUBRIC.md says so
// for H8 in as many words — "a page scores FAIL on H8 today and the number can only shrink". The
// two ledgers being different things is CLAUDE.md §6's own rule; this is that rule, applied.
//
// ── THE STATIC H HALF EMITS NO N/A AT ALL ────────────────────────────────────────────────────
//
// The rubric declares content-derived N/A reasons for four H rows — `renders-no-table`,
// `renders-no-formatted-value`, `declares-no-z-index`, `renders-no-status`. A static matcher
// cannot produce any of them: "this page has no table" and "this page's table is correct" are the
// same observation, zero findings. Claiming the N/A would shrink the denominator on evidence that
// does not bear on it, which is precisely the escape RUBRIC.md's rule 2 exists to close.
//
// So the static H half emits PASS or FAIL and nothing else. A page with no table PASSES H4 — it
// does not hand-roll a table. That widens the denominator, which is the conservative direction: it
// can only lower a score, never raise one. The four redirect-only routes therefore pass every H
// row trivially, on a closure of one file that renders nothing; the totals row separates them out.
//
// ── WHY check-shared-surface.mjs IS READ THROUGH A CHILD PROCESS ─────────────────────────────
//
// That module has no entrypoint guard: importing it RUNS the whole guard at import time and can
// `process.exit(1)` before a single line of this file executes. `scripts/lib/console-routes.mjs`
// records the same obstacle in its own header. So it is imported in a child, with `process.argv`
// arranged so the module takes its `--self-test` branch — which returns normally instead of
// scanning — and the child then calls the exported `scan()` and `parseAllowlist()` itself and
// prints JSON after a sentinel.
//
// That shape is worth more than a workaround: it makes the shared-surface guard's own fixture
// suite a PRECONDITION of this report. Two instruments, two positive controls, both run before
// anything is scored — `positiveControl()` from `check-route-states.mjs` is called directly for
// the same reason.
//
// It is a shim, and it has an owner: **#3788 / PR #3794** adds that entrypoint guard. It was open
// and unmerged when this landed — `dev` was still at 5b48fbc4 — which is why the shim is here and
// not a plain `import`. The moment #3794 lands, `readSharedSurface()` collapses to
// `import { scan, parseAllowlist } from "…/check-shared-surface.mjs"` and everything else in this
// file stays as it is.
//
// The argv line is written so that landing #3794 changes nothing about CORRECTNESS in the
// meantime: with an entrypoint guard, `argv[1]` does not resolve to that module, so it runs
// NOTHING at import and the child still reaches the exported `scan()`. What is lost in that world
// is the self-test precondition, and the vacuity assertions below — which this file computes for
// itself out of `scan()`'s own census — are what still refuse a scan that read nothing. Neither
// control is load-bearing alone, which is the point of having both.
//
// `check()` is deliberately NOT the export used. It returns `{problems, census, perRule, allowed,
// entries, decisions, debt}` and no findings, so it cannot answer "which occurrence is in which
// file" — which is the entire join this report is built on. `scan()` and `parseAllowlist()` are
// exported both before and after #3794.
//
// ── THE LIVE HALF — TWO ARTIFACTS, TWO PERSONAS, TWO ORGANISATIONS (#3634) ───────────────────
//
// The live predicates are measured by the Playwright `audit` project, which writes TWO files:
//
//   test-results/ui-audit.json              routes.spec.ts       T5, T6, R1–R7 · the run's owner,
//                                                                in a fresh EMPTY organisation
//   test-results/ui-audit-permissions.json  permissions.spec.ts  T7 · the `member` persona, in a
//                                                                SECOND organisation of its own
//
// **They are joined, never pooled**, and `apps/console/e2e/audit/report.ts`'s header records what
// pooling them cost: both specs load into one process under `workers: 1`, and one module-level
// array meant `permissions.spec` recorded ~35 T7 verdicts which `routes.spec` then appended 360 of
// its own to, writing all 395 into `ui-audit.json` — the primary scoreboard silently gaining a T7
// column measured in a different organisation. `LIVE_SECTIONS` makes that failure structural here
// too: each section declares the predicates it may carry, the two lists must be disjoint and must
// together be the whole live set, and a record whose predicate is not its section's RAISES.
//
// **The records are COMMITTED, in `apps/console/ui-conformance-live.json`.** They have to be: a
// file that appears only after somebody ran Playwright locally would make the generated files
// disagree between two clean checkouts, which is the same objection this header raised before the
// live half existed. `--import-live=<dir>` produces it from a CI run's `ui-audit` artifact, and
// requires `--run=` and `--commit=` — a baseline nobody can cite the provenance of is not one.
//
// **THE IMPORT STRIPS EVERY RUN-DEPENDENT BYTE.** `generatedAt` is a wall clock; `url` carries the
// run's own org slug; `evidence` carries timestamps, `localhost` URLs, base-ui element ids and
// millisecond timings, every one of which changes on a re-run of an unchanged tree. What survives
// is `{route, predicate, verdict, reason?, detail?}`, where `detail` is a per-predicate summary
// built by `summariseLiveEvidence()` out of the parts that are properties of the PAGE rather than
// of the run — an axe rule id, a count of overlapping pairs, the widths a defect appears at. That
// function RAISES on an evidence shape it does not recognise, so a new one is loud rather than
// silently summarised as nothing.
//
// **A gap is NOT MEASURED, never N/A and never a pass.** `permissions.spec` drives only the
// org-only routes — 27 of 40 — so T7 has no record for the 13 parameterised ones. An N/A there
// would be a claim about the PAGE ("this predicate does not apply"), and RUBRIC.md's rule 2 says
// an N/A must be derivable from the route record. "The instrument did not reach this route" is a
// claim about the INSTRUMENT, which is exactly what #3854 built `NOT MEASURED` for. It renders as
// its own column and is never folded into N/A, and `score` stays PASS ÷ (PASS + FAIL) — a withheld
// predicate leaves the denominator and scores `null`, never 1.
//
// **Nothing may be suppressed.** R5, R6 and R7 declare NO N/A reason at all (RUBRIC.md:199,
// mirrored in `report.ts`), so an N/A on one of them is a parse error here, not a verdict. And a
// live predicate that FAILS must name the issue that owns the failure in `LIVE_DEBT` — checked in
// both directions, so a debt row that stops being true fails the build as loudly as a missing one.
//
// ── NO WALL CLOCK, AND NO UNCOMMITTED INPUT ──────────────────────────────────────────────────
//
// Two constraints inherited from `scripts/programme-rollup.mjs`, which learned both the hard way:
//
//   · nothing time-dependent may be rendered into a diff-gated region, or every PR is stale on
//     arrival. `--self-test` asserts the rendered text carries no date;
//   · the only inputs are COMMITTED files — the tree, the two ledgers, and now the imported live
//     records. `test-results/ui-audit*.json` is still never read by `--write` or by the bare
//     check; it is read once, explicitly, by `--import-live`.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { collectConsoleRoutes, stripCommentLines } from "../../../scripts/lib/console-routes.mjs";
import {
	NA_REASONS as ROUTE_STATE_NA_REASONS,
	PREDICATES as ROUTE_STATE_PREDICATES,
	positiveControl,
	runOver,
} from "../../../scripts/check-route-states.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_DIR = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(CONSOLE_DIR, "..", "..");

const RUBRIC = "apps/console/docs/ui-conformance/RUBRIC.md";
const SCOREBOARD = "apps/console/docs/ui-conformance/scoreboard.md";
const BASELINE_JSON = "apps/console/ui-conformance-baseline.json";
const LIVE_JSON = "apps/console/ui-conformance-live.json";
const LIVE_REPORT_TS = "apps/console/e2e/audit/report.ts";
const ALLOWLIST = "apps/console/shared-surface-allowlist.yaml";
const ROUTE_STATES_BASELINE = "apps/console/route-states-baseline.yaml";
const SHARED_SURFACE = "scripts/check-shared-surface.mjs";

const BEGIN = "<!-- BEGIN GENERATED: audit-report · tree-derived · DO NOT EDIT BELOW -->";
const END = "<!-- END GENERATED: audit-report -->";

/**
 * The joiner for this file's own composite map keys (`rule` + `file`). Written as an escape rather
 * than as a literal, because a raw NUL byte in a source file makes `rg` and `grep -r` report
 * "binary file matches" and print nothing — `check-shared-surface.mjs` carries that incident in its
 * own self-test.
 */
const KEY = "\u0000";

/** Any control character, for splitting a separator another module owns and does not export. */
const CONTROL_CHAR = /[\u0000-\u001f]/;

/** The rubric's five families, in the order it declares them. */
export const FAMILIES = /** @type {const} */ ({
	S: "shell & width",
	T: "states",
	H: "shared surface",
	F: "filter standard",
	R: "rendered integrity",
});

/**
 * `check-shared-surface.mjs`'s rule ids → the RUBRIC.md predicate each one measures.
 *
 * Written out rather than inferred, because the two vocabularies genuinely differ: the guard is
 * named after CLAUDE.md §6's table rows and the rubric after its own families, and the H table
 * lists them in the order H1, H2, H8, H3…H7. `--self-test` pins every pair.
 */
export const RULE_PREDICATE = /** @type {const} */ ({
	page_title: "H1",
	section_header: "H2",
	data_table: "H4",
	format: "H5",
	stat_strip: "H6",
	layer_token: "H7",
	type_scale: "H8",
	empty_state: "H9",
});

/**
 * The guard rules that map to NO rubric predicate, each with the reason and the issue that owns
 * it. A rule id observed in the tree that is in neither this table nor `RULE_PREDICATE` RAISES —
 * a matcher whose findings fall out of the report must not be able to do so quietly.
 *
 * **It is deliberately EMPTY**, and it is kept rather than deleted. `empty_state` was its only
 * entry; #3798 gave the rubric its H9 row and the mapping above absorbed it. A ninth matcher that
 * measures something the rubric has no row for lands here, with its owning issue, rather than
 * falling silently out of the reconciliation — which is the whole reason the table exists.
 */
export const RULES_WITHOUT_A_PREDICATE = /** @type {const} */ ({});

/**
 * Every rubric predicate the STATIC half of this file does not score, and where its verdict comes
 * from instead. Checked against the rubric in both directions by `partitionPredicates()`.
 *
 * `kind: "live"` — measured by the Playwright `audit` project and joined in from
 *                  `apps/console/ui-conformance-live.json`. `section` names which of the two
 *                  artifacts carries it; see `LIVE_SECTIONS`.
 * `kind: "none"` — nothing measures this predicate anywhere, today. `owner` is the issue that
 *                  will build the instrument.
 */
export const NOT_SCORED_STATICALLY = /** @type {const} */ ({
	T5: { kind: "live", section: "routes", why: "the empty state as RENDERED, against a seeded empty org." },
	T6: { kind: "live", section: "routes", why: "the error state as RENDERED, under fault injection." },
	T7: { kind: "live", section: "permissions", why: "permission-denied as RENDERED, as the `member` persona, in an organisation of its own." },
	R1: { kind: "live", section: "routes", why: "horizontal overflow at four viewport widths." },
	R2: { kind: "live", section: "routes", why: "overlay stacking, by hit-testing — a class name is a rendering of the intent, not the stacking." },
	R3: { kind: "live", section: "routes", why: "exactly one scroll container, and it is the shell's." },
	R4: { kind: "live", section: "routes", why: "no two interactive elements overlap." },
	R5: { kind: "live", section: "routes", why: "axe, at wcag2a/wcag2aa." },
	R6: { kind: "live", section: "routes", why: "console errors and failed requests." },
	R7: { kind: "live", section: "routes", why: "interactive within the route's budget." },
	H3: {
		kind: "none",
		owner: "#3797",
		why:
			"StatusBadge. `check-shared-surface.mjs` records why this row stays prose: a page that " +
			"should have shown a status pill and showed a `<Badge>` has no negative form to grep for.",
	},
	F1: { kind: "none", owner: "#3796", why: "the filter standard — a `createFilterStore` store exists for the page." },
	F2: { kind: "none", owner: "#3796", why: "the filter standard — `useFilterUrlSync` is wired." },
	F3: { kind: "none", owner: "#3796", why: "the filter standard — search is debounced and the normalized query is the TanStack key." },
	F4: { kind: "none", owner: "#3796", why: "the filter standard — the bar is built from the shared filter components." },
	F5: { kind: "none", owner: "#3796", why: "the filter standard — the result count is a `CountPill`." },
	F6: { kind: "none", owner: "#3796", why: "the filter standard — `keepPreviousData` plus the placeholder dim." },
	F7: { kind: "none", owner: "#3796", why: "the filter standard — the server builder's separate unfiltered facet pass. A unit test by design, per RUBRIC.md." },
});

// ── the live half: two artifacts, two personas, two organisations ────────────────────────────

/**
 * The two files the Playwright `audit` project writes, and the predicates each one may carry.
 *
 * The split is not a detail of how the specs happen to be organised — it is the correctness
 * property. `apps/console/e2e/audit/report.ts` records what pooling them cost: `permissions.spec`
 * measures the `member` persona in an organisation of its OWN, and its records once ended up in
 * `ui-audit.json` alongside `routes.spec`'s, giving the primary scoreboard a T7 column measured in
 * a different org and reporting every T7 verdict twice.
 *
 * So the `predicates` lists are CHECKED, by `livePredicateSections()`: they must be disjoint, and
 * together they must be exactly the live set `NOT_SCORED_STATICALLY` declares. A record whose
 * predicate is not its section's raises at parse time.
 */
export const LIVE_SECTIONS = /** @type {const} */ ({
	routes: {
		artifact: "test-results/ui-audit.json",
		spec: "apps/console/e2e/audit/routes.spec.ts",
		persona: "the run's own owner",
		org: "a fresh, empty organisation created for the run",
		covers: "every route the manifest names",
	},
	permissions: {
		artifact: "test-results/ui-audit-permissions.json",
		spec: "apps/console/e2e/audit/permissions.spec.ts",
		persona: "the `member` persona, compared against the owner of the same org",
		org: "a SECOND organisation, created by that spec and never touched by the primary run",
		covers: "only the org-only routes; the parameterised ones need a project the persona cannot be given",
	},
});

/**
 * The N/A reasons each live predicate declares, mirrored from `apps/console/e2e/audit/report.ts`.
 *
 * A DECISION MUST MIRROR ITS EMITTER. This table is the reader's half of the recorder's rule, and
 * a hand-written copy of somebody else's list is exactly the thing that stops matching silently —
 * so `--self-test` parses `report.ts`'s own `NA_REASONS` out of the file and asserts the two are
 * identical, key for key and reason for reason.
 *
 * The three empty lists are the point of the table. R5, R6 and R7 are "never N/A" in RUBRIC.md,
 * which means an N/A on one of them is a PARSE ERROR here rather than a verdict: the rubric's whole
 * warning is that escaping a predicate makes a page's score go up with nothing red anywhere.
 */
export const LIVE_NA_REASONS = /** @type {const} */ ({
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
});

/**
 * Every live predicate that FAILS somewhere, and the issue that owns the failure.
 *
 * RUBRIC.md's bargain for the live half is that nothing gets suppressed: what still fails when the
 * baseline lands becomes recorded debt naming its owner. `buildView()` checks this table in BOTH
 * directions — a live predicate with a FAIL and no row here raises, and a row here for a predicate
 * that no longer fails raises too. The second direction is the one that matters over time: a debt
 * ledger nobody is forced to shrink is a ledger that stops being true.
 */
export const LIVE_DEBT = /** @type {const} */ ({
	R3: {
		owner: "#3885",
		why:
			"two nested scroll containers that are not the shell's — a chip `ScrollArea` on " +
			"`~/support/ask` and a `@repo/ui/table` wrapper on `[project]/environments` — each " +
			"overflowing by 3px at all four widths. Trustworthy for the first time now that #3804 " +
			"has made R3's own positive control green.",
	},
	R4: {
		owner: "#3805",
		why:
			"ONE shell defect, not N page defects: `components/shell/topbar.tsx` centres the " +
			"breadcrumb out of flow (`absolute left-1/2`) beside an `ml-auto` action cluster that " +
			"nothing reserves space for, so the two collide from `md:` up. #3805 keeps it " +
			"deliberately rather than folding it into #3619 — the fix is a layout decision, and only " +
			"R4's geometry can prove either answer.",
	},
	R5: {
		owner: "#3805",
		why:
			"the axe residue. `color-contrast` fails EVERY failing route on its own, so R5 cannot " +
			"move at all until that clears — `button-name` went 3 → 0 in #3756 and the score did not " +
			"budge. The console is dark-first and grayscale by design, so each node is a judgement " +
			"between a token fix in `packages/brand/src/tokens.css` and a recorded decision.",
	},
	R6: {
		owner: "#3805",
		why:
			"two routes. `~/connectors` fires 400s from `/_next/image` for connector icons that do " +
			"not exist (#3802, fixed by #3876); `[project]/…/support/cases/[id]` 404s the parent " +
			"list route's RSC prefetch ~70 times in one visit, which is a prefetch storm as well as " +
			"a 404.",
	},
});

/**
 * Which section owns which live predicate, checked in both directions.
 *
 * @returns {Map<string, string>} predicate id → section key
 */
export function livePredicateSections(notScored = NOT_SCORED_STATICALLY, sections = LIVE_SECTIONS) {
	/** @type {Map<string, string>} */
	const owned = new Map();
	/** @type {string[]} */
	const problems = [];
	for (const [id, meta] of Object.entries(notScored)) {
		if (meta.kind !== "live") continue;
		if (!(meta.section in sections)) {
			problems.push(`${id} declares section \`${meta.section}\`, which LIVE_SECTIONS does not define.`);
			continue;
		}
		owned.set(id, meta.section);
	}
	if (owned.size === 0) {
		problems.push("no predicate is declared live at all — the live half would score nothing and say nothing.");
	}
	for (const key of Object.keys(sections)) {
		if ([...owned.values()].includes(key)) continue;
		problems.push(
			`the \`${key}\` section (${sections[key].artifact}) owns NO predicate. An artifact nothing ` +
				`reads is an artifact whose absence looks exactly like a clean run.`,
		);
	}
	if (problems.length > 0) throw new Error(`the live section map is broken:\n  - ${problems.join("\n  - ")}`);
	return owned;
}

/** Any ISO date, any clock time, any absolute URL — the shapes that must never reach a detail. */
const RUN_DEPENDENT = /\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}|https?:\/\//;

/**
 * One line of diagnosis for a FAILing live verdict, out of the parts of its evidence that are
 * properties of the PAGE rather than of the run.
 *
 * The evidence a Playwright record carries is mostly run-dependent: `at` timestamps, `localhost`
 * URLs, base-ui's generated element ids (`base-ui-_r_2_`), and millisecond timings that differ on
 * every runner. Committing any of it would make the generated files churn on a re-run of an
 * unchanged tree, which is the same objection that keeps a wall clock out of the diff-gated region.
 *
 * So each shape gets an explicit summary, and **an unrecognised shape RAISES**. The alternative —
 * falling back to "see the artifact" — is the failure mode this repo names most often: a new
 * evidence shape would summarise as nothing and read exactly like a page with no diagnosis to give.
 *
 * @param {string} predicate
 * @param {unknown} evidence
 * @returns {string}
 */
export function summariseLiveEvidence(predicate, evidence) {
	const at = (widths) => ` at ${widths.map((w) => `${w}w`).join(", ")}`;
	const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
	const isAre = (n) => (n === 1 ? "is" : "are");
	/**
	 * THE SUMMARY MUST MIRROR THE VERDICT. Every branch below re-derives, from the same evidence,
	 * the thing the recorder said was wrong; if it re-derives NOTHING then this file and
	 * `routes.spec.ts` disagree about the threshold, and the honest output is a refusal rather than
	 * "0 overlapping pairs" — a diagnosis that contradicts the verdict it is attached to.
	 */
	const nonEmpty = (n, what) => {
		if (n > 0) return n;
		throw new Error(
			`${predicate}: the record is a FAIL and this summary finds no ${what} in its evidence. The ` +
				`recorder and this file have come apart on what the predicate measures.`,
		);
	};
	const detail = (() => {
		if (predicate === "R1") {
			const bad = asArray(evidence, predicate).filter((m) => Number(m.scrollWidth) > Number(m.clientWidth) + 1);
			nonEmpty(bad.length, "overflowing width");
			return `the body overflows horizontally${at(bad.map((m) => m.width))}`;
		}
		if (predicate === "R3") {
			const rows = asArray(evidence, predicate);
			const bad = rows.filter(
				(m) => m.containers.length > 1 || (m.containers.length === 1 && m.containers[0].isShellScroller !== true),
			);
			nonEmpty(bad.length, "width with a scroll container that is not the shell's");
			const most = Math.max(...bad.map((m) => m.containers.length));
			return `${plural(most, "scroll container")} that ${isAre(most)} not the shell's${at(bad.map((m) => m.width))}`;
		}
		if (predicate === "R4") {
			const rows = asArray(evidence, predicate);
			nonEmpty(rows.length, "overlapping pair");
			const widths = [...new Set(rows.map((o) => o.width))];
			return `${plural(rows.length, "overlapping pair")} of interactive elements${at(widths)}`;
		}
		if (predicate === "R2") {
			const probes = asArray(evidence, predicate);
			const missed = probes.filter((pr) => (pr.points ?? []).some((pt) => pt.inside !== true));
			nonEmpty(missed.length, "overlay whose hit-test landed outside it");
			const kinds = [...new Set(missed.map((pr) => pr.kind))].sort();
			return `${plural(missed.length, "overlay")} hit-tested below the chrome — ${kinds.join(", ")}`;
		}
		if (predicate === "R5") {
			const violations = asArray(evidence, predicate);
			nonEmpty(violations.length, "axe violation");
			return violations.map((v) => `${v.id} (${v.impact}) ×${v.nodes}`).sort().join(", ");
		}
		if (predicate === "R6") {
			const signals = asArray(evidence, predicate);
			nonEmpty(signals.length, "console error or failed request");
			const consoles = signals.filter((g) => g.kind === "console").length;
			const responses = signals.filter((g) => g.kind === "response");
			const statuses = [...new Set(responses.map((g) => g.status))].sort((a, b) => a - b);
			// The record is capped at 10 by routes.spec.ts, so these are counts of what was KEPT.
			return (
				`${plural(consoles, "console error")}, ${plural(responses.length, "failed request")}` +
				`${statuses.length > 0 ? ` (${statuses.join(", ")})` : ""}, of the first 10 recorded`
			);
		}
		if (predicate === "R7") {
			// The p95 itself is a property of the runner, not of the page. The BUDGET is a constant.
			const e = asObject(evidence, predicate);
			nonEmpty(Number(e.budgetMs) || 0, "budget");
			return `p95 over the route's ${e.budgetMs}ms budget`;
		}
		if (predicate === "T5") {
			const e = asObject(evidence, predicate);
			nonEmpty((e.handRolled ?? []).length, "hand-rolled empty region");
			return `${plural(e.handRolled.length, "hand-rolled empty region")}, none resolving to @repo/ui/empty`;
		}
		if (predicate === "T6") {
			const e = asObject(evidence, predicate);
			return `the injected fault did not render components/errors/error-state${e.shellSurvived === true ? " (the shell survived)" : ""}`;
		}
		if (predicate === "T7") {
			const e = asObject(evidence, predicate);
			return e.redirectedAway === true
				? "the member is refused and is redirected away rather than shown a state"
				: "the member is refused and the page renders a blank, not a deliberate state";
		}
		throw new Error(`${predicate}: no evidence summariser. Every live predicate needs one, or its FAILs land with no diagnosis.`);
	})();
	if (RUN_DEPENDENT.test(detail)) {
		throw new Error(
			`${predicate}: the summary ${JSON.stringify(detail)} carries a timestamp or a URL. A ` +
				`run-dependent byte in a committed record makes every later PR stale on arrival.`,
		);
	}
	return detail;
}

/** @param {unknown} e @param {string} predicate */
function asArray(e, predicate) {
	if (!Array.isArray(e)) {
		throw new Error(`${predicate}: expected an array of evidence rows and got ${describe(e)}. The recorder's shape changed.`);
	}
	return e;
}

/** @param {unknown} e @param {string} predicate */
function asObject(e, predicate) {
	if (typeof e !== "object" || e === null || Array.isArray(e)) {
		throw new Error(`${predicate}: expected an evidence object and got ${describe(e)}. The recorder's shape changed.`);
	}
	return e;
}

/** @param {unknown} v */
const describe = (v) => (v === null ? "null" : Array.isArray(v) ? "an array" : typeof v);

/**
 * Reduce the two raw Playwright artifacts to the committed record set. `--import-live`.
 *
 * @param {{routes: unknown, permissions: unknown}} raw parsed `test-results/ui-audit*.json`
 * @param {{run: string, commit: string}} provenance
 */
export function importLive(raw, provenance) {
	const owned = livePredicateSections();
	if (!provenance.run || !provenance.commit) {
		throw new Error("--import-live needs both --run=<url or id> and --commit=<sha>: a baseline nobody can cite is not one.");
	}
	/** @type {Record<string, {runKey: string, records: object[]}>} */
	const runs = {};
	for (const [key, section] of Object.entries(LIVE_SECTIONS)) {
		const body = raw[key];
		if (typeof body !== "object" || body === null || !Array.isArray(body.records)) {
			throw new Error(`${section.artifact}: no \`records\` array. That is a missing or truncated artifact, not an empty run.`);
		}
		if (body.records.length === 0) {
			throw new Error(`${section.artifact}: ZERO records. A run that measured nothing must not import as a clean board.`);
		}
		if (typeof body.runKey !== "string" || body.runKey.length === 0) {
			throw new Error(`${section.artifact}: no \`runKey\`. Without it there is nothing to tell two runs apart.`);
		}
		const records = body.records
			.map((r) => {
				if (owned.get(r.predicate) !== key) {
					throw new Error(
						`${section.artifact} carries a ${r.predicate} record for ${r.route}, and ${r.predicate} ` +
							`belongs to the \`${owned.get(r.predicate) ?? "(unknown)"}\` section. This is the pooling ` +
							`failure e2e/audit/report.ts records — two personas in two organisations, one file.`,
					);
				}
				/** @type {{route: string, predicate: string, verdict: string, reason?: string, detail?: string}} */
				const out = { route: r.route, predicate: r.predicate, verdict: r.verdict };
				if (r.verdict === "N/A" || r.verdict === "NOT MEASURED") out.reason = r.reason;
				if (r.verdict === "FAIL") out.detail = summariseLiveEvidence(r.predicate, r.evidence);
				return out;
			})
			.sort((a, b) => a.route.localeCompare(b.route) || a.predicate.localeCompare(b.predicate));
		runs[key] = { runKey: body.runKey, records };
	}
	const body = {
		$comment: [
			`IMPORTED — the live half of ${RUBRIC}, measured by the Playwright \`audit\` project in CI.`,
			`Refresh with \`node apps/console/scripts/audit-report.mjs --import-live=<dir> --run=<url> --commit=<sha>\`,`,
			"then regenerate the two derived files with `pnpm -F console audit:report --write`.",
			"No wall clock, no URL, no per-run element id: every byte here is a property of the tree that was measured.",
		],
		version: 1,
		source: { run: provenance.run, commit: provenance.commit },
		runs: Object.fromEntries(
			Object.entries(LIVE_SECTIONS).map(([key, section]) => [
				key,
				{
					artifact: section.artifact,
					spec: section.spec,
					persona: section.persona,
					org: section.org,
					covers: section.covers,
					runKey: runs[key].runKey,
					records: runs[key].records,
				},
			]),
		),
	};
	return `${JSON.stringify(body, null, "\t")}\n`;
}

/** The four verdicts, in the order RUBRIC.md and `e2e/audit/report.ts` declare them. */
const VERDICTS = ["PASS", "FAIL", "N/A", "NOT MEASURED"];

/**
 * Read and validate `apps/console/ui-conformance-live.json`.
 *
 * Every rule the recorder enforces at the point a verdict is written is enforced again here, at the
 * point one is read — because the file in between is committed, hand-editable, and the thing a
 * reader will be tempted to "fix" when a number is inconvenient.
 *
 * @param {string} text
 */
export function parseLive(text) {
	const owned = livePredicateSections();
	/** @type {unknown} */
	let body;
	try {
		body = JSON.parse(text);
	} catch (err) {
		throw new Error(`${LIVE_JSON}: not valid JSON (${err instanceof Error ? err.message : String(err)}).`);
	}
	if (typeof body !== "object" || body === null || body.version !== 1) {
		throw new Error(`${LIVE_JSON}: expected \`version: 1\`. Refusing to read an artifact of an unknown shape.`);
	}
	if (typeof body.source?.run !== "string" || typeof body.source?.commit !== "string") {
		throw new Error(`${LIVE_JSON}: \`source.run\` and \`source.commit\` are required — a baseline nobody can cite is not one.`);
	}
	/** @type {Record<string, {runKey: string, records: {route: string, predicate: string, verdict: string, reason?: string, detail?: string}[]}>} */
	const sections = {};
	/** @type {Set<string>} */
	const seen = new Set();
	for (const [key, section] of Object.entries(LIVE_SECTIONS)) {
		const run = body.runs?.[key];
		if (typeof run !== "object" || run === null || !Array.isArray(run.records)) {
			throw new Error(`${LIVE_JSON}: \`runs.${key}\` is missing or has no records. ${section.artifact} was never imported.`);
		}
		// The file restates what its section is — which artifact, which persona, which organisation —
		// so that a reader of the JSON alone knows. A restatement that can drift is worse than none,
		// so it is CHECKED against LIVE_SECTIONS rather than trusted: change the constant and the
		// committed file must be re-imported in the same commit.
		for (const field of ["artifact", "spec", "persona", "org", "covers"]) {
			if (run[field] !== section[field]) {
				throw new Error(
					`${LIVE_JSON}: \`runs.${key}.${field}\` says ${JSON.stringify(run[field])} and LIVE_SECTIONS says ` +
						`${JSON.stringify(section[field])}. Re-import: the committed records describe a section that has moved.`,
				);
			}
		}
		for (const r of run.records) {
			if (owned.get(r.predicate) !== key) {
				throw new Error(
					`${LIVE_JSON}: \`runs.${key}\` carries a ${r.predicate} record (${r.route}); ${r.predicate} belongs ` +
						`to \`${owned.get(r.predicate) ?? "(no section)"}\`. The two personas must not be pooled.`,
				);
			}
			if (!VERDICTS.includes(r.verdict)) {
				throw new Error(`${LIVE_JSON}: ${r.predicate} on ${r.route} has verdict ${JSON.stringify(r.verdict)}, which is not one of ${VERDICTS.join(", ")}.`);
			}
			const declared = LIVE_NA_REASONS[r.predicate];
			if (r.verdict === "N/A") {
				if (!r.reason) throw new Error(`${LIVE_JSON}: ${r.predicate} on ${r.route}: an N/A with no reason is not an N/A.`);
				if (!declared.includes(r.reason)) {
					throw new Error(
						`${LIVE_JSON}: ${r.predicate} on ${r.route}: "${r.reason}" is not a declared N/A reason for ` +
							`${r.predicate} (declared: ${declared.length > 0 ? declared.join(", ") : "none — this predicate is NEVER N/A"}). ` +
							`Change the rubric, or the verdict — not the reason.`,
					);
				}
			} else if (r.verdict === "NOT MEASURED") {
				if (!r.reason) throw new Error(`${LIVE_JSON}: ${r.predicate} on ${r.route}: NOT MEASURED with no reason says nothing about the instrument.`);
			} else if (r.reason) {
				throw new Error(`${LIVE_JSON}: ${r.predicate} on ${r.route}: a ${r.verdict} must not carry a reason.`);
			}
			const dupKey = `${r.route}${KEY}${r.predicate}`;
			if (seen.has(dupKey)) {
				throw new Error(`${LIVE_JSON}: ${r.predicate} on ${r.route} is recorded twice. Two verdicts for one cell is two answers.`);
			}
			seen.add(dupKey);
		}
		sections[key] = { runKey: String(run.runKey ?? ""), records: run.records };
	}
	return { source: body.source, sections };
}

/**
 * The vacuity controls for the live half — the same job `scanVacuityProblems()` does for the
 * static one. An empty artifact must RAISE, not score every route N/A.
 *
 * @param {ReturnType<typeof parseLive>} live
 * @param {string[]} routeOrder
 * @returns {string[]}
 */
export function liveVacuityProblems(live, routeOrder) {
	/** @type {string[]} */
	const problems = [];
	const known = new Set(routeOrder);
	const measured = new Set();
	for (const [key, section] of Object.entries(LIVE_SECTIONS)) {
		const rows = live.sections[key].records;
		if (rows.length === 0) {
			problems.push(`the \`${key}\` section (${section.artifact}) holds ZERO records — it measured nothing, which is not the same as finding nothing.`);
			continue;
		}
		const routes = new Set(rows.map((r) => r.route));
		for (const route of routes) {
			if (!known.has(route)) {
				problems.push(`the \`${key}\` section names route \`${route}\`, which the route manifest does not define — the artifact and the tree have drifted apart.`);
			}
		}
		for (const r of rows) measured.add(r.predicate);
	}
	for (const id of livePredicateSections().keys()) {
		if (!measured.has(id)) {
			problems.push(`${id} has NO record in any section — the predicate was never measured, and a report that scored it 0/0 would say so as \`—\`.`);
		}
	}
	return problems;
}

/**
 * Join the live records onto the manifest's route set, filling every gap with NOT MEASURED.
 *
 * A gap is real: `permissions.spec` drives only the org-only routes, so T7 has no record for the
 * parameterised ones. N/A would be a claim about the PAGE and RUBRIC.md's rule 2 forbids one that
 * is not derivable from the route record; PASS would be a verdict from a measurement that never
 * happened. NOT MEASURED is a claim about the INSTRUMENT, which is what it is for.
 *
 * @param {ReturnType<typeof parseLive>} live
 * @param {string[]} routeOrder
 */
export function joinLive(live, routeOrder) {
	const owned = livePredicateSections();
	/** @type {Map<string, {route: string, predicate: string, verdict: string, reason?: string, detail?: string}>} */
	const byCell = new Map();
	for (const key of Object.keys(LIVE_SECTIONS)) {
		for (const r of live.sections[key].records) {
			byCell.set(`${r.route}${KEY}${r.predicate}`, {
				route: r.route,
				predicate: r.predicate,
				verdict: r.verdict,
				...(r.reason === undefined ? {} : { reason: r.reason }),
				...(r.detail === undefined ? {} : { detail: r.detail }),
			});
		}
	}
	/** @type {{route: string, predicate: string, verdict: string, reason?: string, detail?: string}[]} */
	const verdicts = [];
	for (const route of routeOrder) {
		for (const [id, key] of owned) {
			const hit = byCell.get(`${route}${KEY}${id}`);
			if (hit !== undefined) {
				verdicts.push(hit);
				continue;
			}
			const section = LIVE_SECTIONS[key];
			verdicts.push({
				route,
				predicate: id,
				verdict: "NOT MEASURED",
				reason: `the \`${key}\` run did not reach this route — it covers ${section.covers}`,
			});
		}
	}
	return verdicts;
}

// ── the rubric is the predicate universe ─────────────────────────────────────────────────────

/**
 * The predicates RUBRIC.md defines, read out of its own tables.
 *
 * DERIVED, not typed. A hand-kept list of what a report covers stops covering silently, and this
 * file's whole subject is a rubric whose own stated count was wrong three different ways at once:
 * the header said twenty-six, the seeding commit said 25, and the tables define 33. Reading the
 * tables makes that class of drift impossible: add a row and the report's denominator moves.
 *
 * The stated count is checked against the rows for the same reason — it is the sentence a reader
 * quotes, so it is the one that must not be able to rot.
 *
 * @param {string} text RUBRIC.md
 * @returns {{stated: number, predicates: {id: string, family: string}[]}}
 */
export function parseRubric(text) {
	/** @type {{id: string, family: string}[]} */
	const predicates = [];
	/** @type {Set<string>} */
	const seen = new Set();
	for (const [i, line] of text.split("\n").entries()) {
		const m = line.match(/^\|\s*\*\*([STHFR])(\d+)\*\*\s*\|/);
		if (m === null) continue;
		const id = `${m[1]}${m[2]}`;
		if (seen.has(id)) {
			throw new Error(`${RUBRIC}:${i + 1}: ${id} is defined twice. Two rows for one predicate is two verdict definitions.`);
		}
		seen.add(id);
		predicates.push({ id, family: m[1] });
	}
	if (predicates.length === 0) {
		throw new Error(
			`${RUBRIC}: no predicate rows (\`| **S1** | …\`) found. That is a broken read of the rubric, ` +
				`not a rubric with nothing in it — every score below would have an empty denominator.`,
		);
	}
	const count = text.match(/\*\*(\d+) predicates\*\*/);
	if (count === null) {
		throw new Error(
			`${RUBRIC}: does not state its own predicate count as \`**N predicates**\`. The count is the ` +
				`sentence readers quote; it is checked against the tables so that it cannot rot.`,
		);
	}
	const stated = Number(count[1]);
	if (stated !== predicates.length) {
		throw new Error(
			`${RUBRIC}: says **${stated} predicates** and its tables define ${predicates.length}. ` +
				`Fix the sentence, or the row that was added without one.`,
		);
	}
	return { stated, predicates };
}

/**
 * Split the rubric's predicates three ways, and refuse anything that does not land in exactly one.
 *
 * Both directions are checked. A rubric row missing from every table means a predicate silently
 * dropped out of the report; a table entry naming a predicate the rubric does not define means the
 * report is describing something that no longer exists.
 *
 * @param {{id: string, family: string}[]} rubricPredicates
 * @param {string[]} scoredHere
 * @param {Record<string, {kind: string, owner: string, why: string}>} notScored
 */
export function partitionPredicates(rubricPredicates, scoredHere, notScored) {
	const defined = new Set(rubricPredicates.map((p) => p.id));
	/** @type {string[]} */
	const problems = [];

	for (const id of scoredHere) {
		if (!defined.has(id)) problems.push(`${id} is scored by this report and RUBRIC.md does not define it.`);
		if (id in notScored) problems.push(`${id} is both scored here and declared not-scored. It cannot be both.`);
	}
	for (const id of Object.keys(notScored)) {
		if (!defined.has(id)) problems.push(`${id} is declared not-scored and RUBRIC.md does not define it.`);
	}
	const scored = new Set(scoredHere);
	for (const p of rubricPredicates) {
		if (scored.has(p.id) || p.id in notScored) continue;
		problems.push(
			`${p.id} is defined by RUBRIC.md and this report neither scores it nor declares why not. ` +
				`Add it to the scored set, or to NOT_SCORED_STATICALLY with its owner — a predicate that falls ` +
				`out of the report silently is the failure this table exists to prevent.`,
		);
	}
	if (problems.length > 0) {
		throw new Error(`the predicate partition is broken:\n  - ${problems.join("\n  - ")}`);
	}
	return { scored: [...scored], live: Object.keys(notScored).filter((k) => notScored[k].kind === "live"), none: Object.keys(notScored).filter((k) => notScored[k].kind === "none") };
}

// ── module closures ──────────────────────────────────────────────────────────────────────────

/** Extensions a module graph may traverse. A `.json` or `.css` import resolves and stops. */
const CODE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * One import specifier per match, over COMMENT-STRIPPED source.
 *
 * `import(` is included so `next/dynamic(() => import("@/components/x"))` is followed — a lazily
 * mounted panel is still something the page renders. `require(` is included for the same reason
 * and finds nothing in the console today.
 */
const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"'\n]+)["']/g;

/**
 * Resolve one specifier the way the console's `moduleResolution: "bundler"` + `@/*` alias does.
 *
 * Anything that is not `@/…` or relative is EXTERNAL and is not followed: `@repo/ui`, `react`,
 * `next/*` are outside the guard's scope by construction, so following them would add files no
 * matcher looks at.
 *
 * A `@/…` or relative specifier that resolves to nothing RAISES. That is the loud direction on
 * purpose — the alternative is a page whose closure quietly lost a subtree, which reads exactly
 * like a page with no findings in it. Measured on `dev`: 0 unresolvable specifiers over the union
 * of all 40 route closures and every layout chain.
 *
 * @param {string} spec
 * @param {string} fromFile absolute
 * @param {(p: string) => "file"|"dir"|null} kindOf
 * @returns {{kind: "external"} | {kind: "code", file: string} | {kind: "asset", file: string}}
 */
export function resolveSpecifier(spec, fromFile, kindOf, consoleDir = CONSOLE_DIR) {
	/** @type {string} */
	let base;
	if (spec.startsWith("@/")) base = path.join(consoleDir, spec.slice(2));
	else if (spec.startsWith("./") || spec.startsWith("../")) base = path.resolve(path.dirname(fromFile), spec);
	else return { kind: "external" };

	for (const ext of CODE_EXTS) if (kindOf(base + ext) === "file") return { kind: "code", file: base + ext };
	if (kindOf(base) === "dir") {
		for (const ext of CODE_EXTS) {
			const idx = path.join(base, `index${ext}`);
			if (kindOf(idx) === "file") return { kind: "code", file: idx };
		}
	}
	if (kindOf(base) === "file") return { kind: "asset", file: base };
	throw new Error(
		`${fromFile}: cannot resolve \`${spec}\`. A module graph that quietly loses a subtree reads ` +
			`exactly like a page with no findings in it, so this raises rather than skipping.`,
	);
}

/**
 * Every console module transitively reachable from `entries`, as repo-relative POSIX paths.
 *
 * @param {string[]} entries absolute paths
 * @param {{readFile: (p: string) => string, kindOf: (p: string) => "file"|"dir"|null, repoRoot?: string, consoleDir?: string}} io
 * @returns {Set<string>}
 */
export function moduleClosure(entries, io) {
	const repoRoot = io.repoRoot ?? REPO_ROOT;
	const consoleDir = io.consoleDir ?? CONSOLE_DIR;
	/** @type {Set<string>} */
	const seen = new Set();
	const stack = [...entries];
	while (stack.length > 0) {
		const file = stack.pop();
		if (seen.has(file)) continue;
		seen.add(file);
		const { lines, unterminated } = stripCommentLines(io.readFile(file));
		if (unterminated) {
			throw new Error(
				`${file}: a block comment is still open at EOF. Everything after the opener was blanked, ` +
					`so this module's imports have NOT been read — refusing rather than reporting a short closure.`,
			);
		}
		const src = lines.join("\n");
		SPECIFIER.lastIndex = 0;
		let m;
		while ((m = SPECIFIER.exec(src)) !== null) {
			const hit = resolveSpecifier(m[1], file, io.kindOf, consoleDir);
			if (hit.kind === "code" && !seen.has(hit.file)) stack.push(hit.file);
		}
	}
	return new Set([...seen].map((f) => path.relative(repoRoot, f).split(path.sep).join("/")).sort());
}

// ── the shared-surface guard, read through a child process ───────────────────────────────────

const SENTINEL = "---audit-report-json---";

/**
 * `scan()` and `parseAllowlist()` from `scripts/check-shared-surface.mjs`, without that module's
 * import-time guard running in this process. See the header for why this is a child.
 *
 * @param {string} repoRoot
 * @returns {{findings: {rule: string, file: string, line: number, text: string}[], census: [string, number][], unterminated: string[], baseline: number, debt: number, entries: {section: string, path: string, hits: number, kind: string|null}[]}}
 */
export function readSharedSurface(repoRoot) {
	const moduleUrl = pathToFileURL(path.join(repoRoot, SHARED_SURFACE)).href;
	const script = [
		// argv[1] is deliberately NOT this module's path: today `check-shared-surface.mjs` dispatches
		// on `argv.includes("--self-test")` and takes the self-test branch, which RETURNS instead of
		// scanning; if it ever gains the entrypoint guard every other script here has, argv[1] fails
		// to resolve to it and the module runs nothing at import. Both outcomes are safe. What is not
		// safe — the default branch running the real check and calling process.exit(1) — needs argv
		// to carry neither, which is the one shape this line rules out.
		`process.argv = [process.argv[0], "audit-report-child", "--self-test"];`,
		`const m = await import(${JSON.stringify(moduleUrl)});`,
		`const fs = await import("node:fs");`,
		`const p = await import("node:path");`,
		`const ROOT = ${JSON.stringify(repoRoot)};`,
		`const readFile = (f) => fs.readFileSync(p.join(ROOT, f), "utf8");`,
		`const listDir = (dir) => {`,
		`  let entries;`,
		`  try { entries = fs.readdirSync(p.join(ROOT, dir), { withFileTypes: true }); }`,
		`  catch (err) { if (err && err.code === "ENOTDIR") return []; throw err; }`,
		`  return entries.filter((e) => e.isDirectory() || e.isFile()).map((e) => e.name);`,
		`};`,
		`const scanned = m.scan(readFile, listDir);`,
		`const list = m.parseAllowlist(readFile(${JSON.stringify(ALLOWLIST)}));`,
		`process.stdout.write("\\n" + ${JSON.stringify(SENTINEL)} + "\\n" + JSON.stringify({`,
		`  findings: scanned.findings.map((f) => ({ rule: f.rule, file: f.file, line: f.line, text: f.text })),`,
		`  census: [...scanned.census],`,
		`  unterminated: [...scanned.unterminated],`,
		`  baseline: list.baseline,`,
		`  debt: list.debt,`,
		`  entries: list.entries.map((e) => ({ section: e.section, path: e.path, hits: e.hits, kind: e.kind })),`,
		`}));`,
	].join("\n");

	/** @type {string} */
	let out;
	try {
		out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
			cwd: repoRoot,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err) {
		throw new Error(
			`could not read ${SHARED_SURFACE}: the child exited ${err.status ?? "abnormally"}.\n` +
				`This is the shared-surface guard refusing to hand over a scan — its own fixture suite is ` +
				`the precondition of this report, and a scoreboard over a broken matcher is worse than none.\n` +
				`--- child stderr ---\n${String(err.stderr ?? "").trim()}\n${String(err.stdout ?? "").trim()}`,
		);
	}
	const at = out.indexOf(SENTINEL);
	if (at === -1) {
		throw new Error(
			`could not read ${SHARED_SURFACE}: the child exited 0 but emitted no \`${SENTINEL}\`. It has ` +
				`changed shape — the exported \`scan\`/\`parseAllowlist\` were not reached.\n--- child output ---\n${out.trim()}`,
		);
	}
	return JSON.parse(out.slice(at + SENTINEL.length));
}

/**
 * The vacuity controls this file computes for ITSELF, from the scan's own census.
 *
 * They duplicate what `check-shared-surface.mjs`'s `check()` asserts, on purpose: `check()` is not
 * what the child runs, and this report must not be able to conclude "no findings" from "read no
 * files" if the arrangement above ever stops running the guard's self-test.
 *
 * @param {[string, number][]} census keys are `scopeId SEP root SEP ext`
 * @param {string[]} unterminated
 * @returns {string[]} one line per problem
 */
export function scanVacuityProblems(census, unterminated) {
	/** @type {string[]} */
	const problems = [];
	if (census.length === 0) problems.push("the shared-surface scan reported an EMPTY census — it examined no scope at all.");
	/** @type {Map<string, Map<string, number>>} */
	const byScope = new Map();
	for (const [key, n] of census) {
		// The guard joins `scopeId`, `root` and `ext` with a control character it does not export.
		// Splitting on the CLASS, and refusing anything that is not three parts, means a change of
		// separator becomes the loud failure below rather than two silently mis-parsed axes — a
		// hand-copied constant that stopped matching would read as "every axis is fine".
		const parts = key.split(CONTROL_CHAR);
		if (parts.length !== 3) {
			problems.push(
				`the shared-surface census key ${JSON.stringify(key)} is not \`scope SEP root SEP ext\` — ` +
					"the scan's shape changed, so neither the root axis nor the extension axis can be read.",
			);
			continue;
		}
		const [scopeId, root, ext] = parts;
		if (!byScope.has(scopeId)) byScope.set(scopeId, new Map());
		const axes = byScope.get(scopeId);
		axes.set(`root ${root}`, (axes.get(`root ${root}`) ?? 0) + n);
		axes.set(`ext ${ext}`, (axes.get(`ext ${ext}`) ?? 0) + n);
	}
	for (const [scopeId, axes] of byScope) {
		for (const [axis, n] of axes) {
			if (n === 0) problems.push(`the \`${scopeId}\` scope examined ZERO files for \`${axis}\` — the scan is broken, not the tree.`);
		}
	}
	for (const f of unterminated) {
		problems.push(`${f}: an unterminated block comment — the guard blanked the rest of the file, so it has not read it.`);
	}
	return problems;
}

// ── the derived view ─────────────────────────────────────────────────────────────────────────

/** PASS ÷ (PASS + FAIL). N/A leaves the denominator — RUBRIC.md, "How a predicate is scored". */
export function scoreOf(pass, fail) {
	const denom = pass + fail;
	return denom === 0 ? null : pass / denom;
}

/**
 * Build everything both renderers need, from inputs that are all injectable so `--self-test` can
 * drive the whole pipeline over a fixture rather than over the console.
 *
 * @param {object} input
 * @param {{scored: Record<string, {pass: string[], fail: {route: string, detail: string}[], na: Record<string, string[]>}>, totals: {routes: number, redirectOnly: number, real: number}, manifest: {routes: object[]}}} input.run
 * @param {{id: string, family: string}[]} input.rubricPredicates
 * @param {{findings: {rule: string, file: string, line: number, text: string}[], entries: {section: string, path: string, hits: number, kind: string|null}[], baseline: number, debt: number}} input.surface
 * @param {Map<string, Set<string>>} input.pageClosures  route → repo-relative files
 * @param {Set<string>} input.chromeClosure  every file reachable from a layout chain
 * @param {ReturnType<typeof parseLive>} input.live  the committed live records, both sections
 * @param {typeof LIVE_DEBT} [input.liveDebt]  injectable so `--self-test` can drive both directions
 */
export function buildView({ run, rubricPredicates, surface, pageClosures, chromeClosure, live, liveDebt = LIVE_DEBT }) {
	const scoredIds = [...ROUTE_STATE_PREDICATES, ...Object.values(RULE_PREDICATE)];
	partitionPredicates(rubricPredicates, scoredIds, NOT_SCORED_STATICALLY);
	const liveIds = livePredicateSections();

	// Every rule id the tree or the allowlist actually names must be accounted for. A matcher whose
	// findings map to no predicate and are not declared unmapped would otherwise vanish.
	const known = new Set([...Object.keys(RULE_PREDICATE), ...Object.keys(RULES_WITHOUT_A_PREDICATE)]);
	const observed = new Set([...surface.findings.map((f) => f.rule), ...surface.entries.map((e) => e.section)]);
	const stray = [...observed].filter((id) => !known.has(id)).sort();
	if (stray.length > 0) {
		throw new Error(
			`shared-surface rule(s) ${stray.join(", ")} are neither mapped to a rubric predicate nor ` +
				`declared unmapped. Add each to RULE_PREDICATE or to RULES_WITHOUT_A_PREDICATE with its ` +
				`reason — a matcher whose findings fall out of this report must not be able to do so quietly.`,
		);
	}

	// ── which occurrences a `reason:` entry excuses ────────────────────────────────────────────
	// A `lifts:` (debt) entry excuses NOTHING: it is measured drift a named lane will remove, and
	// RUBRIC.md says a page scores FAIL on H8 today for exactly that reason.
	/** @type {Map<string, number>} rule + KEY + file → occurrences a recorded DECISION covers */
	const excused = new Map();
	for (const e of surface.entries) {
		if (e.kind !== "decision") continue;
		const key = `${e.section}${KEY}${e.path}`;
		excused.set(key, (excused.get(key) ?? 0) + e.hits);
	}
	/** @type {Map<string, {rule: string, file: string, hits: number}>} unexcused occurrences per rule+file */
	const unexcused = new Map();
	/** @type {Map<string, number>} */
	const perRuleTotal = new Map();
	/** @type {Map<string, number>} */
	const perRuleExcused = new Map();
	for (const f of surface.findings) {
		const key = `${f.rule}${KEY}${f.file}`;
		perRuleTotal.set(f.rule, (perRuleTotal.get(f.rule) ?? 0) + 1);
		const row = unexcused.get(key) ?? { rule: f.rule, file: f.file, hits: 0 };
		row.hits += 1;
		unexcused.set(key, row);
	}
	for (const [key, row] of unexcused) {
		const cover = Math.min(excused.get(key) ?? 0, row.hits);
		row.hits -= cover;
		perRuleExcused.set(row.rule, (perRuleExcused.get(row.rule) ?? 0) + cover);
		if (row.hits === 0) unexcused.delete(key);
	}

	// ── verdicts ──────────────────────────────────────────────────────────────────────────────
	/** @type {{route: string, predicate: string, verdict: "PASS"|"FAIL"|"N/A"|"NOT MEASURED", reason?: string, detail?: string}[]} */
	const verdicts = [];
	const routeOrder = run.manifest.routes.map((r) => r.route);

	// The live half, joined onto the same route set. A cell no artifact carries becomes NOT
	// MEASURED here rather than disappearing — see `joinLive()`.
	const liveVacuity = liveVacuityProblems(live, routeOrder);
	if (liveVacuity.length > 0) {
		throw new Error(
			`the live audit records did not measure the console:\n  - ${liveVacuity.join("\n  - ")}\n` +
				`Refresh them with \`--import-live\`. An empty live artifact must never score as a clean board.`,
		);
	}
	verdicts.push(...joinLive(live, routeOrder));

	for (const id of ROUTE_STATE_PREDICATES) {
		const s = run.scored[id];
		for (const route of s.pass) verdicts.push({ route, predicate: id, verdict: "PASS" });
		for (const f of s.fail) verdicts.push({ route: f.route, predicate: id, verdict: "FAIL", detail: f.detail });
		for (const [reason, routes] of Object.entries(s.na)) {
			for (const route of routes) verdicts.push({ route, predicate: id, verdict: "N/A", reason });
		}
	}

	for (const route of routeOrder) {
		const surfaceFiles = pageClosures.get(route) ?? new Set();
		for (const [ruleId, predicate] of Object.entries(RULE_PREDICATE)) {
			/** @type {{file: string, hits: number}[]} */
			const hits = [];
			for (const file of surfaceFiles) {
				const row = unexcused.get(`${ruleId}${KEY}${file}`);
				if (row !== undefined) hits.push({ file, hits: row.hits });
			}
			hits.sort((a, b) => (b.hits - a.hits) || a.file.localeCompare(b.file));
			if (hits.length === 0) {
				verdicts.push({ route, predicate, verdict: "PASS" });
				continue;
			}
			const total = hits.reduce((n, h) => n + h.hits, 0);
			verdicts.push({
				route,
				predicate,
				verdict: "FAIL",
				detail: `${total} occurrence(s) in ${hits.length} file(s), worst ${hits[0].file} (${hits[0].hits})`,
			});
		}
	}
	verdicts.sort((a, b) => a.route.localeCompare(b.route) || a.predicate.localeCompare(b.predicate));

	// ── tallies ───────────────────────────────────────────────────────────────────────────────
	/** @type {Record<string, {family: string, instrument: string, section: string|null, owner: string|null, debt: string|null, pass: number, fail: number, na: number, notMeasured: number, naReasons: Record<string, number>, notMeasuredReasons: Record<string, number>, score: number|null}>} */
	const predicates = {};
	for (const p of rubricPredicates) {
		const notScored = NOT_SCORED_STATICALLY[p.id];
		predicates[p.id] = {
			family: p.family,
			instrument: notScored === undefined
				? (ROUTE_STATE_PREDICATES.includes(p.id) ? "check-route-states" : "check-shared-surface")
				: notScored.kind,
			section: notScored?.section ?? null,
			owner: notScored?.owner ?? null,
			debt: liveDebt[p.id]?.owner ?? null,
			pass: 0,
			fail: 0,
			na: 0,
			notMeasured: 0,
			naReasons: {},
			notMeasuredReasons: {},
			score: null,
		};
	}
	for (const v of verdicts) {
		const row = predicates[v.predicate];
		if (v.verdict === "PASS") row.pass += 1;
		else if (v.verdict === "FAIL") row.fail += 1;
		else if (v.verdict === "NOT MEASURED") {
			// NEVER folded into `na`. An N/A is a claim about the page; this is a claim about the
			// instrument, and a column that absorbed it would let a broken instrument read as a page
			// the predicate does not apply to — #3854's whole argument.
			row.notMeasured += 1;
			row.notMeasuredReasons[v.reason] = (row.notMeasuredReasons[v.reason] ?? 0) + 1;
		} else {
			row.na += 1;
			row.naReasons[v.reason] = (row.naReasons[v.reason] ?? 0) + 1;
		}
	}
	// `score = PASS / (PASS + FAIL)` — a withheld verdict leaves the denominator exactly as an N/A
	// does, so a predicate withheld everywhere scores null and never 1.
	for (const row of Object.values(predicates)) row.score = scoreOf(row.pass, row.fail);

	// ── the live debt ledger, checked in BOTH directions ──────────────────────────────────────
	/** @type {string[]} */
	const debtProblems = [];
	for (const id of liveIds.keys()) {
		const fails = predicates[id].fail;
		if (fails > 0 && liveDebt[id] === undefined) {
			debtProblems.push(
				`${id} FAILS on ${fails} route(s) and no LIVE_DEBT row owns it. RUBRIC.md's bargain for ` +
					`the live half is that nothing is suppressed: what still fails becomes recorded debt naming its owner.`,
			);
		}
		if (fails === 0 && liveDebt[id] !== undefined) {
			debtProblems.push(
				`${id} has a LIVE_DEBT row (${liveDebt[id].owner}) and now FAILS nowhere. Delete the row in ` +
					`the same commit as the fix — a debt ledger nobody is forced to shrink stops being true.`,
			);
		}
	}
	for (const id of Object.keys(liveDebt)) {
		if (!liveIds.has(id)) debtProblems.push(`LIVE_DEBT names ${id}, which is not a live predicate.`);
	}
	if (debtProblems.length > 0) throw new Error(`the live debt ledger is out of date:\n  - ${debtProblems.join("\n  - ")}`);

	// ── per route, per family ─────────────────────────────────────────────────────────────────
	/** @type {Map<string, {route: string, redirectOnly: boolean, surfaceFiles: number, families: Record<string, {pass: number, fail: number, na: number, notMeasured: number, score: number|null, instrumented: number, of: number}>, overall: {pass: number, fail: number, na: number, notMeasured: number, score: number|null}}>} */
	const routes = new Map();
	const familyOf = Object.fromEntries(rubricPredicates.map((p) => [p.id, p.family]));
	const familySize = {};
	for (const p of rubricPredicates) familySize[p.family] = (familySize[p.family] ?? 0) + 1;
	// A LIVE predicate IS instrumented. Only `kind: "none"` is not — that distinction is the whole
	// point of the `—` cell, and counting the R family as un-instrumented after this unit landed
	// would render ten measured predicates as "nothing found".
	const familyInstrumented = {};
	for (const p of rubricPredicates) {
		const notScored = NOT_SCORED_STATICALLY[p.id];
		familyInstrumented[p.family] = (familyInstrumented[p.family] ?? 0) + (notScored === undefined || notScored.kind === "live" ? 1 : 0);
	}
	for (const r of run.manifest.routes) {
		/** @type {Record<string, {pass: number, fail: number, na: number, notMeasured: number, score: number|null, instrumented: number, of: number}>} */
		const families = {};
		for (const key of Object.keys(FAMILIES)) {
			families[key] = { pass: 0, fail: 0, na: 0, notMeasured: 0, score: null, instrumented: familyInstrumented[key] ?? 0, of: familySize[key] ?? 0 };
		}
		routes.set(r.route, {
			route: r.route,
			redirectOnly: r.isRedirectOnly,
			surfaceFiles: (pageClosures.get(r.route) ?? new Set()).size,
			families,
			overall: { pass: 0, fail: 0, na: 0, notMeasured: 0, score: null },
		});
	}
	for (const v of verdicts) {
		const row = routes.get(v.route);
		const fam = row.families[familyOf[v.predicate]];
		const bucket =
			v.verdict === "PASS" ? "pass" : v.verdict === "FAIL" ? "fail" : v.verdict === "NOT MEASURED" ? "notMeasured" : "na";
		fam[bucket] += 1;
		row.overall[bucket] += 1;
	}
	for (const row of routes.values()) {
		for (const fam of Object.values(row.families)) fam.score = scoreOf(fam.pass, fam.fail);
		row.overall.score = scoreOf(row.overall.pass, row.overall.fail);
	}

	// ── reconciliation: every finding is accounted for, twice over ────────────────────────────
	const inSomePage = new Set();
	for (const files of pageClosures.values()) for (const f of files) inSomePage.add(f);
	// SEEDED WITH EVERY KNOWN RULE, not built from the findings. `data_table` and `stat_strip` find
	// nothing on this tree — #3717 and #3718 fixed the last of each — and a table built only from
	// findings would simply not have a row for them. "Found nothing" would then be rendered exactly
	// like "was not run", in the one section whose whole job is that they never look the same.
	/** @type {Record<string, {total: number, decision: number, debt: number, unlisted: number, inPageClosure: number, chromeOnly: number, offTree: number, predicate: string|null, owner: string|null}>} */
	const byRule = {};
	for (const id of [...Object.keys(RULE_PREDICATE), ...Object.keys(RULES_WITHOUT_A_PREDICATE)]) {
		byRule[id] = {
			total: 0, decision: 0, debt: 0, unlisted: 0, inPageClosure: 0, chromeOnly: 0, offTree: 0,
			predicate: RULE_PREDICATE[id] ?? null,
			owner: RULES_WITHOUT_A_PREDICATE[id]?.owner ?? null,
		};
	}
	// PER OCCURRENCE, NOT PER FILE. The allowlist grants its exception per occurrence — an entry
	// says `hits: 2`, and a third occurrence in that file is new drift. Reading the ledger as "this
	// file is listed" would absorb that third one into `debt` and leave `unlisted` at 0, which is
	// the one column this section tells a reader to look at first. Verified by mutation: appending
	// one raw `<h2>` to an already-listed file must move `unlisted` from 0 to 1.
	/** @type {Map<string, {kind: string|null, left: number}>} */
	const listedBudget = new Map();
	for (const e of surface.entries) {
		const key = `${e.section}${KEY}${e.path}`;
		const prior = listedBudget.get(key);
		if (prior === undefined) listedBudget.set(key, { kind: e.kind, left: e.hits });
		else prior.left += e.hits;
	}
	/** @type {Map<string, number>} */
	const chromeFiles = new Map();
	/** @type {Map<string, number>} */
	const offTreeFiles = new Map();
	for (const f of surface.findings) {
		const row = (byRule[f.rule] ??= {
			total: 0, decision: 0, debt: 0, unlisted: 0, inPageClosure: 0, chromeOnly: 0, offTree: 0,
			predicate: RULE_PREDICATE[f.rule] ?? null,
			owner: RULES_WITHOUT_A_PREDICATE[f.rule]?.owner ?? null,
		});
		row.total += 1;
		const budget = listedBudget.get(`${f.rule}${KEY}${f.file}`);
		if (budget !== undefined && budget.left > 0) {
			budget.left -= 1;
			if (budget.kind === "decision") row.decision += 1;
			else row.debt += 1;
		} else {
			row.unlisted += 1;
		}
		if (inSomePage.has(f.file)) row.inPageClosure += 1;
		else if (chromeClosure.has(f.file)) {
			row.chromeOnly += 1;
			chromeFiles.set(f.file, (chromeFiles.get(f.file) ?? 0) + 1);
		} else {
			row.offTree += 1;
			offTreeFiles.set(f.file, (offTreeFiles.get(f.file) ?? 0) + 1);
		}
	}

	return {
		totals: {
			...run.totals,
			predicates: rubricPredicates.length,
			scoredHere: scoredIds.length,
			live: liveIds.size,
			notInstrumented: Object.values(NOT_SCORED_STATICALLY).filter((v) => v.kind === "none").length,
			findings: surface.findings.length,
			findingFiles: new Set(surface.findings.map((f) => f.file)).size,
			liveNotMeasured: verdicts.filter((v) => v.verdict === "NOT MEASURED").length,
		},
		ledgers: { baseline: surface.baseline, debt: surface.debt },
		live: {
			source: live.source,
			sections: Object.fromEntries(
				Object.entries(LIVE_SECTIONS).map(([key, section]) => [
					key,
					{
						artifact: section.artifact,
						spec: section.spec,
						persona: section.persona,
						org: section.org,
						covers: section.covers,
						predicates: [...liveIds].filter(([, k]) => k === key).map(([id]) => id),
						records: live.sections[key].records.length,
						routes: new Set(live.sections[key].records.map((r) => r.route)).size,
					},
				]),
			),
			debt: Object.fromEntries(Object.entries(liveDebt).map(([id, d]) => [id, { owner: d.owner, why: d.why, fail: predicates[id].fail }])),
		},
		predicates,
		routes: [...routes.values()].sort((a, b) => a.route.localeCompare(b.route)),
		verdicts,
		reconciliation: {
			byRule,
			chromeOnlyFiles: [...chromeFiles].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0])).map(([file, hits]) => ({ file, hits })),
			offTreeFiles: [...offTreeFiles].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0])).map(([file, hits]) => ({ file, hits })),
		},
	};
}

// ── rendering ────────────────────────────────────────────────────────────────────────────────

const pct = (v) => (v === null ? "—" : v.toFixed(2));
/**
 * One family cell.
 *
 * The states must not collapse into each other. A family with no instrument is `—`. A family whose
 * every predicate was N/A for this route is `all N/A` — a real answer, and not a zero. A family
 * whose every predicate was WITHHELD is `all withheld`, which is a statement about the instrument
 * and not about the page. Everything else is `PASS/scored · score`, with a `· n withheld` suffix
 * when some of the family's predicates were withheld and others were not — because a score over
 * three of seven predicates and a score over seven of seven must not read the same.
 */
const cell = (f) => {
	if (f.instrumented === 0) return "—";
	if (f.pass + f.fail === 0) {
		if (f.na === 0 && f.notMeasured === 0) return "—";
		if (f.na === 0) return `all withheld (${f.notMeasured})`;
		if (f.notMeasured === 0) return "all N/A";
		return `all N/A or withheld`;
	}
	return `${f.pass}/${f.pass + f.fail} · ${pct(f.score)}${f.notMeasured > 0 ? ` · ${f.notMeasured} withheld` : ""}`;
};

/** The generated region of `scoreboard.md`. No wall clock, no absolute path, no uncommitted input. */
export function renderScoreboard(view) {
	const L = [];
	const t = view.totals;

	L.push("## What this scored");
	L.push("");
	L.push(`**${t.routes} private routes** · ${t.redirectOnly} redirect-only · ${t.real} real pages.`);
	L.push("");
	L.push(`RUBRIC.md defines **${t.predicates} predicates**. This report scores **${t.scoredHere + t.live}** of them —`);
	L.push(`${t.scoredHere} from the tree and ${t.live} from the committed live audit records.`);
	L.push(`${t.notInstrumented} have no instrument anywhere today.`);
	L.push("");
	L.push("| source | what it contributes |");
	L.push("|---|---|");
	L.push("| `scripts/lib/console-routes.mjs` | the route set — the denominator of every number below |");
	L.push("| `scripts/check-route-states.mjs` | S1–S4, T1–T4, per route |");
	L.push(`| \`${ROUTE_STATES_BASELINE}\` | the ratchet those eight predicates are held to |`);
	L.push("| `scripts/check-shared-surface.mjs` | every H-family occurrence, per file |");
	L.push(`| \`${ALLOWLIST}\` | which occurrences are a recorded decision (\`baseline: ${view.ledgers.baseline}\`) and which are measured drift (\`debt: ${view.ledgers.debt}\`) |`);
	L.push(`| \`${LIVE_JSON}\` | T5–T7 and R1–R7 as MEASURED, imported from a CI run of the Playwright \`audit\` project |`);
	L.push(`| \`${RUBRIC}\` | the predicate set itself, read out of its own tables |`);
	L.push("");

	// ── instrument inventory ──────────────────────────────────────────────────────────────────
	L.push("## Which predicates have an instrument");
	L.push("");
	L.push("An un-instrumented predicate is rendered `—` everywhere below, never as a pass and never");
	L.push("omitted. The generator refuses to run unless every rubric predicate lands in exactly one row");
	L.push("of this table. A **live** predicate is instrumented: it is measured in a browser by the");
	L.push("Playwright `audit` project and joined in from the committed records, not inferred from the tree.");
	L.push("");
	L.push("| family | predicates | static | live | no instrument |");
	L.push("|---|---:|---:|---:|---:|");
	const famRows = Object.entries(FAMILIES).map(([key, label]) => {
		const ids = Object.entries(view.predicates).filter(([, p]) => p.family === key);
		return {
			key,
			label,
			all: ids.length,
			here: ids.filter(([, p]) => p.instrument === "check-route-states" || p.instrument === "check-shared-surface").length,
			live: ids.filter(([, p]) => p.instrument === "live").length,
			none: ids.filter(([, p]) => p.instrument === "none").length,
		};
	});
	for (const r of famRows) L.push(`| **${r.key}** — ${r.label} | ${r.all} | ${r.here} | ${r.live} | ${r.none} |`);
	L.push(`| **total** | ${t.predicates} | ${t.scoredHere} | ${t.live} | ${t.notInstrumented} |`);
	L.push("");
	L.push("The un-instrumented eight, each with the issue that owns it:");
	L.push("");
	L.push("| id | owner | what is not being measured |");
	L.push("|---|---|---|");
	for (const [id, meta] of Object.entries(NOT_SCORED_STATICALLY)) {
		if (meta.kind !== "none") continue;
		L.push(`| **${id}** | ${meta.owner} | ${meta.why} |`);
	}
	L.push("");

	// ── the live half ─────────────────────────────────────────────────────────────────────────
	L.push("## The live half — two artifacts, two personas, two organisations");
	L.push("");
	L.push("T5–T7 and R1–R7 are measured in a browser, not read off the tree. The records below were");
	L.push(`imported from **${view.live.source.run}** at commit \`${view.live.source.commit}\` and committed to`);
	L.push(`\`${LIVE_JSON}\`; refresh them with \`--import-live\`. They come from **two files, joined and never`);
	L.push("pooled** — `e2e/audit/report.ts` records what pooling them cost, and the split is checked here:");
	L.push("each section declares the predicates it may carry, and a record in the wrong one refuses to parse.");
	L.push("");
	L.push("| section | artifact | persona | organisation | predicates | records | routes |");
	L.push("|---|---|---|---|---|---:|---:|");
	for (const [key, sec] of Object.entries(view.live.sections)) {
		L.push(
			`| \`${key}\` | \`${sec.artifact}\` | ${sec.persona} | ${sec.org} | ${sec.predicates.join(", ")} | ` +
				`${sec.records} | ${sec.routes} |`,
		);
	}
	L.push("");
	L.push("**A cell no artifact carries is `NOT MEASURED`, never N/A and never a pass.** An N/A is a claim");
	L.push("about the page — RUBRIC.md's rule 2 requires it to be derivable from the route record — and");
	L.push("\"the instrument did not reach this route\" is a claim about the instrument. It gets its own column");
	L.push("below and is never folded into N/A; `score` stays `PASS ÷ (PASS + FAIL)`, so a withheld verdict");
	L.push("leaves the denominator and a predicate withheld everywhere scores `—`, never `1.00`.");
	L.push("");
	const withheld = Object.entries(view.predicates)
		.filter(([, p]) => p.instrument === "live" && p.notMeasured > 0)
		.flatMap(([id, p]) => Object.entries(p.notMeasuredReasons).map(([reason, n]) => ({ id, reason, n })))
		.sort((a, b) => a.id.localeCompare(b.id) || a.reason.localeCompare(b.reason));
	L.push("| withheld | routes | why the instrument did not answer |");
	L.push("|---|---:|---|");
	if (withheld.length === 0) {
		L.push("| — | 0 | every live predicate was measured on every route |");
	} else {
		for (const w of withheld) L.push(`| **${w.id}** | ${w.n} | ${w.reason} |`);
	}
	L.push("");
	L.push("**Nothing is suppressed.** R5, R6 and R7 declare no N/A reason at all, so an N/A on one of them");
	L.push("is a parse error rather than a verdict. What still fails is recorded debt with an owner, and the");
	L.push("generator checks that ledger in both directions — a row that stops being true fails the build as");
	L.push("loudly as a missing one:");
	L.push("");
	L.push("| predicate | FAIL | owner | what is failing |");
	L.push("|---|---:|---|---|");
	const debtRows = Object.entries(view.live.debt).sort(([a], [b]) => a.localeCompare(b));
	if (debtRows.length === 0) {
		L.push("| — | 0 | — | no live predicate fails on any route |");
	} else {
		for (const [id, d] of debtRows) L.push(`| **${id}** | ${d.fail} | ${d.owner} | ${d.why} |`);
	}
	L.push("");

	// ── per predicate ─────────────────────────────────────────────────────────────────────────
	L.push("## Per predicate");
	L.push("");
	L.push("`score = PASS ÷ (PASS + FAIL)`. N/A leaves the denominator, so the N/A column is first-class:");
	L.push("a predicate whose N/A count grows is a predicate being escaped. `NOT MEASURED` leaves it too, and");
	L.push("has a column of its own for the same reason — it is a fact about the instrument, not about a page.");
	L.push("");
	L.push("| id | family | instrument | PASS | FAIL | N/A | NOT MEASURED | score | N/A reasons |");
	L.push("|---|---|---|---:|---:|---:|---:|---:|---|");
	const order = Object.keys(FAMILIES);
	const ids = Object.keys(view.predicates).sort((a, b) => {
		const fa = order.indexOf(view.predicates[a].family);
		const fb = order.indexOf(view.predicates[b].family);
		return fa - fb || Number(a.slice(1)) - Number(b.slice(1));
	});
	for (const id of ids) {
		const p = view.predicates[id];
		const instrument =
			p.instrument === "check-route-states" ? "`check-route-states`"
			: p.instrument === "check-shared-surface" ? "`check-shared-surface`"
			: p.instrument === "live" ? `live — \`${p.section}\``
			: `**none** — ${p.owner}`;
		const scored = p.instrument !== "none";
		const reasons = Object.entries(p.naReasons).sort().map(([r, n]) => `\`${r}\` ${n}`).join(", ");
		L.push(
			`| **${id}** | ${p.family} | ${instrument} | ${scored ? p.pass : "—"} | ${scored ? p.fail : "—"} | ` +
				`${scored ? p.na : "—"} | ${scored ? p.notMeasured : "—"} | ${scored ? pct(p.score) : "—"} | ${reasons || "—"} |`,
		);
	}
	L.push("");
	L.push("The static H half emits **no N/A at all**, which is why those rows are empty rather than");
	L.push("carrying the rubric's `renders-no-table` / `renders-no-formatted-value` / `declares-no-z-index`.");
	L.push("A matcher cannot tell \"this page has no table\" from \"this page's table is correct\" — both are");
	L.push("zero findings — so claiming the N/A would shrink the denominator on evidence that does not bear");
	L.push("on it. Every page is asked, and a page with no table passes H4 by not hand-rolling one.");
	L.push("");

	// ── per route ─────────────────────────────────────────────────────────────────────────────
	L.push("## Per route");
	L.push("");
	L.push("Each cell is `PASS/scored · score` over that family's instrumented predicates —");
	L.push(
		`S ${famRows[0].here + famRows[0].live}/${famRows[0].all}, T ${famRows[1].here + famRows[1].live}/${famRows[1].all}, ` +
			`H ${famRows[2].here + famRows[2].live}/${famRows[2].all}, F ${famRows[3].here + famRows[3].live}/${famRows[3].all}, ` +
			`R ${famRows[4].here + famRows[4].live}/${famRows[4].all}. \`surface\` is the number of console modules the`,
	);
	L.push("page's own import graph reaches, which is the denominator the H column was measured over.");
	L.push("A `· n withheld` suffix means n of that family's predicates were NOT MEASURED on this route: the");
	L.push("score is over the rest, and the cell says so rather than letting a narrower measurement read wider.");
	L.push("");
	L.push("| route | surface | S | T | H | F | R | overall |");
	L.push("|---|---:|---|---|---|---|---|---|");
	for (const r of [...view.routes].sort((a, b) => (a.overall.score ?? 1) - (b.overall.score ?? 1) || a.route.localeCompare(b.route))) {
		L.push(
			`| \`${r.route}\`${r.redirectOnly ? " ·" : ""} | ${r.surfaceFiles} | ${cell(r.families.S)} | ${cell(r.families.T)} | ` +
				`${cell(r.families.H)} | ${cell(r.families.F)} | ${cell(r.families.R)} | **${pct(r.overall.score)}** |`,
		);
	}
	L.push("");
	L.push("`·` marks a redirect-only route: no JSX, a `redirect()` call. It is N/A for six of the eight");
	L.push("route-state predicates and passes the H rows on a closure of one file that renders nothing. It is");
	L.push("**not** N/A for R5, R6 and R7: hitting one of those URLs is a navigation a person really makes, so");
	L.push("the console errors it produces and the time it takes to land are real and are measured.");
	L.push("");

	// ── reconciliation ────────────────────────────────────────────────────────────────────────
	L.push("## Where every shared-surface occurrence landed");
	L.push("");
	L.push(`\`check-shared-surface\` found **${t.findings} occurrences across ${t.findingFiles} files**. This section`);
	L.push("accounts for all of them twice — once by ledger, once by reach — so a rule or a file falling out");
	L.push("of the scoreboard cannot be quiet.");
	L.push("");
	L.push("| rule | predicate | total | recorded decision | measured drift | unlisted | in a page's surface | shared chrome only | outside the private tree |");
	L.push("|---|---|---:|---:|---:|---:|---:|---:|---:|");
	const ruleIds = Object.keys(view.reconciliation.byRule).sort();
	const sum = { total: 0, decision: 0, debt: 0, unlisted: 0, inPageClosure: 0, chromeOnly: 0, offTree: 0 };
	for (const id of ruleIds) {
		const r = view.reconciliation.byRule[id];
		for (const k of Object.keys(sum)) sum[k] += r[k];
		L.push(
			`| \`${id}\` | ${r.predicate ?? `**none** — ${r.owner}`} | ${r.total} | ${r.decision} | ${r.debt} | ` +
				`${r.unlisted} | ${r.inPageClosure} | ${r.chromeOnly} | ${r.offTree} |`,
		);
	}
	L.push(
		`| **total** | | ${sum.total} | ${sum.decision} | ${sum.debt} | ${sum.unlisted} | ` +
			`${sum.inPageClosure} | ${sum.chromeOnly} | ${sum.offTree} |`,
	);
	L.push("");
	L.push("**`unlisted` is the column to read first.** A non-zero value means the guard is red — an");
	L.push("occurrence neither a `reason:` nor a `lifts:` entry accounts for. It is not a defect of this");
	L.push("report; run `pnpm check:shared-surface`.");
	L.push("");
	// "Every rule maps to a predicate" and "the table was never consulted" must not render the same,
	// so the empty case is a sentence rather than an absent paragraph.
	const unmapped = Object.entries(RULES_WITHOUT_A_PREDICATE);
	if (unmapped.length === 0) {
		L.push("**Every matcher maps to a rubric predicate.** `empty_state` was the one that did not — it guarded");
		L.push("CLAUDE.md §6's `@repo/ui/empty` row and the rubric's H table had no row for it, so its occurrences");
		L.push("were counted here and scored nowhere. #3798 gave the rubric **H9**, and it is scored like any other");
		L.push("H row. The live T5 asks the other half of the question: what the empty region resolved to when a");
		L.push("browser actually rendered it against an empty org.");
	} else {
		for (const [id, meta] of unmapped) L.push(`**\`${id}\` maps to no rubric predicate** (${meta.owner}). ${meta.why}`);
	}
	L.push("");
	L.push(`**Reachable only from the shared layout chain** — ${view.reconciliation.chromeOnlyFiles.length} files. These are real`);
	L.push("occurrences in the sidebar, topbar, breadcrumbs and shells that every route renders. They are not");
	L.push("in any route's H column, because attributing the chrome's drift to all 40 routes would say the");
	L.push("console is 40 times worse than it is. The full list is in `ui-conformance-baseline.json`.");
	L.push("");
	L.push(`**Outside every private route's module graph** — ${view.reconciliation.offTreeFiles.length} files. Public routes (sign-in,`);
	L.push("onboarding, OAuth consent, accepting terms) and modules no private page imports. The route manifest");
	L.push("is scoped to `app/(private)`, so these are outside the rubric's stated subject and are listed here");
	L.push("rather than scored:");
	L.push("");
	L.push("| file | occurrences |");
	L.push("|---|---:|");
	for (const f of view.reconciliation.offTreeFiles) L.push(`| \`${f.file}\` | ${f.hits} |`);
	L.push("");
	L.push(`_Generated by \`apps/console/scripts/audit-report.mjs\`. Do not edit below the marker — run \`pnpm -F console audit:report --write\`._`);
	return L.join("\n");
}

/** The machine-readable half. Fully generated, so a merge conflict is resolved by regenerating. */
export function renderJson(view) {
	const round = (v) => (v === null ? null : Number(v.toFixed(4)));
	const body = {
		$comment: [
			"DERIVED — a report, not a source of truth. Never hand-edit; run `pnpm -F console audit:report --write`.",
			`The two ledgers this view is derived from are ${ROUTE_STATES_BASELINE} and ${ALLOWLIST}.`,
			"A merge conflict in this file is resolved by taking either side and regenerating.",
		],
		version: 1,
		generator: "apps/console/scripts/audit-report.mjs",
		sources: {
			routes: "scripts/lib/console-routes.mjs",
			routeStates: `scripts/check-route-states.mjs · ${ROUTE_STATES_BASELINE}`,
			sharedSurface: `${SHARED_SURFACE} · ${ALLOWLIST}`,
			live: `${LIVE_JSON} · imported from the Playwright \`audit\` project`,
			rubric: RUBRIC,
		},
		totals: view.totals,
		ledgers: view.ledgers,
		live: view.live,
		predicates: Object.fromEntries(
			Object.entries(view.predicates).map(([id, p]) => [
				id,
				{
					family: p.family,
					instrument: p.instrument,
					...(p.instrument === "live" ? { section: p.section } : {}),
					owner: p.owner,
					...(p.debt === null ? {} : { debt: p.debt }),
					...(p.instrument === "none"
						? {}
						: {
								pass: p.pass,
								fail: p.fail,
								na: p.na,
								notMeasured: p.notMeasured,
								naReasons: p.naReasons,
								notMeasuredReasons: p.notMeasuredReasons,
								score: round(p.score),
							}),
				},
			]),
		),
		routes: view.routes.map((r) => ({
			route: r.route,
			redirectOnly: r.redirectOnly,
			surfaceFiles: r.surfaceFiles,
			families: Object.fromEntries(
				Object.entries(r.families).map(([k, f]) => [
					k,
					{ instrumented: f.instrumented, of: f.of, pass: f.pass, fail: f.fail, na: f.na, notMeasured: f.notMeasured, score: round(f.score) },
				]),
			),
			overall: { ...r.overall, score: round(r.overall.score) },
		})),
		verdicts: view.verdicts,
		reconciliation: view.reconciliation,
	};
	return `${JSON.stringify(body, null, "\t")}\n`;
}

/** Replace the generated region. Hard-errors on a missing or duplicated marker. */
export function splice(existing, generated) {
	const begins = existing.split(BEGIN).length - 1;
	const ends = existing.split(END).length - 1;
	if (begins === 0 || ends === 0) {
		throw new Error(`${SCOREBOARD}: missing the generated-region markers. Expected exactly one ${BEGIN} and one ${END}.`);
	}
	if (begins > 1 || ends > 1) {
		throw new Error(
			`${SCOREBOARD}: found ${begins} BEGIN and ${ends} END markers — expected exactly one of each. ` +
				`Splicing into the first of two silently orphans everything after the second; refusing to guess.`,
		);
	}
	const head = existing.slice(0, existing.indexOf(BEGIN) + BEGIN.length);
	const tail = existing.slice(existing.indexOf(END));
	return `${head}\n\n${generated}\n\n${tail}`;
}

// ── the run ──────────────────────────────────────────────────────────────────────────────────

/**
 * Score one tree. Raises rather than reporting a clean board on any broken input — the manifest's
 * own zero-route raise passes straight through, and the four controls below are checked first.
 *
 * @param {string} repoRoot
 */
export function runReport(repoRoot) {
	const control = positiveControl();
	if (control.length > 0) {
		throw new Error(
			`the route-state positive control is BROKEN — refusing to score the tree.\n  ${control.join("\n  ")}\n` +
				`A predicate that no longer fires cannot tell a clean tree from a tree it stopped reading.`,
		);
	}

	const abs = (rel) => path.join(repoRoot, rel);
	const consoleDir = path.join(repoRoot, "apps", "console");
	const readFile = (p) => readFileSync(p, "utf8");
	/** @param {string} p @returns {"file"|"dir"|null} */
	const kindOf = (p) => {
		try {
			const s = statSync(p);
			return s.isDirectory() ? "dir" : "file";
		} catch {
			return null;
		}
	};

	const rubric = parseRubric(readFile(abs(RUBRIC)));
	const run = runOver(repoRoot);
	if (run.manifest.routes.length === 0) {
		throw new Error("the route manifest returned zero routes — a broken scan, not an empty app.");
	}

	const surface = readSharedSurface(repoRoot);
	const vacuity = scanVacuityProblems(surface.census, surface.unterminated);
	if (vacuity.length > 0) {
		throw new Error(`the shared-surface scan did not read the console:\n  - ${vacuity.join("\n  - ")}`);
	}

	// The live half's committed records. A MISSING file raises here rather than defaulting to an
	// empty set — an absent artifact must never be reported as ten predicates nobody failed.
	/** @type {string} */
	let liveText;
	try {
		liveText = readFile(abs(LIVE_JSON));
	} catch {
		throw new Error(
			`${LIVE_JSON} is missing. The live half of RUBRIC.md is measured in CI and imported, not ` +
				`inferred: run \`node apps/console/scripts/audit-report.mjs --import-live=<dir> --run=<url> ` +
				`--commit=<sha>\` against a \`ui-audit\` artifact. Scoring without it would report ten ` +
				`predicates as un-measured that this report claims to measure.`,
		);
	}
	const live = parseLive(liveText);

	const io = { readFile, kindOf, repoRoot, consoleDir };
	/** @type {Map<string, Set<string>>} */
	const pageClosures = new Map();
	/** @type {Set<string>} */
	const chromeClosure = new Set();
	for (const r of run.manifest.routes) {
		pageClosures.set(r.route, moduleClosure([abs(r.file)], io));
		for (const f of moduleClosure(r.layoutChain.map(abs), io)) chromeClosure.add(f);
	}

	return buildView({ run, rubricPredicates: rubric.predicates, surface, pageClosures, chromeClosure, live });
}

// ── self-test ────────────────────────────────────────────────────────────────────────────────

function selfTest() {
	let failures = 0;
	/** @param {string} what @param {boolean} cond */
	const ok = (what, cond) => {
		if (cond) {
			console.log(`ok   - ${what}`);
			return;
		}
		failures += 1;
		console.error(`FAIL - ${what}`);
	};
	/** @param {string} what @param {() => unknown} fn @param {string} needle */
	const raises = (what, fn, needle) => {
		try {
			fn();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ok(`${what} (${needle})`, msg.includes(needle));
			return;
		}
		failures += 1;
		console.error(`FAIL - ${what}: it did not raise`);
	};

	// ── the rubric is the predicate universe ─────────────────────────────────────────────────
	const RUBRIC_FIXTURE = [
		"# r",
		"**5 predicates** over every private route.",
		"| id | predicate | PASS when | N/A when |",
		"|---|---|---|---|",
		"| **S1** | a | b | c |",
		"| **T1** | a | b | c |",
		"| **H1** | a | b | c |",
		"| **F1** | a | b | c |",
		"| **R1** | a | b | c |",
		"| `/x` | not a predicate row | 1 | FAIL |",
	].join("\n");
	const parsed = parseRubric(RUBRIC_FIXTURE);
	ok("the rubric's tables are the predicate set", parsed.predicates.length === 5 && parsed.stated === 5);
	ok("...and a non-predicate table row is not mistaken for one", parsed.predicates.every((p) => /^[STHFR]\d+$/.test(p.id)));
	raises("a stated count that disagrees with the tables RAISES", () => parseRubric(RUBRIC_FIXTURE.replace("**5 predicates**", "**26 predicates**")), "and its tables define 5");
	raises("a rubric with no predicate rows RAISES rather than scoring 0/0", () => parseRubric("# r\n**5 predicates**\nno tables"), "no predicate rows");
	raises("a rubric that states no count RAISES", () => parseRubric(RUBRIC_FIXTURE.replace("**5 predicates**", "twenty-six predicates")), "does not state its own predicate count");
	raises("a predicate defined twice RAISES", () => parseRubric(RUBRIC_FIXTURE.replace("| **T1** |", "| **S1** |")), "S1 is defined twice");

	// THE REAL RUBRIC, because the fixture above proves the parser and not the file it will read.
	const realRubric = parseRubric(readFileSync(path.join(REPO_ROOT, RUBRIC), "utf8"));
	ok(
		`the real ${RUBRIC} defines 34 predicates, in five families`,
		realRubric.predicates.length === 34 &&
			[...new Set(realRubric.predicates.map((p) => p.family))].sort().join("") === "FHRST",
	);
	const perFamily = {};
	for (const p of realRubric.predicates) perFamily[p.family] = (perFamily[p.family] ?? 0) + 1;
	ok(
		"...S1-S4 (4), T1-T7 (7), H1-H9 (9), F1-F7 (7), R1-R7 (7)",
		perFamily.S === 4 && perFamily.T === 7 && perFamily.H === 9 && perFamily.F === 7 && perFamily.R === 7,
	);
	ok("...including H9, the empty-state row #3798 asked for", realRubric.predicates.some((p) => p.id === "H9"));

	// ── the partition: every predicate lands in exactly one bucket ───────────────────────────
	const scoredIds = [...ROUTE_STATE_PREDICATES, ...Object.values(RULE_PREDICATE)];
	const part = partitionPredicates(realRubric.predicates, scoredIds, NOT_SCORED_STATICALLY);
	ok("16 predicates are scored statically — S1-S4, T1-T4 and eight H rows", part.scored.length === 16);
	ok("10 are live", part.live.length === 10 && part.live.sort().join(",") === "R1,R2,R3,R4,R5,R6,R7,T5,T6,T7");
	ok("8 have no instrument anywhere — H3 and all seven F rows", part.none.sort().join(",") === "F1,F2,F3,F4,F5,F6,F7,H3");
	ok("...and every one of those eight names an owning issue", part.none.every((id) => /^#\d+$/.test(NOT_SCORED_STATICALLY[id].owner)));
	raises(
		"a rubric predicate in NEITHER table RAISES rather than vanishing from the report",
		() => partitionPredicates([...realRubric.predicates, { id: "S9", family: "S" }], scoredIds, NOT_SCORED_STATICALLY),
		"S9 is defined by RUBRIC.md and this report neither scores it",
	);
	raises(
		"a declared predicate the rubric does not define RAISES",
		() => partitionPredicates(realRubric.predicates, scoredIds, { ...NOT_SCORED_STATICALLY, Z1: { kind: "none", owner: "#1", why: "x" } }),
		"Z1 is declared not-scored and RUBRIC.md does not define it",
	);
	raises(
		"a predicate that is both scored and declared not-scored RAISES",
		() => partitionPredicates(realRubric.predicates, [...scoredIds, "H3"], NOT_SCORED_STATICALLY),
		"H3 is both scored here and declared not-scored",
	);

	// ── the rule-id → H-family mapping, pinned pair by pair ──────────────────────────────────
	ok("page_title → H1", RULE_PREDICATE.page_title === "H1");
	ok("section_header → H2", RULE_PREDICATE.section_header === "H2");
	ok("data_table → H4", RULE_PREDICATE.data_table === "H4");
	ok("format → H5", RULE_PREDICATE.format === "H5");
	ok("stat_strip → H6", RULE_PREDICATE.stat_strip === "H6");
	ok("layer_token → H7", RULE_PREDICATE.layer_token === "H7");
	ok("type_scale → H8", RULE_PREDICATE.type_scale === "H8");
	ok("H3 is mapped by NO rule — StatusBadge has no matcher", !Object.values(RULE_PREDICATE).includes("H3"));
	ok("empty_state → H9 — #3798's decision, not a fold into the live T5", RULE_PREDICATE.empty_state === "H9");
	ok(
		"...and RULES_WITHOUT_A_PREDICATE is now empty, and still exists for the ninth matcher",
		Object.keys(RULES_WITHOUT_A_PREDICATE).length === 0 && typeof RULES_WITHOUT_A_PREDICATE === "object",
	);
	ok(
		"the eight mapped rules are exactly the eight instrumented H rows",
		[...new Set(Object.values(RULE_PREDICATE))].sort().join(",") === "H1,H2,H4,H5,H6,H7,H8,H9",
	);
	ok("H9 and T5 are separate predicates — one static, one live", RULE_PREDICATE.empty_state === "H9" && NOT_SCORED_STATICALLY.T5.kind === "live");

	// ── import resolution ────────────────────────────────────────────────────────────────────
	/** A fake tree: paths → contents. Directories are inferred from the paths. */
	const tree = (files) => {
		const dirs = new Set();
		for (const p of Object.keys(files)) {
			const parts = p.split("/");
			for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
		}
		return {
			readFile: (p) => {
				const key = p.split(path.sep).join("/");
				if (!(key in files)) throw new Error(`fixture has no ${key}`);
				return files[key];
			},
			kindOf: (p) => {
				const key = p.split(path.sep).join("/");
				if (key in files) return "file";
				if (dirs.has(key)) return "dir";
				return null;
			},
			repoRoot: "/r",
			consoleDir: "/r/apps/console",
		};
	};

	const graph = tree({
		"/r/apps/console/app/(private)/x/page.tsx": 'import { A } from "@/components/a";\nimport { B } from "./local";\n',
		"/r/apps/console/components/a.tsx": 'import { C } from "@/lib/c";\nconst dyn = () => import("@/components/lazy");\n',
		"/r/apps/console/components/lazy.tsx": "export const L = 1;",
		"/r/apps/console/lib/c/index.ts": 'import { A } from "@/components/a";\n',
		"/r/apps/console/app/(private)/x/local.tsx": '// import { Ghost } from "@/components/ghost";\nexport const B = 1;',
	});
	const closed = moduleClosure(["/r/apps/console/app/(private)/x/page.tsx"], graph);
	ok(
		"a page's closure follows @/ and relative imports, and a directory index",
		closed.has("apps/console/components/a.tsx") && closed.has("apps/console/lib/c/index.ts") && closed.has("apps/console/app/(private)/x/local.tsx"),
	);
	ok("...and a dynamic import(), because a lazily mounted panel is still rendered", closed.has("apps/console/components/lazy.tsx"));
	ok("...and an import inside a COMMENT is not followed", !closed.has("apps/console/components/ghost.tsx"));
	ok("...and an import cycle terminates", closed.size === 5);
	raises(
		"an unresolvable @/ specifier RAISES rather than silently shortening the closure",
		() => moduleClosure(["/r/a.tsx"], tree({ "/r/a.tsx": 'import { X } from "@/components/gone";' })),
		"cannot resolve `@/components/gone`",
	);
	ok(
		"an external specifier is not followed and does not raise",
		moduleClosure(["/r/a.tsx"], tree({ "/r/a.tsx": 'import { Button } from "@repo/ui/button";\nimport React from "react";' })).size === 1,
	);
	raises(
		"a file whose block comment never closes RAISES rather than reporting no imports",
		() => moduleClosure(["/r/a.tsx"], tree({ "/r/a.tsx": '/* never closed\nimport { X } from "@/components/x";' })),
		"still open at EOF",
	);

	// ── vacuity ──────────────────────────────────────────────────────────────────────────────
	const NUL = "\u0000";
	ok("a healthy census is clean", scanVacuityProblems([[`s${NUL}apps/console/components${NUL}.tsx`, 10]], []).length === 0);
	ok("an EMPTY census is a problem, not a pass", scanVacuityProblems([], []).some((p) => p.includes("EMPTY census")));
	ok(
		"a root that examined zero files is a problem",
		scanVacuityProblems([[`s${NUL}apps/console/components${NUL}.tsx`, 10], [`s${NUL}apps/console/app${NUL}.tsx`, 0]], [])
			.some((p) => p.includes("root apps/console/app")),
	);
	ok(
		"...and so is an extension that examined zero files",
		scanVacuityProblems([[`s${NUL}apps/console/components${NUL}.tsx`, 10], [`s${NUL}apps/console/components${NUL}.ts`, 0]], [])
			.some((p) => p.includes("ext .ts")),
	);
	ok("an unterminated file is a problem", scanVacuityProblems([[`s${NUL}r${NUL}.tsx`, 1]], ["apps/console/x.tsx"]).some((p) => p.includes("has not read it")));
	// The separator belongs to a module that does not export it. If it ever stops being a control
	// character, the axes must become unreadable LOUDLY rather than parse into one bucket and read
	// as "every axis is fine" — which is the same green-over-nothing this whole function exists for.
	ok(
		"a census key that is no longer scope-SEP-root-SEP-ext is a problem, not a silent mis-parse",
		scanVacuityProblems([["s|apps/console/components|.tsx", 10]], []).some((p) => p.includes("the scan's shape changed")),
	);

	// ── the merge, on a fixture that separates every case ────────────────────────────────────
	const fixtureRubric = parseRubric(readFileSync(path.join(REPO_ROOT, RUBRIC), "utf8")).predicates;
	const fixtureRun = {
		totals: { routes: 3, redirectOnly: 1, real: 2 },
		manifest: {
			routes: [
				{ route: "/a", isRedirectOnly: false },
				{ route: "/b", isRedirectOnly: false },
				{ route: "/r", isRedirectOnly: true },
			],
		},
		scored: Object.fromEntries(
			ROUTE_STATE_PREDICATES.map((id) => [
				id,
				id === "S2"
					? { pass: ["/a"], fail: [{ route: "/b", detail: "two widths" }], na: { "redirect-only": ["/r"] } }
					: { pass: ["/a", "/b", "/r"], fail: [], na: {} },
			]),
		),
	};
	const fixtureSurface = {
		baseline: 2,
		debt: 1,
		findings: [
			// /a's own component: two type_scale hits, both recorded DEBT — still a FAIL.
			{ rule: "type_scale", file: "apps/console/components/a.tsx", line: 1, text: "text-[13px]" },
			{ rule: "type_scale", file: "apps/console/components/a.tsx", line: 2, text: "text-[13px]" },
			// /b's own component: one page_title, a recorded DECISION — excused, so PASS.
			{ rule: "page_title", file: "apps/console/components/b.tsx", line: 1, text: "<h1" },
			// a shared chrome file: in no page closure.
			{ rule: "format", file: "apps/console/components/shell/side.tsx", line: 1, text: ".toFixed(" },
			// outside the private tree entirely.
			{ rule: "format", file: "apps/console/components/auth/form.tsx", line: 1, text: ".toFixed(" },
			// mapped to no predicate: counted, scored nowhere.
			{ rule: "empty_state", file: "apps/console/components/a.tsx", line: 9, text: "text-center py-8" },
		],
		entries: [
			{ section: "page_title", path: "apps/console/components/b.tsx", hits: 1, kind: "decision" },
			{ section: "type_scale", path: "apps/console/components/a.tsx", hits: 2, kind: "debt" },
			{ section: "empty_state", path: "apps/console/components/a.tsx", hits: 1, kind: "debt" },
		],
	};
	// ── the live half's fixture ──────────────────────────────────────────────────────────────
	// Hand-built, with hand-written expectations. Every case the join has to get right is separated:
	// a PASS, a FAIL, an N/A with a declared reason, a route the permissions run never reached, and
	// a route the primary run only partly covered.
	const liveRecord = (route, predicate, verdict, extra = {}) => ({ route, predicate, verdict, ...extra });
	const fixtureLive = {
		source: { run: "https://example.invalid/runs/1", commit: "0123456789abcdef0123456789abcdef01234567" },
		sections: {
			routes: {
				runKey: "fixture-org",
				records: [
					liveRecord("/a", "T5", "PASS"),
					liveRecord("/a", "T6", "PASS"),
					liveRecord("/a", "R1", "PASS"),
					liveRecord("/a", "R2", "N/A", { reason: "opens-no-overlay" }),
					liveRecord("/a", "R3", "PASS"),
					liveRecord("/a", "R4", "FAIL", { detail: "1 overlapping pair of interactive elements at 768w" }),
					liveRecord("/a", "R5", "FAIL", { detail: "color-contrast (serious) ×9" }),
					liveRecord("/a", "R6", "PASS"),
					liveRecord("/a", "R7", "PASS"),
					liveRecord("/b", "T5", "N/A", { reason: "no-empty-state" }),
					liveRecord("/b", "T6", "PASS"),
					liveRecord("/b", "R1", "PASS"),
					liveRecord("/b", "R2", "PASS"),
					liveRecord("/b", "R3", "PASS"),
					liveRecord("/b", "R4", "PASS"),
					liveRecord("/b", "R5", "PASS"),
					liveRecord("/b", "R6", "PASS"),
					liveRecord("/b", "R7", "PASS"),
					liveRecord("/r", "T5", "N/A", { reason: "no-empty-state" }),
					liveRecord("/r", "T6", "N/A", { reason: "redirect-only" }),
					liveRecord("/r", "R1", "N/A", { reason: "redirect-only" }),
					liveRecord("/r", "R2", "N/A", { reason: "opens-no-overlay" }),
					liveRecord("/r", "R3", "N/A", { reason: "redirect-only" }),
					liveRecord("/r", "R4", "N/A", { reason: "redirect-only" }),
					liveRecord("/r", "R5", "PASS"),
					liveRecord("/r", "R6", "PASS"),
					// R7 on /r is DELIBERATELY absent — the gap the join must fill with NOT MEASURED.
				],
			},
			permissions: {
				runKey: "fixture-member-org",
				records: [
					liveRecord("/a", "T7", "PASS"),
					liveRecord("/b", "T7", "FAIL", { detail: "the member is refused and the page renders a blank, not a deliberate state" }),
					// /r is absent: `permissions.spec` drives only the org-only routes.
				],
			},
		},
	};
	const fixtureDebt = {
		R4: { owner: "#1", why: "one shell defect" },
		R5: { owner: "#2", why: "the axe residue" },
		T7: { owner: "#3", why: "a blank where a state belongs" },
	};

	const view = buildView({
		run: fixtureRun,
		rubricPredicates: fixtureRubric,
		surface: fixtureSurface,
		live: fixtureLive,
		liveDebt: fixtureDebt,
		pageClosures: new Map([
			["/a", new Set(["apps/console/app/a/page.tsx", "apps/console/components/a.tsx"])],
			["/b", new Set(["apps/console/app/b/page.tsx", "apps/console/components/b.tsx"])],
			["/r", new Set(["apps/console/app/r/page.tsx"])],
		]),
		chromeClosure: new Set(["apps/console/components/shell/side.tsx"]),
	});
	const verdict = (route, predicate) => view.verdicts.find((v) => v.route === route && v.predicate === predicate);
	ok("a finding in a page's own surface FAILS that page", verdict("/a", "H8").verdict === "FAIL");
	ok("...and does NOT fail a page that does not import it", verdict("/b", "H8").verdict === "PASS");
	ok("a `lifts:` (debt) entry does NOT excuse the occurrence — RUBRIC.md's H8 rule", view.predicates.H8.fail === 1);
	ok("a `reason:` (decision) entry DOES excuse it", verdict("/b", "H1").verdict === "PASS" && view.predicates.H1.fail === 0);
	ok("a chrome-only finding fails NO route", verdict("/a", "H5").verdict === "PASS" && verdict("/b", "H5").verdict === "PASS");
	ok("a redirect-only route passes the H rows on an empty surface", verdict("/r", "H8").verdict === "PASS");
	ok(
		"the static H half emits no N/A at all",
		Object.values(RULE_PREDICATE).every((id) => view.predicates[id].na === 0 && Object.keys(view.predicates[id].naReasons).length === 0),
	);
	ok("a route-state N/A flows through with its reason", verdict("/r", "S2").verdict === "N/A" && verdict("/r", "S2").reason === "redirect-only");
	ok("...and N/A leaves the denominator: S2 is 1 PASS / 1 FAIL / 1 N/A = 0.50", view.predicates.S2.score === 0.5);
	ok("score is null, not 0, when nothing was measured", scoreOf(0, 0) === null && view.predicates.H3.score === null);
	ok(
		"an un-instrumented predicate is scored nowhere and carries its owner",
		view.predicates.F7.instrument === "none" && view.predicates.F7.owner === NOT_SCORED_STATICALLY.F7.owner && view.predicates.F7.pass === 0,
	);
	ok("a live predicate IS scored — from the committed records, not from the tree", view.predicates.R2.instrument === "live" && view.predicates.R2.pass === 1 && view.predicates.R2.na === 2);
	ok(
		"the F column reports as not-instrumented, not as a pass",
		view.routes.every((r) => r.families.F.instrumented === 0 && r.families.F.score === null) && cell(view.routes[0].families.F) === "—",
	);
	ok("...and the T column is now 7 of 7 — 4 static plus 3 live", view.routes[0].families.T.instrumented === 7 && view.routes[0].families.T.of === 7);

	// RECONCILIATION: every finding is accounted for on both axes, and the two axes agree.
	const rec = view.reconciliation.byRule;
	const total = Object.values(rec).reduce((n, r) => n + r.total, 0);
	const byLedger = Object.values(rec).reduce((n, r) => n + r.decision + r.debt + r.unlisted, 0);
	const byReach = Object.values(rec).reduce((n, r) => n + r.inPageClosure + r.chromeOnly + r.offTree, 0);
	ok("every finding is accounted for by ledger", total === fixtureSurface.findings.length && byLedger === total);
	ok("...and by reach, independently", byReach === total);
	ok("a chrome-only file is named", view.reconciliation.chromeOnlyFiles.some((f) => f.file.endsWith("shell/side.tsx")));
	ok("an off-tree file is named", view.reconciliation.offTreeFiles.some((f) => f.file.endsWith("auth/form.tsx")));
	ok("empty_state is counted AND scored, as H9 (#3798)", rec.empty_state.total === 1 && rec.empty_state.predicate === "H9" && rec.empty_state.owner === null);
	// "Found nothing" and "was not run" must not render the same. The fixture trips six of the
	// eight rules; the other two must still have a row, reading 0.
	ok(
		"a rule that found NOTHING still gets a row reading 0, rather than no row at all",
		Object.keys(rec).length === 8 && rec.data_table.total === 0 && rec.stat_strip.total === 0,
	);
	ok("...and it is rendered", renderScoreboard(view).includes("| `stat_strip` | H6 | 0 |"));
	ok(
		"a family whose every predicate is N/A for a route reads `all N/A`, not `0/0`",
		cell({ instrumented: 4, of: 4, pass: 0, fail: 0, na: 4, notMeasured: 0, score: null }) === "all N/A",
	);
	// THE LEDGER IS PER OCCURRENCE. An entry declaring 2 hits does not absorb a third — that third
	// is new drift, `check-shared-surface` is red on it, and `unlisted` is the column this report
	// tells a reader to look at first. Reading the ledger per FILE hides it, and hides it in the
	// direction that reports a clean board.
	const overflowed = buildView({
		run: fixtureRun,
		rubricPredicates: fixtureRubric,
		live: fixtureLive,
		liveDebt: fixtureDebt,
		surface: {
			...fixtureSurface,
			findings: [...fixtureSurface.findings, { rule: "type_scale", file: "apps/console/components/a.tsx", line: 3, text: "text-[13px]" }],
		},
		pageClosures: new Map([["/a", new Set(["apps/console/components/a.tsx"])], ["/b", new Set()], ["/r", new Set()]]),
		chromeClosure: new Set(),
	});
	ok(
		"a third occurrence in a file whose entry declares two is UNLISTED, not absorbed into debt",
		overflowed.reconciliation.byRule.type_scale.debt === 2 && overflowed.reconciliation.byRule.type_scale.unlisted === 1,
	);
	raises(
		"a rule id that maps to nothing and is not declared unmapped RAISES",
		() =>
			buildView({
				run: fixtureRun,
				rubricPredicates: fixtureRubric,
				live: fixtureLive,
				liveDebt: fixtureDebt,
				surface: { ...fixtureSurface, findings: [...fixtureSurface.findings, { rule: "brand_new_rule", file: "apps/console/components/a.tsx", line: 1, text: "x" }] },
				pageClosures: new Map([["/a", new Set()], ["/b", new Set()], ["/r", new Set()]]),
				chromeClosure: new Set(),
			}),
		"brand_new_rule",
	);
	raises(
		"...including one that only appears in the allowlist",
		() =>
			buildView({
				run: fixtureRun,
				rubricPredicates: fixtureRubric,
				live: fixtureLive,
				liveDebt: fixtureDebt,
				surface: { ...fixtureSurface, entries: [...fixtureSurface.entries, { section: "ghost_rule", path: "x", hits: 1, kind: "debt" }] },
				pageClosures: new Map([["/a", new Set()], ["/b", new Set()], ["/r", new Set()]]),
				chromeClosure: new Set(),
			}),
		"ghost_rule",
	);

	// ── the live half ────────────────────────────────────────────────────────────────────────
	ok(
		"the two sections partition the ten live predicates, disjointly",
		livePredicateSections().size === 10 &&
			[...livePredicateSections()].filter(([, k]) => k === "permissions").map(([id]) => id).join(",") === "T7",
	);
	raises(
		"a live predicate declaring a section LIVE_SECTIONS does not define RAISES",
		() => livePredicateSections({ R1: { kind: "live", section: "ghosts", why: "x" } }, LIVE_SECTIONS),
		"which LIVE_SECTIONS does not define",
	);
	raises(
		"a section no predicate reads RAISES — an artifact nobody reads has an absence that looks clean",
		() => livePredicateSections({ R1: { kind: "live", section: "routes", why: "x" } }, LIVE_SECTIONS),
		"owns NO predicate",
	);

	// THE DECISION MIRRORS ITS EMITTER. `e2e/audit/report.ts` declares the N/A reasons at the point a
	// verdict is written; this file re-declares them at the point one is read. A hand-copied list is
	// exactly what decays silently, so the emitter's own table is parsed and compared.
	const reportSrc = readFileSync(path.join(REPO_ROOT, LIVE_REPORT_TS), "utf8");
	const naBlock = reportSrc.match(/export const NA_REASONS = \{([\s\S]*?)\n\} as const;/);
	/** @type {Record<string, string[]>} */
	const mirrored = {};
	for (const line of (naBlock?.[1] ?? "").split("\n")) {
		const m = line.match(/^\s*([A-Z]\d+):\s*(\[[^\]]*\]),\s*$/);
		if (m !== null) mirrored[m[1]] = JSON.parse(m[2].replace(/'/g, '"'));
	}
	// The comparison is worthless if the parse found nothing, so that is asserted FIRST and
	// separately — "the emitter's table is empty" and "the emitter's table matches" must not read
	// the same.
	ok(`the ${LIVE_REPORT_TS} NA_REASONS table parses, and is not empty`, naBlock !== null && Object.keys(mirrored).length === 10);
	ok(
		"...and LIVE_NA_REASONS mirrors it exactly, key for key and reason for reason",
		JSON.stringify(Object.entries(mirrored).sort()) === JSON.stringify(Object.entries(LIVE_NA_REASONS).map(([k, v]) => [k, [...v]]).sort()),
	);
	ok(
		"...including the three that are NEVER N/A — an empty list is the assertion, not an omission",
		LIVE_NA_REASONS.R5.length === 0 && LIVE_NA_REASONS.R6.length === 0 && LIVE_NA_REASONS.R7.length === 0,
	);

	// ── evidence summaries: hand-built shapes, hand-written expectations ──────────────────────
	// Never a value the summariser computed. Each shape is the one `e2e/audit/routes.spec.ts` and
	// `permissions.spec.ts` really record — six of the ten FAIL nowhere on today's tree, so without
	// these their branches would ship untested.
	ok(
		"R1 names the widths the body overflowed at, and nothing else",
		summariseLiveEvidence("R1", [
			{ width: 768, scrollWidth: 812, clientWidth: 768, offenders: ["x"] },
			{ width: 1280, scrollWidth: 1280, clientWidth: 1280, offenders: [] },
			{ width: 1440, scrollWidth: 1600, clientWidth: 1440, offenders: [] },
		]) === "the body overflows horizontally at 768w, 1440w",
	);
	raises(
		"...and a one-pixel difference is not an overflow — the spec's own +1 tolerance, mirrored",
		() => summariseLiveEvidence("R1", [{ width: 768, scrollWidth: 769, clientWidth: 768, offenders: [] }]),
		"finds no overflowing width in its evidence",
	);
	ok(
		"R3 counts the containers that are not the shell's, and agrees with itself about number",
		summariseLiveEvidence("R3", [
			{ width: 768, containers: [{ isShellScroller: false }] },
			{ width: 1280, containers: [{ isShellScroller: true }] },
		]) === "1 scroll container that is not the shell's at 768w",
	);
	ok(
		"...and two containers is the defect even when one of them IS the shell's",
		summariseLiveEvidence("R3", [{ width: 1920, containers: [{ isShellScroller: true }, { isShellScroller: false }] }]) ===
			"2 scroll containers that are not the shell's at 1920w",
	);
	ok(
		"R4 counts pairs and names the widths, and carries NO element description",
		summariseLiveEvidence("R4", [
			{ width: 768, a: "button#base-ui-_r_2_", b: "span", overlapWidth: 13, overlapHeight: 20 },
			{ width: 1280, a: "button#base-ui-_r_9_", b: "span", overlapWidth: 4, overlapHeight: 20 },
		]) === "2 overlapping pairs of interactive elements at 768w, 1280w",
	);
	ok(
		"R2 names the overlay kinds that hit-tested below the chrome",
		summariseLiveEvidence("R2", [
			{ kind: "popover-content", points: [{ inside: true }, { inside: false }] },
			{ kind: "dialog-content", points: [{ inside: true }] },
			{ kind: "tooltip-content", points: [{ inside: false }] },
		]) === "2 overlays hit-tested below the chrome — popover-content, tooltip-content",
	);
	ok(
		"R5 is the axe rule ids, sorted, with impact and node count",
		summariseLiveEvidence("R5", [
			{ id: "label", impact: "critical", nodes: 4 },
			{ id: "color-contrast", impact: "serious", nodes: 9 },
		]) === "color-contrast (serious) ×9, label (critical) ×4",
	);
	ok(
		"R6 counts the two kinds and the distinct statuses — no URL, no timestamp",
		summariseLiveEvidence("R6", [
			{ kind: "response", status: 400, url: "http://localhost:3000/x", at: "2026-09-02T11:31:07.746Z" },
			{ kind: "console", text: "Failed to load resource", at: "2026-09-02T11:31:07.747Z" },
			{ kind: "response", status: 404, url: "http://localhost:3000/y", at: "2026-09-02T11:31:07.749Z" },
		]) === "1 console error, 2 failed requests (400, 404), of the first 10 recorded",
	);
	ok(
		"R7 names the BUDGET, which is a constant, and never the p95, which is the runner's",
		summariseLiveEvidence("R7", { samples: [785, 9000], p95: 9000, budgetMs: 8000 }) === "p95 over the route's 8000ms budget",
	);
	ok(
		"T5 counts the hand-rolled regions",
		summariseLiveEvidence("T5", { shared: 0, handRolled: ["a", "b"], items: 0 }) ===
			"2 hand-rolled empty regions, none resolving to @repo/ui/empty",
	);
	ok(
		"T6 says the fault did not reach the shared error state",
		summariseLiveEvidence("T6", { shellSurvived: true, rendersSharedErrorState: false, errorish: "…" }) ===
			"the injected fault did not render components/errors/error-state (the shell survived)",
	);
	ok(
		"T7 distinguishes a redirect from a blank",
		summariseLiveEvidence("T7", { redirectedAway: true }) === "the member is refused and is redirected away rather than shown a state" &&
			summariseLiveEvidence("T7", { redirectedAway: false }) === "the member is refused and the page renders a blank, not a deliberate state",
	);
	raises(
		"an evidence shape the summariser does not know RAISES rather than summarising as nothing",
		() => summariseLiveEvidence("R5", { violations: [] }),
		"expected an array of evidence rows",
	);
	// A summary that contradicts the verdict it is attached to is worse than no summary. Each of
	// these is the recorder and this file disagreeing about what the predicate measures.
	raises("a FAIL whose axe evidence holds NO violation RAISES", () => summariseLiveEvidence("R5", []), "finds no axe violation");
	raises("...and a FAIL with no overlapping pair RAISES", () => summariseLiveEvidence("R4", []), "finds no overlapping pair");
	raises("...and a FAIL with no signal RAISES", () => summariseLiveEvidence("R6", []), "finds no console error or failed request");
	raises(
		"...and a T5 FAIL that hand-rolled nothing RAISES",
		() => summariseLiveEvidence("T5", { shared: 0, handRolled: [], items: 0 }),
		"finds no hand-rolled empty region",
	);
	raises(
		"...and an R3 FAIL whose only container IS the shell's RAISES",
		() => summariseLiveEvidence("R3", [{ width: 768, containers: [{ isShellScroller: true }] }]),
		"finds no width with a scroll container that is not the shell's",
	);
	raises(
		"...and a predicate with no summariser at all RAISES",
		() => summariseLiveEvidence("S1", []),
		"no evidence summariser",
	);
	// The one that would otherwise ship a wall clock into a diff-gated region.
	raises(
		"a summary that carries a timestamp or a URL RAISES",
		() => summariseLiveEvidence("R5", [{ id: "x at 2026-09-02T11:31:07.746Z", impact: "serious", nodes: 1 }]),
		"carries a timestamp or a URL",
	);

	// ── the committed file's own rules ────────────────────────────────────────────────────────
	const described = (key, over) => ({ ...LIVE_SECTIONS[key], runKey: "k", records: [], ...over });
	const liveText = (over) =>
		JSON.stringify({
			version: 1,
			source: fixtureLive.source,
			runs: { routes: described("routes"), permissions: described("permissions"), ...Object.fromEntries(Object.entries(over ?? {}).map(([k, v]) => [k, described(k, v)])) },
		});
	ok("a well-formed live file parses", parseLive(liveText({ routes: { runKey: "k", records: [liveRecord("/a", "R1", "PASS")] } })).sections.routes.records.length === 1);
	raises("a version this file does not know RAISES", () => parseLive(JSON.stringify({ version: 2 })), "expected `version: 1`");
	raises("a file with no provenance RAISES", () => parseLive(JSON.stringify({ version: 1, runs: {} })), "a baseline nobody can cite is not one");
	raises("a missing section RAISES", () => parseLive(JSON.stringify({ version: 1, source: fixtureLive.source, runs: { routes: described("routes") } })), "runs.permissions");
	raises(
		"a section that describes an artifact LIVE_SECTIONS has moved RAISES rather than reading on",
		() => parseLive(JSON.stringify({ version: 1, source: fixtureLive.source, runs: { routes: described("routes", { artifact: "test-results/old.json" }), permissions: described("permissions") } })),
		"describe a section that has moved",
	);
	raises(
		"a T7 record inside the PRIMARY run RAISES — the pooling failure report.ts records",
		() => parseLive(liveText({ routes: { runKey: "k", records: [liveRecord("/a", "T7", "PASS")] } })),
		"The two personas must not be pooled",
	);
	raises(
		"an N/A on R5 RAISES — RUBRIC.md declares it NEVER N/A",
		() => parseLive(liveText({ routes: { runKey: "k", records: [liveRecord("/a", "R5", "N/A", { reason: "redirect-only" })] } })),
		"none — this predicate is NEVER N/A",
	);
	raises(
		"an N/A with an undeclared reason RAISES",
		() => parseLive(liveText({ routes: { runKey: "k", records: [liveRecord("/a", "R1", "N/A", { reason: "looks-fine" })] } })),
		"is not a declared N/A reason",
	);
	raises(
		"an N/A with no reason at all RAISES",
		() => parseLive(liveText({ routes: { runKey: "k", records: [liveRecord("/a", "R1", "N/A")] } })),
		"an N/A with no reason is not an N/A",
	);
	raises(
		"a NOT MEASURED with no reason RAISES — it would say nothing about the instrument",
		() => parseLive(liveText({ routes: { runKey: "k", records: [liveRecord("/a", "R1", "NOT MEASURED")] } })),
		"says nothing about the instrument",
	);
	raises(
		"a PASS carrying a reason RAISES",
		() => parseLive(liveText({ routes: { runKey: "k", records: [liveRecord("/a", "R1", "PASS", { reason: "redirect-only" })] } })),
		"must not carry a reason",
	);
	raises(
		"a verdict outside the four RAISES",
		() => parseLive(liveText({ routes: { runKey: "k", records: [liveRecord("/a", "R1", "SKIPPED")] } })),
		"which is not one of PASS, FAIL, N/A, NOT MEASURED",
	);
	raises(
		"the same (route, predicate) twice RAISES — two verdicts for one cell is two answers",
		() => parseLive(liveText({ routes: { runKey: "k", records: [liveRecord("/a", "R1", "PASS"), liveRecord("/a", "R1", "FAIL")] } })),
		"is recorded twice",
	);

	// ── vacuity: "found nothing" must not be reachable from "was not run" ─────────────────────
	const emptyLive = { source: fixtureLive.source, sections: { routes: { runKey: "k", records: [] }, permissions: { runKey: "k", records: [] } } };
	ok("a healthy live artifact is clean", liveVacuityProblems(fixtureLive, ["/a", "/b", "/r"]).length === 0);
	ok(
		"an EMPTY live artifact is a problem, not ten predicates nobody failed",
		liveVacuityProblems(emptyLive, ["/a"]).some((p) => p.includes("ZERO records")),
	);
	ok(
		"...and every live predicate with no record anywhere is named",
		liveVacuityProblems(emptyLive, ["/a"]).filter((p) => p.includes("has NO record in any section")).length === 10,
	);
	ok(
		"a record naming a route the manifest does not define is a problem",
		liveVacuityProblems(fixtureLive, ["/b", "/r"]).some((p) => p.includes("`/a`") && p.includes("drifted apart")),
	);

	// ── the join, and NOT MEASURED ────────────────────────────────────────────────────────────
	ok("a live FAIL reaches the scoreboard with its detail", verdict("/a", "R4").verdict === "FAIL" && verdict("/a", "R4").detail === "1 overlapping pair of interactive elements at 768w");
	ok("a live N/A keeps its declared reason", verdict("/r", "R1").verdict === "N/A" && verdict("/r", "R1").reason === "redirect-only");
	ok(
		"a cell the PRIMARY run did not reach is NOT MEASURED, naming the run",
		verdict("/r", "R7").verdict === "NOT MEASURED" && verdict("/r", "R7").reason.includes("`routes` run did not reach"),
	);
	ok(
		"...and a route the PERMISSIONS run does not cover is NOT MEASURED, naming that run instead",
		verdict("/r", "T7").verdict === "NOT MEASURED" && verdict("/r", "T7").reason.includes("`permissions` run did not reach"),
	);
	ok(
		"NOT MEASURED is NEVER folded into N/A",
		view.predicates.R7.notMeasured === 1 && view.predicates.R7.na === 0 && view.predicates.T7.notMeasured === 1 && view.predicates.T7.na === 0,
	);
	ok("...and it leaves the denominator, exactly as an N/A does: T7 is 1 PASS / 1 FAIL / 1 withheld = 0.50", view.predicates.T7.score === 0.5);
	ok("...so a predicate withheld everywhere scores null, never 1", scoreOf(0, 0) === null);
	const allWithheld = buildView({
		run: fixtureRun,
		rubricPredicates: fixtureRubric,
		surface: fixtureSurface,
		liveDebt: fixtureDebt,
		live: {
			...fixtureLive,
			sections: {
				...fixtureLive.sections,
				routes: {
					runKey: "k",
					records: fixtureLive.sections.routes.records.map((r) =>
						r.predicate === "R1" ? liveRecord(r.route, "R1", "NOT MEASURED", { reason: "R1's positive control was red" }) : r,
					),
				},
			},
		},
		pageClosures: new Map([["/a", new Set()], ["/b", new Set()], ["/r", new Set()]]),
		chromeClosure: new Set(),
	});
	ok(
		"a predicate withheld on every route it was recorded on scores `—`, and 0.00 appears nowhere",
		allWithheld.predicates.R1.score === null && allWithheld.predicates.R1.pass === 0 && allWithheld.predicates.R1.fail === 0 && allWithheld.predicates.R1.notMeasured === 3,
	);
	ok(
		"...and its per-predicate row renders a dash for the score, not a zero",
		renderScoreboard(allWithheld).split("\n").some((l) => l.startsWith("| **R1** | R | live") && l.endsWith("| 0 | 0 | 0 | 3 | — | — |")),
	);
	ok(
		"a family cell says how many of its predicates were withheld",
		cell({ instrumented: 7, of: 7, pass: 4, fail: 1, na: 1, notMeasured: 1, score: 0.8 }) === "4/5 · 0.80 · 1 withheld",
	);
	ok("...and `all withheld` never reads as `all N/A`", cell({ instrumented: 7, of: 7, pass: 0, fail: 0, na: 0, notMeasured: 7, score: null }) === "all withheld (7)");
	ok("...and a family that is part one and part the other says so", cell({ instrumented: 7, of: 7, pass: 0, fail: 0, na: 3, notMeasured: 4, score: null }) === "all N/A or withheld");
	ok("...and `all N/A` is unchanged when nothing was withheld", cell({ instrumented: 4, of: 4, pass: 0, fail: 0, na: 4, notMeasured: 0, score: null }) === "all N/A");

	// ── the live debt ledger, both directions ─────────────────────────────────────────────────
	raises(
		"a live predicate that FAILS with no owning issue RAISES",
		() => buildView({ run: fixtureRun, rubricPredicates: fixtureRubric, surface: fixtureSurface, live: fixtureLive, liveDebt: { R4: fixtureDebt.R4, R5: fixtureDebt.R5 }, pageClosures: new Map([["/a", new Set()], ["/b", new Set()], ["/r", new Set()]]), chromeClosure: new Set() }),
		"T7 FAILS on 1 route(s) and no LIVE_DEBT row owns it",
	);
	raises(
		"...and a debt row for a predicate that no longer fails RAISES too — the direction that keeps it true",
		() => buildView({ run: fixtureRun, rubricPredicates: fixtureRubric, surface: fixtureSurface, live: fixtureLive, liveDebt: { ...fixtureDebt, R1: { owner: "#9", why: "stale" } }, pageClosures: new Map([["/a", new Set()], ["/b", new Set()], ["/r", new Set()]]), chromeClosure: new Set() }),
		"R1 has a LIVE_DEBT row (#9) and now FAILS nowhere",
	);
	raises(
		"a debt row naming something that is not a live predicate RAISES",
		() => buildView({ run: fixtureRun, rubricPredicates: fixtureRubric, surface: fixtureSurface, live: fixtureLive, liveDebt: { ...fixtureDebt, H1: { owner: "#9", why: "x" } }, pageClosures: new Map([["/a", new Set()], ["/b", new Set()], ["/r", new Set()]]), chromeClosure: new Set() }),
		"LIVE_DEBT names H1, which is not a live predicate",
	);
	raises(
		"an EMPTY live artifact refuses to build a view at all",
		() => buildView({ run: fixtureRun, rubricPredicates: fixtureRubric, surface: fixtureSurface, live: emptyLive, liveDebt: {}, pageClosures: new Map([["/a", new Set()], ["/b", new Set()], ["/r", new Set()]]), chromeClosure: new Set() }),
		"the live audit records did not measure the console",
	);

	// ── the import ────────────────────────────────────────────────────────────────────────────
	const rawArtifacts = {
		routes: {
			runKey: "e2e-org-1",
			generatedAt: "2026-09-02T11:38:25.961Z",
			summary: {},
			records: [
				{ route: "/b", url: "/e2e-org-1/b", predicate: "R1", verdict: "PASS", evidence: [{ width: 768, scrollWidth: 768, clientWidth: 768 }] },
				{ route: "/a", url: "/e2e-org-1", predicate: "R5", verdict: "FAIL", evidence: [{ id: "color-contrast", impact: "serious", nodes: 9 }] },
				{ route: "/a", url: "/e2e-org-1", predicate: "R1", verdict: "N/A", reason: "redirect-only", evidence: [] },
			],
		},
		permissions: { runKey: "e2e-org-2", generatedAt: "2026-09-02T11:31:39.556Z", records: [{ route: "/a", url: "/e2e-org-2", predicate: "T7", verdict: "PASS", evidence: { member: { text: "…" } } }] },
	};
	const imported = JSON.parse(importLive(rawArtifacts, { run: "https://example.invalid/runs/7", commit: "abc123" }));
	ok("the import keeps both runs apart, each with its own runKey", imported.runs.routes.runKey === "e2e-org-1" && imported.runs.permissions.runKey === "e2e-org-2");
	ok("...and records the provenance the baseline is cited by", imported.source.run === "https://example.invalid/runs/7" && imported.source.commit === "abc123");
	ok("...and sorts the records, so two imports of one run are byte-identical", imported.runs.routes.records.map((r) => `${r.route} ${r.predicate}`).join(",") === "/a R1,/a R5,/b R1");
	ok("...and strips generatedAt, url and evidence", !("generatedAt" in imported) && imported.runs.routes.records.every((r) => !("url" in r) && !("evidence" in r)));
	ok("...and summarises a FAIL into a run-independent detail", imported.runs.routes.records[1].detail === "color-contrast (serious) ×9");
	ok("...and carries no wall clock anywhere", !/\d{4}-\d{2}-\d{2}/.test(JSON.stringify(imported)));
	ok("...and re-parses through the same rules it will be read by", parseLive(importLive(rawArtifacts, { run: "r", commit: "c" })).sections.routes.records.length === 3);
	raises(
		"importing an artifact with ZERO records RAISES rather than producing a clean board",
		() => importLive({ ...rawArtifacts, routes: { runKey: "k", records: [] } }, { run: "r", commit: "c" }),
		"ZERO records",
	);
	raises(
		"importing a file with no `records` array at all RAISES",
		() => importLive({ ...rawArtifacts, permissions: { runKey: "k" } }, { run: "r", commit: "c" }),
		"no `records` array",
	);
	raises(
		"importing a T7 record out of the PRIMARY artifact RAISES",
		() => importLive({ ...rawArtifacts, routes: { runKey: "k", records: [{ route: "/a", predicate: "T7", verdict: "PASS" }] } }, { run: "r", commit: "c" }),
		"belongs to the `permissions` section",
	);
	raises("importing without provenance RAISES", () => importLive(rawArtifacts, { run: "", commit: "c" }), "a baseline nobody can cite is not one");

	// ── the CLI's valued arguments ────────────────────────────────────────────────────────────
	ok("--import-live=<dir> --run= --commit= parses", parseCliArgs(["--import-live=x", "--run=r", "--commit=c"]).mode === "import-live");
	ok("...carrying all three values", parseCliArgs(["--import-live=x", "--run=r", "--commit=c"]).dir === "x");
	ok("--import-live without provenance is an ERROR, not a silent import", parseCliArgs(["--import-live=x"]).error?.includes("--run and --commit"));
	ok("...and a space-separated value is an ERROR, not a run named --commit=c", parseCliArgs(["--import-live", "x"]).error?.includes("needs a value"));
	ok("--run without --import-live means nothing and says so", parseCliArgs(["--run=r"]).error?.includes("only mean something with --import-live"));
	ok("--import-live and --write cannot both be asked for", parseCliArgs(["--import-live=x", "--run=r", "--commit=c", "--write"]).error?.includes("cannot both"));
	ok("...and the existing modes are unchanged", parseCliArgs([]).mode === "check" && parseCliArgs(["--write"]).mode === "write" && parseCliArgs(["--nope"]).error?.includes("unrecognised"));

	// ── rendering ────────────────────────────────────────────────────────────────────────────
	const md = renderScoreboard(view);
	ok("the rendered scoreboard names the F family as un-instrumented, with its issue", md.includes("| **F7** |") && md.includes(NOT_SCORED_STATICALLY.F7.owner));
	ok("...and H3 too", md.includes("| **H3** |") && md.includes(NOT_SCORED_STATICALLY.H3.owner));
	// Not "does it say `—` somewhere" — every numeric column of every un-instrumented row must be
	// a dash. A 0.00 there would read as "measured, and failed everywhere", which is the opposite
	// of what is true and the exact confusion this column exists to prevent.
	const noneRows = md.split("\n").filter((l) => /^\| \*\*(?:F\d|H3)\*\* \| [FH] \| \*\*none\*\*/.test(l));
	ok(
		"...and every un-instrumented row's PASS / FAIL / N/A / score columns are all dashes",
		noneRows.length === 8 && noneRows.every((l) => l.endsWith("| — | — | — | — | — | — |")),
	);
	ok("rendering is deterministic", renderScoreboard(view) === md && renderJson(view) === renderJson(view));
	ok(
		"NO WALL CLOCK reaches the diff-gated region — a date there makes every PR stale on arrival",
		!/\d{4}-\d{2}-\d{2}/.test(md) && !/\d{4}-\d{2}-\d{2}/.test(renderJson(view)),
	);
	ok("...and no absolute path either", !md.includes(REPO_ROOT) && !renderJson(view).includes(REPO_ROOT));
	const parsedJson = JSON.parse(renderJson(view));
	ok("the JSON carries one record per (route, predicate) it scored — 16 static + 10 live", parsedJson.verdicts.length === 3 * 26);
	ok("...in the shape e2e/audit/report.ts writes", parsedJson.verdicts.every((v) => "route" in v && "predicate" in v && "verdict" in v));

	// ── splice ───────────────────────────────────────────────────────────────────────────────
	const shell = `# t\n\nintent\n\n${BEGIN}\nold\n${END}\n\ntail\n`;
	ok("splice replaces only the generated region", splice(shell, "new").includes("new") && splice(shell, "new").includes("intent") && splice(shell, "new").includes("tail") && !splice(shell, "new").includes("old"));
	raises("a missing marker RAISES", () => splice("# t\nno markers\n", "new"), "missing the generated-region markers");
	raises("a DUPLICATED marker RAISES rather than orphaning the second region", () => splice(`${shell}${BEGIN}\n${END}\n`, "new"), "expected exactly one of each");

	console.log(failures === 0 ? "\nself-test: all passed" : `\nself-test: ${failures} FAILED`);
	return failures === 0 ? 0 : 1;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────

export const USAGE = [
	"Usage: node apps/console/scripts/audit-report.mjs [--write|--json|--self-test|--import-live=<dir>|--help]",
	"",
	"  (no argument)  check the generated files are in sync with the tree; exit 2 if not",
	"  --write        regenerate apps/console/docs/ui-conformance/scoreboard.md and",
	"                 apps/console/ui-conformance-baseline.json",
	"  --json         print the derived view; write nothing",
	"  --self-test    run the fixture suite; exit 1 on any failure",
	"",
	"  --import-live=<dir>   rewrite apps/console/ui-conformance-live.json from a CI run's",
	"                        `ui-audit` artifact. <dir> is the unpacked artifact (or the",
	"                        test-results/ directory inside it). REQUIRES:",
	"  --run=<url or id>     the workflow run the records came from",
	"  --commit=<sha>        the commit that run measured",
	"",
	"  --help, -h     this text",
].join("\n");

/**
 * The whole argument parser. An unrecognised argument is an ERROR, never a fall-through to the
 * default mode: a caller's typo must not be indistinguishable from a successful run.
 *
 * `--import-live`, `--run` and `--commit` take a value, and ONLY in the `--name=value` form. A
 * space-separated value would make `--run --commit=x` parse as a run named `--commit=x`, which is
 * the shape that silently imports a baseline with no provenance.
 */
export function parseCliArgs(argv) {
	const MODES = { "--write": "write", "--json": "json", "--self-test": "self-test", "--help": "help", "-h": "help" };
	const VALUED = ["--import-live", "--run", "--commit"];
	if (argv.length === 0) return { mode: "check", error: null };

	/** @type {Record<string, string>} */
	const values = {};
	/** @type {string[]} */
	const flags = [];
	for (const a of argv) {
		const eq = a.indexOf("=");
		const name = eq === -1 ? a : a.slice(0, eq);
		if (VALUED.includes(name)) {
			if (eq === -1) return { mode: null, error: `${name} needs a value: write it as ${name}=<value>` };
			if (name in values) return { mode: null, error: `${name} was given twice` };
			values[name] = a.slice(eq + 1);
			if (values[name] === "") return { mode: null, error: `${name}= was given an empty value` };
			continue;
		}
		flags.push(a);
	}
	const unknown = flags.filter((a) => !(a in MODES));
	if (unknown.length > 0) return { mode: null, error: `unrecognised argument${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}` };
	if (flags.some((a) => MODES[a] === "help")) return { mode: "help", error: null };
	const distinct = [...new Set(flags.map((a) => MODES[a]))];
	if ("--import-live" in values) {
		if (distinct.length > 0) return { mode: null, error: `--import-live and ${distinct.join(" and ")} cannot both be asked for` };
		const missing = ["--run", "--commit"].filter((k) => !(k in values));
		if (missing.length > 0) {
			return {
				mode: null,
				error: `--import-live needs ${missing.join(" and ")}: a baseline nobody can cite the provenance of is not one`,
			};
		}
		return { mode: "import-live", error: null, dir: values["--import-live"], run: values["--run"], commit: values["--commit"] };
	}
	const orphans = Object.keys(values);
	if (orphans.length > 0) return { mode: null, error: `${orphans.join(" and ")} only mean something with --import-live` };
	if (distinct.length > 1) return { mode: null, error: `${distinct.join(" and ")} cannot both be asked for` };
	return { mode: distinct[0], error: null };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
	const parsed = parseCliArgs(process.argv.slice(2));
	if (parsed.error !== null) {
		console.error(`audit-report: ${parsed.error}\n\n${USAGE}`);
		process.exit(2);
	}
	if (parsed.mode === "help") {
		console.log(USAGE);
		process.exit(0);
	}
	if (parsed.mode === "self-test") {
		try {
			process.exit(selfTest());
		} catch (err) {
			console.error(`\nFAIL - the self-test raised before it could report: ${err instanceof Error ? err.stack : err}`);
			console.error("self-test: 1 FAILED");
			process.exit(1);
		}
	}

	if (parsed.mode === "import-live") {
		// Both layouts a person actually has in front of them: the unpacked `ui-audit` artifact
		// (which contains `test-results/`) and that directory itself. Anything else is a wrong path,
		// and the message names both files rather than only the first one missing.
		const base = path.resolve(parsed.dir);
		const candidates = [path.join(base, "test-results"), base];
		/** @type {Record<string, unknown>} */
		const raw = {};
		for (const [key, section] of Object.entries(LIVE_SECTIONS)) {
			const leaf = path.basename(section.artifact);
			const found = candidates.map((d) => path.join(d, leaf)).find((f) => {
				try {
					return statSync(f).isFile();
				} catch {
					return false;
				}
			});
			if (found === undefined) {
				console.error(
					`audit-report: could not find \`${leaf}\` under ${candidates.join(" or ")}.\n` +
						`Download it with \`gh run download <run-id> -n ui-audit -D <dir>\`; the \`audit\` job ` +
						`uploads both files with 14-day retention.`,
				);
				process.exit(1);
			}
			try {
				raw[key] = JSON.parse(readFileSync(found, "utf8"));
			} catch (err) {
				console.error(`audit-report: ${found} is not valid JSON (${err instanceof Error ? err.message : String(err)}).`);
				process.exit(1);
			}
		}
		/** @type {string} */
		let body;
		try {
			body = importLive(raw, { run: parsed.run, commit: parsed.commit });
		} catch (err) {
			console.error(`audit-report: ${err instanceof Error ? err.message : String(err)}`);
			process.exit(1);
		}
		writeFileSync(path.join(REPO_ROOT, LIVE_JSON), body);
		const counts = Object.entries(parseLive(body).sections)
			.map(([key, sec]) => `${key} ${sec.records.length}`)
			.join(" · ");
		console.log(`wrote ${LIVE_JSON} — ${counts} record(s), from ${parsed.run} @ ${parsed.commit}`);
		console.log(`Now run \`pnpm -F console audit:report --write\` and commit both.`);
		process.exit(0);
	}

	// Every raise below this line is a REFUSAL, not a finding, and it is printed as one. The three
	// that have been driven rather than reasoned about: the private route group renamed (the
	// manifest's own raise, passed straight through), a module a page imports deleted (the closure
	// refusing to shorten silently), and a scope root moved out from under the shared-surface scan.
	// A stack trace answers none of those; the message does, and exiting 1 keeps them distinct from
	// the staleness exit 2 that a lane sees every day.
	/** @type {ReturnType<typeof runReport>} */
	let view;
	try {
		view = runReport(REPO_ROOT);
	} catch (err) {
		console.error(`audit-report: ${err instanceof Error ? err.message : String(err)}`);
		console.error(
			"\nThis is a refusal to report, not a clean board. A scoreboard produced over a tree this " +
				"could not fully read would say the console is fine about pages it never looked at.",
		);
		process.exit(1);
	}

	if (parsed.mode === "json") {
		console.log(renderJson(view));
		process.exit(0);
	}

	const mdPath = path.join(REPO_ROOT, SCOREBOARD);
	const jsonPath = path.join(REPO_ROOT, BASELINE_JSON);
	const wantMd = splice(readFileSync(mdPath, "utf8"), renderScoreboard(view));
	const wantJson = renderJson(view);

	const t = view.totals;
	const summary =
		`${t.routes} routes · ${t.scoredHere + t.live} of ${t.predicates} predicates scored ` +
		`(${t.scoredHere} static, ${t.live} live) · ${t.liveNotMeasured} live verdict(s) withheld · ` +
		`${t.findings} shared-surface occurrence(s) across ${t.findingFiles} file(s)`;

	if (parsed.mode === "write") {
		writeFileSync(mdPath, wantMd);
		writeFileSync(jsonPath, wantJson);
		console.log(`wrote ${SCOREBOARD} and ${BASELINE_JSON} — ${summary}`);
		process.exit(0);
	}

	const stale = [];
	if (readFileSync(mdPath, "utf8") !== wantMd) stale.push(SCOREBOARD);
	if (readFileSync(jsonPath, "utf8") !== wantJson) stale.push(BASELINE_JSON);
	if (stale.length > 0) {
		for (const f of stale) console.error(`::error::audit-report: ${f} is STALE — run \`pnpm -F console audit:report --write\` and commit.`);
		console.error(`\naudit-report: ${stale.length} generated file(s) do not match the tree (${summary}).`);
		process.exit(2);
	}
	console.log(`audit-report: ${SCOREBOARD} and ${BASELINE_JSON} are in sync — ${summary}`);
}
