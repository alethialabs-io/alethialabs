"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The board's toolbar (#6832): ONE row of tools, top-centre, in the manner of Excalidraw.
//
//   [ Select | Hand ]  [ + Add | Connect ]  [ Undo | Redo ]  [ Tidy | Fit ]  [ Run ▾ ]  [ Sources ]  [ ⌘K | ? | ⋯ ]
//
// Before it the board's controls sat in five places — a status line top-left, a cost chip, a Run
// menu, an Add button and a ⋯ menu top-right, zoom with undo and redo bottom-left, a source-repos
// card on top of those, the minimap and a provenance card sharing the bottom-right — and a person
// had to learn the corners before they could learn the product. Now a tool is here, or it is a row
// of the ⋯ menu at the end of this row, or it is in the command palette; nothing else is drawn
// over the board but the zoom controls (bottom-left) and the changes bar (bottom-centre).
//
// Every tool has an icon, an accessible name, a tooltip that names its key (read from the shortcut
// registry, so it cannot name a key the board does not bind), a pressed state when it is a toggle,
// and — when it cannot be used — a reason in place of the tooltip. A tool is never removed because
// it is unavailable: it stays where it is, disabled, and says why.
//
// On a narrow board (the inspector or the review view is open on a laptop) the row drops four
// tools — Connect, Tidy, Fit and the shortcut sheet — rather than wrap or run under the panel
// beside it. Each of the four is also a key, a row of the ⋯ menu or a row of the command palette.

import {
	Cable,
	GitBranch,
	Hand,
	Keyboard,
	LayoutGrid,
	Maximize,
	MousePointer2,
	Play,
	Plus,
	Redo2,
	Search,
	Undo2,
} from "lucide-react";
import type { KeyboardEvent } from "react";
import { useStore } from "zustand";
import { useBoard } from "@/lib/canvas/store/canvas-store-provider";
import {
	nodeIndex,
	useCanRedo,
	useCanUndo,
	useDesignNodes,
	useSelection,
} from "@/lib/canvas/store/use-board";
import { useInspectorPrefsStore } from "@/lib/stores/use-inspector-prefs-store";
import { CanvasMoreMenu } from "../canvas-more-menu";
import { RunMenu } from "../run-menu";
import { useHasDrawnNodes } from "../use-has-drawn-nodes";
import {
	SHORTCUT_CANVAS_ADD,
	SHORTCUT_CANVAS_CONNECT,
	SHORTCUT_CANVAS_FIT,
	SHORTCUT_CANVAS_HAND,
	SHORTCUT_CANVAS_PALETTE,
	SHORTCUT_CANVAS_REDO,
	SHORTCUT_CANVAS_SELECT,
	SHORTCUT_CANVAS_SHORTCUTS,
	SHORTCUT_CANVAS_TIDY,
	SHORTCUT_CANVAS_UNDO,
} from "./canvas-keys";
import {
	CONNECT_NEEDS_SERVICE,
	GOVERNED_REASON,
	NO_ENVIRONMENT,
	NOTHING_TO_FIT_REASON,
	NOTHING_TO_REDO,
	NOTHING_TO_TIDY,
	NOTHING_TO_UNDO,
} from "./reasons";
import { ToolButton, ToolSeparator } from "./tool-button";

export interface CanvasToolbarProps {
	projectId: string;
	/** The environment the board edits; absent when the page resolved none, and Run is then off. */
	environmentId?: string;
	/** A bring-your-own IaC module governs the environment: nothing can be added or connected. */
	governed: boolean;
	/** Whether the add picker is open, and how to open it. */
	addOpen: boolean;
	onAdd: () => void;
	/** Whether the command palette is open, and how to open it. */
	paletteOpen: boolean;
	onOpenPalette: () => void;
	/** Whether the shortcut sheet is open, and how to open it. */
	shortcutsOpen: boolean;
	onShowShortcuts: () => void;
	onUndo: () => void;
	onRedo: () => void;
	/** Lay the cards out again. */
	onTidy: () => void;
	onFitView: () => void;
	/** Whether this environment has sources to show (scanned repositories, an IaC module). With
	 * none, the Sources tool is not drawn: there is nothing it could open. */
	hasSources: boolean;
	sourcesOpen: boolean;
	onToggleSources: () => void;
}

