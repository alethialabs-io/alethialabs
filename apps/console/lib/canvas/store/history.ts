// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The board's undo history (#6764), as pure functions over values.
//
// A checkpoint is the document as it stood BEFORE a change. Undo puts the newest checkpoint back
// and keeps what it replaced for redo. Three rules make that correct where the old history was not:
//
//   - EVERY change takes a checkpoint — a field edit and a finished move as much as an add or a
//     remove. The old history took one only on structural actions, so undo after ten minutes of
//     field edits restored the board from before the last add and discarded all of them.
//   - A checkpoint holds the design and where its cards sit, and nothing else. A card the design
//     does not own (an add-on, a chart, an external resource) is not in it, so undo cannot take one
//     off the board.
//   - A checkpoint that would restore exactly what is already there is not taken, so an explicit
//     checkpoint followed by the change it was taken for is one step, not two.
//
// Snapshots are held by reference: every writer in this directory replaces arrays and objects
// rather than mutating them, so a snapshot cannot change after it is taken.

import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import type { CollectionPositions } from "@/lib/canvas/collections";
import type { Positions, StagedOperation } from "./types";

/** The number of steps kept. Older ones are dropped. */
export const HISTORY_CAP = 50;

/** Edits to the same node and field closer together than this are one step. */
export const COALESCE_MS = 1000;

/** The part of the document a step restores. */
export interface HistorySnapshot {
	designNodes: CanvasNode[];
	positions: Positions;
	collectionPositions: CollectionPositions;
	operations: StagedOperation[];
}

/** One step: the snapshot it restores, what the change was, and when it was last extended. */
export interface HistoryEntry extends HistorySnapshot {
	/** What the change after this snapshot was: "add", "edit", "move" and so on. */
	label: string;
	/** Changes with the same non-null key, close together in time, extend this step. */
	coalesceKey: string | null;
	at: number;
}

/** The two stacks: `past` newest last, `future` next-to-redo first. */
export interface HistoryState {
	past: HistoryEntry[];
	future: HistoryEntry[];
}

/** A history with nothing to undo or redo. */
export const EMPTY_HISTORY: HistoryState = { past: [], future: [] };

/** True when two snapshots are the same document (compared by reference, see the header). */
export function sameSnapshot(a: HistorySnapshot, b: HistorySnapshot): boolean {
	return (
		a.designNodes === b.designNodes &&
		a.positions === b.positions &&
		a.collectionPositions === b.collectionPositions &&
		a.operations === b.operations
	);
}

/** The snapshot fields of `source`, and only those. */
export function snapshotOf(source: HistorySnapshot): HistorySnapshot {
	return {
		designNodes: source.designNodes,
		positions: source.positions,
		collectionPositions: source.collectionPositions,
		operations: source.operations,
	};
}

/**
 * Take a checkpoint of `current` ahead of a change, and drop the redo stack: a new change makes
 * the undone ones unreachable.
 *
 * No step is added when the newest step already restores `current`, or when the change extends the
 * newest step (same `coalesceKey`, within {@link COALESCE_MS}).
 */
export function checkpoint(
	history: HistoryState,
	current: HistorySnapshot,
	label: string,
	options: { coalesceKey?: string | null; now: number },
): HistoryState {
	const key = options.coalesceKey ?? null;
	const top = history.past[history.past.length - 1];
	if (top) {
		const extends_ =
			key !== null && top.coalesceKey === key && options.now - top.at < COALESCE_MS;
		if (extends_ || sameSnapshot(top, current)) {
			const kept: HistoryEntry = {
				...top,
				// An explicit checkpoint adopts the key of the change that follows it, so the next edit
				// of the same field extends it rather than adding a step.
				coalesceKey: extends_ ? key : (top.coalesceKey ?? key),
				at: options.now,
			};
			return { past: [...history.past.slice(0, -1), kept], future: [] };
		}
	}
	const entry: HistoryEntry = {
		...snapshotOf(current),
		label,
		coalesceKey: key,
		at: options.now,
	};
	return { past: [...history.past, entry].slice(-HISTORY_CAP), future: [] };
}

/** The result of stepping through the history: the stacks afterwards and the snapshot to restore. */
export interface HistoryStep {
	history: HistoryState;
	restore: HistorySnapshot;
}

/** Undo: restore the newest step and keep `current` for redo. Null when there is nothing to undo. */
export function stepBack(history: HistoryState, current: HistorySnapshot): HistoryStep | null {
	const entry = history.past[history.past.length - 1];
	if (!entry) return null;
	const redo: HistoryEntry = {
		...snapshotOf(current),
		label: entry.label,
		coalesceKey: null,
		at: entry.at,
	};
	return {
		history: {
			past: history.past.slice(0, -1),
			future: [redo, ...history.future].slice(0, HISTORY_CAP),
		},
		restore: snapshotOf(entry),
	};
}

/** Redo: restore the next undone step and keep `current` for undo. Null when there is none. */
export function stepForward(history: HistoryState, current: HistorySnapshot): HistoryStep | null {
	const entry = history.future[0];
	if (!entry) return null;
	const undo: HistoryEntry = {
		...snapshotOf(current),
		label: entry.label,
		coalesceKey: null,
		at: entry.at,
	};
	return {
		history: {
			past: [...history.past, undo].slice(-HISTORY_CAP),
			future: history.future.slice(1),
		},
		restore: snapshotOf(entry),
	};
}
