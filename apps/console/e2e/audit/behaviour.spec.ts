// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Family B — B1–B5 over every route the manifest names (#6116). The instrument is `behaviour.ts`;
// this file owns the organisation, the route loop, the recording and the calibration.
//
// ── AN ORGANISATION OF ITS OWN, SEEDED ──────────────────────────────────────────────────────────
//
// B1, B3 and B4 compare a disturbed render with the answered one, and an ANSWERED EMPTY STATE is the
// one render they cannot read: a server-backed "No jobs yet" and a client read that has not answered
// look identical (`behaviour.ts` → `ANSWERED_EMPTY`). So family B runs against an organisation
// SEEDED with two rows in every list `seedFilterFixtures` reaches. That cannot be the persona's org:
// `routes.spec.ts` keeps it EMPTY for T5, and the `audit` project runs every spec in one worker, in
// an order this file does not control. So it signs a new owner up — through the product's own
// signup walk, `signup.ts`, the way T7 does — and seeds THAT organisation, leaving every other
// spec's subject untouched whatever order the runner picks.
//
// The plan is the default one a new organisation gets. What that does NOT give this leg is the
// hosted product's plan gating: the release gate boots a SELF-MANAGED console, which never renders
// an upsell, so F021 ("the skeleton promises a table and the page is an upsell card") cannot be
// reproduced here. B2 on the gated routes is therefore NOT MEASURED `hosted-only` (see `GATED`),
// never scored against a list the hosted product would not show.
//
// ── THE ORDER ───────────────────────────────────────────────────────────────────────────────────
//
//   1. the positive control (`behaviourControl`) — before any route is scored; a predicate it names
//      is WITHHELD for the whole run and every route reports NOT MEASURED for it;
//   2. phase 1, every route: the answered load, the held load (B1, B3), the forced-failure load
//      (B4), the skeleton swap (B2). The answered load's reads are kept for phase 2;
//   3. phase 2, every route: B5. It needs EVERY route's reads first, because a read made by every
//      route under the same shells is the shell's, not the page's (`shellReadsFor`) — failing the
//      sidebar's read on forty routes would measure the sidebar forty times;
//   4. the calibration: the jobs slice, ADR 0005's reference page, must PASS B1, B3, B4 and B5 and
//      be MEASURED on B2 — whose FAIL there is a real finding, see `REFERENCE_EXPECTED`;
//   5. the floor: every predicate must have produced a PASS or a FAIL on enough routes that its
//      column is a measurement — a column of NOT MEASURED must not read as a clean board.
//
// The audit project sets `fullyParallel: false`, which is what makes the order real.
//
// ── WHAT A FAIL HERE DOES, AND DOES NOT DO ──────────────────────────────────────────────────────
//
// A route that FAILS a B predicate does not fail its test. The verdict is recorded and reaches the
// scoreboard through `--import-live`, where `audit-report.mjs` holds every B FAIL to a per-route
// ledger with an owner (`BEHAVIOUR_LEDGER`, the two-ledger rule) — checked in both directions there.
// What fails a test here is the INSTRUMENT: a red positive control, a reference page that does not
// pass, a predicate that measured too few routes. Per-route findings ride the ledger, not the
// release gate's per-test ratchet, so a lane that fixes a page moves one ledger line in its own PR.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type BrowserContext } from "@playwright/test";
import { closeDb, orgIdBySlug } from "../helpers/db";
import { seedFilterFixtures } from "../helpers/seed-filters";
import {
	behaviourControl,
	judgeB1,
	judgeB2Worst,
	judgeB3,
	judgeB4,
	judgeB5,
	loadAnswered,
	loadFailed,
	loadHeld,
	loadWithOneFailure,
	measureSkeletonSwap,
	pageEntry,
	structurallyShell,
	shellReadsFor,
	B5_READ_CAP,
	type BControlResult,
	type BVerdict,
	type OneFailure,
	type RegionSnapshot,
} from "./behaviour";
import { materialize, resolveOwner, type AuditContext } from "./context";
import { consoleRoutes, type RouteRecord } from "./manifest";
import { createReport, type PredicateId } from "./report";
import { signUpWithRetry } from "./signup";

