"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Request-scoped context the canvas provides so the external-IaC overlay (rendered without props
// of its own) can reach the project/environment it belongs to, read the currently attached source,
// and refresh itself after attach / detach / rescan. Kept out of the persisted canvas store on
// purpose — these ids are per-page, not draft state (mirrors ByoChartCanvasContext). A BYO IaC
// source is single-per-environment (v1 replace mode), so this carries ONE source, not a list.

import { createContext, useContext } from "react";
import type { IacSourceState } from "@/app/server/actions/byo-iac";

export interface IacSourceCanvasContextValue {
	projectId: string;
	environmentId: string | null;
	/** The environment's attached IaC source, or null when none is attached. */
	source: IacSourceState | null;
	/** Re-fetch the attached IaC source (after attach / detach / rescan). */
	refresh: () => void;
}

const IacSourceCanvasContext = createContext<IacSourceCanvasContextValue | null>(null);

export const IacSourceCanvasProvider = IacSourceCanvasContext.Provider;

/** Null on canvases without a project (the create flow) — the IaC overlay only exists in edit mode. */
export function useIacSourceCanvas(): IacSourceCanvasContextValue | null {
	return useContext(IacSourceCanvasContext);
}
