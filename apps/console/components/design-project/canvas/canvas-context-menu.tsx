"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useReactFlow, type NodeChange } from "@xyflow/react";
import {
	Copy,
	EyeOff,
	LayoutGrid,
	Maximize,
	Plus,
	Settings2,
	Shuffle,
	Trash2,
} from "lucide-react";
import { useCallback, useState } from "react";
import {
	ContextMenu,
	ContextMenuCheckboxItem,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuLabel,
	ContextMenuSeparator,
	type ContextMenuPoint,
} from "@repo/ui/context-menu";
import { arrangeBoard } from "@/lib/canvas/arrange";
import { kindFromCollectionId } from "@/lib/canvas/collections";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import type { CanvasNode, NodeKind } from "./graph/types";
import { NODE_REGISTRY } from "./graph/node-registry";

/**
 * What a right-click pointed at. `pane` is empty board; `node` is one card (a real store node or a
 * collapsed collection card); `selection` is the marquee's node set. Reachable from outside as
 * `CanvasContextMenuState["target"]`, so it is not exported on its own.
 */
type CanvasContextTarget =
	| { kind: "pane" }
	| { kind: "node"; nodeId: string }
	| { kind: "selection"; ids: string[] };

/** An open context menu: what it points at, and where the pointer was (viewport CSS pixels). */
export interface CanvasContextMenuState {
	target: CanvasContextTarget;
	point: ContextMenuPoint;
}

/**
 * The only parts of a mouse event this menu reads: where the pointer was, what it was over, and the
 * ability to suppress the browser's own menu. Declared structurally rather than as
 * `React.MouseEvent` because React Flow hands the pane handler a NATIVE `MouseEvent` on one of its
 * two paths (see `CanvasFlowProps.onPaneContextMenu`) — and because a handler that names only what
 * it uses is one a test can call without fabricating a synthetic event.
 */
export interface CanvasPointerEvent {
	clientX: number;
	clientY: number;
	target: EventTarget | null;
	preventDefault: () => void;
}

/** What `useCanvasContextMenu` hands back: the state, the three React Flow handlers, and a close. */
export interface CanvasContextMenuController {
	state: CanvasContextMenuState | null;
	close: () => void;
	onPaneContextMenu: (event: CanvasPointerEvent) => void;
	onNodeContextMenu: (event: CanvasPointerEvent, node: { id: string }) => void;
	onSelectionContextMenu: (
		event: CanvasPointerEvent,
		nodes: { id: string }[],
	) => void;
}

/**
 * Which store nodes a right-clicked card stands for. A real card is itself; a collapsed collection
 * card (the Secrets vault) has no store row, so it stands for every member of its kind.
 */
function targetIdsFor(nodeId: string, nodes: CanvasNode[]): string[] {
	const collection = kindFromCollectionId(nodeId);
	if (!collection) return [nodeId];
	return nodes.filter((n) => n.data.kind === collection).map((n) => n.id);
}

/**
 * The menu's OPEN state and the three React Flow events that produce it. Held here — by the canvas,
 * in component state — and never in the canvas store: which menu is showing is view interaction, not
 * design state, exactly like the hand tool (`CanvasInteractionContext`).
 *
 * A right-click on a node also SELECTS it, exclusively: the menu's Remove/Duplicate act on what the
 * pointer named, so the board has to agree with the menu about what that is. Selection is written as
 * `select` node changes through the store's `onNodesChange`, the same path a click takes.
 *
 * Setting a new state while one is open simply replaces it — the menu moves to the new point with
 * the new items rather than needing an explicit close first.
 */
