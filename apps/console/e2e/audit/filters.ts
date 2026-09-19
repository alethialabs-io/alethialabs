// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// F8–F10 — THE FILTER STANDARD, OBSERVED IN A BROWSER (#4278).
//
// F1–F7 read the standard off the tree. What they cannot read is what the bar DOES: whether a facet
// you pick reaches the URL and comes back from it, whether the counts beside the options hold still
// while you filter, whether the search box asks the server once or six times. This module is the
// measurement; `filters.spec.ts` owns the route loop, the seeding and the recording.
//
//   F8  apply the first facet option → one of the surface's own URL params appears → the URL, opened
//       in a FRESH TAB, restores the selection and the narrowed list → Reset clears every param the
//       surface writes and the count returns to the full count.
//   F9  every option of that facet carries the same count, and the option set is the same, before
//       and after the option is applied — F7's unfiltered facet pass, observed end to end.
//   F10 six keystrokes into the search box → the data requests carrying the search within 500 ms of
//       the last one carry at most ONE distinct search value; the nonsense token then renders
//       `[data-slot="empty"]` inside `main` and no hand-rolled "No results" outside it.
//
// ── WHAT IT CAN AND CANNOT SEE ─────────────────────────────────────────────────────────────────
//
// The reload in F8 is a FRESH TAB, deliberately. `createFilterStore` persists to sessionStorage and
// sessionStorage survives a same-tab reload, so a same-tab reload would pass on a page whose URL
// hydration is broken — the store would restore the selection and rewrite the URL from it. A new
// tab has its own sessionStorage, so the only thing that can restore the view there is the URL,
// which is the claim F8 makes ("a filtered view is linkable").
//
// A facet is found by its COUNT. Every shared facet primitive in `@repo/ui` renders an option's count
// through `CountFigure` (`data-slot="count-figure"`), and nothing else in a console page does — so
// "a button carrying a numeric count figure" is the one shape FacetFilter, FilterChip, MultiCombobox
// and FunnelFilter all share. A bar whose options show no counts is therefore not found, and the
// route is NOT MEASURED naming that, never PASS. F8 and F9 drive the FIRST option that narrows, of
// the FIRST facet found that has one; they do not claim every facet. When no facet found offers an
// option narrower than the full list, or the list does not actually narrow once the option is
// applied, BOTH are NOT MEASURED with the counts — never PASS, because with the list unchanged F9's
// comparison and F8's restore and reset steps cannot fail. `measureRoundTrip` enforces it, and the
// control's `one-kind` arm proves it on a bar that would otherwise have passed F9 vacuously.
//
// F10's "data request" is a request whose POST BODY carries the typed token (a server action's
// arguments) or a non-RSC fetch whose URL does. The App Router's RSC refetch — which
// `useFilterUrlSync`'s per-keystroke `router.replace` provokes — is COUNTED in the evidence and is
// not the debounce's question. And a server action POSTs to the CURRENT page URL, which after the
// first keystroke carries `?search=…`: matching on the URL would count every unrelated poll on the
// page as a search request, so a POST is matched on its body alone.
//
// The verdict counts DISTINCT search values, not requests. A page that polls (the jobs list refetches
// every 5 s while anything is active) can send a second request carrying the already-debounced value
// inside the window; that is the same value twice, not a per-keystroke fetch. A request per
// keystroke carries a different prefix each time — `zqx`, `zqxv`, … — so it still reads as several.
// The raw request count stays in the evidence.
//
// Nothing here presses a confirm or submits a form: the only things activated are facet options,
// the openers that show them, the search input and the bar's own Reset.

import { execFileSync } from "node:child_process";
import path from "node:path";
import type { BrowserContext, Page, Request } from "@playwright/test";

import { repoRoot } from "./manifest";

// ── the subject set, derived ────────────────────────────────────────────────────────────────────

/** One URL param a surface writes — `scripts/check-filter-standard.mjs`'s `deriveUrlParams`. */
export interface UrlParam {
	key: string;
	param: string;
	array: boolean;
}

/** One filter surface a route owns, with the params its `useFilterUrlSync` call writes. */
export interface OwnedSurface {
	symbol: string;
	params: UrlParam[];
	searchParam: string | null;
}

/** One manifest route and the surfaces it owns — empty for a page that is not a list page. */
export interface FilterRoute {
	route: string;
	isRedirectOnly: boolean;
	surfaces: OwnedSurface[];
}

/** `audit-report.mjs --filter-surfaces`. */
export interface SubjectSet {
	version: number;
	surfaces: number;
	routes: FilterRoute[];
}

/**
 * The fewest surfaces the derivation may produce. Fifteen `createFilterStore` call sites exist on
 * `dev` today; a derivation that finds fewer has stopped reading the console, and a live pass over a
 * shrunken subject set reports a clean board about pages it never asked.
 */
export const SURFACE_FLOOR = 15;

