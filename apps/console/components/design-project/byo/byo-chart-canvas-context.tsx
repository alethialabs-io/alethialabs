"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Request-scoped context the canvas provides so a BYO chart node (rendered by React Flow, with no
// props of its own) can reach the project/environment it belongs to and refresh itself after a
// detach. Kept out of the persisted canvas store on purpose — these ids are per-page, not draft state.

import { createContext, useContext } from "react";

export interface ByoChartCanvasContextValue {
	projectId: string;
	environmentId: string | null;
	/** Re-fetch the attached charts + re-seed the chart nodes (after attach/detach). */
	refresh: () => void;
}

const ByoChartCanvasContext = createContext<ByoChartCanvasContextValue | null>(null);

export const ByoChartCanvasProvider = ByoChartCanvasContext.Provider;

/** Null on canvases without a project (the create flow) — chart nodes only exist in edit mode. */
export function useByoChartCanvas(): ByoChartCanvasContextValue | null {
	return useContext(ByoChartCanvasContext);
}