export function useCanvasContextMenu(): CanvasContextMenuController {
	const [state, setState] = useState<CanvasContextMenuState | null>(null);

	/** Dismiss the menu (Escape, an outside press, or after an item runs). */
	const close = useCallback(() => setState(null), []);

	const onPaneContextMenu = useCallback(
		(event: CanvasPointerEvent) => {
			// React Flow 12 reaches this from TWO places depending on `panOnDrag`: with the board's
			// `[1, 2]` it is d3-zoom's pan-END for a right-press that did not move (a real right-DRAG
			// pans and never lands here), and the event is the native mouseup; with `panOnDrag === true`
			// (hand tool / Space) it is the pane's own DOM `contextmenu`, which React Flow does not
			// preventDefault for us. So preventDefault unconditionally — it is a no-op on the mouseup.
			event.preventDefault();
			// The pan-end path fires for a right-press anywhere over the renderer, and a node that is
			// not draggable carries no `nopan` to stop it. Ignore anything that started on a card or on
			// the selection rect: those have their own menus.
			const target = event.target;
			if (
				target instanceof Element &&
				target.closest(".react-flow__node, .react-flow__nodesselection")
			) {
				return;
			}
			setState({
				target: { kind: "pane" },
				point: { x: event.clientX, y: event.clientY },
			});
		},
		[],
	);

	const onNodeContextMenu = useCallback(
		(event: CanvasPointerEvent, node: { id: string }) => {
			// Nothing in React Flow suppresses the browser menu on a card — only the pane gets that.
			event.preventDefault();
			const { nodes, onNodesChange } = useCanvasStore.getState();
			const ids = targetIdsFor(node.id, nodes);
			const changes: NodeChange<CanvasNode>[] = nodes.map((n) => ({
				id: n.id,
				type: "select",
				selected: ids.includes(n.id),
			}));
			onNodesChange(changes);
			setState({
				target: { kind: "node", nodeId: node.id },
				point: { x: event.clientX, y: event.clientY },
			});
		},
		[],
	);

	const onSelectionContextMenu = useCallback(
		(event: CanvasPointerEvent, nodes: { id: string }[]) => {
			event.preventDefault();
			setState({
				target: { kind: "selection", ids: nodes.map((n) => n.id) },
				point: { x: event.clientX, y: event.clientY },
			});
		},
		[],
	);

	return {
		state,
		close,
		onPaneContextMenu,
		onNodeContextMenu,
		onSelectionContextMenu,
	};
}

export interface CanvasContextMenuProps {
	/** The open menu, or null. Comes from `useCanvasContextMenu`. */
	state: CanvasContextMenuState | null;
	/** Dismiss — Escape, an outside press, or an item that ran. */
	onClose: () => void;
	/** A BYO-IaC source governs this environment (replace mode): the design is inert, so no add. */
	iacGoverned: boolean;
	/** Open the Add palette. Owned by the canvas, which also owns the palette's open state. */
	onAddService: () => void;
}

/**
 * The canvas right-click menu — one component for all three targets.
 *
 * Right-click did nothing on this board, and the board is where right-drag PANS, so the gesture
 * read as broken rather than absent. Every entry here already existed somewhere else (the ⋯ menu,
 * the inspector's danger zone, the ⌘K palette); what it did not have was a way to act on the card
 * under the pointer without opening its card first.
 *
 * There is deliberately no Paste. The canvas has no clipboard model, and a disabled-forever Paste
 * is a menu telling the user about a feature that does not exist.
 */
export function CanvasContextMenu({
	state,
	onClose,
	iacGoverned,
	onAddService,
}: CanvasContextMenuProps) {
	const { fitView } = useReactFlow();
	const nodes = useCanvasStore((s) => s.nodes);
	const openCard = useCanvasStore((s) => s.openCard);
	const removeNodes = useCanvasStore((s) => s.removeNodes);
	const duplicateNodes = useCanvasStore((s) => s.duplicateNodes);
	const toggleKindVisibility = useCanvasStore((s) => s.toggleKindVisibility);
	const repairOverlaps = useCanvasStore((s) => s.repairOverlaps);
	const showConnections = useCanvasStore((s) => s.showConnections);
	const toggleConnections = useCanvasStore((s) => s.toggleConnections);

	const target = state?.target ?? null;

	return (
		<ContextMenu
			open={state !== null}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			anchor={state?.point ?? null}
		>
			<ContextMenuContent className="w-56">
				{target?.kind === "node" && (
					<NodeItems
						nodeId={target.nodeId}
						nodes={nodes}
						openCard={openCard}
						removeNodes={removeNodes}
						duplicateNodes={duplicateNodes}
						toggleKindVisibility={toggleKindVisibility}
					/>
				)}

				{target?.kind === "selection" && (
					<SelectionItems
						ids={target.ids}
						nodes={nodes}
						removeNodes={removeNodes}
						duplicateNodes={duplicateNodes}
					/>
				)}

				{target?.kind === "pane" && (
					<>
						<ContextMenuItem disabled={iacGoverned} onSelect={onAddService}>
							<Plus className="mr-2 h-4 w-4 text-muted-foreground" />
							Add service…
						</ContextMenuItem>
						<ContextMenuSeparator />
						<ContextMenuItem onSelect={() => void arrangeBoard(fitView)}>
							<LayoutGrid className="mr-2 h-4 w-4 text-muted-foreground" />
							Auto-arrange
						</ContextMenuItem>
						<ContextMenuItem onSelect={() => repairOverlaps()}>
							<Shuffle className="mr-2 h-4 w-4 text-muted-foreground" />
							Repair overlaps
						</ContextMenuItem>
						<ContextMenuItem onSelect={() => void fitView({ padding: 0.3 })}>
							<Maximize className="mr-2 h-4 w-4 text-muted-foreground" />
							Fit view
						</ContextMenuItem>
						<ContextMenuSeparator />
						<ContextMenuCheckboxItem
							checked={showConnections}
							onCheckedChange={() => toggleConnections()}
						>
							Show connections
						</ContextMenuCheckboxItem>
					</>
				)}
			</ContextMenuContent>
		</ContextMenu>
	);
}