/** Narrowed, never cast — CLAUDE.md §6. */
function isUrlParam(v: unknown): v is UrlParam {
	return typeof v === "object" && v !== null && "key" in v && typeof v.key === "string" && "param" in v && typeof v.param === "string" && "array" in v && typeof v.array === "boolean";
}

/** Narrowed, never cast. */
function isSubjectSet(v: unknown): v is SubjectSet {
	if (typeof v !== "object" || v === null) return false;
	if (!("version" in v) || v.version !== 1 || !("surfaces" in v) || typeof v.surfaces !== "number") return false;
	if (!("routes" in v) || !Array.isArray(v.routes)) return false;
	return v.routes.every(
		(r: unknown) =>
			typeof r === "object" &&
			r !== null &&
			"route" in r &&
			typeof r.route === "string" &&
			"surfaces" in r &&
			Array.isArray(r.surfaces) &&
			r.surfaces.every(
				(s: unknown) =>
					typeof s === "object" && s !== null && "symbol" in s && typeof s.symbol === "string" && "params" in s && Array.isArray(s.params) && s.params.every(isUrlParam),
			),
	);
}

/**
 * The live subject set, from `apps/console/scripts/audit-report.mjs --filter-surfaces`.
 *
 * A child process, for the reason `manifest.ts` gives: the generator is ESM and a spec is CJS. It
 * RAISES — on a failed child, on a shape it was not written against, and below the surface floor —
 * rather than returning an empty set, which the spec would score as a console with no list pages.
 */
