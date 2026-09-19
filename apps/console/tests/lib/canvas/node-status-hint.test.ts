// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `nodeStatusHint` is the default line the inspector shows when the server gave it no message of
// its own. It used to be a `Partial<Record<NodeStatusState, string>>` in node-inspector.tsx — the
// node-state vocabulary enumerated a second time, apart from `NODE_STATUS_META` which already owns
// that set. #4295 folded it back beside the union as a switch.
//
// These tests pin the property that move was FOR: the two must agree on the state set, exactly and
// in both directions. `Partial<Record<>>` could not express that — a state added to the union got
// silently no hint — and the `satisfies never` arm only catches a MISSING case at compile time. It
// cannot catch a hint that is blank, a hint that is a copy-paste of its neighbour, or the one state
// that is supposed to have none. That is what is asserted here.

import { describe, expect, it } from "vitest";
import {
	NODE_STATUS_META,
	nodeStatusHint,
	type NodeStatusState,
} from "@/lib/canvas/node-status";

/** The state set, taken from the map that owns it rather than re-typed here. */
const STATES = Object.keys(NODE_STATUS_META) as NodeStatusState[];

/**
 * The one state with no hint, and why.
 *
 * `needs-setup` always carries the offending config issue as `status.message`, and the inspector
 * renders `status.message ?? nodeStatusHint(state)`. A generic line here would therefore never be
 * seen — except in the case where the issue text was missing, where it would replace a specific
 * answer with a vague one. So its absence is deliberate, and pinned.
 */
const NO_HINT: NodeStatusState = "needs-setup";

describe("nodeStatusHint", () => {
	it("answers for every state NODE_STATUS_META declares", () => {
		expect(STATES.length).toBeGreaterThan(0); // vacuity guard: an empty map would pass everything
		for (const state of STATES) {
			if (state === NO_HINT) continue;
			const hint = nodeStatusHint(state);
			expect(hint, `no hint for "${state}"`).toBeTypeOf("string");
			expect(hint?.trim(), `blank hint for "${state}"`).not.toBe("");
		}
	});

	it("gives needs-setup no hint, because its config issue is the better line", () => {
		expect(nodeStatusHint(NO_HINT)).toBeUndefined();
	});

	it("gives each state its OWN line — no two states share a hint", () => {
		const hints = STATES.filter((s) => s !== NO_HINT).map((s) => nodeStatusHint(s));
		expect(new Set(hints).size).toBe(hints.length);
	});

	it("does not merely restate the label the badge already shows beside it", () => {
		// The inspector renders the StatusBadge and this line side by side, so a hint equal to the
		// label is a row that says one thing twice.
		for (const state of STATES) {
			const hint = nodeStatusHint(state);
			if (!hint) continue;
			expect(hint.toLowerCase()).not.toBe(NODE_STATUS_META[state].label.toLowerCase());
		}
	});

	it("returns undefined for a state outside the union rather than throwing", () => {
		// The `default` arm. A cast is needed to get past the compiler on purpose — this is the
		// runtime shape a persisted-but-since-removed state would arrive as, and the inspector must
		// render an empty line rather than crash the canvas. `tests/**` is exempt from the repo's
		// assertion ban precisely so a boundary like this can be exercised.
		expect(nodeStatusHint("not-a-real-state" as NodeStatusState)).toBeUndefined();
	});
});
