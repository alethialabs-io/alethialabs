"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useStore } from "@xyflow/react";

/**
 * Why every "Fit view" entry point is disabled on an empty board. One string, so the controls bar,
 * the ⋯ menu, the pane context menu and the ⌘K palette cannot disagree about it.
 */
export const NOTHING_TO_FIT = "Nothing on the board to fit";

/**
 * Whether the board DRAWS at least one node — what "Fit view" has to fit.
 *
 * Reads React Flow's own node lookup, not the canvas store: `CanvasFlow` never draws the project,
 * cluster and network nodes (and hides layers and BYO-IaC-governed kinds), so a store holding only
 * those draws nothing, and `fitView()` on it is a click that visibly does nothing (#4996). Must be
 * called inside a ReactFlowProvider.
 */
export function useHasDrawnNodes(): boolean {
	return useStore((s) => s.nodeLookup.size > 0);
}