export function subjectSet(): SubjectSet {
	const generator = path.join(repoRoot(), "apps", "console", "scripts", "audit-report.mjs");
	let raw: string;
	try {
		raw = execFileSync(process.execPath, [generator, "--filter-surfaces"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
	} catch (err) {
		throw new Error(`the filter-surface subject set could not be produced, so F8–F10 have nothing to measure and MUST NOT guess.\n  seam: ${generator} --filter-surfaces\n  ${String(err)}`);
	}
	const parsed: unknown = JSON.parse(raw);
	if (!isSubjectSet(parsed)) throw new Error(`${generator} --filter-surfaces did not produce a subject set: ${raw.slice(0, 200)}`);
	if (parsed.surfaces < SURFACE_FLOOR) {
		throw new Error(`the subject set derives ${parsed.surfaces} filter surface(s), under the floor of ${SURFACE_FLOOR}. The derivation has stopped reading the console; a live pass over it would report pages it never asked.`);
	}
	return parsed;
}

// ── the outcome of one predicate on one route ───────────────────────────────────────────────────

/** What one predicate concluded. `na` and `not-measured` are different claims and never share a column. */
export type Outcome =
	| { kind: "verdict"; verdict: "PASS" | "FAIL"; evidence: unknown }
	| { kind: "not-measured"; reason: string; evidence?: unknown }
	| { kind: "na"; reason: "not-a-list-page" | "no-search-field" };

/** F8–F10 for one route. */
export interface RouteOutcome {
	F8: Outcome;
	F9: Outcome;
	F10: Outcome;
}

/** Below this many rows a filter narrows nothing, and F8/F9 are not askable. */
export const MIN_ROWS = 2;

/** Six keystrokes — the issue's number, and one more than a five-letter word a list might contain. */
export const SEARCH_TOKEN = "zqxvjk";

/** How long after the LAST keystroke requests are still counted. */
export const DEBOUNCE_WINDOW_MS = 500;

/** The first three characters: a per-keystroke fetch sends four requests carrying at least this much. */
const TOKEN_PREFIX = SEARCH_TOKEN.slice(0, 3);

// ── reading the page ────────────────────────────────────────────────────────────────────────────

/** How a list's size was read. `empty` is the shared empty state with no rows beside it. */
export interface ListCount {
	source: "count-pill" | "rows" | "empty" | "none";
	value: number | null;
}

/**
 * The list's size: the count pill when the page has one, otherwise its table rows.
 *
 * The pill first, because it is the standard's own answer to "how many results" (F5); the rows are
 * the fallback for the pages F5 already fails, and the evidence says which one was read.
 */
export async function readListCount(page: Page): Promise<ListCount> {
	return page.evaluate(() => {
		const main = document.querySelector("main");
		if (main === null) return { source: "none" as const, value: null };
		const shown = (el: Element) => {
			const r = el.getBoundingClientRect();
			return r.width > 0 && r.height > 0;
		};
		const pill = [...main.querySelectorAll('[data-slot="count-pill"]')].find(shown);
		const digits = pill?.textContent?.replace(/[^\d]/g, "") ?? "";
		if (pill !== undefined && digits !== "") return { source: "count-pill" as const, value: Number(digits) };
		const table = [...main.querySelectorAll("table")].find(shown);
		if (table !== undefined) {
			const rows = [...table.querySelectorAll("tbody tr")].filter((tr) => shown(tr) && tr.querySelectorAll("td").length > 1 && tr.querySelector('[data-slot="empty"]') === null);
			return { source: "rows" as const, value: rows.length };
		}
		const empty = [...main.querySelectorAll('[data-slot="empty"]')].find(shown);
		if (empty !== undefined) return { source: "empty" as const, value: 0 };
		return { source: "none" as const, value: null };
	});
}

/**
 * Wait until the list stops moving: two identical reads 300 ms apart, after at least 600 ms, for at
 * most `budgetMs`. A list still moving when the budget runs out is returned as read — the caller's
 * comparison then fails on it, which is the honest outcome for a page that never settled.
 */
export async function settle(page: Page, budgetMs = 8_000): Promise<ListCount> {
	const start = Date.now();
	await page.waitForTimeout(600);
	let last = await readListCount(page);
	while (Date.now() - start < budgetMs) {
		await page.waitForTimeout(300);
		const next = await readListCount(page);
		if (next.source === last.source && next.value === last.value) return next;
		last = next;
	}
	return last;
}

/** One facet option as rendered: its label, its count, and whether it is selected. */
export interface FacetOption {
	index: number;
	label: string;
	count: number;
	pressed: boolean;
	inMain: boolean;
}

/**
 * Mark every VISIBLE facet option on the page with `data-filter-option=<index>` and describe it.
 *
 * An option is the nearest button, `role=option` or `command-item` around a `count-figure` whose
 * text is a number — see the header for why the count is the anchor. The count pill beside a
 * heading is `data-slot="count-pill"`, a different slot, and is never read as an option.
 */
export async function markFacetOptions(page: Page): Promise<FacetOption[]> {
	return page.evaluate(() => {
		for (const el of document.querySelectorAll("[data-filter-option]")) el.removeAttribute("data-filter-option");
		const shown = (el: Element) => {
			const r = el.getBoundingClientRect();
			return r.width > 0 && r.height > 0;
		};
		const out: { index: number; label: string; count: number; pressed: boolean; inMain: boolean }[] = [];
		const seen = new Set<Element>();
		for (const fig of document.querySelectorAll('[data-slot="count-figure"]')) {
			const text = (fig.textContent ?? "").trim();
			if (!/^\d[\d,]*$/.test(text) || !shown(fig)) continue;
			const option = fig.closest('button, [role="option"], [data-slot="command-item"]');
			if (option === null || seen.has(option) || !shown(option)) continue;
			seen.add(option);
			const index = out.length;
			option.setAttribute("data-filter-option", String(index));
			const full = (option instanceof HTMLElement ? option.innerText : option.textContent ?? "").trim();
			const label = full.replace(new RegExp(`\\s*${text}\\s*$`), "").replace(/\s+/g, " ").trim() || full;
			const pressed =
				option.getAttribute("aria-pressed") === "true" ||
				option.getAttribute("aria-selected") === "true" ||
				option.getAttribute("data-checked") === "true" ||
				option.querySelector("svg.lucide-check") !== null;
			out.push({ index, label, count: Number(text.replace(/,/g, "")), pressed, inMain: option.closest("main") !== null });
		}
		return out;
	});
}

/**
 * Mark the controls that can reveal a facet's options — popover triggers, `aria-haspopup` buttons and
 * text-entry inputs (`role=combobox`, `type=search`/`text`, or no type) in `main` — with
 * `data-filter-opener=<index>`, and return how many there are. A checkbox, radio or switch built on
 * `input` is never one: the selector names the text-entry types, so clicking an opener cannot toggle
 * a setting.
 *
 * NOTHING INSIDE A TABLE, A ROW, A DIALOG OR A FORM. A row's action menu is an `aria-haspopup` button
 * too, and the popover it opens can hold a confirm; a filter bar is never inside any of the four.
 * Re-marked before every use, in document order, so an index survives a re-render or a fresh load.
 */
async function markOpeners(page: Page): Promise<number> {
	return page.evaluate(() => {
		for (const el of document.querySelectorAll("[data-filter-opener]")) el.removeAttribute("data-filter-opener");
		const main = document.querySelector("main");
		if (main === null) return 0;
		let n = 0;
		for (const el of main.querySelectorAll('[data-slot="popover-trigger"], button[aria-haspopup], input[role="combobox"], input[type="search"], input[type="text"], input:not([type])')) {
			if (el.closest('table, [role="row"], [role="dialog"], [role="alertdialog"], form') !== null) continue;
			const r = el.getBoundingClientRect();
			if (r.width === 0 || r.height === 0) continue;
			el.setAttribute("data-filter-opener", String(n));
			n += 1;
		}
		return n;
	});
}

/** How many openers one route may try before the bar is reported as not found. */
const OPENER_BUDGET = 12;

/** Close whatever the last step opened, without activating anything. */
async function closeOverlays(page: Page): Promise<void> {
	await page.keyboard.press("Escape").catch(() => {});
	await page.evaluate(() => {
		const active = document.activeElement;
		if (active instanceof HTMLElement) active.blur();
	});
	await page.waitForTimeout(150);
}

/** Where a facet was found: always visible (chips), or behind the Nth opener, maybe one panel deep. */
export interface FacetProbe {
	opener: number | null;
	descend: boolean;
}

/**
 * Reveal a probe's options again. Returns false when the opener is gone, or when asked to descend
 * through an opener that is not a `FunnelFilter`.
 *
 * The descent clicks the FIRST button of the panel that opened, so it is allowed only behind the
 * funnel's own trigger (its `SlidersHorizontal` icon): that panel lists facets, and nothing else in
 * the console guarantees its first button is not an action.
 */
async function openProbe(page: Page, probe: FacetProbe): Promise<boolean> {
	if (probe.opener === null) return true;
	if (probe.opener >= (await markOpeners(page))) return false;
	const opener = page.locator(`[data-filter-opener="${probe.opener}"]`);
	if (probe.descend && (await opener.locator("svg.lucide-sliders-horizontal").count()) === 0) return false;
	await opener.click({ timeout: 2_000 }).catch(() => {});
	await page.waitForTimeout(350);
	if (probe.descend) {
		const panelButton = page.locator('[data-slot="popover-content"] button').first();
		if ((await panelButton.count()) === 0) return false;
		await panelButton.click({ timeout: 2_000 }).catch(() => {});
		await page.waitForTimeout(350);
	}
	return true;
}

/** Whether a facet offers an unselected option that would NARROW a list of `full` rows. */
function narrows(options: readonly FacetOption[], full: number | null): boolean {
	return options.some((o) => !o.pressed && o.count > 0 && full !== null && o.count < full);
}

/**
 * Find the facet to drive and leave its options OPEN and marked.
 *
 * Chips first — they need no opener. Then each opener in turn, and one panel deep for a
 * `FunnelFilter`, whose first panel lists facets rather than options. The first facet with an option
 * that NARROWS the list wins — an author facet on a one-author org selects every row and proves
 * nothing about the round trip. Failing that, the first facet with any option at all is returned so
 * the caller can report WHY nothing was measured; `measureRoundTrip` never applies a non-narrowing
 * option. Returns null when nothing in the budget revealed a counted option.
 */
export async function discoverFacet(page: Page, full: number | null): Promise<{ probe: FacetProbe; options: FacetOption[] } | null> {
	const always = (await markFacetOptions(page)).filter((o) => o.inMain);
	if (narrows(always, full)) return { probe: { opener: null, descend: false }, options: always };
	let fallback: FacetProbe | null = always.some((o) => !o.pressed) ? { opener: null, descend: false } : null;
	const n = Math.min(await markOpeners(page), OPENER_BUDGET);
	for (let i = 0; i < n; i += 1) {
		for (const descend of [false, true]) {
			const probe = { opener: i, descend };
			if (!(await openProbe(page, probe))) continue;
			const options = await markFacetOptions(page);
			if (narrows(options, full)) return { probe, options };
			if (fallback === null && options.some((o) => !o.pressed)) fallback = probe;
			await closeOverlays(page);
		}
	}
	if (fallback === null) return null;
	// Re-open the fallback so its options are the ones marked, exactly as a narrowing find leaves them.
	if (!(await openProbe(page, fallback))) return null;
	const options = await markFacetOptions(page);
	return { probe: fallback, options: fallback.opener === null ? options.filter((o) => o.inMain) : options };
}

/** Every non-empty URL param among `params`, as `name=value`. */
function presentParams(url: string, params: readonly string[]): Map<string, string> {
	const search = new URL(url).searchParams;
	const out = new Map<string, string>();
	for (const p of params) {
		const v = search.get(p);
		if (v !== null && v !== "") out.set(p, v);
	}
	return out;
}

/** Poll `page.url()` for up to `ms` until `pred` holds. */
async function waitForUrl(page: Page, pred: (url: string) => boolean, ms = 3_000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (pred(page.url())) return true;
		await page.waitForTimeout(150);
	}
	return pred(page.url());
}

/** The bar's own "Reset · N" button, if it is showing. */
function resetButton(page: Page) {
	return page.locator("main button").filter({ hasText: /^\s*Reset\s*·\s*\d+\s*$/ }).first();
}

/** The steps F8 records, in the order they are driven. `null` = not reached. */
export interface RoundTripSteps {
	applied: boolean | null;
	survivedReload: boolean | null;
	restoredList: boolean | null;
	resetUrl: boolean | null;
	resetCount: boolean | null;
}

/**
 * F8 and F9 on one loaded, settled list page.
 *
 * `openPage` makes the fresh tab F8's reload happens in — injected so the positive control can serve
 * its fixture there too.
 */
export async function measureRoundTrip(
	page: Page,
	surfaces: readonly OwnedSurface[],
	full: ListCount,
	openPage: () => Promise<Page>,
): Promise<{ F8: Outcome; F9: Outcome }> {
	const allParams = [...new Set(surfaces.flatMap((s) => s.params.map((p) => p.param)))];
	const facetParams = [...new Set(surfaces.flatMap((s) => s.params.filter((p) => p.array).map((p) => p.param)))];
	const found = await discoverFacet(page, full.value);
	if (found === null) {
		const reason = "no facet option carrying a count was found in the bar — `CountFigure` is the anchor every shared facet primitive renders, and nothing revealed one";
		return { F8: { kind: "not-measured", reason }, F9: { kind: "not-measured", reason } };
	}
	const { probe } = found;
	const scope = probe.opener === null ? found.options.filter((o) => o.inMain) : found.options;
	// The first option that NARROWS. There is no fallback to one that does not: an option covering
	// every row leaves the list — and an in-memory facet pass — exactly as it was, so F9's before/after
	// comparison and F8's list-restore and reset-count steps would all hold whatever the bar does.
	const target = scope.find((o) => !o.pressed && o.count > 0 && full.value !== null && o.count < full.value);
	if (target === undefined) {
		await closeOverlays(page);
		const reason = "no option of the facet found narrowed the list — every unselected option with a count covers every row, so applying one could not tell a working bar from a broken one";
		const evidence = { full: full.value, options: scope.map((o) => ({ option: o.label, count: o.count, pressed: o.pressed })) };
		return { F8: { kind: "not-measured", reason, evidence }, F9: { kind: "not-measured", reason, evidence } };
	}
	const before = new Map(scope.map((o) => [o.label, o.count]));

	await page.locator(`[data-filter-option="${target.index}"]`).click({ timeout: 3_000 });
	await closeOverlays(page);
	const applied = await waitForUrl(page, (u) => presentParams(u, facetParams).size > 0);
	const param = [...presentParams(page.url(), facetParams).keys()][0] ?? null;
	const narrowed = await settle(page);

	// The option's count said it narrows; the list must agree before anything below can fail. A list
	// that did not move — a click that never landed, or a count source that ignores the filter — makes
	// F9's comparison and F8's restore/reset steps vacuous, so both are withheld with the reading.
	if (narrowed.value === null || full.value === null || narrowed.value >= full.value) {
		await closeOverlays(page);
		const reason = `the list did not narrow after the option "${target.label}" (count ${target.count}) was applied — ${full.value} before, ${narrowed.value} after, read from the ${narrowed.source} — so an unchanged facet or restored list would prove nothing`;
		const evidence = { option: target.label, optionCount: target.count, full: full.value, narrowed: narrowed.value, source: narrowed.source, applied, param };
		return { F8: { kind: "not-measured", reason, evidence }, F9: { kind: "not-measured", reason, evidence } };
	}

	// ── F9: the same facet's options, after ───────────────────────────────────────────────────
	let F9: Outcome;
	if (!(await openProbe(page, probe))) {
		F9 = { kind: "not-measured", reason: "the facet's opener was gone after the option was applied, so its counts could not be read again" };
	} else {
		const after = (await markFacetOptions(page)).filter((o) => probe.opener !== null || o.inMain);
		await closeOverlays(page);
		const afterMap = new Map(after.map((o) => [o.label, o.count]));
		const moved = [...before].filter(([label, count]) => afterMap.has(label) && afterMap.get(label) !== count).map(([label, count]) => ({ option: label, before: count, after: afterMap.get(label) }));
		const vanished = [...before.keys()].filter((label) => !afterMap.has(label));
		F9 = {
			kind: "verdict",
			verdict: moved.length === 0 && vanished.length === 0 ? "PASS" : "FAIL",
			evidence: { compared: before.size, moved, vanished, applied, option: target.label, full: full.value, narrowed: narrowed.value },
		};
	}

	// ── F8: the round trip ────────────────────────────────────────────────────────────────────
	const steps: RoundTripSteps = { applied, survivedReload: null, restoredList: null, resetUrl: null, resetCount: null };
	const counts: { full: number | null; narrowed: number | null; afterReload: number | null; afterReset: number | null } = {
		full: full.value,
		narrowed: narrowed.value,
		afterReload: null,
		afterReset: null,
	};
	if (applied && param !== null) {
		const value = presentParams(page.url(), [param]).get(param);
		const fresh = await openPage();
		try {
			await fresh.goto(page.url(), { waitUntil: "domcontentloaded" });
			const reloaded = await settle(fresh);
			counts.afterReload = reloaded.value;
			steps.survivedReload = presentParams(fresh.url(), [param]).get(param) === value;
			steps.restoredList = steps.survivedReload ? reloaded.value === narrowed.value : null;
			const reset = resetButton(fresh);
			if ((await reset.count()) === 0) {
				steps.resetUrl = false;
			} else {
				await reset.click({ timeout: 3_000 });
				steps.resetUrl = await waitForUrl(fresh, (u) => presentParams(u, allParams).size === 0);
				const afterReset = await settle(fresh);
				counts.afterReset = afterReset.value;
				steps.resetCount = afterReset.value === full.value;
			}
		} finally {
			await fresh.close();
		}
	}
	const passed = Object.values(steps).every((s) => s === true);
	return {
		F8: { kind: "verdict", verdict: passed ? "PASS" : "FAIL", evidence: { param, option: target.label, countSource: full.source, counts, steps } },
		F9,
	};
}

/** The shared search input: `@repo/ui`'s `FilterSearch` is an input beside a lucide search icon. */
function searchInput(page: Page) {
	return page.locator("main div:has(> svg.lucide-search) > input").first();
}

/** F10's debounce half: how many requests carried the token within the window, and how many distinct values. */
export interface DebounceReading {
	keystrokes: number;
	windowMs: number;
	dataRequests: number;
	distinctValues: string[];
	rscRequests: number;
}

/** The longest prefix of `SEARCH_TOKEN` (at least `TOKEN_PREFIX`) that `text` contains, or null. */
function carriedValue(text: string): string | null {
	for (let n = SEARCH_TOKEN.length; n >= TOKEN_PREFIX.length; n -= 1) {
		if (text.includes(SEARCH_TOKEN.slice(0, n))) return SEARCH_TOKEN.slice(0, n);
	}
	return null;
}

/**
 * Type the token one key at a time and count the requests that carried it.
 *
 * Classified as the header says: an RSC request (header `rsc: 1`, or `_rsc=` in its URL) is counted
 * apart; a POST counts only when its BODY carries the token; any other fetch counts when its URL
 * does. Each hit records the longest token prefix it carried, which is what the verdict compares.
 * Page navigations and static assets never carry it.
 */
export async function measureDebounce(page: Page): Promise<DebounceReading | null> {
	const input = searchInput(page);
	if ((await input.count()) === 0 || !(await input.isVisible())) return null;
	const hits: { at: number; rsc: boolean; value: string }[] = [];
	const onRequest = (req: Request) => {
		const url = req.url();
		const headers = req.headers();
		const rsc = headers.rsc === "1" || url.includes("_rsc=");
		const value = carriedValue(req.method() === "POST" ? (req.postData() ?? "") : url);
		if (value === null || req.resourceType() === "document") return;
		hits.push({ at: Date.now(), rsc, value });
	};
	page.on("request", onRequest);
	try {
		await input.click({ timeout: 3_000 });
		await input.fill("");
		const start = Date.now();
		await page.keyboard.type(SEARCH_TOKEN, { delay: 50 });
		const last = Date.now();
		await page.waitForTimeout(DEBOUNCE_WINDOW_MS);
		const inWindow = hits.filter((h) => h.at >= start && h.at <= last + DEBOUNCE_WINDOW_MS);
		const data = inWindow.filter((h) => !h.rsc);
		return {
			keystrokes: SEARCH_TOKEN.length,
			windowMs: DEBOUNCE_WINDOW_MS,
			dataRequests: data.length,
			distinctValues: [...new Set(data.map((h) => h.value))],
			rscRequests: inWindow.filter((h) => h.rsc).length,
		};
	} finally {
		page.off("request", onRequest);
	}
}

/**
 * F10's empty half: after a nonsense search, is there a `[data-slot="empty"]` inside `main`, and how
 * many hand-rolled "no results" messages sit outside it?
 *
 * A hand-rolled message is an element whose OWN text (its direct text nodes) reads like "No … found"
 * / "No results" / "No matches", visible, and not inside the shared empty state.
 */
export async function readEmptyState(page: Page): Promise<{ rendered: boolean; handRolledOutside: number }> {
	await page.locator('main [data-slot="empty"]').first().waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
	return page.evaluate(() => {
		const main = document.querySelector("main");
		if (main === null) return { rendered: false, handRolledOutside: 0 };
		const shown = (el: Element) => {
			const r = el.getBoundingClientRect();
			return r.width > 0 && r.height > 0;
		};
		const rendered = [...main.querySelectorAll('[data-slot="empty"]')].some(shown);
		let handRolledOutside = 0;
		for (const el of main.querySelectorAll("*")) {
			if (el.closest('[data-slot="empty"]') !== null || !shown(el)) continue;
			const own = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? "").join(" ").trim();
			if (/^no\b.{0,60}\b(results?|match(es)?|found)\b/i.test(own)) handRolledOutside += 1;
		}
		return { rendered, handRolledOutside };
	});
}