/** What a toolbar's arrow keys move between: its tools, and the wrappers of its disabled ones. */
const TOOL_SELECTOR = '[data-tool]:not(:disabled), [data-slot="disabled-reason"]';

/** True when an element is drawn. An engine with no `checkVisibility` is taken to draw everything. */
function isDrawn(el: HTMLElement): boolean {
	return typeof el.checkVisibility === "function" ? el.checkVisibility() : true;
}

/**
 * Arrow keys, Home and End move the focus along the toolbar (the ARIA toolbar pattern). Tab still
 * walks every tool, so nothing depends on knowing this.
 */
function moveAlongToolbar(event: KeyboardEvent<HTMLDivElement>): void {
	const { key, currentTarget, target } = event;
	if (key !== "ArrowRight" && key !== "ArrowLeft" && key !== "Home" && key !== "End") return;
	// A menu opened from the toolbar is drawn elsewhere but is this element's React child: its
	// arrow keys are its own.
	if (!(target instanceof HTMLElement) || !currentTarget.contains(target)) return;
	const tools = Array.from(currentTarget.querySelectorAll<HTMLElement>(TOOL_SELECTOR)).filter(
		isDrawn,
	);
	if (tools.length === 0) return;
	const at = tools.findIndex((tool) => tool === target || tool.contains(target));
	const last = tools.length - 1;
	const next =
		key === "Home"
			? 0
			: key === "End"
				? last
				: key === "ArrowRight"
					? at >= last
						? 0
						: at + 1
					: at <= 0
						? last
						: at - 1;
	event.preventDefault();
	tools[next]?.focus();
}

