// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// FAMILY B — WHAT THE USER EXPERIENCES WHILE A ROUTE LOADS (#6116, ADR 0005).
//
// The families before this one score SHAPE: a route could pass all of them and still paint a queue
// of skeletons, say "No results." while it waits, and render an error as an empty list. Every page
// of the 2026-10-19 hunt did one of those. This module measures the five behaviours RUBRIC.md's
// family B names; `behaviour.spec.ts` owns the route loop, the organisation and the recording.
//
//   B1  no client data fetch before first paint — with EVERY read held (never answered), the region
//       renders exactly what it renders once the reads answer: the first paint already carried the
//       data, so it needed no request it could have had on the server.
//   B2  the skeleton has the final layout's shape — the route's own loading state is painted by a
//       soft navigation whose data response is held, then released; the frame the skeleton occupies
//       and the frame the page occupies are compared (CLS-style score ≤ 0.02, and the same number of
//       side-by-side blocks).
//   B3  no empty state while pending — with every read held, the region shows no empty copy it does
//       not also show once answered.
//   B4  error ≠ empty ≠ endless skeleton — every read answered 500, on the cold load AND on the stale
//       refetch a prefetched region makes later; neither may leave a skeleton, show empty copy, or
//       drop content without an error surface in its place.
//   B5  one failure, one region — each of the page's own reads is failed ALONE; none may blank every
//       region of the page.
//
// ── WHAT A "READ" IS ────────────────────────────────────────────────────────────────────────────
//
// A server-action POST (`next-action` header) or a call to the read router (`/{org}/~/rpc/…`, ADR
// 0005 D1). Those are the two transports a console page reads data over. Anything else — the RSC
// payload of a navigation, `/api/auth/*`, static chunks — is never held or failed, so B1 asks about
// data reads, not about the document. A read over another transport (an SSE stream, a bare
// `fetch('/api/…')`) is invisible to every predicate here; that is the stated bound, not a gap
// discovered later.
//
// ── WHY THE VERDICTS ARE COMPARISONS ────────────────────────────────────────────────────────────
//
// Every verdict compares a disturbed render (reads held, reads failed) with the SAME route answered.
// An absolute reading would be wrong in both directions: "No limit" is a label, not empty copy, and
// a static banner with `role="alert"` is not an error the reads caused. Only what CHANGES between the
// two renders is attributed to the reads. The cost is stated in RUBRIC.md and repeated here: a page
// whose ANSWERED render is its own empty state cannot tell a server-backed empty answer from a
// client fetch that has not happened yet — both render the same — so B1/B3/B4 are NOT MEASURED there
// with that reason, never PASS. The spec drives an organisation SEEDED with rows for exactly this
// reason: every list the seed reaches answers non-empty.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Browser, BrowserContext, Page, Request, Route } from "@playwright/test";
import { errorStateSignature } from "./error-state";
import { awaitReady, isLoadingRead } from "./inert";
import { repoRoot } from "./manifest";

/** The viewport every B measurement is taken at. B2's score is a fraction of it. */
export const B_VIEWPORT = { width: 1280, height: 900 } as const;

/** RUBRIC.md's B2 budget: a CLS-style score above this is a skeleton that does not match. */
export const B2_BUDGET = 0.02;

/** A page read beyond this many is not failed one at a time; B5 is NOT MEASURED with the count. */
export const B5_READ_CAP = 8;

/**
 * How far B4's second phase moves the page's clock before it asks the page to refetch. TanStack's
 * console defaults are a 30 s `staleTime` (`lib/query/client.ts`) and some hooks hold data for a
 * minute; six minutes is past every `staleTime` the console sets, so a focus refetch really fires.
 */
export const B4_STALE_JUMP_MS = 6 * 60_000;

// ── reads ───────────────────────────────────────────────────────────────────────────────────────

/** The marker in a read-router URL: `/{org}/~/rpc/<procedure path>`. */
const RPC_MARKER = "/~/rpc/";

/**
 * The read a request is, or `null` when it is not a data read.
 *
 * `rpc <procedure>` for the read router, `action <id>` for a server action. The key is what B5 fails
 * one at a time and what the shell attribution intersects across routes, so it must be the same for
 * the same read on every route — the procedure path and the action id both are.
 */
export function readKey(request: Pick<Request, "url" | "method" | "headers">): string | null {
	const { pathname } = new URL(request.url());
	// The change stream (`/{org}/~/events`, #6115) and its `?probe=1` are NOT data reads. The stream
	// stays open for the life of the page, so holding it proves nothing and counting it would make
	// every page "fetch on mount" the day the bus client lands; the probe only asks why the stream
	// closed. Told apart by the header the stream sends (`Accept: text/event-stream`, the rule
	// `destructive.spec.ts`'s `trackInFlight` uses since #6178) AND by the path, so the probe —
	// which does not ask for a stream — is excluded too.
	if ((request.headers()["accept"] ?? "").includes("text/event-stream") || /\/~\/events\/?$/.test(pathname)) return null;
	const at = pathname.indexOf(RPC_MARKER);
	if (at >= 0) return `rpc ${pathname.slice(at + RPC_MARKER.length)}`;
	const action = request.headers()["next-action"];
	if (request.method() === "POST" && typeof action === "string" && action.length > 0) return `action ${action}`;
	return null;
}

/**
 * Whether a URL can carry a read for a page at `pathname`: the page's own path (server actions POST
 * to the current URL) or the read router. Used as the `page.route()` matcher so that only these
 * requests pay for interception — routing every static chunk through a handler would slow every
 * load the audit takes.
 */
function readCarrier(pathname: string): (url: URL) => boolean {
	return (url) => url.pathname === pathname || url.pathname.includes(RPC_MARKER);
}

let actionNames: Map<string, string> | null = null;
let actionWorkers: Map<string, Set<string>> | null = null;

/**
 * Server-action ids → `exportedName (file)`, read from the build's server-reference manifest.
 *
 * BEST EFFORT, and it says so. An action id is a hash; a FAIL that names "action 7f3a…" sends the
 * reader to grep a build. The CI leg runs `next start` from this directory, so the manifest is on
 * disk; anywhere it is not (or carries no names), the label falls back to "a server action" — never
 * to the hash, because a committed detail must be the same bytes on the next build.
 */
function namesFromManifest(): Map<string, string> {
	if (actionNames) return actionNames;
	actionNames = new Map();
	actionWorkers = new Map();
	const file = path.join(process.cwd(), ".next", "server", "server-reference-manifest.json");
	if (!existsSync(file)) return actionNames;
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		const node = typeof parsed === "object" && parsed !== null && "node" in parsed ? parsed.node : null;
		if (typeof node !== "object" || node === null) return actionNames;
		for (const [id, entry] of Object.entries(node)) {
			if (typeof entry !== "object" || entry === null) continue;
			const name = "exportedName" in entry && typeof entry.exportedName === "string" ? entry.exportedName : null;
			const fileName = "filename" in entry && typeof entry.filename === "string" ? entry.filename : null;
			if (name) actionNames.set(id, fileName ? `${name} (${fileName})` : name);
			const workers = "workers" in entry && typeof entry.workers === "object" && entry.workers !== null ? Object.keys(entry.workers) : [];
			if (workers.length > 0) actionWorkers.set(id, new Set(workers));
		}
	} catch {
		// A manifest that does not parse names nothing; the labels fall back as documented above.
	}
	return actionNames;
}

/**
 * A `workers` lookup over a server-reference manifest's JSON — the same shape the build writes. The
 * positive control hands it a FIXTURE manifest, so its shell reads are classified by the code path the
 * routes' are, not by a stand-in rule.
 */
export function workersFromManifest(manifest: unknown): (key: string) => ReadonlySet<string> | null {
	const map = new Map<string, Set<string>>();
	const node = typeof manifest === "object" && manifest !== null && "node" in manifest ? manifest.node : null;
	if (typeof node === "object" && node !== null) {
		for (const [id, entry] of Object.entries(node)) {
			if (typeof entry !== "object" || entry === null) continue;
			const workers = "workers" in entry && typeof entry.workers === "object" && entry.workers !== null ? Object.keys(entry.workers) : [];
			if (workers.length > 0) map.set(id, new Set(workers));
		}
	}
	return (key) => (key.startsWith("action ") ? (map.get(key.slice("action ".length)) ?? null) : null);
}

/**
 * Whether the build's server-reference manifest is on disk and says which pages reference each
 * action. B3, B4 and B5 tell the PAGE's reads from the shell's through it; without it every shell
 * read would count as the page's, and a route that exercised only its shell would read as measured.
 * `behaviour.spec.ts` refuses to score when this is false — loudly, never by falling back.
 */
export function manifestKnowsWorkers(): boolean {
	namesFromManifest();
	return (actionWorkers?.size ?? 0) > 0;
}

/**
 * Every way the manifest disagrees with what the run OBSERVED: an action a route made whose manifest
 * entry does not list that route's page. Empty for a manifest that describes this build. A manifest
 * whose worker keys were renamed, or one from another build, names none of the observed routes and
 * fails here — closed — instead of classifying every read as the page's.
 */
export function manifestConsistencyProblems(
	readsByRoute: ReadonlyMap<string, readonly string[]>,
	entries: ReadonlyMap<string, string>,
	workers: (key: string) => ReadonlySet<string> | null = workersOf,
): string[] {
	const problems: string[] = [];
	// No action observed at all is not a clean manifest: it is a run that measured nothing the check
	// could test, and every classification downstream would rest on an unchecked input.
	if (![...readsByRoute.values()].some((reads) => reads.some((k) => k.startsWith("action ")))) {
		problems.push("the run observed no server action at all, so the manifest could not be checked against anything");
	}
	for (const [route, reads] of readsByRoute) {
		const entry = entries.get(route);
		for (const key of reads) {
			if (!key.startsWith("action ")) continue;
			const w = workers(key);
			if (w === null) problems.push(`${route} made ${key}, which the manifest does not list`);
			else if (entry === undefined || !w.has(entry)) problems.push(`${route} made ${key}, and the manifest does not list ${entry ?? "its page"} under it`);
		}
	}
	return problems;
}

/**
 * The build entries (`app/(private)/[org]/~/jobs/page`) whose client graph references a server
 * action, from the same manifest — or `null` when the build does not say. Read by `shellReadsFor`.
 */
export function workersOf(key: string): ReadonlySet<string> | null {
	if (!key.startsWith("action ")) return null;
	namesFromManifest();
	return actionWorkers?.get(key.slice("action ".length)) ?? null;
}

