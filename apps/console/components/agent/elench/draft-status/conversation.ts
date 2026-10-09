"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What the bar above the box needs from the conversation around it, which only the conversation
// knows (ADR 0001 §14 slice 11):
//
// - G10's inline error: when listing the conversations or loading one fails, the surface still
//   renders the draft (slice 10 catches the failure into `loadError`), and the bar says what failed,
//   with a Retry;
// - D15's excerpt: when another tab or device SENT the message this box was editing, the conflict
//   bar names the first 60 characters of that turn, read from the transcript once it is loaded.

import { createContext, useContext } from "react";

/** What failed to load, and how to try again. */
export interface DraftLoadError {
	/** `list`: the conversations; `resume` / `select`: the conversation on screen. */
	step: "list" | "resume" | "select";
	retry: () => void;
}

/** The conversation's facts the draft status reads. */
export interface DraftConversationFacts {
	/** Set while a load has failed (G10); null otherwise. */
	loadError: DraftLoadError | null;
	/** The text of the transcript's user turn `turnId`, or null when the transcript does not hold it. */
	sentText: (turnId: string) => string | null;
}

/** Nothing failed, and no transcript to read. */
const NONE: DraftConversationFacts = { loadError: null, sentText: () => null };

/** Provided by the conversation for its composer. */
export const DraftConversationContext = createContext<DraftConversationFacts>(NONE);

/** The facts of the surrounding conversation. */
export function useDraftConversation(): DraftConversationFacts {
	return useContext(DraftConversationContext);
}

/** What the bar says for a failed `step`. */
export function loadErrorText(step: DraftLoadError["step"]): string {
	return step === "list" ? "Your conversations could not be loaded." : "The conversation could not be loaded.";
}