/** The board's toolbar. See the file header for what is on it and why. */
export function CanvasToolbar({
	projectId,
	environmentId,
	governed,
	addOpen,
	onAdd,
	paletteOpen,
	onOpenPalette,
	shortcutsOpen,
	onShowShortcuts,
	onUndo,
	onRedo,
	onTidy,
	onFitView,
	hasSources,
	sourcesOpen,
	onToggleSources,
}: CanvasToolbarProps) {
	const board = useBoard();
	const handTool = useStore(board.view, (s) => s.handTool);
	const canUndo = useCanUndo();
	const canRedo = useCanRedo();
	const drawsNodes = useHasDrawnNodes();
	const selection = useSelection();
	const designNodes = useDesignNodes();
	// A connection starts from a service: the tool is live for exactly one selected service.
	const selected = selection.length === 1 ? nodeIndex(designNodes).get(selection[0] ?? "") : undefined;
	const service = selected?.data.kind === "service" ? selected : null;

	/**
	 * Open the selected service's connections, where a connection is added and what it injects is
	 * chosen. The inspector that has a Connections tab reads the tab asked for here; the one before
	 * it lists a service's bindings under Settings, so that tab is recorded for the kind as well.
	 */
	const connect = () => {
		if (!service) return;
		useInspectorPrefsStore.getState().setTab("service", "settings");
		board.view.getState().setSubject({ kind: "node", id: service.id }, "connections");
	};

	return (
		<div
			role="toolbar"
			aria-label="Canvas tools"
			aria-orientation="horizontal"
			data-slot="canvas-toolbar"
			onKeyDown={moveAlongToolbar}
			className="pointer-events-auto flex max-w-full items-center border border-border bg-card p-1 shadow-sm"
		>
			<ToolButton
				label="Select"
				shortcutId={SHORTCUT_CANVAS_SELECT}
				pressed={!handTool}
				onClick={() => board.view.getState().setHandTool(false)}
			>
				<MousePointer2 className="h-3.5 w-3.5" />
			</ToolButton>
			<ToolButton
				label="Hand tool (pan)"
				shortcutId={SHORTCUT_CANVAS_HAND}
				pressed={handTool}
				onClick={() => board.view.getState().setHandTool(true)}
			>
				<Hand className="h-3.5 w-3.5" />
			</ToolButton>

			<ToolSeparator />

			<ToolButton
				primary
				label="Add"
				shortcutId={SHORTCUT_CANVAS_ADD}
				expanded={addOpen}
				disabledReason={governed ? GOVERNED_REASON : null}
				onClick={onAdd}
			>
				<Plus className="h-3.5 w-3.5" />
				Add
			</ToolButton>
			<ToolButton
				secondary
				label="Connect the selected service"
				shortcutId={SHORTCUT_CANVAS_CONNECT}
				disabledReason={governed ? GOVERNED_REASON : service ? null : CONNECT_NEEDS_SERVICE}
				onClick={connect}
				className="ml-0.5"
			>
				<Cable className="h-3.5 w-3.5" />
			</ToolButton>

			<ToolSeparator />

			<ToolButton
				label="Undo"
				shortcutId={SHORTCUT_CANVAS_UNDO}
				disabledReason={canUndo ? null : NOTHING_TO_UNDO}
				onClick={onUndo}
			>
				<Undo2 className="h-3.5 w-3.5" />
			</ToolButton>
			<ToolButton
				label="Redo"
				shortcutId={SHORTCUT_CANVAS_REDO}
				disabledReason={canRedo ? null : NOTHING_TO_REDO}
				onClick={onRedo}
			>
				<Redo2 className="h-3.5 w-3.5" />
			</ToolButton>

			<ToolSeparator secondary />

			<ToolButton
				secondary
				label="Tidy layout"
				shortcutId={SHORTCUT_CANVAS_TIDY}
				disabledReason={drawsNodes ? null : NOTHING_TO_TIDY}
				onClick={onTidy}
			>
				<LayoutGrid className="h-3.5 w-3.5" />
			</ToolButton>
			<ToolButton
				secondary
				label="Fit view"
				shortcutId={SHORTCUT_CANVAS_FIT}
				disabledReason={drawsNodes ? null : NOTHING_TO_FIT_REASON}
				onClick={onFitView}
			>
				<Maximize className="h-3.5 w-3.5" />
			</ToolButton>

			<ToolSeparator />

			{/* Every job the platform can run on this environment: plan, audit, drift, probe. */}
			{environmentId ? (
				<RunMenu projectId={projectId} environmentId={environmentId} />
			) : (
				<ToolButton label="Run" disabledReason={NO_ENVIRONMENT} onClick={() => {}}>
					<Play className="h-3.5 w-3.5" />
				</ToolButton>
			)}

			{hasSources && (
				<ToolButton
					label="Sources"
					expanded={sourcesOpen}
					onClick={onToggleSources}
				>
					<GitBranch className="h-3.5 w-3.5" />
				</ToolButton>
			)}

			<ToolSeparator />

			<ToolButton
				label="Command palette"
				shortcutId={SHORTCUT_CANVAS_PALETTE}
				expanded={paletteOpen}
				onClick={onOpenPalette}
			>
				<Search className="h-3.5 w-3.5" />
			</ToolButton>
			<ToolButton
				secondary
				label="Keyboard shortcuts"
				shortcutId={SHORTCUT_CANVAS_SHORTCUTS}
				expanded={shortcutsOpen}
				onClick={onShowShortcuts}
			>
				<Keyboard className="h-3.5 w-3.5" />
			</ToolButton>
			{/* The environment's cost, settings and activity; how the board is drawn; the layers. */}
			<CanvasMoreMenu iacGoverned={governed} onShowShortcuts={onShowShortcuts} />
		</div>
	);
}
