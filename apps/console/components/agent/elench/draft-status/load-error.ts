"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// G10's inline error (ADR 0001 §11.3, §14 slice 11): when listing the conversations or loading one
// fails, the surface still renders the draft (slice 10 catches the failure into `loadError`), and
// the bar above the box says what failed, with a Retry. The conversation provides it; the bar reads it.

import { createContext, useContext } from "react";

/** What failed to load, and how to try again. */
export interface DraftLoadError {
	/** `list`: the conversations; `resume` / `select`: the conversation on screen. */
	step: "list" | "resume" | "select";
	retry: () => void;
}

/** Provided by the conversation while a load has failed; null otherwise. */
export const DraftLoadErrorContext = createContext<DraftLoadError | null>(null);

/** The load failure the surrounding conversation reports, or null. */
export function useDraftLoadError(): DraftLoadError | null {
	return useContext(DraftLoadErrorContext);
}

/** What the bar says for a failed `step`. */
export function loadErrorText(step: DraftLoadError["step"]): string {
	return step === "list" ? "Your conversations could not be loaded." : "The conversation could not be loaded.";
}