/** The build entry a route's page compiles to: `apps/console/app/x/page.tsx` → `app/x/page`. */
export function pageEntry(file: string): string {
	return file.replace(/^apps\/console\//, "").replace(/\.[jt]sx?$/, "");
}

/** A read key, as a person reads it — and as a committed detail can carry it. */
export function readLabel(key: string): string {
	if (key.startsWith("rpc ")) return `the \`${key.slice(4)}\` read`;
	const name = namesFromManifest().get(key.slice("action ".length));
	return name ? `the \`${name}\` server action` : "a server action";
}

// ── one look at the region ──────────────────────────────────────────────────────────────────────

/** What the page's `main` shows, reduced to the signals the B verdicts compare. */
export interface RegionSnapshot {
	hasMain: boolean;
	/** Visible `data-slot="skeleton"` placeholders. */
	skeletons: number;
	/** `main`, or anything in it, says `aria-busy="true"`. */
	busy: boolean;
	/**
	 * Empty states, recognised by their MARKUP, never by their wording: `@repo/ui/empty`
	 * (`data-slot="empty"`) and `DataTable`'s empty row — the one body row whose single cell spans
	 * the table. A phrase matcher read labels such as "No limit" as empty copy.
	 */
	empty: number;
	/** Outermost error surfaces: `role="alert"`, `RegionError`, or the shared `ErrorState`. */
	errors: number;
	/** The ROUTE boundary's `ErrorState` is showing — the whole page failed, not a region of it. */
	routeError: boolean;
	/** Table body rows, `role="row"` rows that are not header rows, and list items. */
	rows: number;
	/** Visible elements carrying text of their own, outside any skeleton. */
	leaves: number;
	/**
	 * The leaves that read as CONTENT — at least four letters, no digit, no relative time. What it
	 * leaves out is exactly the text a correct page renders only after hydration: a clock or a date
	 * (`ClockSlot` waits for `useHydrated()`), "3 minutes ago", an avatar's initials. B1 compares
	 * this, never `leaves`, because its subject is the server render (see `judgeB1`).
	 */
	contentLeaves: number;
	/** The same, outside every error surface — what is left of the page when something failed. */
	leavesOutsideErrors: number;
	/** The leaves' own text, lower-cased with digits and relative times masked. Evidence, not verdict. */
	texts: string[];
}

/** Relative times — "3 minutes ago" on one load is "4 minutes ago" on the next, and is not data. */
const RELATIVE_TIME = String.raw`\b(?:about |almost |over |less than )?(?:a|an|\d+) (?:second|minute|hour|day|week|month|year)s?(?: ago)?\b|\bjust now\b|\bin (?:a|an|\d+) (?:second|minute|hour|day|week|month|year)s?\b`;

/** Read `main` once. Never waits — the caller decides when the page has had its chance. */
export async function snapshotRegion(page: Page): Promise<RegionSnapshot> {
	return page.evaluate(
		({ arms, relativeTime }) => {
			const zero = { hasMain: false, skeletons: 0, busy: false, empty: 0, errors: 0, routeError: false, rows: 0, leaves: 0, contentLeaves: 0, leavesOutsideErrors: 0, texts: [] };
			const main = document.querySelector("main");
			if (main === null) return zero;
			const shown = (el: Element): boolean => {
				const style = window.getComputedStyle(el);
				const r = el.getBoundingClientRect();
				return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) >= 0.05 && r.width > 0 && r.height > 0;
			};
			const all = Array.from(main.querySelectorAll("*")).filter(shown);
			// Both error renders: `RegionError` (a data region's, #6117 — `data-slot="region-error"`,
			// `role="alert"`) and the route boundary's `ErrorState` (its class signature).
			const isErrorSurface = (el: Element): boolean =>
				el.getAttribute("role") === "alert" ||
				el.getAttribute("data-slot") === "region-error" ||
				arms.some((tokens) => tokens.every((t) => el.classList.contains(t)));
			const errorRoots = all.filter((el) => {
				if (!isErrorSurface(el)) return false;
				for (let p = el.parentElement; p !== null && p !== main; p = p.parentElement) if (isErrorSurface(p)) return false;
				return true;
			});
			const inError = (el: Element): boolean => errorRoots.some((root) => root.contains(el));
			const inSkeleton = (el: Element): boolean => el.closest('[data-slot="skeleton"]') !== null;
			const ownText = (el: Element): string =>
				Array.from(el.childNodes)
					.filter((n) => n.nodeType === Node.TEXT_NODE)
					.map((n) => n.textContent ?? "")
					.join(" ")
					.replace(/\s+/g, " ")
					.trim();
			const timeRe = new RegExp(relativeTime, "gi");
			// `RegionError` is built on the empty-state primitives; inside an error surface nothing is empty copy.
			const emptySlots = all.filter((el) => el.getAttribute("data-slot") === "empty" && !inError(el)).length;
			// `DataTable`'s empty row: a body row with ONE cell spanning the table (`colSpan` ≥ 2).
			const isEmptyRow = (el: Element): boolean =>
				el instanceof HTMLTableRowElement && el.closest("tbody") !== null && el.cells.length === 1 && el.cells[0].colSpan >= 2;
			const emptyRows = all.filter((el) => isEmptyRow(el) && !inError(el)).length;
			const rows = all.filter((el) => {
				if (inSkeleton(el)) return false;
				if (el.tagName === "TR") return el.closest("tbody") !== null && !isEmptyRow(el);
				if (el.getAttribute("role") === "row") return el.querySelector('[role="columnheader"]') === null;
				return el.tagName === "LI" || el.getAttribute("role") === "listitem";
			}).length;
			const leafEls = all.filter((el) => !inSkeleton(el) && ownText(el) !== "");
			const mask = (s: string): string => s.toLowerCase().replace(timeRe, "<t>").replace(/\d/g, "#").slice(0, 80);
			return {
				hasMain: true,
				skeletons: all.filter((el) => el.getAttribute("data-slot") === "skeleton").length,
				busy: main.getAttribute("aria-busy") === "true" || main.querySelector('[aria-busy="true"]') !== null,
				empty: emptySlots + emptyRows,
				errors: errorRoots.length,
				routeError: all.some((el) => arms.some((tokens) => tokens.every((t) => el.classList.contains(t)))),
				rows,
				leaves: leafEls.length,
				contentLeaves: leafEls.filter((el) => {
					const m = mask(ownText(el));
					return !/[#]|<t>/.test(m) && (m.match(/[a-z]/g) ?? []).length >= 4;
				}).length,
				leavesOutsideErrors: leafEls.filter((el) => !inError(el)).length,
				texts: leafEls.slice(0, 400).map((el) => mask(ownText(el))),
			};
		},
		{ arms: errorStateSignature(), relativeTime: RELATIVE_TIME },
	);
}

/**
 * Wait until `main` has stopped changing: unchanged for `quietMs`, and at least `minMs` after the
 * call — or `capMs`, whichever is first. A held or failed page never "settles" in the loading sense
 * (it may keep its skeleton forever, which is the finding), so the wait is for STILLNESS, not for
 * readiness; `quietMs` is chosen per caller to outlast whatever the page is still doing (a query
 * retry waits about a second).
 */
export async function waitStill(page: Page, opts: { minMs: number; quietMs: number; capMs: number }): Promise<boolean> {
	const start = Date.now();
	const read = () =>
		page
			.evaluate(() => {
				const main = document.querySelector("main");
				return main === null ? "none" : `${main.querySelectorAll("*").length}|${main.innerText.length}|${main.querySelectorAll('[aria-busy="true"]').length}`;
			})
			.catch(() => "unreadable");
	let last = await read();
	let since = Date.now();
	for (;;) {
		await page.waitForTimeout(250);
		const now = await read();
		if (now !== last) {
			last = now;
			since = Date.now();
		}
		const elapsed = Date.now() - start;
		if (elapsed >= opts.minMs && Date.now() - since >= opts.quietMs) return true;
		if (elapsed >= opts.capMs) return false;
	}
}

// ── the three loads B1, B3 and B4 compare ───────────────────────────────────────────────────────

/** The route answered normally — the render every disturbed one is compared against. */
export interface AnsweredLoad {
	snapshot: RegionSnapshot;
	/** Whether the page settled (no skeleton, no `aria-busy`) inside the readiness budget. */
	settled: boolean;
	/** Every read the page made from navigation to settled, in first-seen order. */
	reads: string[];
}

/** Open a page at the B viewport, collecting the reads it makes. */
async function openTracked(context: BrowserContext): Promise<{ page: Page; reads: Set<string> }> {
	const page = await context.newPage();
	await page.setViewportSize(B_VIEWPORT);
	const reads = new Set<string>();
	page.on("request", (request) => {
		const key = readKey(request);
		if (key !== null) reads.add(key);
	});
	return { page, reads };
}

/** Load `url` with every read answered, and read the settled region. */
export async function loadAnswered(context: BrowserContext, url: string): Promise<AnsweredLoad> {
	const { page, reads } = await openTracked(context);
	try {
		await page.goto(url, { waitUntil: "domcontentloaded" });
		const readiness = await awaitReady(page);
		const snapshot = await snapshotRegion(page);
		return { snapshot, settled: readiness.settled && !isLoadingRead(readiness.last), reads: [...reads] };
	} finally {
		await page.close();
	}
}

/** The route with every read held: what the first paint shows when no client read ever answers. */
export interface HeldLoad {
	snapshot: RegionSnapshot;
	/** The reads that were held — the requests the page made and never got an answer to. */
	held: string[];
}

/**
 * Load `url` with reads held open, and read the region once it holds still.
 *
 * `pass` answers the reads it names normally. B1 passes none — its subject is the server render,
 * and the first held server action stalls hydration (measured on the jobs slice). B3 passes the
 * SHELL's reads (`structurallyShell`), so the page hydrates and every read of the PAGE's own is held:
 * an empty state a client component renders after hydration while its read is pending is only
 * visible that way. One limit the browser imposes and this cannot lift: Next sends server actions
 * one at a time, so the first held page action keeps every later one from being SENT — held or
 * never sent, none of them answers, which is the condition B3 asks about.
 */
export async function loadHeld(context: BrowserContext, url: string, pass: (key: string) => boolean = () => false): Promise<HeldLoad> {
	const { page } = await openTracked(context);
	const held: Route[] = [];
	const keys = new Set<string>();
	try {
		const pathname = new URL(url, "http://placeholder.invalid").pathname;
		await page.route(readCarrier(pathname), async (route) => {
			const key = readKey(route.request());
			if (key === null || pass(key)) return route.fallback();
			keys.add(key);
			held.push(route);
		});
		await page.goto(url, { waitUntil: "domcontentloaded" });
		await page.waitForLoadState("load").catch(() => {});
		await waitStill(page, { minMs: 1_500, quietMs: 1_000, capMs: 8_000 });
		return { snapshot: await snapshotRegion(page), held: [...keys] };
	} finally {
		await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
		await page.close();
	}
}

/** B1's loads and verdict: the held load, and the answered load taken right after it. */
export interface B1Measurement {
	verdict: BVerdict;
	held: HeldLoad;
	after: AnsweredLoad;
}

/**
 * Take B1's held load and, straight after it, an answered load, then judge the held render against
 * that load AND every earlier answered load the caller took (`judgeB1Loads`). The load after is the
 * one at the held load's data: phase 1's answered load can be minutes and a run's worth of fixture
 * writes older (#6326).
 */
export async function measureB1(context: BrowserContext, url: string, earlier: readonly AnsweredLoad[]): Promise<B1Measurement> {
	const held = await loadHeld(context, url);
	const after = await loadAnswered(context, url);
	return { verdict: judgeB1Loads(earlier, held, after), held, after };
}

/** A body the read router's own unexpected-error path answers with, so the client decodes it as one. */
const RPC_FAILURE = JSON.stringify({
	json: { defined: false, code: "INTERNAL_SERVER_ERROR", status: 500, message: "Internal server error" },
	meta: [],
});

/** Answer one intercepted read with a 500, in the shape its transport's client expects. */
function failRead(route: Route): Promise<void> {
	const rpc = new URL(route.request().url()).pathname.includes(RPC_MARKER);
	return route.fulfill(
		rpc
			? { status: 500, contentType: "application/json", body: RPC_FAILURE }
			: { status: 500, contentType: "text/plain", body: "Internal Server Error" },
	);
}

/** One phase of the forced-failure load. */
export interface FailedPhase {
	phase: "cold load" | "stale refetch";
	snapshot: RegionSnapshot;
	/** How many reads were answered 500 by the end of this phase. */
	failed: number;
	/** WHICH reads were answered 500 by the end of this phase — the evidence, and what B4 classifies. */
	failedKeys: string[];
}

/** Makes a fresh, isolated context — B4 installs a fake clock, and a clock is per context. */
export type ContextFactory = () => Promise<BrowserContext>;

/**
 * Load `url` with every read answered 500, then make the page's queries stale and refetch them.
 *
 * TWO phases, because a server-prefetched region makes NO read on its cold load — failing its reads
 * there proves nothing about it. What it does later is refetch: on window focus once its data is
 * stale, and on its own interval. So the clock is moved past every `staleTime` the console sets and
 * the page is told it is visible again; whatever the refetch fails into is phase two. Without this,
 * "render the empty state on error" on a prefetched page (the jobs slice) would PASS B4 forever.
 *
 * A fresh CONTEXT, not a page: Playwright's clock is installed per context and would otherwise
 * leak into every later load the audit takes.
 */
export async function loadFailed(newContext: ContextFactory, url: string): Promise<FailedPhase[]> {
	const context = await newContext();
	try {
		await context.clock.install();
		const { page } = await openTracked(context);
		let failed = 0;
		const failedKeys = new Set<string>();
		const pathname = new URL(url, "http://placeholder.invalid").pathname;
		await page.route(readCarrier(pathname), async (route) => {
			if (readKey(route.request()) === null) return route.fallback();
			failed += 1;
			const k = readKey(route.request());
			if (k !== null) failedKeys.add(k);
			await failRead(route);
		});
		await page.goto(url, { waitUntil: "domcontentloaded" });
		await page.waitForLoadState("load").catch(() => {});
		// `quietMs` outlasts the console's one query retry (TanStack's first retry waits ~1 s).
		await waitStill(page, { minMs: 2_000, quietMs: 2_500, capMs: 12_000 });
		const cold: FailedPhase = { phase: "cold load", snapshot: await snapshotRegion(page), failed, failedKeys: [...failedKeys] };
		await context.clock.fastForward(B4_STALE_JUMP_MS);
		await page.evaluate(() => {
			document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
			window.dispatchEvent(new Event("focus"));
		});
		await waitStill(page, { minMs: 3_000, quietMs: 2_500, capMs: 12_000 });
		const stale: FailedPhase = { phase: "stale refetch", snapshot: await snapshotRegion(page), failed, failedKeys: [...failedKeys] };
		return [cold, stale];
	} finally {
		await context.close();
	}
}

/** Load `url` with ONE read answered 500 and every other read answered normally (B5), counting the 500s. */
export async function loadWithOneFailure(context: BrowserContext, url: string, key: string): Promise<{ snapshot: RegionSnapshot; intercepted: number }> {
	const { page } = await openTracked(context);
	let intercepted = 0;
	try {
		const pathname = new URL(url, "http://placeholder.invalid").pathname;
		await page.route(readCarrier(pathname), async (route) => {
			if (readKey(route.request()) !== key) return route.fallback();
			intercepted += 1;
			await failRead(route);
		});
		await page.goto(url, { waitUntil: "domcontentloaded" });
		await page.waitForLoadState("load").catch(() => {});
		await waitStill(page, { minMs: 2_000, quietMs: 2_500, capMs: 10_000 });
		// The count is the proof the failure was INJECTED. A read the run saw once and this load never
		// made (a poll that did not fire, a read keyed on state this load lacks) fails nothing, and a
		// region that "survived" it proves nothing.
		return { snapshot: await snapshotRegion(page), intercepted };
	} finally {
		await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
		await page.close();
	}
}

// ── verdicts (pure — the self-test drives every branch) ─────────────────────────────────────────

/** A measured verdict, or the reason the instrument could not give one. */
export type BVerdict =
	| { verdict: "PASS" | "FAIL"; evidence: unknown }
	| { verdict: "NOT MEASURED"; reason: string; evidence: unknown };

/** The signals B1 compares, named the way a FAIL's detail names them. */
export type Signal = "skeleton" | "empty copy" | "rows" | "error surface" | "content";

/** Which signals separate a disturbed render from the answered one. */
export function differences(answered: RegionSnapshot, other: RegionSnapshot): Signal[] {
	const out: Signal[] = [];
	if (other.skeletons > 0 && answered.skeletons === 0) out.push("skeleton");
	if (other.empty !== answered.empty) out.push("empty copy");
	if (other.rows !== answered.rows) out.push("rows");
	if (other.errors !== answered.errors) out.push("error surface");
	if (other.contentLeaves < answered.contentLeaves) out.push("content");
	return out;
}

/** Texts in `a` and not in `b`, as a multiset difference — the evidence a reader attributes from. */
function onlyIn(a: readonly string[], b: readonly string[]): string[] {
	const pool = new Map<string, number>();
	for (const t of b) pool.set(t, (pool.get(t) ?? 0) + 1);
	const out: string[] = [];
	for (const t of a) {
		const n = pool.get(t) ?? 0;
		if (n > 0) pool.set(t, n - 1);
		else out.push(t);
	}
	return out.slice(0, 12);
}

/** The NOT MEASURED reason every comparison shares when the answered render never settled. */
export const NOT_SETTLED =
	"answered-not-settled — the route still showed a skeleton or `aria-busy` after the readiness budget with every read answered, so there is no answered render to compare against";

/** The NOT MEASURED reason for a route none of whose OWN reads was held or failed. */
export const NO_PAGE_READS =
	"no-page-reads — every read this route made is its shell's (or it made none), so no failure or wait of its own can be injected from the browser";

/** The NOT MEASURED reason for a route whose answered render is its own empty state. */
export const ANSWERED_EMPTY =
	"answered-empty — the route's answered render is its empty state, and a server-backed empty answer and a client read that has not answered render the same";

/**
 * B1: with every read held, the region already carries its DATA — the rows, the empty-or-not answer,
 * no skeleton, no error, and no fewer content-bearing text elements than once answered.
 *
 * THE HELD RENDER MAY NEVER HYDRATE, and that was measured, not assumed: on the jobs slice the first
 * held server action stalls hydration, so the held render IS the server render. Two things a correct
 * page renders differently there are therefore not compared. `aria-busy` is true on every filtered
 * list's server render by design (`useFilterUrlSync` reports the URL unread until mount, #4980), and
 * clock, date and initials text waits for hydration by design (`ClockSlot`). Neither is data. Both
 * stay in the evidence (`heldRender.busy`, `onlyAnswered` / `onlyHeld`), so a reader still sees them.
 *
 * ONE comparison. A route is judged through `judgeB1Loads`, over every answered load of it.
 */
export function judgeB1(answered: AnsweredLoad, held: HeldLoad, grown = false): BVerdict {
	const evidence = b1Evidence(answered, held, grown);
	if (!answered.settled) return { verdict: "NOT MEASURED", reason: NOT_SETTLED, evidence };
	if (evidence.differs.length > 0) return { verdict: "FAIL", evidence };
	if (answered.snapshot.empty > 0 && held.held.length > 0) return { verdict: "NOT MEASURED", reason: ANSWERED_EMPTY, evidence };
	return { verdict: "PASS", evidence };
}

/**
 * What one B1 comparison saw: the signals that differ, and both renders. `grown` drops `rows` from
 * the differences — only ever for a load taken before the held one, when `judgeB1Loads` has shown
 * that the feed grew in between.
 */
function b1Evidence(answered: AnsweredLoad, held: HeldLoad, grown: boolean) {
	const differs = differences(answered.snapshot, held.snapshot);
	return {
		differs: grown ? differs.filter((d) => d !== "rows") : differs,
		grown,
		held: held.held,
		answered: summary(answered.snapshot),
		heldRender: summary(held.snapshot),
		onlyAnswered: onlyIn(answered.snapshot.texts, held.snapshot.texts),
		onlyHeld: onlyIn(held.snapshot.texts, answered.snapshot.texts),
	};
}

/**
 * B1 over every answered load of the route: the ones taken BEFORE the held load (phase 1's), and the
 * one taken straight AFTER it (`measureB1`).
 *
 * B1 compares rows, and a feed can be appended to between two loads. Phase 1's answered load was
 * taken before the run's own fixtures wrote to the activity log; the held load came in phase 2, after
 * them, so `~/settings/activity` held 7 rows against 4 answered and FAILed with a correct first paint
 * (#6326). So a row count is excused in exactly one shape: the held render has MORE rows than an
 * earlier answered load, and the answered load after the held one settled with the SAME count as the
 * held render — the data the held load saw, confirmed by a load of it. Nothing else is excused: a
 * skeleton, an empty state, an error or missing content still FAILs against any load that shows it,
 * and fewer held rows than any answered load still FAILs.
 *
 * Every settled load is a witness, and the verdict is the STRICTEST: FAIL when any comparison FAILs,
 * PASS when none does and at least one PASSes, NOT MEASURED otherwise (the first comparison's reason).
 * Strictest, because an answered load can settle before a client-only region arrives — a page with
 * no skeleton for that region reads as settled — and such a load matches a held render that lacks the
 * region. A rule that PASSed on any match passed `[project]/settings/general` that way. The evidence
 * is the deciding comparison's, with each comparison's verdict under `bracket`.
 */
export function judgeB1Loads(earlier: readonly AnsweredLoad[], held: HeldLoad, after: AnsweredLoad): BVerdict {
	const confirmed = after.settled && after.snapshot.rows === held.snapshot.rows;
	const judged = [
		...earlier.map((a) => ({ a, grown: confirmed && held.snapshot.rows > a.snapshot.rows })),
		{ a: after, grown: false },
	].map(({ a, grown }) => ({ a, grown, v: judgeB1(a, held, grown) }));
	const chosen = judged.find((j) => j.v.verdict === "FAIL") ?? judged.find((j) => j.v.verdict === "PASS") ?? judged[0];
	if (chosen === undefined) return { verdict: "NOT MEASURED", reason: NOT_SETTLED, evidence: { held: held.held } };
	const evidence = { ...b1Evidence(chosen.a, held, chosen.grown), bracket: judged.map((j) => j.v.verdict) };
	const v = chosen.v;
	if (v.verdict === "NOT MEASURED") return { verdict: "NOT MEASURED", reason: v.reason, evidence };
	return { verdict: v.verdict, evidence };
}

/** B3: with every PAGE read held (the shell's answered), no empty state the answered render does not show. */
export function judgeB3(answered: AnsweredLoad, held: HeldLoad): BVerdict {
	// `held` is the PAGE's reads: the load answered every read the manifest places in the shells.
	const evidence = { heldEmpty: held.snapshot.empty, answeredEmpty: answered.snapshot.empty, held: held.held };
	if (!answered.settled) return { verdict: "NOT MEASURED", reason: NOT_SETTLED, evidence };
	// Nothing of the page's own was pending, so "no empty state while pending" was never asked. The
	// first cut PASSed these: a route that exercised only its shell read as measured (#6180 re-review).
	if (held.held.length === 0) return { verdict: "NOT MEASURED", reason: NO_PAGE_READS, evidence };
	if (held.snapshot.empty > answered.snapshot.empty) return { verdict: "FAIL", evidence };
	if (held.snapshot.empty === 0) return { verdict: "PASS", evidence };
	return { verdict: "NOT MEASURED", reason: ANSWERED_EMPTY, evidence };
}

/** What a failed phase did wrong, against the answered render. Empty when nothing. */
export function failureProblems(answered: RegionSnapshot, failed: RegionSnapshot): string[] {
	const out: string[] = [];
	if (failed.skeletons > 0 || failed.busy) out.push("endless skeleton");
	if (failed.empty > answered.empty) out.push("empty copy");
	const errorAppeared = failed.errors > answered.errors;
	if (!errorAppeared && (failed.rows < answered.rows || failed.contentLeaves < answered.contentLeaves)) {
		out.push("content vanished with no error surface");
	}
	return out;
}

/** B4: neither failed phase leaves a skeleton, shows empty copy, or drops content silently. */
export function judgeB4(answered: AnsweredLoad, phases: readonly FailedPhase[], isPageRead: (key: string) => boolean = () => true): BVerdict {
	const results = phases.map((p) => ({
		phase: p.phase,
		failed: p.failed,
		failedKeys: p.failedKeys,
		pageReadsFailed: p.failedKeys.filter(isPageRead),
		problems: failureProblems(answered.snapshot, p.snapshot),
		render: summary(p.snapshot),
	}));
	const evidence = { phases: results, answered: summary(answered.snapshot) };
	if (!answered.settled) return { verdict: "NOT MEASURED", reason: NOT_SETTLED, evidence };
	const failedAny = phases.some((p) => p.failed > 0);
	// Nothing was failed, so nothing was measured: a route that made no read has no failure to render.
	if (!failedAny) return { verdict: "NOT MEASURED", reason: "no-reads-failed — the route made no data read, so forcing reads to fail reached nothing", evidence };
	// Only the SHELL's reads were failed: whatever `main` did, the page's own regions were never
	// asked to render a failure. Counted through the manifest, as B5 counts (#6180 re-review).
	if (!results.some((r) => r.pageReadsFailed.length > 0)) return { verdict: "NOT MEASURED", reason: NO_PAGE_READS, evidence };
	if (results.some((r) => r.problems.length > 0)) return { verdict: "FAIL", evidence };
	const errorShown = phases.some((p) => p.snapshot.errors > answered.snapshot.errors);
	if (answered.snapshot.empty > 0 && failedAny && !errorShown) return { verdict: "NOT MEASURED", reason: ANSWERED_EMPTY, evidence };
	return { verdict: "PASS", evidence };
}

/** B5's per-read observation: what the region kept when this one read failed, and whether it was. */
export interface OneFailure {
	key: string;
	snapshot: RegionSnapshot;
	/** How many requests for this read were answered 500 — 0 means the failure never happened. */
	intercepted: number;
}

/**
 * Whether ONE failed read took more than its own region down.
 *
 * It did when the ROUTE boundary answered (`ErrorState`: the whole page replaced by an error), or
 * when nothing outside an error surface is left and no error surface took its place (a skeleton that
 * never resolves, a blank — `~/settings/general`, F050/F051). When the page has two or more reads of
 * its own, ANY failure that leaves no text outside an error surface took its siblings down, because
 * those siblings were fed by reads that answered.
 */
export function tookPageDown(snapshot: RegionSnapshot, pageReadCount: number): boolean {
	if (snapshot.routeError) return true;
	if (snapshot.leavesOutsideErrors === 0 && snapshot.errors === 0) return true;
	return pageReadCount >= 2 && snapshot.leavesOutsideErrors === 0;
}

/**
 * B5: one failed read of the page's own takes down only its own region — measured on EVERY route
 * that has a read of its own, including a route with exactly one (whose failure must render a leaf
 * error, not the route's error page). A route with NO read of its own, or one on which no failure
 * was actually injected, is NOT MEASURED: the first PASS-by-structure shortcut produced 25 of 34
 * PASSes, 17 of them on routes nothing was failed on (#6180's review).
 */
export function judgeB5(answered: AnsweredLoad, pageReads: readonly string[], shellReads: readonly string[], failures: readonly OneFailure[]): BVerdict {
	const injected = failures.filter((f) => f.intercepted > 0);
	const blanked = injected.filter((f) => tookPageDown(f.snapshot, pageReads.length)).map((f) => readLabel(f.key));
	const evidence = {
		pageReads,
		shellReads,
		blanked,
		injected: injected.length,
		notReached: failures.filter((f) => f.intercepted === 0).map((f) => f.key),
		kept: failures.map((f) => ({ read: f.key, intercepted: f.intercepted, leavesOutsideErrors: f.snapshot.leavesOutsideErrors, errors: f.snapshot.errors, routeError: f.snapshot.routeError })),
	};
	if (!answered.settled) return { verdict: "NOT MEASURED", reason: NOT_SETTLED, evidence };
	if (pageReads.length === 0) {
		return { verdict: "NOT MEASURED", reason: NO_PAGE_READS, evidence };
	}
	if (pageReads.length > B5_READ_CAP) {
		return {
			verdict: "NOT MEASURED",
			reason: `over-read-budget — the route makes ${pageReads.length} reads of its own and B5 fails at most ${B5_READ_CAP} one at a time`,
			evidence,
		};
	}
	if (injected.length === 0) {
		return { verdict: "NOT MEASURED", reason: "not-intercepted — none of the route's reads was made again on the failure loads, so nothing was failed", evidence };
	}
	return { verdict: blanked.length > 0 ? "FAIL" : "PASS", evidence };
}

// ── the floor under B3 and B5 (#6318) ───────────────────────────────────────────────────────────
//
// B3 and B5 can only measure a route that makes a read of its OWN on load, and ADR 0005 moves every
// first-paint read onto the server prefetch, so the set they can measure shrinks with every correct
// migration. A floor that COUNTED their PASS/FAIL cells (`MIN_MEASURED_FOR`, 10→9→7→6 on B3 and
// 10→9 on B5) had to be lowered by hand each time, and a floor every correct change lowers no longer
// tells a migration from an instrument that stopped measuring.
//
// So the floor asks a question a migration cannot change the answer to: did the instrument score
// every route that an INDEPENDENT load saw make a read of its own on load? The witness is B4's cold
// load — a different load, in a context of its own, that fails every read and records which of them
// were the page's. A route it saw read on load must be scored, with one excuse per predicate that is
// a fact about the page: B3 may read `answered-empty` (the answered render is its own empty state),
// B5 may read `over-read-budget` (more reads of its own than B5 fails one at a time). A route it did
// not see read is legitimately `no-page-reads` (B5: also `not-intercepted`). Any other NOT MEASURED
// — a thrown load, a missing phase, a withheld predicate, an unrecognised reason — is the
// instrument's and fails. A B4 that was itself withheld, or not measured for an instrument reason,
// witnesses nothing, and one that still carries cold-load evidence fails the floor outright.
//
// "Every witnessed route was scored" is vacuously true when nothing was witnessed, so CONTROL routes
// that read on load by design must each be witnessed and scored — one per SHELL. The witness and the
// verdicts share the shell classifier (`shellReadsFor`), the read carrier (`readCarrier`) and the
// read key (`readKey`), so a fault in any of them can move a route out of both at once. A control in
// every shell turns such a fault red as long as it reaches the control's page reads; a fault confined
// to one shell's routes is caught by that shell's control.
//
// The boundary, stated: a fault in those shared parts that spares every control's reads and drops
// only other routes' is invisible here. That is the fixture control's job (`shell-only`,
// `cold-shell`, `action-page-read`, `client-fetch` drive the classifier, the carrier and the key
// together) and the classifier's self-tests', not this floor's.

/** A written B record, as the floor reads it. */
export interface BFloorRecord {
	route: string;
	predicate: string;
	verdict: string;
	reason?: string;
	evidence?: unknown;
}

/** The predicates whose measurable set shrinks as routes prefetch, and so are floored by witness. */
export type LoadReadPredicate = "B3" | "B5";

/**
 * The NOT MEASURED reasons that describe the ROUTE rather than the instrument, per predicate. Every
 * other reason fails the floor. `no-page-reads` and `not-intercepted` additionally fail on a route
 * the witness saw make a read of its own on load (`LOAD_READ_EXCUSES`).
 */
const ROUTE_REASONS: Record<LoadReadPredicate, readonly string[]> = {
	B3: ["no-page-reads", "answered-empty"],
	B5: ["no-page-reads", "not-intercepted", "over-read-budget"],
};

/** The reasons that mean "this route made no read of its own to measure" — false on a witnessed route. */
const LOAD_READ_EXCUSES: Record<LoadReadPredicate, readonly string[]> = {
	B3: ["no-page-reads"],
	B5: ["no-page-reads", "not-intercepted"],
};

/** A NOT MEASURED reason's leading token (`no-page-reads — …` → `no-page-reads`). */
function reasonToken(reason: string | undefined): string {
	return (reason ?? "").trim().split(/\s/)[0] ?? "";
}

/** B4's own NOT MEASURED reasons that are facts about the route — a B4 carrying one still witnesses. */
const B4_ROUTE_REASONS: readonly string[] = ["answered-empty", "no-page-reads", "no-reads-failed"];

/** Whether a B4 record can witness: scored, or NOT MEASURED for a fact about its route. */
function trustedB4(record: BFloorRecord): boolean {
	return record.verdict !== "NOT MEASURED" || B4_ROUTE_REASONS.includes(reasonToken(record.reason));
}

/**
 * The page reads B4's COLD load failed on `record`, or an empty list when the record carries no
 * cold-phase evidence. A B4 whose load threw, or that has no record, carries none and witnesses
 * nothing. A WITHHELD B4 keeps its evidence (`report.ts` rewrites the verdict, not the evidence), so
 * `readsOnLoad` skips it and `loadReadFloorProblems` fails on it.
 */
function coldPageReads(record: BFloorRecord): string[] {
	const ev = record.evidence;
	if (typeof ev !== "object" || ev === null || !("phases" in ev) || !Array.isArray(ev.phases)) return [];
	const phases: unknown[] = ev.phases;
	const out: string[] = [];
	for (const p of phases) {
		if (typeof p !== "object" || p === null || !("phase" in p) || p.phase !== "cold load") continue;
		if (!("pageReadsFailed" in p) || !Array.isArray(p.pageReadsFailed)) continue;
		const keys: unknown[] = p.pageReadsFailed;
		for (const k of keys) if (typeof k === "string") out.push(k);
	}
	return out;
}

/**
 * The routes an independent load saw make a read of their own ON LOAD, with those reads: B4's cold
 * phase failed at least one read the shell classifier gave the page. Only a B4 that was measured
 * (`trustedB4`) witnesses.
 */
export function readsOnLoad(records: readonly BFloorRecord[]): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const r of records) {
		if (r.predicate !== "B4" || !trustedB4(r)) continue;
		const reads = coldPageReads(r);
		if (reads.length > 0) out.set(r.route, reads);
	}
	return out;
}