const manifest = consoleRoutes();
const report = createReport();

/** The artifact `--import-live` reads as the `behaviour` section. */
const ARTIFACT = "ui-audit-behaviour.json";

/** Where this run's organisation, session and phase-1 reads are kept across a worker restart. */
const STATE_FILE = path.resolve(process.cwd(), "e2e/.auth/audit-behaviour.json");
const STORAGE_FILE = path.resolve(process.cwd(), "e2e/.auth/audit-behaviour-storage.json");

/** A state file older than this is a previous run's, never this one's. */
const STATE_TTL_MS = 3 * 60 * 60_000;

/** The reference page: ADR 0005's jobs slice. Every predicate must PASS here. */
const REFERENCE_ROUTE = "/[org]/~/jobs";

/**
 * The fewest routes a predicate must have scored (PASS or FAIL) for its column to count. The
 * manifest has 36 real pages; a predicate under this answered for less than a third of them.
 */
const MIN_MEASURED = 10;

const B_IDS = ["B1", "B2", "B3", "B4", "B5"] as const satisfies readonly PredicateId[];

/**
 * The routes the hosted product gates by plan (F021, 2026-10-19 hunt): on a plan without the
 * feature they render an upsell where a self-managed console renders the list. Their skeleton is
 * the F021 question, and only a leg booted as the hosted edition can ask it.
 */
const GATED: ReadonlySet<string> = new Set(["/[org]/~/alerts", "/[org]/~/runners", "/[org]/~/settings/teams", "/[org]/~/settings/sso"]);

/** B2's NOT MEASURED reason on a gated route. */
const HOSTED_ONLY =
	"hosted-only — the hosted product renders an upsell on this route for a plan without the feature, and the release gate's self-managed console never does; the skeleton-against-upsell question (F021) needs a leg booted as the hosted edition";

/** How many times B2 drives the swap; the worst measured one is the verdict (`judgeB2Worst`). */
const B2_SWAPS = 2;

/** What phase 1 learned about one route, for phase 2. */
interface RouteState {
	reads: string[];
	settled: boolean;
	answered: RegionSnapshot;
}

/** Everything this spec persists. */
interface BehaviourState {
	createdAt: number;
	ctx: AuditContext;
	control: BControlResult;
	routes: Record<string, RouteState>;
}

/** Structural check on a persisted state — the fields this spec reads, never trusted blind. */
function isState(value: unknown): value is BehaviourState {
	if (typeof value !== "object" || value === null) return false;
	if (!("createdAt" in value) || typeof value.createdAt !== "number") return false;
	if (!("ctx" in value) || typeof value.ctx !== "object" || value.ctx === null) return false;
	if (!("orgSlug" in value.ctx) || typeof value.ctx.orgSlug !== "string") return false;
	if (!("control" in value) || typeof value.control !== "object" || value.control === null) return false;
	return "routes" in value && typeof value.routes === "object" && value.routes !== null;
}

let state: BehaviourState | null = null;
let main: BrowserContext | null = null;
let browserRef: Browser | null = null;
let baseURL: string | undefined;

/** Persist the state for whichever worker runs next. */
function saveState(): void {
	if (!state) return;
	mkdirSync(path.dirname(STATE_FILE), { recursive: true });
	writeFileSync(STATE_FILE, `${JSON.stringify(state)}\n`);
}

/**
 * This run's state, if a worker before this one already built it.
 *
 * A Playwright worker is discarded after a failed or timed-out test and the next one runs
 * `beforeAll` again. Signing a SECOND owner up there would split one run's records across two
 * organisations under two run keys — and `report.ts`'s `write()` replaces a file whose run key
 * differs. So the organisation is persisted and re-adopted, provided it is young enough to be this
 * run's and still exists in the database the console is reading.
 */
async function restoreState(): Promise<BehaviourState | null> {
	if (!existsSync(STATE_FILE) || !existsSync(STORAGE_FILE)) return null;
	const parsed: unknown = JSON.parse(readFileSync(STATE_FILE, "utf8"));
	if (!isState(parsed)) return null;
	if (Date.now() - parsed.createdAt > STATE_TTL_MS) return null;
	if (!(await orgIdBySlug(parsed.ctx.orgSlug))) return null;
	return parsed;
}