/**
 * F8–F10 for one route whose URL is already known. The page is left wherever it ended.
 *
 * @param openPage makes the fresh tab F8's reload happens in
 */
export async function measureRoute(page: Page, url: string, surfaces: readonly OwnedSurface[], openPage: () => Promise<Page>): Promise<RouteOutcome> {
	await page.goto(url, { waitUntil: "domcontentloaded" });
	const full = await settle(page);

	let F8: Outcome;
	let F9: Outcome;
	if (full.value === null) {
		const reason = "the page rendered no count pill, no table and no empty state in `main`, so there is no list size to narrow";
		F8 = { kind: "not-measured", reason };
		F9 = { kind: "not-measured", reason };
	} else if (full.value < MIN_ROWS) {
		const reason = `the list rendered ${full.value} row(s) (read from the ${full.source}); a filter over fewer than ${MIN_ROWS} narrows nothing — e2e/helpers/seed-filters.ts seeds no pair for this surface`;
		F8 = { kind: "not-measured", reason, evidence: { count: full } };
		F9 = { kind: "not-measured", reason, evidence: { count: full } };
	} else {
		({ F8, F9 } = await measureRoundTrip(page, surfaces, full, openPage));
	}

	let F10: Outcome;
	if (!surfaces.some((s) => s.searchParam !== null)) {
		F10 = { kind: "na", reason: "no-search-field" };
	} else {
		await page.goto(url, { waitUntil: "domcontentloaded" });
		await settle(page);
		const debounce = await measureDebounce(page);
		if (debounce === null) {
			F10 = {
				kind: "not-measured",
				reason: "the page's store declares a `search` filter and no `FilterSearch` input rendered in `main` — a tabbed or conditional bar this pass did not reach",
			};
		} else {
			const empty = await readEmptyState(page);
			const failed = debounce.distinctValues.length > 1 || !empty.rendered || empty.handRolledOutside > 0;
			F10 = { kind: "verdict", verdict: failed ? "FAIL" : "PASS", evidence: { debounce, empty } };
		}
	}
	return { F8, F9, F10 };
}

