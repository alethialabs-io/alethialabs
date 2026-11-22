"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The board's toolbar (#6832): ONE row of tools, top-centre, in the manner of Excalidraw.
//
//   [ prod EKS 1.31 ]  [ Select | Hand ]  [ + Add | Connect ]  [ Undo | Redo ]  [ Tidy | Fit ]  [ Run ▾ | Sources ]  [ ⌘K | ? | ⋯ ]
//
// It starts with the environment, because the first thing to know about a board is what it is a
// board OF: one environment, which is one Kubernetes cluster. The chip names it and opens its
// settings, where the cluster is sized.
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
// On a narrow board (the inspector or the review view is open on a laptop) the row gets shorter
// rather than wrap or run under the panel beside it: first it drops four tools — Connect, Tidy,
// Fit and the shortcut sheet — and then the environment chip. Each of the four is also a key, a
// row of the ⋯ menu or a row of the command palette, and the environment's settings are a row of
// the ⋯ menu.

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
import { Button } from "@repo/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/tooltip";
import { useEnvironmentStatus } from "@/lib/canvas/environment-status-context";
import { useBoard } from "@/lib/canvas/store/canvas-store-provider";
import {
	nodeIndex,
	useCanRedo,
	useCanUndo,
	useDesignNodes,
	useEffectiveProvider,
	useSelection,
} from "@/lib/canvas/store/use-board";
import { PROJECT_NODE_ID } from "@/lib/canvas/store/types";
import { getProvider } from "@/lib/cloud-providers";
import { CanvasMoreMenu } from "../canvas-more-menu";
import { SHORTCUT_BOARD_CONNECT } from "../nodes/board-shortcuts";
import { RunMenu } from "../run-menu";
import { useClusterK8sVersion } from "../use-cluster-k8s-version";
import { useHasDrawnNodes } from "../use-has-drawn-nodes";
import {
	SHORTCUT_CANVAS_ADD,
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
	/** Whether the inspector is showing the environment's Sources, and how to open or close it. */
	sourcesOpen: boolean;
	onToggleSources: () => void;
}

/**
 * What the toolbar's arrow keys move between, in the order drawn: each tool, or — for a tool that
 * is off — the focusable element `DisabledReason` wraps it in, which is the one that says why.
 */
function stopsOf(toolbar: HTMLElement): HTMLElement[] {
	const stops: HTMLElement[] = [];
	for (const tool of Array.from(toolbar.querySelectorAll<HTMLElement>("[data-tool]"))) {
		const stop = tool.matches(":disabled") ? tool.parentElement : tool;
		if (stop && isDrawn(stop)) stops.push(stop);
	}
	return stops;
}

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
	const tools = stopsOf(currentTarget);
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

/**
 * The environment this board designs: its name, and the cluster it is — the cloud's own name for a
 * managed cluster and the Kubernetes version it will deploy, when the design says. Pressing it
 * opens the environment on the rail: its settings, or, where a bring-your-own IaC module governs
 * the environment and owns those settings, where the module came from.
 *
 * Nothing here names a cloud: the cluster's name is the catalog's, for the project's cloud.
 */
function EnvironmentChip({ governed }: { governed: boolean }) {
	const board = useBoard();
	const env = useEnvironmentStatus();
	const k8s = useClusterK8sVersion();
	const provider = useEffectiveProvider(PROJECT_NODE_ID);
	const name = env.environment?.name ?? null;
	const called = name ? `Environment ${name}` : "Environment";
	const service = provider ? getProvider(provider).clusterService : null;
	const cluster = [service && service !== "—" ? service : null, k8s.version ?? null]
		.filter((part): part is string => part !== null)
		.join(" ");

	return (
		<>
			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							type="button"
							data-tool=""
							variant="ghost"
							size="sm"
							className="hidden h-8 max-w-40 rounded-none px-2 text-xs @[37rem]:inline-flex"
							aria-label={cluster ? `${called}, ${cluster}` : called}
							onClick={() =>
								board.view
									.getState()
									.setSubject({ kind: "environment" }, governed ? "sources" : undefined)
							}
						>
							<span className="truncate font-medium">{name ?? "Environment"}</span>
							{cluster && (
								<span className="shrink-0 font-mono text-ui-xs text-muted-foreground">{cluster}</span>
							)}
						</Button>
					}
				/>
				<TooltipContent side="bottom">
					{governed ? "This environment's sources" : "Environment settings"}
				</TooltipContent>
			</Tooltip>
			<span aria-hidden className="mx-1 hidden h-5 w-px shrink-0 bg-border @[37rem]:block" />
		</>
	);
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
	 * Open the selected service's Connections in the inspector, where a connection is added and
	 * what it injects is chosen. Drawing one on the board, and the `C` key's menu, are the board's.
	 */
	const connect = () => {
		if (!service) return;
		board.view.getState().setSubject({ kind: "node", id: service.id }, "connections");
	};

	return (
		<div
			role="toolbar"
			aria-label="Canvas tools"
			aria-orientation="horizontal"
			data-slot="canvas-toolbar"
			onKeyDown={moveAlongToolbar}
			className="pointer-events-auto flex max-w-full items-center overflow-x-auto border border-border bg-card p-1 shadow-sm"
		>
			<EnvironmentChip governed={governed} />

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
				shortcutId={SHORTCUT_BOARD_CONNECT}
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

			{/* Where the design came from: scanned repositories, the IaC module, attached charts. */}
			<ToolButton label="Sources" expanded={sourcesOpen} onClick={onToggleSources}>
				<GitBranch className="h-3.5 w-3.5" />
			</ToolButton>

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
