"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { create } from "zustand";
import {
	deleteWidget,
	listThreadWidgets,
	type PinWidgetInput,
	pinWidget,
	updateWidget,
} from "@/app/server/actions/widgets";
import type { ThreadWidget } from "@/lib/db/schema";
import { buildOccupancy, firstFit, type GridRect } from "@/lib/widgets/layout";
import type { WidgetMode } from "@/types/jsonb.types";

/** A pin request: everything the server action needs, minus the placement the store
 * resolves (pass posX/posY to pin at an explicit cell instead of first-fit). */
export type PinInput = Omit<PinWidgetInput, "posX" | "posY"> & {
	posX?: number;
	posY?: number;
};

/** A widget's grid rect (for occupancy math). */
function rectOf(w: ThreadWidget): GridRect & { id: string } {
	return { id: w.id, x: w.pos_x, y: w.pos_y, colspan: w.colspan, rowspan: w.rowspan };
}

interface WidgetGridState {
	/** The thread whose grid is loaded (null = none). */
	threadId: string | null;
	widgets: ThreadWidget[];
	loading: boolean;
	/** The empty cell showing an inline "describe what goes here…" composer. `span` is the
	 * number of contiguous free columns to the right (1–2) so the composer never overlaps a
	 * neighbouring widget. */
	cellPrompt: { x: number; y: number; span: number } | null;
	/** A submitted cell request awaiting dispatch into the chat (the conversation
	 * consumes it: stages `pendingCellTarget`, sends the text, clears this). */
	pendingCellRequest: { x: number; y: number; text: string } | null;
	/** The grid cell the NEXT chat request should fill (read fresh by prepareBody). */
	pendingCellTarget: { x: number; y: number } | null;
	setCellPrompt: (cell: { x: number; y: number; span: number } | null) => void;
	submitCellPrompt: (text: string) => void;
	setPendingCellTarget: (cell: { x: number; y: number } | null) => void;
	clearPendingCellRequest: () => void;
	/** toolCallIds already pinned this session (client-side auto-pin guard; the DB
	 * unique upsert is the durable guard). */
	pinned: Set<string>;
	/** Load a thread's grid (idempotent per thread; clears on thread switch). */
	hydrate: (threadId: string) => Promise<void>;
	/** Forget the loaded grid (new chat / close). */
	reset: () => void;
	/** Pin at first-fit (auto-pin + user pins); resolves placement client-side.
	 * Resolves true when a widget actually landed/updated (false = dedupe no-op).
	 * Callers pinning SEVERAL widgets must await them one at a time — each first-fit
	 * reads the current grid, so parallel pins would all pick the same cell. */
	pin: (input: PinInput) => Promise<boolean>;
	/** Optimistically move/resize a widget, then persist. */
	place: (id: string, rect: Partial<GridRect>) => void;
	setMode: (id: string, mode: WidgetMode) => void;
	remove: (id: string) => void;
}

/**
 * Per-thread widget-grid state: hydrated from `thread_widgets`, mutated optimistically
 * (drag/resize/mode/delete persist via server actions), with client-side first-fit for
 * new pins. One grid at a time — keyed by the active thread.
 */
export const useWidgetGridStore = create<WidgetGridState>((set, get) => ({
	threadId: null,
	widgets: [],
	loading: false,
	pinned: new Set<string>(),
	cellPrompt: null,
	pendingCellRequest: null,
	pendingCellTarget: null,

	setCellPrompt: (cell) => set({ cellPrompt: cell }),
	submitCellPrompt: (text) => {
		const cell = get().cellPrompt;
		const trimmed = text.trim();
		if (!cell || !trimmed) return;
		set({
			cellPrompt: null,
			pendingCellRequest: { x: cell.x, y: cell.y, text: trimmed },
		});
	},
	setPendingCellTarget: (cell) => set({ pendingCellTarget: cell }),
	clearPendingCellRequest: () => set({ pendingCellRequest: null }),

	hydrate: async (threadId) => {
		if (get().threadId === threadId && !get().loading) return;
		set({ threadId, loading: true, widgets: [], pinned: new Set<string>() });
		try {
			const widgets = await listThreadWidgets(threadId);
			// Ignore a stale response if the user already switched threads again.
			if (get().threadId !== threadId) return;
			set({
				widgets,
				loading: false,
				pinned: new Set(
					widgets.map((w) => w.tool_call_id).filter((id): id is string => !!id),
				),
			});
		} catch {
			if (get().threadId === threadId) set({ loading: false });
		}
	},

	reset: () => set({ threadId: null, widgets: [], pinned: new Set<string>() }),

	pin: async (input) => {
		const { threadId, widgets, pinned } = get();
		if (!threadId || input.threadId !== threadId) return false;
		if (input.toolCallId && pinned.has(input.toolCallId)) return false;
		if (input.toolCallId) {
			set({ pinned: new Set(pinned).add(input.toolCallId) });
		}
		const spot =
			input.posX !== undefined && input.posY !== undefined
				? { x: input.posX, y: input.posY }
				: firstFit(buildOccupancy(widgets.map(rectOf)), {
						colspan: input.colspan,
						rowspan: input.rowspan,
					});
		try {
			const row = await pinWidget({ ...input, posX: spot.x, posY: spot.y });
			if (get().threadId !== threadId || !row) return false;
			set((s) => ({
				// Replace-by-source/toolCallId may return an existing id — swap, don't dupe.
				widgets: [...s.widgets.filter((w) => w.id !== row.id), row],
			}));
			return true;
		} catch {
			// A failed pin is non-fatal (the transcript still shows the result).
			return false;
		}
	},

	place: (id, rect) => {
		set((s) => ({
			widgets: s.widgets.map((w) =>
				w.id === id
					? {
							...w,
							pos_x: rect.x ?? w.pos_x,
							pos_y: rect.y ?? w.pos_y,
							colspan: rect.colspan ?? w.colspan,
							rowspan: rect.rowspan ?? w.rowspan,
						}
					: w,
			),
		}));
		const w = get().widgets.find((x) => x.id === id);
		if (!w) return;
		void updateWidget({
			id,
			posX: w.pos_x,
			posY: w.pos_y,
			colspan: w.colspan,
			rowspan: w.rowspan,
		});
	},

	setMode: (id, mode) => {
		set((s) => ({
			widgets: s.widgets.map((w) => (w.id === id ? { ...w, mode } : w)),
		}));
		void updateWidget({ id, mode });
	},

	remove: (id) => {
		set((s) => ({ widgets: s.widgets.filter((w) => w.id !== id) }));
		void deleteWidget(id);
	},
}));
