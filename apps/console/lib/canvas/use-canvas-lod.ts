"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Zoom-driven level of detail for canvas cards. A large architecture stays legible because the card
// sheds DETAIL before it sheds LEGIBILITY: at a distance a node is a glyph and a status dot; up
// close it's the full instrument panel.

import { useStore } from "@xyflow/react";

/** How much of a card is drawn at the current zoom. */
export type CanvasLod = "glyph" | "compact" | "full";

/** Zoom thresholds — the single place the tiers are defined. */
export const LOD_THRESHOLD = { glyph: 0.5, compact: 0.85 } as const;

/** The tier for a given zoom level (pure — so it can be unit-tested without React Flow). */
export function lodForZoom(zoom: number): CanvasLod {
	if (zoom < LOD_THRESHOLD.glyph) return "glyph";
	if (zoom < LOD_THRESHOLD.compact) return "compact";
	return "full";
}

/**
 * The current LOD tier, from the React Flow viewport zoom. Selecting the derived TIER (not the raw
 * zoom) means a node only re-renders when it actually crosses a threshold, not on every zoom frame.
 */
export function useCanvasLod(): CanvasLod {
	return useStore((s) => lodForZoom(s.transform[2]));
}
