"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect, useRef, type FocusEvent, type KeyboardEvent } from "react";
import { collectionNodeId } from "@/lib/canvas/collections";
import { useBoard } from "@/lib/canvas/store/canvas-store-provider";
import type { Subject, WorkspaceCard } from "@/lib/canvas/store/types";
import { useSubject } from "@/lib/canvas/store/use-board";
import { subjectOfCard } from "@/lib/canvas/store/view-store";
import { Inspector } from "../inspector-shell/inspector";
import { StagedOperationsStrip } from "../inspector-shell/staged-operations-strip";
import { inspectorOpen, subjectKey, type InspectorContext } from "../inspector-shell/subject";
import type { DestroyEnvironmentControl } from "./destroy-tree-view";

/**
 * Rail geometry: the inspector's width and the gap between it and the board. ONE width, for every
 * subject — selecting a different thing never changes how much of the board is visible.
 */
export const RAIL_W = 392;
export const RAIL_GAP = 12;

/** What the rail knows about its host. */
export type RailContext = InspectorContext;

/**
 * Whether the rail has something to draw for a legacy rail card. The board reads it for the seam
 * it draws against the rail; it is the inspector's own answer (`inspectorOpen`) for the subject the
 * card maps onto, so the two cannot disagree.
 */
export function isRailOpen(card: WorkspaceCard | null, ctx: RailContext = {}): boolean {
	return inspectorOpen(subjectOfCard(card), ctx);
}

/** The board card a subject is about, if it is drawn: where the focus goes back to. */
function cardElementOf(subject: Subject): HTMLElement | null {
	const id =
		subject.kind === "node"
			? subject.id
			: subject.kind === "collection"
				? collectionNodeId(subject.nodeKind)
				: null;
	if (id === null) return null;
	for (const el of document.querySelectorAll(".react-flow__node")) {
		if (el.getAttribute("data-id") === id && el instanceof HTMLElement) return el;
	}
	return null;
}

/** True when the focus sits on a board card and was put there from the keyboard. */
function keyboardFocusOnCard(): boolean {
	const active = document.activeElement;
	if (!(active instanceof HTMLElement) || !active.classList.contains("react-flow__node")) {
		return false;
	}
	try {
		return active.matches(":focus-visible");
	} catch {
		// An engine without the selector cannot say; leave the focus where it is.
		return false;
	}
}

/**
 * The workspace's right-hand rail: where the ONE inspector is drawn (#6834).
 *
 * It is a flex sibling of the board, never an overlay: it takes its width out of the board's, so it
 * cannot cover the toolbar, the changes bar or a card, and the board stays live while it is open.
 * Its width is fixed. Selecting a different subject swaps the inspector's content in place — the
 * rail neither closes nor moves.
 *
 * What it owns, the same for every subject:
 *
 *   - Escape, with the focus anywhere inside it, closes the inspector. A field that holds
 *     uncommitted typing is left first, so what was typed is staged rather than dropped.
 *   - Closing returns the focus to the card the subject was about, or to the control the person
 *     came from, when the focus was in the rail.
 *   - Opening from the keyboard (Enter on a focused card) moves the focus into the inspector, so
 *     its fields are one Tab away rather than after every card on the board.
 *
 * It is mounted INSIDE the canvas: every subject then sits under the React Flow provider, the BYO
 * providers and the add-ons query they need. Unmounting the canvas — leaving Architecture — closes
 * the inspector.
 *
 * The rail draws NO top border: it sits flush under the topbar, whose `border-b` is the top line.
 */
export function WorkspaceRail({
	projectId,
	environmentId,
	destroyEnvironment,
}: {
	projectId?: string;
	environmentId?: string | null;
	destroyEnvironment?: DestroyEnvironmentControl;
}) {
	const board = useBoard();
	const subject = useSubject();
	const open = inspectorOpen(subject, { projectId, environmentId });
	const region = useRef<HTMLElement | null>(null);
	/** The control the focus came from when it last entered the rail. */
	const opener = useRef<HTMLElement | null>(null);
	/** Whether the focus is, or was when the content went away, inside the rail. */
	const focusInside = useRef(false);
	const previous = useRef<Subject | null>(null);

	useEffect(() => () => board.view.getState().setSubject(null), [board]);

	useEffect(() => {
		const before = previous.current;
		previous.current = subject;
		if (subject && !before) {
			// Opened. From the keyboard, bring the focus along.
			if (keyboardFocusOnCard()) region.current?.focus();
			return;
		}
		if (!subject && before && focusInside.current) {
			// Closed with the focus in the rail: its content is gone, so the focus would fall to the
			// page. Put it back on what the subject was about, else where the person came from.
			focusInside.current = false;
			const target = cardElementOf(before) ?? (opener.current?.isConnected ? opener.current : null);
			target?.focus();
		}
	}, [subject]);

	/** Escape closes the inspector, after leaving a field so that its typing is committed. */
	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (event.key !== "Escape" || event.defaultPrevented) return;
		const target = event.target;
		// A select, a menu or a dialog opened from here is portalled out of the rail and owns its
		// own Escape; React still bubbles the event to this handler, so ask the DOM where it was.
		if (!(target instanceof HTMLElement) || !region.current?.contains(target)) return;
		const opensPopup = target.hasAttribute("aria-haspopup") || target.getAttribute("role") === "combobox";
		if (opensPopup && target.getAttribute("aria-expanded") === "true") return;
		event.stopPropagation();
		target.blur();
		focusInside.current = true;
		board.view.getState().setSubject(null);
	};

	const onFocus = (event: FocusEvent<HTMLElement>) => {
		focusInside.current = true;
		const from = event.relatedTarget;
		if (from instanceof HTMLElement && !region.current?.contains(from)) opener.current = from;
	};

	const onBlur = (event: FocusEvent<HTMLElement>) => {
		const to = event.relatedTarget;
		// Focus that moved to something outside the rail has left it. Focus that went nowhere (the
		// focused control was removed) has not been taken anywhere yet.
		if (to instanceof HTMLElement && !region.current?.contains(to)) focusInside.current = false;
	};

	return (
		// `workspace-rail` (app/globals.css) transitions the width; `workspace-card-in` fades the
		// content in when the subject changes.
		<div
			style={{ width: open ? RAIL_W + RAIL_GAP : 0 }}
			className="workspace-rail h-full shrink-0 overflow-hidden"
			data-testid="workspace-rail"
			data-open={open ? "true" : "false"}
		>
			<div className="h-full pl-3" style={{ width: RAIL_W + RAIL_GAP }}>
				<aside
					ref={region}
					aria-label="Inspector"
					hidden={!open}
					tabIndex={-1}
					onKeyDown={onKeyDown}
					onFocus={onFocus}
					onBlur={onBlur}
					className="flex h-full flex-col overflow-hidden rounded-none border-x border-b border-border bg-background outline-none"
					style={{ width: RAIL_W }}
				>
					{open && subject && (
						<div key={subjectKey(subject)} className="workspace-card-in flex min-h-0 flex-1 flex-col">
							<Inspector
								projectId={projectId}
								environmentId={environmentId}
								destroyEnvironment={destroyEnvironment}
							/>
						</div>
					)}
					<StagedOperationsStrip />
				</aside>
			</div>
		</div>
	);
}