/**
 * Everything wrong with `predicate`'s column as a measurement, against the load witness. Empty when
 * every route that made a read of its own on load was scored, every other NOT MEASURED names a fact
 * about its route, and every one of `controls` — routes that read on load by design, one per shell —
 * was both witnessed and scored.
 */
export function loadReadFloorProblems(records: readonly BFloorRecord[], predicate: LoadReadPredicate, controls: readonly string[]): string[] {
	const problems: string[] = [];
	if (controls.length === 0) problems.push(`the ${predicate} floor was given no control route, so a scan that saw no read anywhere would pass it`);
	const witnessed = readsOnLoad(records);
	for (const r of records) {
		if (r.predicate === "B4" && !trustedB4(r) && coldPageReads(r).length > 0) {
			problems.push(`B4 on ${r.route} is NOT MEASURED (${(r.reason ?? "").slice(0, 120)}) yet carries cold-load evidence — a withheld B4 cannot witness ${predicate}'s floor`);
		}
	}
	const mine = new Map(records.filter((r) => r.predicate === predicate).map((r) => [r.route, r]));
	const accepted = ROUTE_REASONS[predicate];
	const excuses = LOAD_READ_EXCUSES[predicate];
	for (const [route, r] of mine) {
		if (r.verdict !== "NOT MEASURED") continue;
		const token = reasonToken(r.reason);
		if (!accepted.includes(token)) {
			problems.push(`${predicate} on ${route} is NOT MEASURED for a reason that is the instrument's, not the route's: ${(r.reason ?? "(no reason)").slice(0, 160)}`);
			continue;
		}
		const reads = witnessed.get(route);
		if (reads && excuses.includes(token)) {
			problems.push(`${predicate} on ${route} read \`${token}\`, but B4's cold load saw it make ${reads.length} read(s) of its own on load (${reads.slice(0, 3).join(", ")}) — the ${predicate} load did not see what another load did`);
		}
	}
	for (const route of witnessed.keys()) {
		if (!mine.has(route)) problems.push(`${predicate} has no record for ${route}, which B4's cold load saw make a read of its own on load`);
	}
	for (const control of controls) {
		const c = mine.get(control);
		if (!witnessed.has(control)) {
			problems.push(`the control route ${control} was not seen making a read of its own on load — either the witness stopped seeing reads in its shell, or the control stopped reading on load and needs replacing with a route of that shell that does`);
		}
		if (c?.verdict !== "PASS" && c?.verdict !== "FAIL") {
			problems.push(`${predicate} did not score the control route ${control} (${c ? `${c.verdict}${c.reason ? ` — ${c.reason.slice(0, 120)}` : ""}` : "no record"})`);
		}
	}
	return problems;
}

