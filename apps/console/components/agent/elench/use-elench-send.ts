"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Elench send path, on the drafts store (ADR 0001 §7.2, §14 slice 9). Every send is an event:
// Enter on the box is `SUBMIT` (D9 / D10), and a prompt that is not the box's text (a suggestion
// card, a seed prompt, an empty-cell prompt) is `SUBMIT_EXTERNAL` (D10x / D10y). The store decides
// what is sent, under which turn id, and what happens to the words when it fails; nothing here
// holds a message, a pending turn or a failure of its own, so nothing here can lose one.

import type { ChatStatus } from "ai";
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import type { DraftMention } from "@/lib/elench/draft-content";
import { selectDraft } from "@/lib/stores/elench-drafts/selectors";
import type { DraftsStoreHandle } from "@/lib/stores/elench-drafts/store";
import type { DraftEntry, DraftKey } from "@/lib/stores/elench-drafts/types";
import type { ElenchCellTarget } from "@/types/jsonb.types";

/** The draft a composer writes to: the tab's store and the conversation's key. */
export interface ElenchDraftBinding {
	store: DraftsStoreHandle;
	key: DraftKey;
}

/**
 * Provided by the conversation for the conversation on screen. Null while there is no draft to
 * write to: before the tab's store exists, or while the page's org is not known yet.
 */
export const ElenchDraftContext = createContext<ElenchDraftBinding | null>(null);

/** The draft the surrounding conversation shows, or null. */
export function useElenchDraft(): ElenchDraftBinding | null {
	return useContext(ElenchDraftContext);
}

/** Subscribes to nothing: the snapshot of an absent binding never changes. */
function subscribeNothing(): () => void {
	return () => undefined;
}

/** The entry of `binding`'s key, re-rendering on its every change; null when this tab holds none. */
export function useDraftEntry(binding: ElenchDraftBinding | null): DraftEntry | null {
	const subscribe = useCallback(
		(onChange: () => void) =>
			binding === null ? subscribeNothing() : binding.store.view.subscribe(onChange),
		[binding],
	);
	const snapshot = useCallback(
		() => (binding === null ? null : selectDraft(binding.store.view.getState(), binding.key)),
		[binding],
	);
	return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** A prompt that is not the box's text (D10x / D10y). */
export interface ExternalPrompt {
	text: string;
	mentions?: DraftMention[];
	/** The widget-grid cell the prompt is aimed at; the empty-cell prompt's (ADR 0003 §9.4 change 3). */
	cellTarget?: ElenchCellTarget | null;
	/** Where it came from (`suggestion`, `seed`, `cell`): never its text. */
	origin: string;
}

/** What the conversation and the composer send through. */
export interface ElenchSend {
	/** D9 / D10: Enter on the box. False when there is no draft to send from. */
	submit: () => boolean;
	/** D10x / D10y: send `prompt`; the box is untouched. False when there is no draft to send from. */
	submitExternal: (prompt: ExternalPrompt) => boolean;
}

/**
 * True when the chat can take a request now (R3): `ready` or `error`. A request of this Chat in
 * flight (`submitted`, `streaming`) means a send would interleave with it.
 */
export function chatReady(status: ChatStatus | undefined): boolean {
	return status === "ready" || status === "error";
}

/**
 * The send path of the conversation in `binding`: each call dispatches one event to the store and
 * does nothing else. `status` is the chat's, read for R3's guard at the moment of the send.
 */
export function useElenchSend(
	binding: ElenchDraftBinding | null,
	status: ChatStatus | undefined,
): ElenchSend {
	const ready = chatReady(status);
	const submit = useCallback((): boolean => {
		if (binding === null) return false;
		binding.store.dispatch({
			type: "ENTRY",
			key: binding.key,
			event: { type: "SUBMIT", chatReady: ready },
		});
		return true;
	}, [binding, ready]);
	const submitExternal = useCallback(
		(prompt: ExternalPrompt): boolean => {
			if (binding === null) return false;
			binding.store.dispatch({
				type: "ENTRY",
				key: binding.key,
				event: {
					type: "SUBMIT_EXTERNAL",
					text: prompt.text,
					mentions: prompt.mentions ?? [],
					cellTarget: prompt.cellTarget ?? null,
					origin: prompt.origin,
					chatReady: ready,
				},
			});
			return true;
		},
		[binding, ready],
	);
	return useMemo(() => ({ submit, submitExternal }), [submit, submitExternal]);
}