// ── the positive control ────────────────────────────────────────────────────────────────────────
//
// Four bars with KNOWN answers, plus the good one the first three are each one defect away from. The
// fourth, `one-kind`, gives every row the same facet value AND computes its counts in memory: no
// option can narrow it, so F8 and F9 must be NOT MEASURED there — a PASS would be the vacuous one
// (#4867's review), since an in-memory facet pass shows unchanged counts when nothing narrowed. The control
// runs before any route is scored, and `filters.spec.ts` withholds F8–F10 for the whole run if it is
// red — a verdict from an instrument already shown not to work is the #3804 failure.

/** The origin the fixtures are served from. Never resolved by DNS: `context.route()` answers it. */
export const CONTROL_ORIGIN = "http://filters-control.invalid";

/** The four fixture modes. Each bad one breaks exactly one predicate. */
export type ControlMode = "good" | "no-url" | "moving-counts" | "per-keystroke" | "one-kind";

/**
 * The fixture list page. Plain DOM, the SAME slots the real primitives render — a `count-pill`, chips
 * with `aria-pressed` and a `count-figure`, a search input beside `svg.lucide-search`, a "Reset · N"
 * button and a `data-slot="empty"` state — so the control exercises the matchers the routes use.
 */
export const CONTROL_FIXTURE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>filters control</title></head><body><main>
<div><div><svg class="lucide lucide-search" width="10" height="10"></svg><input aria-label="Search widgets" id="q" autocomplete="off"></div>
<div role="group" aria-label="Kind" id="chips"></div><span id="reset-slot"></span></div>
<h2>Widgets <span data-slot="count-pill" id="pill"></span></h2>
<table><thead><tr><th>Name</th><th>Kind</th></tr></thead><tbody id="rows"></tbody></table>
<div id="empty-slot"></div>
</main>
<script>
var MODE = "__MODE__";
var ROWS = [{ name: "alpha", kind: "a" }, { name: "beta", kind: "b" }, { name: "gamma", kind: "a" }];
if (MODE === "one-kind") ROWS = [{ name: "alpha", kind: "a" }, { name: "beta", kind: "a" }, { name: "gamma", kind: "a" }];
var p = new URLSearchParams(location.search);
var state = { kinds: (p.get("kinds") || "").split(",").filter(Boolean), search: p.get("search") || "" };
var timer = null;
function match(r) { return (state.kinds.length === 0 || state.kinds.indexOf(r.kind) >= 0) && (!state.search || r.name.indexOf(state.search) >= 0); }
function writeUrl() {
	if (MODE === "no-url") return;
	var q = new URLSearchParams();
	if (state.kinds.length) q.set("kinds", state.kinds.join(","));
	if (state.search) q.set("search", state.search);
	var s = q.toString();
	history.replaceState(null, "", s ? location.pathname + "?" + s : location.pathname);
}
function render() {
	var rows = ROWS.filter(match);
	document.getElementById("pill").textContent = String(rows.length);
	document.getElementById("rows").innerHTML = rows.map(function (r) { return "<tr><td>" + r.name + "</td><td>" + r.kind + "</td></tr>"; }).join("");
	var universe = MODE === "moving-counts" || MODE === "one-kind" ? rows : ROWS.filter(function (r) { return !state.search || r.name.indexOf(state.search) >= 0; });
	document.getElementById("chips").innerHTML = ["a", "b"].map(function (k) {
		var n = universe.filter(function (r) { return r.kind === k; }).length;
		if (MODE === "moving-counts" && n === 0) return "";
		return '<button type="button" data-kind="' + k + '" aria-pressed="' + (state.kinds.indexOf(k) >= 0) + '">Kind ' + k + ' <span data-slot="count-figure">' + n + "</span></button>";
	}).join("");
	var active = state.kinds.length + (state.search ? 1 : 0);
	document.getElementById("reset-slot").innerHTML = active > 0 ? '<button type="button" id="reset">Reset · ' + active + "</button>" : "";
	document.getElementById("empty-slot").innerHTML = rows.length === 0 ? '<div data-slot="empty">No widgets match these filters</div>' : "";
}
document.addEventListener("click", function (e) {
	var t = e.target instanceof Element ? e.target.closest("button") : null;
	if (!t) return;
	if (t.id === "reset") { state = { kinds: [], search: "" }; document.getElementById("q").value = ""; }
	else if (t.getAttribute("data-kind")) { var k = t.getAttribute("data-kind"); var i = state.kinds.indexOf(k); if (i >= 0) state.kinds.splice(i, 1); else state.kinds.push(k); }
	else return;
	writeUrl(); render();
});
document.getElementById("q").value = state.search;
document.getElementById("q").addEventListener("input", function (e) {
	state.search = e.target.value; writeUrl(); render();
	if (MODE === "per-keystroke") { fetch("/data", { method: "POST", body: JSON.stringify({ search: state.search }) }); return; }
	clearTimeout(timer);
	timer = setTimeout(function () { fetch("/data", { method: "POST", body: JSON.stringify({ search: state.search }) }); }, 300);
});
render();
</script></body></html>`;

/** Serve the fixture for one mode on a context, so a fresh tab (F8's reload) gets it too. */
export async function serveControl(context: BrowserContext, mode: ControlMode, fixture = CONTROL_FIXTURE): Promise<void> {
	await context.unroute(`${CONTROL_ORIGIN}/**`).catch(() => {});
	await context.route(`${CONTROL_ORIGIN}/**`, (route) => {
		if (new URL(route.request().url()).pathname === "/data") return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
		return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: fixture.replace("__MODE__", mode) });
	});
}

/** The surface the fixture declares — what `--filter-surfaces` would report for it. */
export const CONTROL_SURFACE: OwnedSurface = {
	symbol: "useWidgetFilters",
	params: [
		{ key: "search", param: "search", array: false },
		{ key: "kinds", param: "kinds", array: true },
	],
	searchParam: "search",
};