/** The reads every route under the same shells makes — the shell's, not the page's. */
/**
 * Whether the build says a server action belongs to the shells: every page entry under the route's
 * shells references it. Answerable before any run, so B3 can let the shell's reads through.
 */
export function structurallyShell(key: string, chainEntries: readonly string[], workers: (key: string) => ReadonlySet<string> | null = workersOf): boolean {
	const w = workers(key);
	return w !== null && chainEntries.length > 0 && chainEntries.every((e) => w.has(e));
}

/**
 * THE one classifier B3, B4 and B5 share: for `route`, is `key` the SHELL's read?
 *
 * It classifies the KEY, not the route's answered reads. A route's B3 and B4 loads run in contexts of
 * their own and make shell reads its warm answered load never made; when only the answered reads were
 * classified, those reads counted as the page's, and B4 PASSed five `~/support*` routes on nothing but
 * a failed shell action (#6180's fourth review). So any key, from any load, is the shell's when:
 *
 *   · STRUCTURE, CONFIRMED BY OBSERVATION — the build's server-reference manifest places it in EVERY
 *     page under the route's shells AND another route was seen making it, in any load. Reference is
 *     not use: `app-shell.tsx` imports `useJobsQuery` → `getJob`, so `getJob` is in every AppShell
 *     bundle while only `~/jobs/[id]` calls it, and the reference-only rule called it "shell"
 *     (#6180's third review); or
 *   · every route under those shells made it (the intersection; over every route when fewer than
 *     three share the chain); or
 *   · it is a read-router procedure one of the route's LAYOUTS reads (`layoutRpcReads`) — a read-router
 *     read has no manifest entry, and a layout's prefetch is the shell's by construction.
 *
 * Everything else is the page's. `readsByRoute` should already hold a COLD load of every route
 * (`behaviour.spec.ts` phase 1), so a shell read that fires only on a fresh context has been seen on
 * the other routes before any route is measured, whatever order the tests run in.
 */
