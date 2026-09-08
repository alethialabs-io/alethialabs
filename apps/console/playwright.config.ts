// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { STORAGE_STATE } from "./e2e/fixtures/auth";

const isCI = !!process.env.CI;
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

// Where the console's stdout (incl. the logged OTP) is teed. Locally `pnpm dev:up` already tees to
// the default path and Playwright reuses that server; in CI this config boots the server itself and
// tees `next start` here (the e2e-browser job sets DEV_CONSOLE_LOG to match).
const consoleLog = process.env.DEV_CONSOLE_LOG ?? "/tmp/alethia-dev-console.log";

const TEST_DIR = path.join(__dirname, "e2e");
const WORKFLOWS_DIR = path.join(__dirname, "..", "..", ".github", "workflows");

/**
 * The slice of a Playwright project the guard reads. Declared locally rather than importing
 * `Project`: the guard only ever needs the selection fields, and a local shape keeps the
 * `projects` array's own inference (device options, `dependencies`) exactly as Playwright checks it.
 */
interface ProjectShape {
	name?: string;
	testMatch?: string | RegExp | (string | RegExp)[];
	testIgnore?: string | RegExp | (string | RegExp)[];
}

/**
 * Where each project ACTUALLY runs — the workflow job that invokes `--project=<name>`, or `null`
 * for one that deliberately runs nowhere but a laptop (with the reason it is not gating).
 *
 * This map is not documentation. `assertNoDeadZone()` below checks it against the workflows on
 * every Playwright invocation, in both directions, so it cannot quietly go stale.
 *
 * Why it exists (#2875): the config used to define seven projects while CI launched two. Three
 * projects — `elench-ux`, `canvas`, `qa` — and a denylist catch-all called `chromium` ran in no
 * job anywhere, ~14 specs' worth, and read to every later reader as coverage that did not exist.
 */
const RUN_POSTURE: Record<string, string | null> = {
	// A dependency of the gating projects, never invoked on its own. Named leg by leg, because the
	// shorthand was wrong in both halves: `hero` signs ITSELF in as step 1 and declares no
	// dependency, `console` signs up per-spec, and `qa` builds its personas in `global-setup`
	// behind ALETHIA_QA_E2E=1. Only elench-ai, elench-live, canvas and audit declare
	// `dependencies: ["setup"]`. This string is what the dead-zone guard prints when it fails, so a
	// reader debugging a `setup` problem on the `qa` or `hero` leg was being sent to look for a
	// dependency that is not there.
	setup: "ci.yml · dependency of elench-ai · release-gate.yml · dependency of elench-ai/canvas/audit",
	// Twice-homed: the per-PR job on dev (ci.yml) and the promotion gate (release-gate.yml). ci.yml
	// skips its copy on a PR into main/staging so one merge ref does not boot the same console twice.
	hero: "ci.yml · E2E (browser · Playwright hero path) · release-gate.yml · Release gate (hero)",
	"elench-ai":
		"ci.yml · E2E (browser · Elench AI journeys · scripted model) · release-gate.yml · Release gate (elench-ai)",
	"elench-live": "e2e-ai-nightly.yml · Elench live-model journeys",
	// Nightly in ci.yml (that run refreshes ui-conformance-live.json) AND a leg of the release gate,
	// where it is REQUIRED on main by ratchet: it fails on regression against gate-baseline.json,
	// not on absolute red — which is what lets a suite with recorded findings gate a promotion
	// without #2417's shape.
	audit: "ci.yml · UI conformance audit (nightly) · release-gate.yml · Release gate (audit)",
	// The three that ran NOWHERE until the release gate (#4265). Each is a leg now, by ratchet.
	canvas: "release-gate.yml · Release gate (canvas)",
	console: "release-gate.yml · Release gate (console)",
	qa: "release-gate.yml · Release gate (qa)",
};

/**
 * Reasons for the `null` postures — printed by the guard so the exemption stays argued, not assumed.
 *
 * EMPTY since the release gate (#4265): every project has a job. It stays as a map so the next
 * project that genuinely runs nowhere has somewhere to write its reason, and rule 2 below still
 * refuses a project with no posture at all.
 */
const LOCAL_ONLY_REASON: Record<string, string> = {};

/**
 * The e2e dead-zone guard. Fails the run — including both gating CI jobs, which is the point —
 * when a spec or a project has no home:
 *
 *   1. every `e2e/**\/*.spec.ts` is selected by at least one project (no orphan FILE);
 *   2. every project has a RUN_POSTURE entry (no unclassified project);
 *   3. every project whose posture names a job is really invoked as `--project=<name>` in
 *      `.github/workflows/**` (no posture that OVERSTATES where a project runs);
 *   4. every project whose posture is `null` is really invoked NOWHERE (no posture that
 *      UNDERSTATES it, which would make the honest table quietly wrong the other way).
 *
 * Rules 3 and 4 mirror the emitter — the workflows — rather than restating a belief about them.
 */
