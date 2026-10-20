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
	/** `@repo/ui/empty` regions plus hand-written empty copy ("No results.", "No jobs yet"). */
	empty: number;
	/** Outermost error surfaces: `role="alert"`, or the shared `ErrorState`. */
	errors: number;
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

/** Copy that says a list or region is empty, matched against an element's OWN text. */
const EMPTY_COPY = String.raw`^(?:no results|no [a-z][a-z0-9 '’,/-]{0,48}|nothing (?:here|to show)(?: yet)?)\.?$`;

/** Relative times — "3 minutes ago" on one load is "4 minutes ago" on the next, and is not data. */
const RELATIVE_TIME = String.raw`\b(?:about |almost |over |less than )?(?:a|an|\d+) (?:second|minute|hour|day|week|month|year)s?(?: ago)?\b|\bjust now\b|\bin (?:a|an|\d+) (?:second|minute|hour|day|week|month|year)s?\b`;

/** Read `main` once. Never waits — the caller decides when the page has had its chance. */
export async function snapshotRegion(page: Page): Promise<RegionSnapshot> {
	return page.evaluate(
		({ arms, emptyCopy, relativeTime }) => {
			const zero = { hasMain: false, skeletons: 0, busy: false, empty: 0, errors: 0, rows: 0, leaves: 0, contentLeaves: 0, leavesOutsideErrors: 0, texts: [] };
			const main = document.querySelector("main");
			if (main === null) return zero;
			const shown = (el: Element): boolean => {
				const style = window.getComputedStyle(el);
				const r = el.getBoundingClientRect();
				return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) >= 0.05 && r.width > 0 && r.height > 0;
			};
			const all = Array.from(main.querySelectorAll("*")).filter(shown);
			const isErrorSurface = (el: Element): boolean =>
				el.getAttribute("role") === "alert" || arms.some((tokens) => tokens.every((t) => el.classList.contains(t)));
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
			const emptyRe = new RegExp(emptyCopy, "i");
			const timeRe = new RegExp(relativeTime, "gi");
			const emptySlots = all.filter((el) => el.getAttribute("data-slot") === "empty").length;
			const emptyText = all.filter(
				(el) => el.closest('[data-slot="empty"]') === null && !inError(el) && emptyRe.test(ownText(el)),
			).length;
			const rows = all.filter((el) => {
				if (inSkeleton(el)) return false;
				if (el.tagName === "TR") return el.closest("tbody") !== null;
				if (el.getAttribute("role") === "row") return el.querySelector('[role="columnheader"]') === null;
				return el.tagName === "LI" || el.getAttribute("role") === "listitem";
			}).length;
			const leafEls = all.filter((el) => !inSkeleton(el) && ownText(el) !== "");
			const mask = (s: string): string => s.toLowerCase().replace(timeRe, "<t>").replace(/\d/g, "#").slice(0, 80);
			return {
				hasMain: true,
				skeletons: all.filter((el) => el.getAttribute("data-slot") === "skeleton").length,
				busy: main.getAttribute("aria-busy") === "true" || main.querySelector('[aria-busy="true"]') !== null,
				empty: emptySlots + emptyText,
				errors: errorRoots.length,
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
		{ arms: errorStateSignature(), emptyCopy: EMPTY_COPY, relativeTime: RELATIVE_TIME },
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

/** Load `url` with every read held open, and read the region once it holds still. */
export async function loadHeld(context: BrowserContext, url: string): Promise<HeldLoad> {
	const { page } = await openTracked(context);
	const held: Route[] = [];
	const keys = new Set<string>();
	try {
		const pathname = new URL(url, "http://placeholder.invalid").pathname;
		await page.route(readCarrier(pathname), async (route) => {
			const key = readKey(route.request());
			if (key === null) return route.fallback();
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
		const pathname = new URL(url, "http://placeholder.invalid").pathname;
		await page.route(readCarrier(pathname), async (route) => {
			if (readKey(route.request()) === null) return route.fallback();
			failed += 1;
			await failRead(route);
		});
		await page.goto(url, { waitUntil: "domcontentloaded" });
		await page.waitForLoadState("load").catch(() => {});
		// `quietMs` outlasts the console's one query retry (TanStack's first retry waits ~1 s).
		await waitStill(page, { minMs: 2_000, quietMs: 2_500, capMs: 12_000 });
		const cold: FailedPhase = { phase: "cold load", snapshot: await snapshotRegion(page), failed };
		await context.clock.fastForward(B4_STALE_JUMP_MS);
		await page.evaluate(() => {
			document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
			window.dispatchEvent(new Event("focus"));
		});
		await waitStill(page, { minMs: 3_000, quietMs: 2_500, capMs: 12_000 });
		const stale: FailedPhase = { phase: "stale refetch", snapshot: await snapshotRegion(page), failed };
		return [cold, stale];
	} finally {
		await context.close();
	}
}

/** Load `url` with ONE read answered 500 and every other read answered normally (B5). */
export async function loadWithOneFailure(context: BrowserContext, url: string, key: string): Promise<RegionSnapshot> {
	const { page } = await openTracked(context);
	try {
		const pathname = new URL(url, "http://placeholder.invalid").pathname;
		await page.route(readCarrier(pathname), async (route) => {
			if (readKey(route.request()) !== key) return route.fallback();
			await failRead(route);
		});
		await page.goto(url, { waitUntil: "domcontentloaded" });
		await page.waitForLoadState("load").catch(() => {});
		await waitStill(page, { minMs: 2_000, quietMs: 2_500, capMs: 10_000 });
		return await snapshotRegion(page);
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
 */
export function judgeB1(answered: AnsweredLoad, held: HeldLoad): BVerdict {
	const differs = differences(answered.snapshot, held.snapshot);
	const evidence = {
		differs,
		held: held.held,
		answered: summary(answered.snapshot),
		heldRender: summary(held.snapshot),
		onlyAnswered: onlyIn(answered.snapshot.texts, held.snapshot.texts),
		onlyHeld: onlyIn(held.snapshot.texts, answered.snapshot.texts),
	};
	if (!answered.settled) return { verdict: "NOT MEASURED", reason: NOT_SETTLED, evidence };
	if (differs.length > 0) return { verdict: "FAIL", evidence };
	if (answered.snapshot.empty > 0 && held.held.length > 0) return { verdict: "NOT MEASURED", reason: ANSWERED_EMPTY, evidence };
	return { verdict: "PASS", evidence };
}

/** B3: with every read held, no empty copy the answered render does not show. */
export function judgeB3(answered: AnsweredLoad, held: HeldLoad): BVerdict {
	const evidence = { heldEmpty: held.snapshot.empty, answeredEmpty: answered.snapshot.empty, held: held.held };
	if (!answered.settled) return { verdict: "NOT MEASURED", reason: NOT_SETTLED, evidence };
	if (held.snapshot.empty > answered.snapshot.empty) return { verdict: "FAIL", evidence };
	if (held.snapshot.empty === 0) return { verdict: "PASS", evidence };
	return held.held.length > 0 ? { verdict: "NOT MEASURED", reason: ANSWERED_EMPTY, evidence } : { verdict: "PASS", evidence };
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
export function judgeB4(answered: AnsweredLoad, phases: readonly FailedPhase[]): BVerdict {
	const results = phases.map((p) => ({ phase: p.phase, failed: p.failed, problems: failureProblems(answered.snapshot, p.snapshot), render: summary(p.snapshot) }));
	const evidence = { phases: results, answered: summary(answered.snapshot) };
	if (!answered.settled) return { verdict: "NOT MEASURED", reason: NOT_SETTLED, evidence };
	if (results.some((r) => r.problems.length > 0)) return { verdict: "FAIL", evidence };
	const failedAny = phases.some((p) => p.failed > 0);
	const errorShown = phases.some((p) => p.snapshot.errors > answered.snapshot.errors);
	if (answered.snapshot.empty > 0 && failedAny && !errorShown) return { verdict: "NOT MEASURED", reason: ANSWERED_EMPTY, evidence };
	return { verdict: "PASS", evidence };
}

/** B5's per-read observation: what the region kept when this one read failed. */
export interface OneFailure {
	key: string;
	snapshot: RegionSnapshot;
}

/**
 * B5: no single page read's failure blanks every region. A page with at most one read of its own
 * has no sibling region for one failure to take down, and passes on that structure — the evidence
 * says so rather than leaving a bare PASS.
 */
export function judgeB5(answered: AnsweredLoad, pageReads: readonly string[], shellReads: readonly string[], failures: readonly OneFailure[]): BVerdict {
	const blanked = failures.filter((f) => answered.snapshot.leaves > 0 && f.snapshot.leavesOutsideErrors === 0).map((f) => readLabel(f.key));
	const evidence = {
		pageReads,
		shellReads,
		blanked,
		kept: failures.map((f) => ({ read: f.key, leavesOutsideErrors: f.snapshot.leavesOutsideErrors, errors: f.snapshot.errors })),
	};
	if (!answered.settled) return { verdict: "NOT MEASURED", reason: NOT_SETTLED, evidence };
	if (pageReads.length > B5_READ_CAP) {
		return {
			verdict: "NOT MEASURED",
			reason: `over-read-budget — the route makes ${pageReads.length} reads of its own and B5 fails at most ${B5_READ_CAP} one at a time`,
			evidence,
		};
	}
	if (pageReads.length <= 1) return { verdict: "PASS", evidence: { ...evidence, single: true } };
	return { verdict: blanked.length > 0 ? "FAIL" : "PASS", evidence };
}

/** The reads every route under the same shells makes — the shell's, not the page's. */
export function shellReadsFor(
	route: string,
	chains: ReadonlyMap<string, string>,
	readsByRoute: ReadonlyMap<string, readonly string[]>,
	entries: ReadonlyMap<string, string> = new Map(),
	workers: (key: string) => ReadonlySet<string> | null = workersOf,
): string[] {
	const chain = chains.get(route);
	const peers = [...readsByRoute.keys()].filter((r) => chains.get(r) === chain);
	// STRUCTURAL FIRST. The build's server-reference manifest says which page entries reference each
	// action; one that EVERY page under the same shells references lives in those shells (a layout's
	// client graph is bundled into every page beneath it). That needs no run to have caught the read —
	// the intersection below misses a shell poll that happened not to fire on one route, and then
	// calls it the page's. Measured on the first run: seven "page reads" on the jobs slice, all shell.
	const chainEntries = [...chains].filter(([, c]) => c === chain).map(([r]) => entries.get(r)).filter((e): e is string => e !== undefined);
	const structural = new Set<string>();
	if (chainEntries.length > 0) {
		for (const key of readsByRoute.get(route) ?? []) {
			const w = workers(key);
			if (w !== null && chainEntries.every((e) => w.has(e))) structural.add(key);
		}
	}
	// Fewer than three routes under one chain cannot separate a page read from a shell read, so the
	// intersection widens to every measured route: whatever EVERY route reads is the outer shell's.
	const pool = peers.length >= 3 ? peers : [...readsByRoute.keys()];
	const [first, ...rest] = pool;
	if (first === undefined) return [];
	const common = new Set(readsByRoute.get(first) ?? []);
	for (const r of rest) {
		const reads = new Set(readsByRoute.get(r) ?? []);
		for (const k of [...common]) if (!reads.has(k)) common.delete(k);
	}
	return [...new Set([...common, ...structural])].sort();
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
	/** A large bordered or filled block — what B2's column count reads. */
	block: boolean;
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
	const score = outlineShift(s, f, B_VIEWPORT);
	const columns = { skeleton: columnCount(outcome.skeleton.filter((c) => c.block).map((c) => c.box)), final: columnCount(outcome.final.filter((c) => c.block).map((c) => c.box)) };
	const evidence = { score: Number(score.toFixed(4)), budget: B2_BUDGET, columns, outline: { skeleton: s, final: f }, prefetched: outcome.prefetched };
	// A column mismatch is a question about SIDE-BY-SIDE blocks, so it is asked only when one frame has
	// two or more. One filled skeleton box over a page with no bordered block (a canvas, plain text)
	// is not a column count disagreeing — measured on the first run, it failed the canvas and the CLI
	// hand-off for a frame whose outline matched.
	const columnsDisagree = Math.max(columns.skeleton, columns.final) >= 2 && columns.skeleton !== columns.final;
	return { verdict: score > B2_BUDGET || columnsDisagree ? "FAIL" : "PASS", evidence };
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
			return { box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, block: (bordered || filled) && r.height >= 64 && r.width >= width * 0.2 };
		};
		const captured: { i: number; box: { x: number; y: number; w: number; h: number }; block: boolean }[] = [];
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
		// Two frames, so the fallback has painted rather than merely mounted.
		await page.waitForTimeout(400);
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

/** The fixture modes, each named for the defect it carries (or `prefetched`, which carries none). */
export type BControlMode =
	| "prefetched"
	| "client-fetch"
	| "empty-while-pending"
	| "empty-on-error"
	| "endless-skeleton"
	| "two-regions-contained"
	| "two-regions-blanked"
	| "swap-matching"
	| "swap-columns"
	| "swap-shifted";

/**
 * One fixture page, every mode. Plain DOM in the slots the console renders — `data-slot="skeleton"`,
 * `aria-busy`, `role="alert"`, table rows — and reads over the read router's own URL shape, so the
 * loaders intercept them exactly as they intercept a console page's. `window.next.router` is a
 * stand-in with the two methods B2 calls; its push paints a skeleton, then fetches the route's data
 * the way the App Router does (`RSC: 1`), so the hold-and-release in `measureSkeletonSwap` is
 * exercised for real.
 */
export const B_CONTROL_FIXTURE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>behaviour control</title>
<style>body{margin:0;font:14px sans-serif}main{display:block;padding:16px}.sk{height:16px;width:240px;background:#ddd;margin:8px 0}.frame{border:1px solid #999;height:400px}</style></head>
<body><main><div id="region">__SSR__</div><div id="region-b">__SSR_B__</div></main>
<script>
var MODE = "__MODE__";
var SKELETON = '<div data-slot="skeleton" class="sk"></div><div data-slot="skeleton" class="sk"></div>';
var EMPTY = '<p>No results.</p>';
var ERROR = '<div role="alert">Couldn\\'t load these rows</div>';
function rows(names) { return '<table><tbody>' + names.map(function (n) { return '<tr><td>' + n + '</td></tr>'; }).join('') + '</tbody></table>'; }
function read(name) { return fetch('/acme/~/rpc/fixture/' + name).then(function (r) { if (!r.ok) throw new Error('read failed'); return r.json(); }); }
function set(id, html, busy) { var el = document.getElementById(id); el.innerHTML = html; if (busy) el.setAttribute('aria-busy', 'true'); else el.removeAttribute('aria-busy'); }
if (MODE === "client-fetch" || MODE === "empty-while-pending" || MODE === "endless-skeleton") {
	read('rows').then(function (b) { set('region', rows(b.json), false); }, function () { if (MODE !== "endless-skeleton") set('region', ERROR, false); });
}
if (MODE === "prefetched" || MODE === "empty-on-error") {
	read('aux').then(function () {}, function () {});
	setTimeout(function () { read('rows').then(function () {}, function () { set('region', MODE === "empty-on-error" ? EMPTY : ERROR, false); }); }, 30000);
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
	var FRAME = '<div class="frame"><div data-slot="skeleton" class="sk" style="margin:16px"></div></div>';
	var FINAL = MODE === "swap-columns"
		? '<div style="display:flex;gap:16px"><div class="frame" style="flex:1"><p>alpha</p></div><div class="frame" style="flex:1"><p>beta</p></div></div>'
		: MODE === "swap-shifted"
			? '<div class="frame" style="margin-top:160px"><p style="margin:16px">alpha</p></div>'
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

/** What each mode renders on the server, before any script runs. */
function ssrFor(mode: BControlMode): { a: string; b: string } {
	const rows = "<table><tbody><tr><td>alpha</td></tr><tr><td>beta</td></tr></tbody></table>";
	const skeleton = '<div data-slot="skeleton" class="sk"></div><div data-slot="skeleton" class="sk"></div>';
	if (mode === "prefetched" || mode === "empty-on-error") return { a: rows, b: "" };
	if (mode === "empty-while-pending") return { a: "<p>No results.</p>", b: "" };
	if (mode === "client-fetch" || mode === "endless-skeleton") return { a: `<div aria-busy="true">${skeleton}</div>`, b: "" };
	if (mode === "two-regions-contained" || mode === "two-regions-blanked") return { a: skeleton, b: skeleton };
	return { a: "<p>origin page</p>", b: "" };
}

/** Serve every fixture mode, and its reads, on one context. */
export async function serveBehaviourControl(context: BrowserContext): Promise<void> {
	await context.route(`${B_CONTROL_ORIGIN}/**`, (route) => {
		const { pathname } = new URL(route.request().url());
		if (pathname.includes(RPC_MARKER)) {
			return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ json: ["alpha", "beta"], meta: [] }) });
		}
		const mode = pathname.split("/")[4] ?? "prefetched";
		const known: readonly string[] = [
			"prefetched", "client-fetch", "empty-while-pending", "empty-on-error", "endless-skeleton",
			"two-regions-contained", "two-regions-blanked", "swap-matching", "swap-columns", "swap-shifted",
		];
		const m: BControlMode = isControlMode(mode, known) ? mode : "prefetched";
		const ssr = ssrFor(m);
		return route.fulfill({
			status: 200,
			contentType: "text/html; charset=utf-8",
			body: B_CONTROL_FIXTURE.replace("__MODE__", m).replace("__SSR__", ssr.a).replace("__SSR_B__", ssr.b),
		});
	});
}

/** Narrow a path segment to a fixture mode. */
function isControlMode(value: string, known: readonly string[]): value is BControlMode {
	return known.includes(value);
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
	const expectVerdict = (id: BControlResult["broken"][number], mode: BControlMode, got: BVerdict, want: "PASS" | "FAIL") => {
		if (got.verdict !== want) {
			broken.add(id);
			lines.push(`${id} on the \`${mode}\` fixture: expected ${want}, got ${got.verdict}${got.verdict === "NOT MEASURED" ? ` (${got.reason})` : ""}`);
		}
	};
	try {
		const measure = async (mode: BControlMode) => {
			const url = controlUrl(mode);
			const answered = await loadAnswered(context, url);
			const held = await loadHeld(context, url);
			const failed = await loadFailed(newContext, url);
			return { b1: judgeB1(answered, held), b3: judgeB3(answered, held), b4: judgeB4(answered, failed) };
		};
		const good = await measure("prefetched");
		expectVerdict("B1", "prefetched", good.b1, "PASS");
		expectVerdict("B3", "prefetched", good.b3, "PASS");
		expectVerdict("B4", "prefetched", good.b4, "PASS");
		const client = await measure("client-fetch");
		expectVerdict("B1", "client-fetch", client.b1, "FAIL");
		expectVerdict("B3", "client-fetch", client.b3, "PASS");
		expectVerdict("B4", "client-fetch", client.b4, "PASS");
		expectVerdict("B3", "empty-while-pending", (await measure("empty-while-pending")).b3, "FAIL");
		expectVerdict("B4", "empty-on-error", (await measure("empty-on-error")).b4, "FAIL");
		expectVerdict("B4", "endless-skeleton", (await measure("endless-skeleton")).b4, "FAIL");

		for (const [mode, want] of [["two-regions-contained", "PASS"], ["two-regions-blanked", "FAIL"]] as const) {
			const url = controlUrl(mode);
			const answered = await loadAnswered(context, url);
			const failures: OneFailure[] = [];
			for (const key of answered.reads) failures.push({ key, snapshot: await loadWithOneFailure(context, url, key) });
			expectVerdict("B5", mode, judgeB5(answered, answered.reads, [], failures), want);
		}

		for (const [mode, want] of [["swap-matching", "PASS"], ["swap-columns", "FAIL"], ["swap-shifted", "FAIL"]] as const) {
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