export function shellClassifier(
	route: string,
	chains: ReadonlyMap<string, string>,
	readsByRoute: ReadonlyMap<string, readonly string[]>,
	entries: ReadonlyMap<string, string> = new Map(),
	workers: (key: string) => ReadonlySet<string> | null = workersOf,
	layoutReads: ReadonlySet<string> = new Set(),
): (key: string) => boolean {
	const chain = chains.get(route);
	const peers = [...readsByRoute.keys()].filter((r) => chains.get(r) === chain);
	const chainEntries = [...chains].filter(([, c]) => c === chain).map(([r]) => entries.get(r)).filter((e): e is string => e !== undefined);
	const pool = peers.length >= 3 ? peers : [...readsByRoute.keys()];
	const [first, ...rest] = pool;
	const common = new Set(first === undefined ? [] : (readsByRoute.get(first) ?? []));
	for (const r of rest) {
		const reads = new Set(readsByRoute.get(r) ?? []);
		for (const k of [...common]) if (!reads.has(k)) common.delete(k);
	}
	const observedElsewhere = (key: string) => [...readsByRoute].some(([r, ks]) => r !== route && ks.includes(key));
	return (key) =>
		layoutReads.has(key) || common.has(key) || (chainEntries.length > 0 && structurallyShell(key, chainEntries, workers) && observedElsewhere(key));
}

/** A read-router call in source: `rpc.workspace.context`, `orpc.jobs.page`, `serverOrpc().x.y`. */
const RPC_CALL = /\b(?:rpc|orpc|serverOrpc\(\))\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\b/g;

/**
 * The read-router procedures a route's LAYOUTS read (`rpc <namespace>/<procedure>`), from their source.
 *
 * A read-router read has no server-reference manifest entry, so the structural half of the
 * classifier cannot see it, and a shell read the layout prefetches is made by the client only when it
 * goes stale — on the stale refetch, on every route, after phase 1 has run. Read off the layout that
 * prefetches it, it is the shell's by construction: `[org]/layout.tsx` seeds `workspace.*` for the
 * shell (#6114). Without this, B4 PASSed the support routes on nothing but failed `workspace.*`
 * refetches (the import of run 40474520273, before this rule). Raises on an unreadable layout.
 *
 * @param layoutFiles repo-relative layout files, as the route manifest lists them
 */
export function layoutRpcReads(layoutFiles: readonly string[]): Set<string> {
	const out = new Set<string>();
	for (const rel of layoutFiles) {
		const src = readFileSync(path.join(repoRoot(), rel), "utf8");
		for (const m of src.matchAll(RPC_CALL)) out.add(`rpc ${m[1]}/${m[2]}`);
	}
	return out;
}

/** The route's reads that `shellClassifier` assigns to the shell — the evidence B5 records. */
export function shellReadsFor(
	route: string,
	chains: ReadonlyMap<string, string>,
	readsByRoute: ReadonlyMap<string, readonly string[]>,
	entries: ReadonlyMap<string, string> = new Map(),
	workers: (key: string) => ReadonlySet<string> | null = workersOf,
	layoutReads: ReadonlySet<string> = new Set(),
): string[] {
	const isShell = shellClassifier(route, chains, readsByRoute, entries, workers, layoutReads);
	return [...new Set(readsByRoute.get(route) ?? [])].filter(isShell).sort();
}

/** The snapshot without its texts — what a record's evidence carries. */
function summary(s: RegionSnapshot): Omit<RegionSnapshot, "texts"> {
	const { texts: _texts, ...rest } = s;
	return rest;
}

// ── B2: the skeleton against the page ───────────────────────────────────────────────────────────

/** A box in viewport pixels, clipped to the viewport. */
export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** One element of a captured frame. */
export interface Captured {
	i: number;
	box: Box;
	/** A large bordered or filled block — what B2's column count and per-block score read. */
	block: boolean;
	/** The element holds table body rows, `role="row"` rows or list items — an OPEN-ENDED list. */
	list: boolean;
	/** The element has no element children: a leaf of the frame. */
	leaf: boolean;
}