function assertNoDeadZone(projects: ProjectShape[]): void {
	const problems: string[] = [];

	// ── Rule 1: no orphan spec file. Matching uses the ABSOLUTE path, the same string Playwright
	// tests `testMatch`/`testIgnore` against, so this cannot diverge from real selection.
	const specs = collectSpecs(TEST_DIR);
	if (specs.length === 0) {
		// "found nothing" is a broken scan, not a clean bill of health.
		problems.push(`no *.spec.ts found under ${TEST_DIR} — the dead-zone scan is broken`);
	}
	for (const spec of specs) {
		const owners = projects.filter((p) => selects(p, spec));
		if (owners.length === 0) {
			problems.push(
				`${path.relative(TEST_DIR, spec)} is selected by NO project — it would run nowhere. ` +
					`Add it to a project's testMatch, or delete it.`,
			);
		}
	}

	// ── Rule 2: every project is classified.
	const named = projects.map((p) => p.name).filter((n): n is string => !!n);
	for (const name of named) {
		if (!(name in RUN_POSTURE)) {
			problems.push(`project "${name}" has no RUN_POSTURE entry — say where it runs, or that it does not.`);
		}
	}
	for (const name of Object.keys(RUN_POSTURE)) {
		if (!named.includes(name)) {
			problems.push(`RUN_POSTURE names "${name}", which is not a project any more — drop the entry.`);
		}
	}

	// ── Rules 3 + 4: the posture must match what the workflows actually invoke.
	const invoked = projectsInvokedByWorkflows();
	for (const name of named) {
		if (!(name in RUN_POSTURE)) continue; // already reported by rule 2
		const posture = RUN_POSTURE[name];
		if (posture === null && invoked.has(name)) {
			problems.push(
				`project "${name}" is marked local-only but a workflow invokes --project=${name}. ` +
					`Give it a posture string naming that job.`,
			);
		}
		if (posture !== null && name !== "setup" && !invoked.has(name)) {
			problems.push(
				`project "${name}" claims to run in "${posture}" but no workflow invokes ` +
					`--project=${name}. Either wire it up, or set its posture to null with a reason.`,
			);
		}
	}

	if (problems.length > 0) {
		throw new Error(
			`playwright.config.ts — e2e dead zone (#2875):\n  - ${problems.join("\n  - ")}\n\n` +
				`Deliberately local-only projects and why:\n` +
				Object.entries(LOCAL_ONLY_REASON)
					.map(([k, v]) => `  · ${k}: ${v}`)
					.join("\n"),
		);
	}
}

/** Every `*.spec.ts` under `dir`, recursively, as absolute paths. */
function collectSpecs(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === ".auth") continue;
			out.push(...collectSpecs(full));
		} else if (entry.name.endsWith(".spec.ts")) {
			out.push(full);
		}
	}
	return out;
}

/** Whether `project` would collect `file` — its testMatch minus its testIgnore. */
function selects(project: ProjectShape, file: string): boolean {
	const posix = file.split(path.sep).join("/");
	const hit = (patterns: RegExp[] | undefined, fallback: boolean): boolean => {
		if (patterns === undefined) return fallback;
		return patterns.some((re) => {
			re.lastIndex = 0;
			return re.test(posix);
		});
	};
	// Playwright's default testMatch collects every *.spec.ts, so an absent testMatch means "all".
	if (!hit(asRegExps(project.testMatch), true)) return false;
	return !hit(asRegExps(project.testIgnore), false);
}

/** Narrows a testMatch/testIgnore to the RegExp forms this config uses (string globs are refused). */
function asRegExps(value: ProjectShape["testMatch"]): RegExp[] | undefined {
	if (value === undefined) return undefined;
	const list = Array.isArray(value) ? value : [value];
	const regexps = list.filter((v): v is RegExp => v instanceof RegExp);
	if (regexps.length !== list.length) {
		// A string glob would silently fall through `selects()` and re-open the dead zone: the
		// guard would report "claimed" for a file no project actually collects.
		throw new Error(
			`playwright.config.ts — testMatch/testIgnore must be RegExp, got ` +
				`${list.map((v) => (v instanceof RegExp ? "RegExp" : `"${String(v)}"`)).join(", ")}. ` +
				`The dead-zone guard only understands regexes.`,
		);
	}
	return regexps;
}