/**
 * The menu for one card. `nodeId` may be a collapsed collection card, which has no store row: it
 * then reads as its kind (Configure opens the vault's panel, Hide hides the kind) with Remove and
 * Duplicate off, because a single gesture must not destroy or clone forty secrets.
 */
function NodeItems({
	nodeId,
	nodes,
	openCard,
	removeNodes,
	duplicateNodes,
	toggleKindVisibility,
}: {
	nodeId: string;
	nodes: CanvasNode[];
	openCard: (card: { kind: "inspector"; nodeId: string }) => void;
	removeNodes: (ids: string[]) => void;
	duplicateNodes: (ids: string[]) => void;
	toggleKindVisibility: (kind: NodeKind) => void;
}) {
	const node = nodes.find((n) => n.id === nodeId);
	const kind: NodeKind | null = node?.data.kind ?? kindFromCollectionId(nodeId);
	const def = kind ? NODE_REGISTRY[kind] : null;
	// `deletable: false` marks the out-of-band cards (charts, described workloads, add-ons, BYO-IaC
	// resources): they are removed by their own action, not by the design's delete path. The store's
	// `removeNodes` already refuses them — the menu says so instead of offering a no-op.
	const canRemove = !!node && node.deletable !== false;
	const canDuplicate = !!node && def?.cardinality === "array";

	return (
		<>
			{def && <ContextMenuLabel>{def.label}</ContextMenuLabel>}
			<ContextMenuItem
				onSelect={() => openCard({ kind: "inspector", nodeId })}
			>
				<Settings2 className="mr-2 h-4 w-4 text-muted-foreground" />
				Configure
			</ContextMenuItem>
			{canDuplicate && (
				<ContextMenuItem onSelect={() => duplicateNodes([nodeId])}>
					<Copy className="mr-2 h-4 w-4 text-muted-foreground" />
					Duplicate
				</ContextMenuItem>
			)}
			{kind && (
				<ContextMenuItem onSelect={() => toggleKindVisibility(kind)}>
					<EyeOff className="mr-2 h-4 w-4 text-muted-foreground" />
					Hide {def?.label ?? kind}
				</ContextMenuItem>
			)}
			<ContextMenuSeparator />
			<ContextMenuItem
				variant="destructive"
				disabled={!canRemove}
				onSelect={() => removeNodes([nodeId])}
			>
				<Trash2 className="mr-2 h-4 w-4" />
				Remove
			</ContextMenuItem>
		</>
	);
}

/**
 * The menu for a marquee selection. Duplicate and Remove are the two verbs that mean anything for a
 * set; each is off when the store would refuse every member of it (all singletons / all
 * non-deletable), so a disabled row is the honest form of "this set cannot be cloned".
 */
function SelectionItems({
	ids,
	nodes,
	removeNodes,
	duplicateNodes,
}: {
	ids: string[];
	nodes: CanvasNode[];
	removeNodes: (ids: string[]) => void;
	duplicateNodes: (ids: string[]) => void;
}) {
	const selected = nodes.filter((n) => ids.includes(n.id));
	const canDuplicate = selected.some(
		(n) => NODE_REGISTRY[n.data.kind].cardinality === "array",
	);
	const canRemove = selected.some((n) => n.deletable !== false);

	return (
		<>
			<ContextMenuLabel>{ids.length} selected</ContextMenuLabel>
			<ContextMenuItem
				disabled={!canDuplicate}
				onSelect={() => duplicateNodes(ids)}
			>
				<Copy className="mr-2 h-4 w-4 text-muted-foreground" />
				Duplicate
			</ContextMenuItem>
			<ContextMenuSeparator />
			<ContextMenuItem
				variant="destructive"
				disabled={!canRemove}
				onSelect={() => removeNodes(ids)}
			>
				<Trash2 className="mr-2 h-4 w-4" />
				Remove
			</ContextMenuItem>
		</>
	);
}