/** The union of boxes, or `null` for none. */
export function outline(boxes: readonly Box[]): Box | null {
	if (boxes.length === 0) return null;
	const x0 = Math.min(...boxes.map((b) => b.x));
	const y0 = Math.min(...boxes.map((b) => b.y));
	const x1 = Math.max(...boxes.map((b) => b.x + b.w));
	const y1 = Math.max(...boxes.map((b) => b.y + b.h));
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The CLS formula applied to the move from the skeleton's outline to the page's: the area of the
 * union of both, as a fraction of the viewport, times the furthest the TOP, LEFT or RIGHT edge moved,
 * as a fraction of the viewport's larger side.
 *
 * The BOTTOM edge is excluded on purpose: a skeleton cannot know how many rows the answer has, and a
 * list that answers with two rows under an eight-row skeleton moves nothing on screen — nothing
 * below the region shifts, which is also why the browser's own CLS would score it zero.
 */
export function outlineShift(skeleton: Box, final: Box, viewport: { width: number; height: number }): number {
	const u = outline([skeleton, final]);
	if (u === null) return 0;
	const impact = (u.w * u.h) / (viewport.width * viewport.height);
	const moved = Math.max(Math.abs(skeleton.x - final.x), Math.abs(skeleton.y - final.y), Math.abs(skeleton.x + skeleton.w - (final.x + final.w)));
	return impact * (moved / Math.max(viewport.width, viewport.height));
}

/**
 * The most blocks that sit side by side anywhere in the frame: blocks whose vertical ranges overlap,
 * counted as the largest set of pairwise horizontally-disjoint ones. A two-column page under a
 * one-column skeleton is the F007 shape (two stacked boxes over a two-column form), and the outline
 * alone cannot see it.
 */
export function columnCount(blocks: readonly Box[]): number {
	let best = 0;
	for (const b of blocks) {
		const band = blocks.filter((o) => o.y < b.y + b.h && b.y < o.y + o.h).sort((p, q) => p.x + p.w - (q.x + q.w));
		let count = 0;
		let edge = Number.NEGATIVE_INFINITY;
		for (const o of band) {
			if (o.x >= edge - 1) {
				count += 1;
				edge = o.x + o.w;
			}
		}
		best = Math.max(best, count);
	}
	return best;
}

/** What B2 measured, or why it could not. */
export type SwapOutcome =
	| { kind: "measured"; skeleton: Captured[]; final: Captured[]; prefetched: boolean }
	| { kind: "not-measured"; reason: string; prefetched: boolean };

/** The area of the intersection over the area of the union — 0 when two boxes do not meet. */
function iou(a: Box, b: Box): number {
	const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
	const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
	if (w <= 0 || h <= 0) return 0;
	const inter = w * h;
	return inter / (a.w * a.h + b.w * b.h - inter);
}

/** One skeleton block's score against the region of the page that replaced it. */
export interface BlockScore {
	skeleton: Box;
	/** The final block (or the final leaves) it was matched to — `null` when nothing replaced it. */
	region: Box | null;
	/** The region is an open-ended list, so its bottom edge is not a shift (see `blockShift`). */
	list: boolean;
	score: number;
}

/**
 * The CLS formula for ONE skeleton block moving to the region of the page that replaced it — every
 * edge counts, the bottom included, unless the region is an open-ended list.
 *
 * The outline alone (`outlineShift`) is pinned at top, left and right by the shell on almost every
 * route, so it scored exactly 0 on 33 of 36 routes in the first run, and a 494px skeleton panel that
 * became a 96px card PASSED (#6180's review). A block whose height is wrong IS a shift — whatever sat
 * below it moves — so its bottom edge is measured. A LIST's bottom is not: no skeleton can know how
 * many rows the answer has, and a table that answers two rows under an eight-row skeleton moves
 * nothing above it. A skeleton block nothing replaced scores as vanishing: its whole height.
 */
export function blockShift(skeleton: Box, region: Box | null, list: boolean, viewport: { width: number; height: number }): number {
	const max = Math.max(viewport.width, viewport.height);
	const area = viewport.width * viewport.height;
	if (region === null) return ((skeleton.w * skeleton.h) / area) * (skeleton.h / max);
	const u = outline([skeleton, region]);
	if (u === null) return 0;
	const moved = Math.max(
		Math.abs(skeleton.x - region.x),
		Math.abs(skeleton.y - region.y),
		Math.abs(skeleton.x + skeleton.w - (region.x + region.w)),
		list ? 0 : Math.abs(skeleton.y + skeleton.h - (region.y + region.h)),
	);
	return ((u.w * u.h) / area) * (moved / max);
}

/** Score every skeleton block against what replaced it. */
export function blockScores(skeleton: readonly Captured[], final: readonly Captured[], viewport: { width: number; height: number }): BlockScore[] {
	const finalBlocks = final.filter((c) => c.block);
	const finalLeaves = final.filter((c) => c.leaf);
	return skeleton
		.filter((c) => c.block)
		.map((sb) => {
			let best: Captured | null = null;
			let bestIou = 0;
			for (const fb of finalBlocks) {
				const v = iou(sb.box, fb.box);
				if (v > bestIou) {
					bestIou = v;
					best = fb;
				}
			}
			// No final block overlaps it: the page drew that area without a frame (plain text, a
			// canvas). What replaced the skeleton block is then the leaves the page put inside it.
			const region = best ? best.box : outline(finalLeaves.filter((l) => iou(sb.box, l.box) > 0).map((l) => l.box));
			const list = best ? best.list : false;
			return { skeleton: sb.box, region, list, score: blockShift(sb.box, region, list, viewport) };
		});
}

/** B2's verdict over a swap. */
export function judgeB2(outcome: SwapOutcome): BVerdict {
	if (outcome.kind === "not-measured") return { verdict: "NOT MEASURED", reason: outcome.reason, evidence: { prefetched: outcome.prefetched } };
	const s = outline(outcome.skeleton.map((c) => c.box));
	const f = outline(outcome.final.map((c) => c.box));
	if (s === null || f === null) {
		return {
			verdict: "NOT MEASURED",
			reason: s === null ? "no-skeleton-region — the loading state replaced nothing inside `main`" : "no-final-region — the answered page added nothing inside `main`",
			evidence: { prefetched: outcome.prefetched },
		};
	}
	const outlineScore = outlineShift(s, f, B_VIEWPORT);
	const scored = blockScores(outcome.skeleton, outcome.final, B_VIEWPORT);
	// A skeleton of THIN BARS has no block-sized element, so per-block scoring has nothing to score
	// and the outline (whose top, left and right the shell pins) reads 0 — `~/support/abuse` PASSED
	// with its bottom edge 241px off (#6180 re-review). Such a skeleton is ONE block: its whole
	// outline against the page's, bottom included — unless the page ends in an open-ended list.
	const pageEndsInList = outcome.final.some((c) => c.list && Math.abs(c.box.y + c.box.h - (f.y + f.h)) <= 1);
	const blocks = scored.length > 0 ? scored : [{ skeleton: s, region: f, list: pageEndsInList, score: blockShift(s, f, pageEndsInList, B_VIEWPORT) }];
	const worst = blocks.reduce<BlockScore | null>((w, b) => (w === null || b.score > w.score ? b : w), null);
	const score = Math.max(outlineScore, worst?.score ?? 0);
	const columns = { skeleton: columnCount(outcome.skeleton.filter((c) => c.block).map((c) => c.box)), final: columnCount(outcome.final.filter((c) => c.block).map((c) => c.box)) };
	const evidence = {
		score: Number(score.toFixed(4)),
		outlineScore: Number(outlineScore.toFixed(4)),
		worstBlock: worst === null ? null : { ...worst, score: Number(worst.score.toFixed(4)) },
		blocks: scored.length,
		wholeSkeletonAsOneBlock: scored.length === 0,
		budget: B2_BUDGET,
		columns,
		outline: { skeleton: s, final: f },
		prefetched: outcome.prefetched,
	};
	// A column mismatch is a question about SIDE-BY-SIDE blocks, so it is asked only when one frame has
	// two or more. One filled skeleton box over a page with no bordered block (a canvas, plain text)
	// is not a column count disagreeing — measured on the first run, it failed the canvas and the CLI
	// hand-off for a frame whose outline matched.
	const columnsDisagree = Math.max(columns.skeleton, columns.final) >= 2 && columns.skeleton !== columns.final;
	return { verdict: score > B2_BUDGET || columnsDisagree ? "FAIL" : "PASS", evidence };
}

/**
 * B2 over SEVERAL swaps, keeping the WORST. One capture is one frame of a loading state that can
 * still be settling (a nested boundary resolving, a font swap), and `~/settings/general` flipped
 * between FAIL and PASS across runs on unchanged code. The worst of the measured swaps is the
 * verdict; a swap that could not be measured counts only when none could.
 */
export function judgeB2Worst(outcomes: readonly SwapOutcome[]): BVerdict {
	const verdicts = outcomes.map(judgeB2);
	const measured = verdicts.filter((v) => v.verdict !== "NOT MEASURED");
	if (measured.length === 0) return verdicts[0] ?? { verdict: "NOT MEASURED", reason: "no-swap — B2 drove no navigation", evidence: null };
	// The WORST measured swap: a FAIL over a PASS, and between two of a kind the higher score — so a
	// PASS reports the closer call, not whichever swap ran first.
	const scoreOf = (v: BVerdict): number => {
		const e = v.evidence;
		return typeof e === "object" && e !== null && "score" in e && typeof e.score === "number" ? e.score : 0;
	};
	const chosen = [...measured].sort((a, b) => Number(b.verdict === "FAIL") - Number(a.verdict === "FAIL") || scoreOf(b) - scoreOf(a))[0];
	return { ...chosen, evidence: { worst: chosen.evidence, swaps: verdicts.map((v) => v.verdict) } };
}

/** Read a property of `window.next.router` in the page, without trusting its type. */
async function routerReady(page: Page): Promise<boolean> {
	return page
		.waitForFunction(
			() => {
				const runtime: unknown = Reflect.get(window, "next");
				if (typeof runtime !== "object" || runtime === null) return false;
				const router: unknown = Reflect.get(runtime, "router");
				return typeof router === "object" && router !== null && typeof Reflect.get(router, "push") === "function";
			},
			null,
			{ timeout: 15_000 },
		)
		.then(
			() => true,
			() => false,
		);
}

/** Call `window.next.router[method](href)` in the page. */
async function callRouter(page: Page, method: "prefetch" | "push", href: string): Promise<void> {
	await page.evaluate(
		([m, h]) => {
			const runtime: unknown = Reflect.get(window, "next");
			if (typeof runtime !== "object" || runtime === null) return;
			const router: unknown = Reflect.get(runtime, "router");
			if (typeof router !== "object" || router === null) return;
			const fn: unknown = Reflect.get(router, m);
			if (typeof fn === "function") Reflect.apply(fn, router, [h]);
		},
		[method, href] as const,
	);
}

/** Capture every element in `main`, tagging each so the swap can tell which survived it. */
async function captureFrame(page: Page, mode: "tag" | "fresh"): Promise<{ captured: Captured[]; present: number[] }> {
	return page.evaluate((m) => {
		const main = document.querySelector("main");
		if (main === null) return { captured: [], present: [] };
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const width = main.clientWidth;
		const boxOf = (el: Element) => {
			const style = window.getComputedStyle(el);
			if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) < 0.05) return null;
			const r = el.getBoundingClientRect();
			const x0 = Math.max(0, r.left);
			const y0 = Math.max(0, r.top);
			const x1 = Math.min(vw, r.right);
			const y1 = Math.min(vh, r.bottom);
			if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
			const bordered = ["Top", "Right", "Bottom", "Left"].some(
				(side) => parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 && style.getPropertyValue(`border-${side.toLowerCase()}-style`) !== "none",
			);
			const filled = style.backgroundImage !== "none" || !/rgba\([^)]*,\s*0\)|transparent/.test(style.backgroundColor);
			return {
				box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
				block: (bordered || filled) && r.height >= 64 && r.width >= width * 0.2,
				list: el.querySelector('tbody tr, [role="row"], li, [role="listitem"]') !== null,
				leaf: el.children.length === 0,
			};
		};
		const captured: { i: number; box: { x: number; y: number; w: number; h: number }; block: boolean; list: boolean; leaf: boolean }[] = [];
		const present: number[] = [];
		let i = 0;
		for (const el of Array.from(main.querySelectorAll("*"))) {
			const tag = el.getAttribute("data-b2-skeleton");
			if (m === "fresh" && tag !== null) {
				present.push(Number(tag));
				continue;
			}
			if (m === "tag") el.setAttribute("data-b2-skeleton", String(i));
			const b = boxOf(el);
			if (b !== null) captured.push({ i, ...b });
			i += 1;
		}
		return { captured, present };
	}, mode);
}

/**
 * B2: paint the route's OWN loading state, then the route, and capture both.
 *
 * From `origin` (a page that shares every layout with the target down to the target's loading
 * boundary, so it is that boundary's fallback that paints — see `behaviour.spec.ts`), the target is
 * prefetched (Next prefetches a dynamic route only as far as its loading boundary), then pushed with
 * its data response HELD. The loading state paints; every element in `main` is tagged and measured;
 * the response is released; whatever is new afterwards is the page, and whatever tagged element is
 * gone is the skeleton. Layout nodes that survive the swap are neither, so a shell inside `main`
 * cannot pass or fail a page.
 *
 * If the URL never moves while the response is held, the loading state was not available to paint
 * and the route is NOT MEASURED saying so — never a PASS over a skeleton nobody saw.
 */
export async function measureSkeletonSwap(page: Page, origin: string, target: string): Promise<SwapOutcome> {
	await page.setViewportSize(B_VIEWPORT);
	await page.goto(origin, { waitUntil: "domcontentloaded" });
	await page.waitForLoadState("load").catch(() => {});
	if (!(await routerReady(page))) return { kind: "not-measured", reason: "no-client-router — `window.next.router` never appeared on the origin page", prefetched: false };
	const targetPath = new URL(target, page.url()).pathname;
	const held: Route[] = [];
	// Holding stops at the release. The handler stays installed until the swap is read — removing it
	// while a released request is still walking the handler chain marks that request handled twice —
	// so every later request (a refresh, a revalidation) has to pass straight through it instead.
	let holding = true;
	const matcher = (url: URL) => url.pathname === targetPath;
	await page.route(matcher, async (route) => {
		const req = route.request();
		const headers = req.headers();
		if (holding && req.method() === "GET" && headers["rsc"] === "1" && headers["next-router-prefetch"] === undefined) {
			held.push(route);
			return;
		}
		await route.fallback();
	});
	try {
		const prefetch = page
			.waitForResponse((r) => new URL(r.url()).pathname === targetPath && r.request().headers()["next-router-prefetch"] !== undefined, { timeout: 8_000 })
			.then(
				() => true,
				() => false,
			);
		await callRouter(page, "prefetch", target);
		const prefetched = await prefetch;
		await page.waitForTimeout(300);
		await callRouter(page, "push", target);
		const moved = await page
			.waitForFunction((p) => window.location.pathname === p && document.querySelector("main") !== null, targetPath, { timeout: 10_000 })
			.then(
				() => true,
				() => false,
			);
		if (!moved) {
			return {
				kind: "not-measured",
				reason: "loading-state-not-painted — the URL never moved to the route while its data response was held, so its loading state was not available to paint",
				prefetched,
			};
		}
		if (held.length === 0) {
			return { kind: "not-measured", reason: "no-held-response — the route rendered without a data response to hold, so no loading state was shown", prefetched };
		}
		// A DEFINED loading frame: the fallback has to hold still — the same element count and text
		// length for 600ms — before it is captured, so a capture never lands on a
		// nested boundary half-way through resolving (the `~/settings/general` flip).
		await waitStill(page, { minMs: 400, quietMs: 600, capMs: 4_000 });
		const skeleton = await captureFrame(page, "tag");
		holding = false;
		for (const route of held.splice(0)) await route.fallback().catch(() => {});
		await awaitReady(page);
		const after = await captureFrame(page, "fresh");
		const survived = new Set(after.present);
		return {
			kind: "measured",
			skeleton: skeleton.captured.filter((c) => !survived.has(c.i)),
			final: after.captured,
			prefetched,
		};
	} finally {
		holding = false;
		for (const route of held) await route.fallback().catch(() => {});
		await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
	}
}

