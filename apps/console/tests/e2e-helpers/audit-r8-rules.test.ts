// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// R8's two #4980 rules, as pure functions.
//
// 1. A control already in the state it selects is not inert. `~/settings/roles` selects the
//    built-in `owner` row on arrival; pressing it again correctly changes nothing, and R8 filed it
//    inert whenever no unrelated re-render landed in the window. The rule reads the control's own
//    ARIA claim — and deliberately NOT `aria-pressed`, whose toggle is expected to unpress.
// 2. An empty enumeration is N/A only when the page had loaded. `~/runners` and
//    `[project]/architecture` were filed `no-enabled-controls` from their skeletons.

import { describe, expect, it } from "vitest";
import {
	emptyEnumerationReason,
	hasSettled,
	isAlreadySelected,
	READY_STABLE_READS,
	type ReadinessRead,
	type SelectionState,
} from "../../e2e/audit/inert";

/** A selection state with nothing set, overridable per case. */
function sel(over: Partial<SelectionState> = {}): SelectionState {
	return { role: null, current: null, selected: null, checked: null, ...over };
}

describe("isAlreadySelected", () => {
	it("reads aria-current of any token but false as the current member of a set", () => {
		expect(isAlreadySelected(sel({ current: "true" }))).toBe(true);
		expect(isAlreadySelected(sel({ current: "page" }))).toBe(true);
		expect(isAlreadySelected(sel({ current: "false" }))).toBe(false);
	});

	it("reads aria-selected=true, and a checked radio, as already selected", () => {
		expect(isAlreadySelected(sel({ selected: "true" }))).toBe(true);
		expect(isAlreadySelected(sel({ role: "radio", checked: "true" }))).toBe(true);
		expect(isAlreadySelected(sel({ role: "menuitemradio", checked: "true" }))).toBe(true);
	});

	it("does NOT excuse a checked checkbox or a control that claims nothing", () => {
		expect(isAlreadySelected(sel({ role: "checkbox", checked: "true" }))).toBe(false);
		expect(isAlreadySelected(sel({ checked: "true" }))).toBe(false);
		expect(isAlreadySelected(sel())).toBe(false);
	});
});

/** One readiness read. */
function read(controls: number, over: Partial<ReadinessRead> = {}): ReadinessRead {
	return { hasMain: true, controls, busy: false, skeletons: 0, ...over };
}

describe("hasSettled", () => {
	it("settles a page with controls after two agreeing reads", () => {
		expect(hasSettled([read(6)])).toBe(false);
		expect(hasSettled([read(6), read(6)])).toBe(true);
		expect(hasSettled([read(4), read(6)])).toBe(false);
	});

	it("never settles on a read that says it is loading — the skeleton is not the page", () => {
		const skeleton = read(0, { skeletons: 8 });
		expect(hasSettled(Array.from({ length: 20 }, () => skeleton))).toBe(false);
		expect(hasSettled([read(6, { busy: true }), read(6, { busy: true })])).toBe(false);
		expect(hasSettled([read(0, { hasMain: false }), read(0, { hasMain: false })])).toBe(false);
	});

	it("needs a longer quiet stretch before it believes a page offers NOTHING", () => {
		const empty = Array.from({ length: READY_STABLE_READS.empty - 1 }, () => read(0));
		expect(hasSettled(empty)).toBe(false);
		expect(hasSettled([...empty, read(0)])).toBe(true);
	});
});

describe("emptyEnumerationReason", () => {
	it("allows N/A only for a page that settled and was not loading", () => {
		expect(emptyEnumerationReason({ settled: true, last: read(0), waitedMs: 1500 })).toBeNull();
	});

	it("withholds as NOT MEASURED, naming what was seen, when the page never finished loading", () => {
		const reason = emptyEnumerationReason({ settled: false, last: read(0, { skeletons: 8 }), waitedMs: 15000 });
		expect(reason).toMatch(/^page-not-ready/);
		expect(reason).toContain("8 skeleton(s)");
		expect(emptyEnumerationReason({ settled: false, last: read(0, { hasMain: false }), waitedMs: 15000 })).toContain("no `<main>`");
	});
});
