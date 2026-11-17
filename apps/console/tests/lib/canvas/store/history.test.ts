// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The undo history as values (#6764): what a checkpoint adds, when it adds nothing, and what a
// step back and a step forward hand back. Every snapshot here is a distinct object on purpose —
// the history compares snapshots by reference.

import { describe, expect, it } from "vitest";
import {
	checkpoint,
	COALESCE_MS,
	EMPTY_HISTORY,
	HISTORY_CAP,
	stepBack,
	stepForward,
	type HistorySnapshot,
} from "@/lib/canvas/store/history";
import { databaseNode, projectNode } from "@/tests/fixtures/canvas/nodes";

/** A snapshot that is nothing but itself: fresh objects in every field. */
function snap(port = 5432): HistorySnapshot {
	return {
		designNodes: [projectNode(), databaseNode("orders", port)],
		positions: {},
		collectionPositions: {},
		operations: [],
	};
}

describe("checkpoint", () => {
	it("adds one step holding the document as it stood, and drops the redo stack", () => {
		const before = snap();
		const undone = stepBack(checkpoint(EMPTY_HISTORY, before, "add", { now: 0 }), snap(1));
		if (!undone) throw new Error("there was a step to undo");
		expect(undone.history.future).toHaveLength(1);

		const next = checkpoint(undone.history, before, "edit", { now: 10 });
		expect(next.past).toHaveLength(1);
		expect(next.past[0].designNodes).toBe(before.designNodes);
		expect(next.past[0].label).toBe("edit");
		expect(next.future).toEqual([]);
	});

	it("adds nothing when the newest step already restores the document", () => {
		const current = snap();
		const once = checkpoint(EMPTY_HISTORY, current, "commit", { now: 0 });
		const twice = checkpoint(once, current, "edit", { coalesceKey: "edit:a:port", now: 5 });
		expect(twice.past).toHaveLength(1);
		// …and the step adopts the key of the change that follows, so the next edit extends it.
		expect(twice.past[0].coalesceKey).toBe("edit:a:port");
	});

	it("extends the newest step for the same key inside the window, and not outside it", () => {
		const first = checkpoint(EMPTY_HISTORY, snap(1), "edit", { coalesceKey: "k", now: 0 });
		const inside = checkpoint(first, snap(2), "edit", { coalesceKey: "k", now: COALESCE_MS - 1 });
		expect(inside.past).toHaveLength(1);
		// The window slides: it is measured from the last extension, not from the first edit.
		const stillInside = checkpoint(inside, snap(3), "edit", {
			coalesceKey: "k",
			now: 2 * COALESCE_MS - 2,
		});
		expect(stillInside.past).toHaveLength(1);
		const outside = checkpoint(stillInside, snap(4), "edit", {
			coalesceKey: "k",
			now: 4 * COALESCE_MS,
		});
		expect(outside.past).toHaveLength(2);
	});

	it("does not extend a step for another key, or a step with no key", () => {
		const keyed = checkpoint(EMPTY_HISTORY, snap(1), "edit", { coalesceKey: "a", now: 0 });
		expect(checkpoint(keyed, snap(2), "edit", { coalesceKey: "b", now: 1 }).past).toHaveLength(2);
		const plain = checkpoint(EMPTY_HISTORY, snap(1), "add", { now: 0 });
		expect(checkpoint(plain, snap(2), "add", { now: 1 }).past).toHaveLength(2);
	});

	it("keeps the newest steps up to the cap", () => {
		let history = EMPTY_HISTORY;
		for (let i = 0; i < HISTORY_CAP + 10; i++) {
			history = checkpoint(history, snap(i), "add", { now: i });
		}
		expect(history.past).toHaveLength(HISTORY_CAP);
		expect(history.past[0].at).toBe(10);
	});
});

describe("stepBack and stepForward", () => {
	it("answer null when there is nothing to step to", () => {
		expect(stepBack(EMPTY_HISTORY, snap())).toBeNull();
		expect(stepForward(EMPTY_HISTORY, snap())).toBeNull();
	});

	it("undo restores the step and keeps what it replaced for redo", () => {
		const before = snap(5432);
		const after = snap(6543);
		const back = stepBack(checkpoint(EMPTY_HISTORY, before, "edit", { now: 0 }), after);
		if (!back) throw new Error("there was a step to undo");
		expect(back.restore.designNodes).toBe(before.designNodes);
		expect(back.history.past).toEqual([]);

		const forward = stepForward(back.history, before);
		if (!forward) throw new Error("there was a step to redo");
		expect(forward.restore.designNodes).toBe(after.designNodes);
		expect(forward.history.future).toEqual([]);
		expect(forward.history.past).toHaveLength(1);
		expect(forward.history.past[0].designNodes).toBe(before.designNodes);
	});

	it("a step put back by undo or redo never extends: its key is dropped", () => {
		const keyed = checkpoint(EMPTY_HISTORY, snap(1), "edit", { coalesceKey: "k", now: 0 });
		const back = stepBack(keyed, snap(2));
		if (!back) throw new Error("there was a step to undo");
		expect(back.history.future[0].coalesceKey).toBeNull();
		const forward = stepForward(back.history, snap(1));
		if (!forward) throw new Error("there was a step to redo");
		expect(forward.history.past[0].coalesceKey).toBeNull();
	});
});