// ── the positive control ────────────────────────────────────────────────────────────────────────
//
// Every predicate above is driven, through the SAME loaders and the SAME judges the routes go
// through, against fixture pages with KNOWN answers — a good page that must PASS and, per predicate,
// a page one defect away from it that must FAIL. `behaviour.spec.ts` runs this before it scores a
// route and withholds, for the whole run, every predicate the control names: a verdict from an
// instrument already shown not to fire is the #3804 failure.

/** The origin the fixtures are served from. Never resolved by DNS — `context.route()` answers it. */
export const B_CONTROL_ORIGIN = "http://behaviour-control.invalid";

/** The fixture modes, each named for the defect it carries (or `prefetched`/`static`, which carry none). */
export const B_CONTROL_MODES = [
	"prefetched",
	"static",
	"client-fetch",
	"empty-while-pending",
	"empty-after-hydration",
	"shell-only",
	"empty-on-error",
	"vanish-on-error",
	"endless-skeleton",
	"region-error",
	"one-read-contained",
	"one-read-route-error",
	"two-regions-contained",
	"two-regions-blanked",
	"swap-matching",
	"swap-columns",
	"swap-shifted",
	"swap-height",
	"swap-list",
	"swap-bars",
	"action-page-read",
	"cold-shell",
	"layout-rpc-refetch",
	"growing-feed",
] as const;

/**
 * The fixture's build: two page entries under one shell — the fixture page and a PEER — and two
 * server actions, BOTH referenced by both entries. `fx-shell` is the shell's: the peer makes it too.
 * `fx-page` is referenced everywhere and called by the fixture page alone — the `getJob` shape that
 * the first classifier called "shell" (#6180's third review). The fixture's reads are classified by
 * `shellReadsFor`, the same function the routes go through, over this manifest and the peer's reads.
 */
const FIXTURE_ROUTE = "/fixture";
const FIXTURE_PEER = "/peer";
const FIXTURE_ENTRY_MAP: ReadonlyMap<string, string> = new Map([
	[FIXTURE_ROUTE, "app/fixture/page"],
	[FIXTURE_PEER, "app/fixture/other"],
]);
const FIXTURE_CHAINS: ReadonlyMap<string, string> = new Map([
	[FIXTURE_ROUTE, "FixtureShell"],
	[FIXTURE_PEER, "FixtureShell"],
]);
const FIXTURE_WORKERS = workersFromManifest({
	node: {
		"fx-shell": { workers: { "app/fixture/page": {}, "app/fixture/other": {} } },
		"fx-page": { workers: { "app/fixture/page": {}, "app/fixture/other": {} } },
	},
});

/** The read-router procedure the fixture's LAYOUT prefetches — the `workspace.*` shape (#6114). */
const FIXTURE_LAYOUT_READS: ReadonlySet<string> = new Set(["rpc fixture/layoutread"]);

/** The fixture's shell classifier, given what its page was seen making — the peer only ever makes `fx-shell`. */
function fixtureClassifier(reads: readonly string[]): (key: string) => boolean {
	const readsByRoute = new Map<string, readonly string[]>([
		[FIXTURE_ROUTE, reads],
		[FIXTURE_PEER, ["action fx-shell"]],
	]);
	return shellClassifier(FIXTURE_ROUTE, FIXTURE_CHAINS, readsByRoute, FIXTURE_ENTRY_MAP, FIXTURE_WORKERS, FIXTURE_LAYOUT_READS);
}

/** One fixture mode. */
export type BControlMode = (typeof B_CONTROL_MODES)[number];

/**
 * One fixture page, every mode. Plain DOM in the slots the console renders — `data-slot="skeleton"`,
 * `aria-busy`, `role="alert"`, `data-slot="empty"`, a `DataTable`-shaped empty row, table rows, the
 * route boundary's `ErrorState` classes — and reads over the read router's own URL shape, so the
 * loaders intercept them exactly as they intercept a console page's. The `fx-shell` server action is
 * the SHELL's read, classified through a fixture build manifest (`FIXTURE_WORKERS`). `window.next.router` is a
 * stand-in with the two methods B2 calls; its push paints a skeleton, then fetches the route's data
 * the way the App Router does (`RSC: 1`), so the hold-and-release in `measureSkeletonSwap` is
 * exercised for real.
 */
