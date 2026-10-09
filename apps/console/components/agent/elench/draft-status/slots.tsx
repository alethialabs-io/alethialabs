"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The two mount points of a draft's status (ADR 0001 §7.4, §14 slice 9). The composer renders both,
// wherever it is mounted (the modal landing and the docked chat): the bar slot above the box and
// the footer slot under it, so slice 11 can fill them without touching the composer. Until slice 11 both render nothing: the words are kept by
// the store whatever these show, and nothing on screen claims a state the store has not reached.

import type { DraftKey } from "@/lib/stores/elench-drafts/types";

/** Where one draft's status is rendered: the key it reports on. */
export interface DraftSlotProps {
	draftKey: DraftKey;
}

/**
 * The composer footer's status line (§7.4: "Saved", "Saving…", "Not saved …"). Renders nothing
 * until slice 11 fills it.
 */
export function DraftFooterSlot(_props: DraftSlotProps): null {
	return null;
}

/**
 * The bar above the composer: the conflict, claimed, uncertain and credential bars and the
 * notices of D9a, D24, D31 and D36 (§7.4). Renders nothing until slice 11 fills it.
 */
export function DraftBarSlot(_props: DraftSlotProps): null {
	return null;
}