/** The context every load opens its pages in — the seeded owner's session. */
function context(): BrowserContext {
	if (!main) throw new Error("the behaviour audit has no browser context — beforeAll did not finish");
	return main;
}

/** The run's state — present once beforeAll has finished. */
function current(): BehaviourState {
	if (!state) throw new Error("the behaviour audit has no organisation — beforeAll did not finish");
	return state;
}

test.beforeAll(async ({ browser }, testInfo) => {
	baseURL = testInfo.project.use.baseURL;
	browserRef = browser;
	state = await restoreState();
	if (!state) {
		// THE INSTRUMENT FIRST. It drives fixture pages only, in contexts of its own.
		const control = await behaviourControl(browser);
		const signup = await browser.newContext({ baseURL, storageState: undefined });
		try {
			const page = await signup.newPage();
			const stamp = Date.now();
			const { orgSlug } = await signUpWithRetry(page, (i) => `e2e-audit-behaviour-${stamp}-${i}@alethia.test`, 3, "audit/B");
			const owner = await resolveOwner(orgSlug);
			const fixtures = await seedFilterFixtures(owner);
			await signup.storageState({ path: STORAGE_FILE });
			state = {
				createdAt: Date.now(),
				control,
				routes: {},
				ctx: {
					orgSlug,
					owner,
					projectSlug: fixtures.project.slug,
					jobId: fixtures.jobIds[0],
					supportCaseId: fixtures.supportCaseIds[0],
				},
			};
			saveState();
		} finally {
			await signup.close();
		}
	}
	const { control } = current();
	if (control.broken.length > 0) {
		report.withhold(control.broken, `positive control failed: ${control.lines.join("; ")}`);
		console.error(`ui-audit/B: THE POSITIVE CONTROL IS BROKEN for ${control.broken.join(", ")}.\n  ${control.lines.join("\n  ")}`);
	}
	main = await browser.newContext({ baseURL, storageState: STORAGE_FILE });
});

test.afterAll(async () => {
	if (state) console.log(`ui-audit/B: ${report.write(state.ctx.orgSlug, ARTIFACT)}`);
	await main?.close();
	await closeDb();
});

/** Record one B verdict through the recorder that enforces the rubric's rules. */
function put(route: RouteRecord, url: string, predicate: PredicateId, v: BVerdict): void {
	if (v.verdict === "NOT MEASURED") report.notMeasured({ route: route.route, url, predicate, reason: v.reason, evidence: v.evidence });
	else report.record({ route: route.route, url, predicate, verdict: v.verdict, evidence: v.evidence });
}

/**
 * A thrown measurement, as a NOT MEASURED reason. One line, digits masked: the reason is committed
 * on import, and a timeout's millisecond count would make every re-import a diff.
 */
function instrumentError(err: unknown): string {
	const first = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";
	return `instrument-error — ${first.replace(/\d+/g, "#").slice(0, 160)}`;
}

/** Run one measurement; a throw becomes NOT MEASURED for the predicates it was answering. */
async function measured(route: RouteRecord, url: string, ids: readonly PredicateId[], fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
	} catch (err) {
		for (const id of ids) report.notMeasured({ route: route.route, url, predicate: id, reason: instrumentError(err) });
	}
}

