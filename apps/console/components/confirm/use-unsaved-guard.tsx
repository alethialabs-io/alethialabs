"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The console's one "discard your changes?" question, for a sheet that is closed and for a row
// that is left while an edit is unsaved.
//
// `useUnsavedGuard` answers "is there anything to lose" from a react-hook-form form or from a
// boolean the caller already computes, and holds the thing the person was trying to do until they
// have answered. `DiscardPrompt` is the question itself. `useLeavePageGuard` is the page-level
// half: a settings form that is a whole page, not a sheet, has no close to wrap, so the leaving it
// guards is a reload or a closed tab.

import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmAction } from "@/components/confirm/confirm-action";

/** The part of a react-hook-form form the guard reads. Every `useForm` result satisfies it. */
export interface DirtySource {
	formState: { isDirty: boolean };
}

/** What {@link DiscardPrompt} needs from its caller, besides its copy. */
export interface DiscardPromptState {
	open: boolean;
	/** The person chose to keep editing. */
	onKeep: () => void;
	/** The person chose to drop the changes. */
	onDiscard: () => void;
}

/** What {@link useUnsavedGuard} returns. */
export interface UnsavedGuard {
	/** True while there is an unsaved change. */
	dirty: boolean;
	/** Runs `leave` at once when nothing is unsaved; otherwise asks first and runs it on Discard. */
	guard: (leave: () => void) => void;
	/** Spread onto {@link DiscardPrompt}. */
	prompt: DiscardPromptState;
}

/**
 * Asks before unsaved changes are dropped. Give it the form (its `isDirty` is read during render,
 * which is what makes react-hook-form track it) or a boolean, wrap each way of leaving in
 * `guard(...)`, and render one `<DiscardPrompt {...prompt} />`.
 */
export function useUnsavedGuard(source: DirtySource | boolean): UnsavedGuard {
	const dirty = typeof source === "boolean" ? source : source.formState.isDirty;
	const [held, setHeld] = useState<{ leave: () => void } | null>(null);

	const guard = useCallback(
		(leave: () => void) => {
			if (dirty) setHeld({ leave });
			else leave();
		},
		[dirty],
	);
	const onKeep = useCallback(() => setHeld(null), []);
	const onDiscard = useCallback(() => {
		setHeld(null);
		held?.leave();
	}, [held]);

	return { dirty, guard, prompt: { open: held !== null, onKeep, onDiscard } };
}

interface DiscardPromptProps extends DiscardPromptState {
	title: string;
	description: string;
	/** The discard button's text. */
	confirmLabel: string;
}

/** The discard question. Cancel and Escape keep the changes; the primary button drops them. */
export function DiscardPrompt({
	open,
	onKeep,
	onDiscard,
	title,
	description,
	confirmLabel,
}: DiscardPromptProps) {
	/** Set by the discard itself, so the close that follows it is not read as "keep editing". */
	const discarded = useRef(false);
	return (
		<ConfirmAction
			open={open}
			onOpenChange={(next) => {
				if (next) return;
				if (discarded.current) {
					discarded.current = false;
					return;
				}
				onKeep();
			}}
			title={title}
			description={description}
			confirmLabel={confirmLabel}
			severity={{ level: "confirm" }}
			run={() => {
				discarded.current = true;
				onDiscard();
			}}
		/>
	);
}

/**
 * The page-level form of the guard (R6 E-17, F-16): while `dirty`, a reload or a closed tab asks the
 * browser's own "leave site?" question first. For a settings form that IS the page, where there is
 * no sheet close to wrap in `guard(...)`. A save resets the form, which clears `dirty` and the guard.
 */
export function useLeavePageGuard(dirty: boolean): void {
	useEffect(() => {
		if (!dirty) return undefined;
		const warn = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [dirty]);
}