/** Every project name any workflow invokes as `--project=<name>`. Reads the emitter, not a belief. */
function projectsInvokedByWorkflows(): Set<string> {
	if (!existsSync(WORKFLOWS_DIR)) {
		// A missing workflows dir cannot be read as "nothing is wired" — that is the silent-green
		// failure this whole guard exists to prevent.
		throw new Error(
			`playwright.config.ts — cannot verify e2e wiring: ${WORKFLOWS_DIR} does not exist. ` +
				`Run Playwright from a full checkout.`,
		);
	}
	const found = new Set<string>();
	for (const file of readdirSync(WORKFLOWS_DIR)) {
		if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
		const text = readFileSync(path.join(WORKFLOWS_DIR, file), "utf8");
		for (const m of text.matchAll(/--project=([A-Za-z0-9_-]+)/g)) found.add(m[1]);
	}
	return found;
}

/**
 * The theme every audited route STARTS in. Typed as the literal rather than left to inference: inside
 * the `projects` array a bare `"light"` widens to `string`, which no `defineConfig` overload accepts
 * — measured on the first CI run of #4195 (TS2769 at the `defineConfig` call).
 */
const AUDIT_START_THEME: "light" = "light";

const projects = [
	// Produces the reusable authenticated persona (e2e/.auth/persona.json). Specs that only need
	// an authed session — not the onboarding demo — can add `dependencies: ["setup"]` +
	// `use: { storageState: STORAGE_STATE }`.
	{ name: "setup", testMatch: /fixtures\/auth\.setup\.ts/ },

	// The CI-gated hero: the full sellable flow, fresh context (it signs itself in as step 1).
	{
		name: "hero",
		testMatch: /hero-happy-path\.spec\.ts/,
		use: { ...devices["Desktop Chrome"] },
	},

	// The Elench journeys against a SCRIPTED model (ALETHIA_AI_MOCK=1 on the console): the whole
	// server pipeline — route, tools, grid persistence, artifacts, RLS — runs for real, only the
	// model is deterministic. CI-gated alongside the hero path.
	//
	// One shared persona (the `setup` project) rather than a signup per test: the AI journeys are
	// about the chat, and five hermetic signups in a row trip Better Auth's per-IP rate limit
	// (5 OTP sends / 60s — lib/config/auth.ts). Each test still gets its own thread.
	//
	// `elench-ux.spec.ts` runs HERE, not in a project of its own (#2875). It carries the Elench
	// SURFACE regressions — @-mention menu geometry, rail structure, artifact side-effects, the
	// class of defect a type-check can never see — and it was already written FOR this console:
	// its artifact test sends "Build a dashboard…", which is the scripted `dashboard` scenario in
	// lib/config/ai-mock.ts (4 blocks → the 4 widget cards it asserts). Against an AI-off console
	// that test can only 503. It had its own `elench-ux` project that no workflow ever invoked, so
	// it ran nowhere and the surface it guards was unguarded.
	{
		name: "elench-ai",
		testMatch: /elench-(ai|ux)\.spec\.ts/,
		dependencies: ["setup"],
		use: { ...devices["Desktop Chrome"], storageState: STORAGE_STATE },
	},

	// The Elench AI journeys against a REAL model (needs ANTHROPIC_API_KEY). Loose,
	// behavior-level assertions — never merge-gating; run by the nightly workflow.
	{
		name: "elench-live",
		testMatch: /elench-live\.spec\.ts/,
		retries: 2,
		dependencies: ["setup"],
		use: { ...devices["Desktop Chrome"], storageState: STORAGE_STATE },
	},

	// The Architecture canvas journeys, on the shared `setup` persona. A leg of release-gate.yml.
	{
		name: "canvas",
		testMatch: /architecture-canvas\.spec\.ts/,
		dependencies: ["setup"],
		use: { ...devices["Desktop Chrome"], storageState: STORAGE_STATE },
	},

	// The per-surface smokes. Each drives a full email-OTP signup through `fixtures/auth.ts`, so
	// there is no shared storageState here.
	//
	// This is an ALLOWLIST, deliberately. It replaced a `chromium` project that was a denylist over
	// the whole testDir: every spec added to e2e/ fell into it automatically, and since no workflow
	// ever invoked it, every such spec was born dead (#2875). An allowlist plus the guard above
	// means a new spec that nothing runs fails the config instead of disappearing.
	//
	// A leg of release-gate.yml, where ALETHIA_AUTH_RATE_LIMIT=0 removes the 5-OTP/60s cap that
	// was the recorded reason these full-signup smokes could not be poured into a gating job.
	{
		name: "console",
		// `(^|/)` rather than a `/e2e/` anchor: Playwright matches testMatch against the absolute
		// path, but this pattern then holds under a testDir-relative one too, so the project cannot
		// silently collect zero tests if that ever changes. The testIgnore is load-bearing — without
		// it `connectors.spec.ts` would also swallow `flows/connectors.spec.ts` out of the qa project.
		testMatch:
			/(^|\/)(account-settings|activity|billing|connectors|elench-agent|evidence|usage)\.spec\.ts$/,
		testIgnore: /flows\//,
		use: { ...devices["Desktop Chrome"] },
	},

	// The live half of the console UI conformance rubric (apps/console/docs/ui-conformance/RUBRIC.md):
	// predicates R1–R7 and T5–T7 over every route `scripts/lib/console-routes.mjs` reports. The half
	// static analysis cannot reach — an overlay's STACKING, a page's real geometry at four widths,
	// what axe sees, what the console logged.
	//
	// `fullyParallel: false` is load-bearing, not a performance choice. `routes.spec.ts` audits the
	// empty org FIRST and only then writes the rows the `[project]`/`[id]` routes need, because T5
	// ("the empty state renders through EmptyState") has exactly one moment in which it can be
	// asked. Tests in one file run in declaration order in one worker only when the project is not
	// fully parallel; with it on, the seeding step could land before the pass it must follow.
	{
		name: "audit",
		// `(^|/)audit/` rather than a bare `audit/`: the pattern is tested against the ABSOLUTE
		// path, and a checkout or worktree whose directory name merely contains "audit" must not
		// pull unrelated specs in. The segment has to be exactly `audit`.
		testMatch: /(^|\/)audit\/[^/]*\.spec\.ts$/,
		fullyParallel: false,
		// One route test loads the page at FOUR viewport widths, runs axe, opens every overlay the
		// page offers and hit-tests each one, then reloads it once more with an injected fault. The
		// 30s default is not a budget for that, and the failure it produces is worse than slow:
		// Playwright discards the worker after a timeout, the next test starts in a FRESH one, and
		// the module-level audit context goes with it — measured, on 2026-09-01, as every
		// `[project]` route in pass 2 suddenly reporting "cannot materialise".
		timeout: 180_000,
		// NO RETRIES, overriding the config-wide `isCI ? 2 : 0`. This project is expected to report
		// real FAILURES, not flakes; retrying each one twice would triple a job that already takes
		// the best part of an hour, and would say nothing new.
		retries: 0,
		dependencies: ["setup"],
		// `colorScheme` is STATED, not inherited. Playwright's default is `light`, and with
		// `app/layout.tsx` on `defaultTheme="system"` that default was the only theme the audit had
		// ever painted — every R5 verdict was a light-mode verdict published as the verdict (#4195).
		// This is the theme each route STARTS in; `e2e/audit/signals.ts` → `scanRouteThemes` then
		// emulates dark for the second half of R5 and hands the page back in light.
		use: { ...devices["Desktop Chrome"], storageState: STORAGE_STATE, colorScheme: AUDIT_START_THEME },
	},

	// The QA suite (e2e/flows). Needs ALETHIA_QA_E2E=1 so global-setup builds its personas. A leg
	// of release-gate.yml, gated by RATCHET (scripts/e2e-ratchet.mjs): its recorded reds are debt
	// in gate-baseline.json, and a promotion fails only on a regression against them.
	{
		name: "qa",
		testMatch: /flows\/.*\.spec\.ts/,
		use: { ...devices["Desktop Chrome"] },
	},
];