/** The URL segments a `loading.tsx` covers (`[org]`, `~`, `jobs`), route groups removed. */
function boundarySegments(file: string): string[] {
	const rel = file.replace(/^apps\/console\/app\//, "").split("/").slice(0, -1);
	return rel.filter((s) => !(s.startsWith("(") && s.endsWith(")")));
}

/** Whether `segs` starts with `prefix`. */
function startsWith(segs: readonly string[], prefix: readonly string[]): boolean {
	return prefix.every((p, i) => segs[i] === p);
}

/**
 * The route B2 navigates FROM, so that the fallback which paints is the target's own loading
 * boundary rather than one above it.
 *
 * A loading boundary at segment L wraps L's page and everything under it; a navigation inside an
 * already-mounted boundary keeps showing the old content (React does not re-reveal a boundary in a
 * transition), and a navigation from OUTSIDE a higher boundary paints that higher one. So the origin
 * must diverge from the target exactly at L: share every segment above it and differ at L. The
 * nearest such route in the manifest is taken; when none exists the divergence moves one segment
 * up, and what paints is then what a person arriving from there sees — measured, not excused.
 */
function originFor(route: RouteRecord, loadingFile: string): RouteRecord | null {
	const target = boundarySegments(loadingFile);
	for (let depth = target.length - 1; depth >= 0; depth--) {
		const parent = target.slice(0, depth);
		const candidates = manifest.routes
			.filter((r) => r.route !== route.route && !r.isRedirectOnly)
			.filter((r) => startsWith(r.urlSegments, parent) && r.urlSegments.length > depth && r.urlSegments[depth] !== target[depth])
			.sort((a, b) => a.urlSegments.length - b.urlSegments.length || a.route.localeCompare(b.route));
		if (candidates[0]) return candidates[0];
	}
	return null;
}

/** A fresh context with this run's session — B4 installs a fake clock, which is per context. */
async function isolatedContext(): Promise<BrowserContext> {
	if (!browserRef) throw new Error("the behaviour audit has no browser — beforeAll did not finish");
	return browserRef.newContext({ baseURL, storageState: STORAGE_FILE });
}

test("the behaviour instrument's positive control still fires", () => {
	const { control } = current();
	expect(
		control.lines,
		`a predicate that no longer fires cannot tell a correct page from one it stopped reading. ` +
			`${control.broken.join(", ") || "(none)"} are WITHHELD for this whole run.`,
	).toEqual([]);
});

test.describe("phase 1 · B1–B4 on every route, in a seeded organisation of its own", () => {
	for (const route of manifest.routes) {
		test(route.route, async () => {
			const s = current();
			const url = materialize(route, s.ctx);
			if (route.isRedirectOnly) {
				for (const id of ["B1", "B2", "B3", "B4"] as const) report.record({ route: route.route, url, predicate: id, verdict: "N/A", reason: "redirect-only" });
				return;
			}
			// A route whose measurement THROWS records NOT MEASURED with the error and the test goes on: one
			// flaky load is a gap in one cell, and the floor test below is what turns a systemic one red.
			await measured(route, url, ["B1", "B3", "B4"], async () => {
				const a = await loadAnswered(context(), url);
				s.routes[route.route] = { reads: a.reads, settled: a.settled, answered: a.snapshot };
				saveState();
				// B1 holds EVERY read: its subject is the server render.
				put(route, url, "B1", judgeB1(a, await loadHeld(context(), url)));
				// B3 answers the SHELL's reads, so the page hydrates, and holds every read of the page's own.
				const chainEntries = manifest.routes.filter((r) => r.shellChain.join(" > ") === route.shellChain.join(" > ")).map((r) => pageEntry(r.file));
				put(route, url, "B3", judgeB3(a, await loadHeld(context(), url, (key) => structurallyShell(key, chainEntries))));
				put(route, url, "B4", judgeB4(a, await loadFailed(isolatedContext, url)));
			});
			const loading = route.boundaries.loading?.file ?? null;
			if (loading === null) {
				report.record({ route: route.route, url, predicate: "B2", verdict: "N/A", reason: "no-loading-boundary" });
			} else if (GATED.has(route.route)) {
				report.notMeasured({ route: route.route, url, predicate: "B2", reason: HOSTED_ONLY });
			} else {
				await measured(route, url, ["B2"], async () => {
					const origin = originFor(route, loading);
					if (origin === null) {
						report.notMeasured({ route: route.route, url, predicate: "B2", reason: "no-origin — no route in the manifest sits outside this route's loading boundary" });
						return;
					}
					const swaps = [];
					for (let i = 0; i < B2_SWAPS; i++) {
						const page = await context().newPage();
						try {
							swaps.push(await measureSkeletonSwap(page, materialize(origin, s.ctx), url));
						} finally {
							await page.close();
						}
					}
					put(route, url, "B2", judgeB2Worst(swaps));
				});
			}
		});
	}
});

test.describe("phase 2 · B5, each of a page's own reads failed alone", () => {
	for (const route of manifest.routes) {
		test(route.route, async () => {
			const s = current();
			const url = materialize(route, s.ctx);
			if (route.isRedirectOnly) {
				report.record({ route: route.route, url, predicate: "B5", verdict: "N/A", reason: "redirect-only" });
				return;
			}
			const mine = s.routes[route.route];
			if (!mine) {
				report.notMeasured({ route: route.route, url, predicate: "B5", reason: "phase-one-missing — phase 1 recorded no reads for this route" });
				return;
			}
			const chains = new Map(manifest.routes.map((r) => [r.route, r.shellChain.join(" > ")]));
			const readsByRoute = new Map(Object.entries(s.routes).map(([r, v]) => [r, v.reads]));
			const entries = new Map(manifest.routes.map((r) => [r.route, pageEntry(r.file)]));
			const shell = shellReadsFor(route.route, chains, readsByRoute, entries);
			const pageReads = mine.reads.filter((k) => !shell.includes(k));
			const failures: OneFailure[] = [];
			await measured(route, url, ["B5"], async () => {
				if (mine.settled && pageReads.length >= 1 && pageReads.length <= B5_READ_CAP) {
					for (const key of pageReads) failures.push({ key, ...(await loadWithOneFailure(context(), url, key)) });
				}
				put(route, url, "B5", judgeB5({ snapshot: mine.answered, settled: mine.settled, reads: mine.reads }, pageReads, shell, failures));
			});
		});
	}
});

/** Every B record this run wrote, across every worker — the file, not one worker's buffer. */
function writtenRecords(): { route: string; predicate: string; verdict: string; reason?: string }[] {
	const file = report.write(current().ctx.orgSlug, ARTIFACT);
	const body: unknown = JSON.parse(readFileSync(file, "utf8"));
	if (typeof body !== "object" || body === null || !("records" in body) || !Array.isArray(body.records)) return [];
	return body.records.filter(
		(r: unknown): r is { route: string; predicate: string; verdict: string; reason?: string } =>
			typeof r === "object" && r !== null && "route" in r && typeof r.route === "string" && "predicate" in r && typeof r.predicate === "string" && "verdict" in r && typeof r.verdict === "string",
	);
}

/**
 * What the reference slice must answer, per predicate. B2 is the one it does NOT pass, and that is a
 * finding, not a calibration gap: the jobs skeleton (`~/jobs/loading.tsx`) has no row for the
 * PageToolbar and a one-row filter bar, so its table frame paints ~100px above where the page puts it
 * (score 0.047 on two swaps of run 39464989816). It is debt in `BEHAVIOUR_LEDGER`, owned by #6121.
 * What the calibration still asserts for B2 is that it MEASURED the page — a skeleton swap that
 * stopped painting would otherwise turn the reference into a NOT MEASURED nobody reads.
 */
const REFERENCE_EXPECTED: Record<(typeof B_IDS)[number], readonly string[]> = {
	B1: ["PASS"],
	B2: ["PASS", "FAIL"],
	B3: ["PASS"],
	B4: ["PASS"],
	B5: ["PASS"],
};

test("the jobs slice — ADR 0005's reference page — answers B1–B5 as calibrated", () => {
	const records = writtenRecords().filter((r) => r.route === REFERENCE_ROUTE);
	for (const id of B_IDS) {
		const r = records.find((x) => x.predicate === id);
		expect(
			REFERENCE_EXPECTED[id].includes(r?.verdict ?? "no record"),
			`${id} on ${REFERENCE_ROUTE} read ${r ? `${r.verdict}${r.reason ? ` — ${r.reason}` : ""}` : "no record"}; ` +
				`the reference slice must read ${REFERENCE_EXPECTED[id].join(" or ")}. A predicate that does not ` +
				"answer the page it was calibrated on is an instrument defect until shown otherwise.",
		).toBe(true);
	}
});

test("every B predicate scored enough routes to be a measurement", () => {
	const records = writtenRecords();
	for (const id of B_IDS) {
		const scored = records.filter((r) => r.predicate === id && (r.verdict === "PASS" || r.verdict === "FAIL")).length;
		expect(scored, `${id} produced a PASS or a FAIL on ${scored} route(s); a column of NOT MEASURED must not read as a clean board`).toBeGreaterThanOrEqual(MIN_MEASURED);
	}
});
