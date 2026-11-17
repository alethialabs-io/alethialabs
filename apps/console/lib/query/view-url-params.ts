// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The URL codec for VIEW state: which overlay is open and which step of a wizard is on screen.
//
// It sits beside `filter-url-codec.ts` and is built on the same `ParamReader`, for the same
// reason that file gives: a server component and a client hook must decode a link identically,
// so the decode lives once, with no React and no `"use client"`. Filters answer "which rows";
// these params answer "which part of the page" — a link, a refresh or Back should reproduce
// both, and neither needs a second URL mechanism.
//
// Two shapes, and the difference is whether the wizard IS the page:
//   page wizard     ?step=<id>
//   overlay wizard  ?wizard=<id>&step=<id>     — the overlay is open exactly while ?wizard= names it
//
// A value is accepted only when it is a short identifier (letters, digits, `-`, `_`). Anything
// else reads as absent, so a hand-edited link can select a step or an overlay and nothing more.
//
// A LIST page has three more pieces of view state, and they are decoded here for the same reason
// (#6814):
//   ?page=<n>          which page of the rows, 1-based; the first page is the absent param
//   ?selected=<id>     which row is open beside the list (a detail pane or sheet)
//   ?range=<value>     the time window, on a page that keeps it out of its filter store
//
// None of them is a filter-store key: a page number and a selected row mean something only for
// the filters they were chosen under, so `useFilterUrlSync` is told to drop them when a filter
// changes (`resetParams`), and neither counts on "Reset · N". Every decoder is total — an
// unreadable value is the default view, never an error and never a view nobody chose.

import type { ParamReader } from "@/lib/query/filter-url-codec";
import { parseRangeFilter, type RangeFilter } from "@/lib/query/range-filter";

/** The param naming the open overlay wizard. */
export const WIZARD_PARAM = "wizard";

/** The param naming the step on screen. */
export const STEP_PARAM = "step";

/** The param naming the page of a list's rows. */
export const PAGE_PARAM = "page";

/** The param naming the row open beside a list. */
export const SELECTION_PARAM = "selected";

/** The param naming a list's time window. */
export const RANGE_PARAM = "range";

/** The params `useFilterUrlSync` is handed as `resetParams` on a paged list with a detail pane. */
export const FILTER_DEPENDENT_PARAMS: readonly string[] = [PAGE_PARAM, SELECTION_PARAM];

/** A set of param changes: a string sets the param, `null` removes it. */
export type ParamPatch = Readonly<Record<string, string | null>>;

/** How a wizard appears in the URL. */
export interface WizardUrlShape {
	readonly id: string;
	readonly presentation: "page" | "overlay";
}

/** The longest identifier the decoder accepts. */
const MAX_VIEW_ID_LENGTH = 64;

/** Whether `value` is an identifier this codec will put in, or read from, a URL. */
export function isViewId(value: string): boolean {
	return value.length <= MAX_VIEW_ID_LENGTH && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}

/** One view param as an identifier, or `null` when it is absent or not an identifier. */
export function readViewParam(params: ParamReader, name: string): string | null {
	const raw = params.get(name);
	if (raw === null) return null;
	return isViewId(raw) ? raw : null;
}

/** Whether the URL says the overlay wizard `id` is open. */
export function isWizardOpenInUrl(params: ParamReader, id: string): boolean {
	return readViewParam(params, WIZARD_PARAM) === id;
}

/**
 * The step the URL names for this wizard, or `null` when it names none. An overlay's step counts
 * only while the URL also names that overlay — `?step=` left behind by another wizard is not ours.
 */
export function wizardStepFromUrl(params: ParamReader, wizard: WizardUrlShape): string | null {
	if (wizard.presentation === "overlay" && !isWizardOpenInUrl(params, wizard.id)) return null;
	return readViewParam(params, STEP_PARAM);
}

/** The patch that shows `step` of this wizard; an overlay's patch also names the overlay. */
export function wizardStepPatch(wizard: WizardUrlShape, step: string | null): ParamPatch {
	return wizard.presentation === "overlay"
		? { [WIZARD_PARAM]: wizard.id, [STEP_PARAM]: step }
		: { [STEP_PARAM]: step };
}

/**
 * The patch that removes every param this wizard owns: its step, the overlay marker when it is an
 * overlay, and the params its steps asked to keep across step changes (`extra`).
 */
export function wizardClearPatch(wizard: WizardUrlShape, extra: readonly string[] = []): ParamPatch {
	const patch: Record<string, string | null> = { [STEP_PARAM]: null };
	if (wizard.presentation === "overlay") patch[WIZARD_PARAM] = null;
	for (const name of extra) patch[name] = null;
	return patch;
}

/**
 * A query string with `patch` applied to `search`. Params the patch does not name keep their
 * value and their order. Returns the string without a leading `?`; it is empty when nothing is left.
 */
export function applyParamPatch(search: string, patch: ParamPatch): string {
	const params = new URLSearchParams(search);
	for (const [name, value] of Object.entries(patch)) {
		if (value === null) params.delete(name);
		else params.set(name, value);
	}
	return params.toString();
}

/** `pathname` with `patch` applied to `search`: the href a router is given. */
export function hrefWithParamPatch(pathname: string, search: string, patch: ParamPatch): string {
	const next = applyParamPatch(search, patch);
	return next === "" ? pathname : `${pathname}?${next}`;
}

/** The highest page number the codec reads or writes (six digits). */
const MAX_PAGE = 999_999;

/**
 * The 1-based page the URL names. Absent, not a whole number, below 1 or above the cap all read
 * as the first page.
 */
export function pageFromUrl(params: ParamReader, name: string = PAGE_PARAM): number {
	const raw = params.get(name);
	if (raw === null || !/^[1-9][0-9]{0,5}$/.test(raw)) return 1;
	return Number.parseInt(raw, 10);
}

/** The patch that shows `page`. The first page removes the param, so a pristine list keeps a clean URL. */
export function pagePatch(page: number, name: string = PAGE_PARAM): ParamPatch {
	const whole = Number.isFinite(page) ? Math.floor(page) : 1;
	return { [name]: whole <= 1 || whole > MAX_PAGE ? null : String(whole) };
}

/** The id of the row the URL says is open, or `null` when it names none or the value is not an identifier. */
export function selectionFromUrl(params: ParamReader, name: string = SELECTION_PARAM): string | null {
	return readViewParam(params, name);
}

/** The patch that opens the row `id`, or closes the open one for `null` and for anything that is not an identifier. */
export function selectionPatch(id: string | null, name: string = SELECTION_PARAM): ParamPatch {
	return { [name]: id !== null && isViewId(id) ? id : null };
}

/**
 * The time window the URL names, decoded exactly as a `range` filter value is
 * (`lib/query/range-filter.ts`): a preset stays relative, an explicit window is its two bounds,
 * and absent or unreadable is the page's default window.
 */
export function rangeFromUrl(params: ParamReader, name: string = RANGE_PARAM): RangeFilter {
	return parseRangeFilter(params.get(name) ?? "");
}

/**
 * The patch that shows the window `value` (a preset id, or `<from>/<to>`). The page's default
 * window removes the param, and so does a value that does not decode.
 */
export function rangePatch(value: string, name: string = RANGE_PARAM): ParamPatch {
	return { [name]: parseRangeFilter(value).kind === "default" ? null : value };
}