assertNoDeadZone(projects);

export default defineConfig({
	testDir: "./e2e",
	// The QA suite's persona factory. Playwright has no per-project globalSetup, so this runs for
	// every invocation — and returns immediately unless ALETHIA_QA_E2E is set. That guard is what
	// keeps the merge-gating `hero` and `elench-ai` runs completely unaffected by it.
	globalSetup: "./e2e/global-setup.ts",
	fullyParallel: true,
	forbidOnly: isCI,
	retries: isCI ? 2 : 0,
	workers: isCI ? 1 : undefined,
	// In CI the `json` reporter feeds scripts/e2e-ratchet.mjs — the release gate's verdict is a
	// comparison of this file with apps/console/e2e/gate-baseline.json, not the exit code.
	reporter: isCI
		? [["list"], ["html", { open: "never" }], ["json", { outputFile: "test-results/results.json" }]]
		: "html",
	use: {
		baseURL,
		trace: "on-first-retry",
		screenshot: "only-on-failure",
		// Generous nav budget: covers a cold CI server's first response (and, locally, `next dev`
		// compiling a route on first hit). Per-assertion expects keep the default 5s.
		navigationTimeout: 60_000,
	},
	projects,
	// Local: reuse the `pnpm dev:up` console (which already tees to the default log). CI: boot the
	// built console with `next start` and tee stdout so the OTP helper can read the code. `next start`
	// (over `next dev`) keeps the run deterministic — no per-route on-demand compilation mid-test.
	webServer: {
		command: isCI ? `pnpm start 2>&1 | tee ${consoleLog}` : "pnpm dev",
		url: baseURL,
		reuseExistingServer: !isCI,
		timeout: 180_000,
		stdout: "pipe",
		stderr: "pipe",
	},
});

// Re-export so tooling importing the config also has the persona path handy.
export { STORAGE_STATE };