/** One arm's expectation, read off a measured outcome. */
function verdictOf(o: Outcome): string {
	return o.kind === "verdict" ? o.verdict : o.kind === "na" ? `N/A ${o.reason}` : `NOT MEASURED — ${o.reason}`;
}

/**
 * Drive `measureRoute()` over every fixture mode and return one line per arm that answered wrong.
 *
 * Every arm is asked in BOTH directions: the good bar must PASS all three, and each bad bar must FAIL
 * the one predicate it breaks. A control that only proves the PASS side is how an instrument that
 * cannot fail reads as working.
 *
 * @param fixture injectable so `predicate-selftest.spec.ts` can neuter one arm and see it named
 */
export async function filtersControl(page: Page, fixture = CONTROL_FIXTURE): Promise<string[]> {
	const context = page.context();
	const problems: string[] = [];
	const run = async (mode: ControlMode) => {
		await serveControl(context, mode, fixture);
		return measureRoute(page, `${CONTROL_ORIGIN}/list`, [CONTROL_SURFACE], () => context.newPage());
	};
	try {
		const good = await run("good");
		for (const id of ["F8", "F9", "F10"] as const) {
			if (verdictOf(good[id]) !== "PASS") problems.push(`the good bar reported ${id} ${verdictOf(good[id])}`);
		}
		const noUrl = await run("no-url");
		const noUrlF8 = noUrl.F8;
		if (!(noUrlF8.kind === "verdict" && noUrlF8.verdict === "FAIL")) problems.push(`the bar that never writes the URL reported F8 ${verdictOf(noUrlF8)}`);
		const moving = await run("moving-counts");
		if (!(moving.F9.kind === "verdict" && moving.F9.verdict === "FAIL")) problems.push(`the bar whose counts move reported F9 ${verdictOf(moving.F9)}`);
		const chatty = await run("per-keystroke");
		if (!(chatty.F10.kind === "verdict" && chatty.F10.verdict === "FAIL")) problems.push(`the bar that fetches per keystroke reported F10 ${verdictOf(chatty.F10)}`);
		const oneKind = await run("one-kind");
		for (const id of ["F8", "F9"] as const) {
			if (oneKind[id].kind !== "not-measured") problems.push(`the bar whose facet cannot narrow reported ${id} ${verdictOf(oneKind[id])}`);
		}
	} finally {
		await context.unroute(`${CONTROL_ORIGIN}/**`).catch(() => {});
	}
	return problems;
}