export const B_CONTROL_FIXTURE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>behaviour control</title>
<style>body{margin:0;font:14px sans-serif}main{display:block;padding:16px}.sk{height:16px;width:240px;background:#ddd;margin:8px 0}.frame{border:1px solid #999;height:400px}.listframe{border:1px solid #999;padding:16px}</style></head>
<body><main>__STATIC__<div id="region">__SSR__</div><div id="region-b">__SSR_B__</div></main>
<script>
var MODE = "__MODE__";
var SKELETON = '<div data-slot="skeleton" class="sk"></div><div data-slot="skeleton" class="sk"></div>';
var EMPTY = '<div data-slot="empty">No results.</div>';
var ERROR = '<div role="alert">Couldn\\'t load these rows</div>';
var REGION_ERROR = '<div data-slot="region-error" data-state="error"><p>Couldn\\'t load these rows</p></div>';
var ROUTE_ERROR = '<div class="__ROUTE_ERROR__"><p>Something went wrong loading this page</p></div>';
function rows(names) { return '<table><tbody>' + names.map(function (n) { return '<tr><td>' + n + '</td></tr>'; }).join('') + '</tbody></table>'; }
function read(name) { return fetch('/acme/~/rpc/fixture/' + name).then(function (r) { if (!r.ok) throw new Error('read failed'); return r.json(); }); }
function shellRead() { return fetch(location.pathname, { method: 'POST', headers: { 'Next-Action': 'fx-shell' } }).then(function (r) { if (!r.ok) throw new Error('shell read failed'); }); }
function pageAction() { return fetch(location.pathname, { method: 'POST', headers: { 'Next-Action': 'fx-page' } }).then(function (r) { if (!r.ok) throw new Error('page read failed'); }); }
if (MODE === "cold-shell") {
	// The shell read fires only on a COLD context — the first visit, before this origin's storage holds
	// anything — the way a real shell read can fire on a fresh session and not on a warm one.
	if (!localStorage.getItem('fx-warm')) { localStorage.setItem('fx-warm', '1'); shellRead().then(function () {}, function () {}); }
}
if (MODE === "layout-rpc-refetch") {
	// A layout-prefetched read the client makes only when it goes stale: nothing in the page reads.
	setTimeout(function () { read('layoutread').then(function () {}, function () {}); }, 30000);
}
if (MODE === "action-page-read") {
	shellRead().then(function () {}, function () {});
	pageAction().then(function () {}, function () { set('region', EMPTY, false); });
}
function set(id, html, busy) { var el = document.getElementById(id); if (!el) return; el.innerHTML = html; if (busy) el.setAttribute('aria-busy', 'true'); else el.removeAttribute('aria-busy'); }
if (MODE === "client-fetch" || MODE === "empty-while-pending" || MODE === "endless-skeleton" || MODE === "region-error") {
	read('rows').then(function (b) { set('region', rows(b.json), false); }, function () { if (MODE !== "endless-skeleton") set('region', MODE === "region-error" ? REGION_ERROR : ERROR, false); });
}
if (MODE === "shell-only") {
	shellRead().then(function () {}, function () {});
}
if (MODE === "empty-after-hydration") {
	shellRead().then(function () {
		set('region', EMPTY, false);
		read('rows').then(function (b) { set('region', rows(b.json), false); }, function () { set('region', ERROR, false); });
	}, function () {});
}
if (MODE === "prefetched" || MODE === "empty-on-error" || MODE === "vanish-on-error") {
	read('aux').then(function () {}, function () {});
	setTimeout(function () { read('rows').then(function () {}, function () { set('region', MODE === "empty-on-error" ? EMPTY : MODE === "vanish-on-error" ? '' : ERROR, false); }); }, 30000);
}
if (MODE === "one-read-contained" || MODE === "one-read-route-error") {
	read('a').then(function (b) { set('region', rows(b.json), false); }, function () {
		if (MODE === "one-read-route-error") document.querySelector('main').innerHTML = ROUTE_ERROR; else set('region', REGION_ERROR.replace('<div data-slot', '<div role="alert" data-slot'), false);
	});
}
if (MODE === "two-regions-contained" || MODE === "two-regions-blanked") {
	['a', 'b'].forEach(function (name) {
		var id = name === 'a' ? 'region' : 'region-b';
		read(name).then(function (b) { set(id, rows(b.json), false); }, function () {
			if (MODE === "two-regions-blanked") document.querySelector('main').innerHTML = ERROR; else set(id, ERROR, false);
		});
	});
}
if (MODE.indexOf("swap-") === 0) {
	var FRAME = MODE === "swap-list"
		? '<div class="frame">' + SKELETON + SKELETON + SKELETON + '</div>'
		: MODE === "swap-bars"
			? '<div data-slot="skeleton" style="height:16px;background:#ddd;margin:0 0 8px"></div><div data-slot="skeleton" style="height:16px;background:#ddd"></div>'
			: '<div class="frame"><div data-slot="skeleton" class="sk" style="margin:16px"></div></div>';
	var FINAL = MODE === "swap-columns"
		? '<div style="display:flex;gap:16px"><div class="frame" style="flex:1"><p>alpha</p></div><div class="frame" style="flex:1"><p>beta</p></div></div>'
		: MODE === "swap-shifted"
			? '<div class="frame" style="margin-top:160px"><p style="margin:16px">alpha</p></div>'
			: MODE === "swap-height"
				? '<div class="frame" style="height:200px"><p style="margin:16px">alpha</p></div>'
				: MODE === "swap-list"
					? '<div class="listframe">' + rows(['alpha', 'beta']) + '</div>'
					: MODE === "swap-bars"
						? '<div style="height:320px"><p>alpha</p><p>beta</p><p>gamma</p></div>'
						: '<div class="frame"><p style="margin:16px">alpha</p></div>';
	window.next = { router: {
		prefetch: function (href) { fetch(href, { headers: { 'RSC': '1', 'Next-Router-Prefetch': '1' } }); },
		push: function (href) {
			history.pushState(null, '', href);
			document.querySelector('main').innerHTML = FRAME;
			fetch(href, { headers: { 'RSC': '1' } }).then(function () { document.querySelector('main').innerHTML = FINAL; });
		}
	} };
}
</script></body></html>`;

/**
 * The `growing-feed` mode's rows on its Nth page load in one context: two, then five from the second
 * load on — an append-only log that one burst of writes grew between two loads, the way the run's own
 * fixtures grow `~/settings/activity` (#6326). Served from the server, so its first paint is correct.
 */
function feedRows(served: number): string {
	const names = served >= 2 ? ["alpha", "beta", "gamma", "delta", "epsilon"] : ["alpha", "beta"];
	return `<table><tbody>${names.map((n) => `<tr><td>${n}</td></tr>`).join("")}</tbody></table>`;
}

/** What each mode renders on the server, before any script runs. `feedServed` is `growing-feed`'s load count. */
function ssrFor(mode: BControlMode, feedServed = 1): { a: string; b: string; staticCopy: string } {
	const rows = "<table><tbody><tr><td>alpha</td></tr><tr><td>beta</td></tr></tbody></table>";
	if (mode === "growing-feed") return { a: feedRows(feedServed), b: "", staticCopy: "" };
	const skeleton = '<div data-slot="skeleton" class="sk"></div><div data-slot="skeleton" class="sk"></div>';
	const none = "";
	if (mode === "prefetched" || mode === "empty-on-error" || mode === "vanish-on-error" || mode === "static" || mode === "shell-only" || mode === "action-page-read" || mode === "cold-shell" || mode === "layout-rpc-refetch") return { a: rows, b: none, staticCopy: none };
	// `DataTable`'s empty row: one body row whose single cell spans the table.
	if (mode === "empty-while-pending") return { a: '<table><tbody><tr><td colspan="2">No results.</td></tr></tbody></table>', b: none, staticCopy: none };
	if (mode === "client-fetch" || mode === "endless-skeleton" || mode === "region-error" || mode === "empty-after-hydration") {
		return { a: `<div aria-busy="true">${skeleton}</div>`, b: none, staticCopy: none };
	}
	if (mode === "one-read-contained" || mode === "one-read-route-error") return { a: skeleton, b: none, staticCopy: "<p>Static settings copy that reads no data</p>" };
	if (mode === "two-regions-contained" || mode === "two-regions-blanked") return { a: skeleton, b: skeleton, staticCopy: none };
	return { a: "<p>origin page</p>", b: none, staticCopy: none };
}

/** Serve every fixture mode, and its reads, on one context. */
export async function serveBehaviourControl(context: BrowserContext): Promise<void> {
	const routeError = (errorStateSignature()[0] ?? []).join(" ");
	// Per context: `growing-feed` grows on this context's second load of it, wherever that falls.
	let feedServed = 0;
	await context.route(`${B_CONTROL_ORIGIN}/**`, (route) => {
		const { pathname } = new URL(route.request().url());
		if (pathname.includes(RPC_MARKER)) {
			return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ json: ["alpha", "beta"], meta: [] }) });
		}
		const mode = pathname.split("/")[4] ?? "prefetched";
		const m: BControlMode = isControlMode(mode) ? mode : "prefetched";
		if (m === "growing-feed") feedServed += 1;
		const ssr = ssrFor(m, feedServed);
		return route.fulfill({
			status: 200,
			contentType: "text/html; charset=utf-8",
			body: B_CONTROL_FIXTURE.replace("__MODE__", m)
				.replace("__SSR__", ssr.a)
				.replace("__SSR_B__", ssr.b)
				.replace("__STATIC__", ssr.staticCopy)
				.replace("__ROUTE_ERROR__", routeError),
		});
	});
}

/** Narrow a path segment to a fixture mode. */
function isControlMode(value: string): value is BControlMode {
	return B_CONTROL_MODES.some((m) => m === value);
}

/** The fixture URL for a mode. */
export function controlUrl(mode: BControlMode): string {
	return `${B_CONTROL_ORIGIN}/acme/~/control/${mode}`;
}

/** The result of the control: the predicates it found broken, and why. */
export interface BControlResult {
	broken: ("B1" | "B2" | "B3" | "B4" | "B5")[];
	lines: string[];
}

/**
 * Drive every predicate over the fixtures, in BOTH directions, and name what answered wrong.
 *
 * @param browser the run's browser — the control makes its own contexts, never the audit's
 */
export async function behaviourControl(browser: Browser): Promise<BControlResult> {
	const lines: string[] = [];
	const broken = new Set<BControlResult["broken"][number]>();
	const newContext: ContextFactory = async () => {
		const c = await browser.newContext({ storageState: undefined });
		await serveBehaviourControl(c);
		return c;
	};
	const context = await newContext();
	// The REASON is asserted with the verdict: a NOT MEASURED for the wrong cause (action interception
	// broken, so `no-reads-failed` where `no-page-reads` was meant) is the instrument failing quietly.
	const expectVerdict = (id: BControlResult["broken"][number], mode: BControlMode, got: BVerdict, want: BVerdict["verdict"], reason?: string) => {
		const reasonOk = reason === undefined || (got.verdict === "NOT MEASURED" && got.reason.startsWith(reason));
		if (got.verdict !== want || !reasonOk) {
			broken.add(id);
			lines.push(`${id} on the \`${mode}\` fixture: expected ${want}${reason === undefined ? "" : ` \`${reason}\``}, got ${got.verdict}${got.verdict === "NOT MEASURED" ? ` (${got.reason})` : ""}`);
		}
	};
	try {
		// B3's and B4's loads run COLD — a context of their own, as the routes' do — and the answered
		// load runs WARM, after a first visit, so a read that only a cold context makes is one the
		// answered load never saw. The classifier has to place it by its KEY.
		const measure = async (mode: BControlMode) => {
			const url = controlUrl(mode);
			await loadAnswered(context, url);
			const answered = await loadAnswered(context, url);
			const isShell = fixtureClassifier(answered.reads);
			const cold = await newContext();
			let pageHeld: HeldLoad;
			try {
				pageHeld = await loadHeld(cold, url, isShell);
			} finally {
				await cold.close();
			}
			const failed = await loadFailed(newContext, url);
			return { b3: judgeB3(answered, pageHeld), b4: judgeB4(answered, failed, (k) => !isShell(k)) };
		};
		// B1 through `measureB1`, as the routes take it: an earlier answered load (phase 1's, on a
		// route), then the held load and the answered load after it.
		const b1 = async (mode: BControlMode, on: BrowserContext = context) => {
			const first = await loadAnswered(on, controlUrl(mode));
			return { first, ...(await measureB1(on, controlUrl(mode), [first])) };
		};
		expectVerdict("B1", "prefetched", (await b1("prefetched")).verdict, "PASS");
		expectVerdict("B1", "client-fetch", (await b1("client-fetch")).verdict, "FAIL");
		// A feed that grew between the earlier answered load and the held one (#6326). Its first paint is
		// correct, so B1 must PASS — and the fixture must really have grown under it: the plain comparison
		// with the earlier load has to FAIL, or this PASS would prove nothing about the growth rule. A
		// context of its own, because the fixture counts its loads per context.
		const feed = await newContext();
		try {
			const grew = await b1("growing-feed", feed);
			expectVerdict("B1", "growing-feed", grew.verdict, "PASS");
			if (judgeB1(grew.first, grew.held).verdict !== "FAIL") {
				broken.add("B1");
				lines.push("B1 on the `growing-feed` fixture: the feed did not grow between the earlier answered load and the held one, so the growth rule was not exercised");
			}
		} finally {
			await feed.close();
		}
		const good = await measure("prefetched");
		expectVerdict("B3", "prefetched", good.b3, "PASS");
		expectVerdict("B4", "prefetched", good.b4, "PASS");
		const client = await measure("client-fetch");
		expectVerdict("B3", "client-fetch", client.b3, "PASS");
		expectVerdict("B4", "client-fetch", client.b4, "PASS");
		expectVerdict("B3", "empty-while-pending", (await measure("empty-while-pending")).b3, "FAIL");
		// The empty state appears only AFTER the shell's read answers, so a load that holds every read
		// (B1's) never shows it — B3 must hold the PAGE's reads and answer the shell's to see it.
		expectVerdict("B3", "empty-after-hydration", (await measure("empty-after-hydration")).b3, "FAIL");
		expectVerdict("B4", "empty-on-error", (await measure("empty-on-error")).b4, "FAIL");
		// No skeleton, no empty state, no error: the rows just go. Only the "content vanished" clause
		// can fail this one, so it pins that clause on its own.
		expectVerdict("B4", "vanish-on-error", (await measure("vanish-on-error")).b4, "FAIL");
		expectVerdict("B4", "endless-skeleton", (await measure("endless-skeleton")).b4, "FAIL");
		// The region-level error render (#6117) WITHOUT `role="alert"`, so only its `data-slot` can
		// make it read as an error: a recogniser that forgot `RegionError` reads this as content
		// that vanished silently, and fails B4 on a page that did the right thing.
		expectVerdict("B4", "region-error", (await measure("region-error")).b4, "PASS");
		// A page that made no read has nothing to fail, which is not a pass.
		expectVerdict("B4", "static", (await measure("static")).b4, "NOT MEASURED", "no-reads-failed");
		// A page whose only read is its SHELL's: B3 and B4 exercised nothing of the page's own.
		const shellOnly = await measure("shell-only");
		expectVerdict("B3", "shell-only", shellOnly.b3, "NOT MEASURED", "no-page-reads");
		expectVerdict("B4", "shell-only", shellOnly.b4, "NOT MEASURED", "no-page-reads");
		// A page read made over a server ACTION, referenced by every page entry and called by this
		// page alone: it is the page's, so failing it is measured — and the page renders an empty state.
		expectVerdict("B4", "action-page-read", (await measure("action-page-read")).b4, "FAIL");
		// A shell read made ONLY on a cold context: the warm answered load never saw it, the cold B3 and
		// B4 loads do. Classified by its key it is the shell's, and neither predicate measured the page.
		const coldShell = await measure("cold-shell");
		expectVerdict("B3", "cold-shell", coldShell.b3, "NOT MEASURED", "no-page-reads");
		expectVerdict("B4", "cold-shell", coldShell.b4, "NOT MEASURED", "no-page-reads");
		// Only a LAYOUT's read-router prefetch failed, on the stale refetch: no read of the page's own.
		expectVerdict("B4", "layout-rpc-refetch", (await measure("layout-rpc-refetch")).b4, "NOT MEASURED", "no-page-reads");

		const b5 = async (mode: BControlMode) => {
			const url = controlUrl(mode);
			const answered = await loadAnswered(context, url);
			const failures: OneFailure[] = [];
			for (const key of answered.reads) failures.push({ key, ...(await loadWithOneFailure(context, url, key)) });
			const isShell = fixtureClassifier(answered.reads);
			return judgeB5(answered, answered.reads.filter((k) => !isShell(k)), answered.reads.filter(isShell), failures);
		};
		expectVerdict("B5", "two-regions-contained", await b5("two-regions-contained"), "PASS");
		expectVerdict("B5", "two-regions-blanked", await b5("two-regions-blanked"), "FAIL");
		expectVerdict("B5", "one-read-contained", await b5("one-read-contained"), "PASS");
		expectVerdict("B5", "one-read-route-error", await b5("one-read-route-error"), "FAIL");
		expectVerdict("B5", "static", await b5("static"), "NOT MEASURED", "no-page-reads");

		const swaps: [BControlMode, BVerdict["verdict"]][] = [
			["swap-matching", "PASS"],
			["swap-columns", "FAIL"],
			["swap-shifted", "FAIL"],
			["swap-height", "FAIL"],
			["swap-list", "PASS"],
			// Bars only — no block-sized element — over a taller page: only the whole-skeleton block sees it.
			["swap-bars", "FAIL"],
		];
		for (const [mode, want] of swaps) {
			const page = await context.newPage();
			try {
				expectVerdict("B2", mode, judgeB2(await measureSkeletonSwap(page, controlUrl(mode), `${controlUrl(mode)}/next`)), want);
			} finally {
				await page.close();
			}
		}
	} catch (err) {
		for (const id of ["B1", "B2", "B3", "B4", "B5"] as const) broken.add(id);
		lines.push(`the control itself threw: ${err instanceof Error ? err.message : String(err)}`);
	} finally {
		await context.close();
	}
	return { broken: [...broken].sort(), lines };
}
