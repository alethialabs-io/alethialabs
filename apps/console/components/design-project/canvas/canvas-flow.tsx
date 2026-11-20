"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	Background,
	BackgroundVariant,
	MiniMap,
	NodeToolbar,
	Position,
	ReactFlow,
	type AriaLabelConfig,
	type EdgeTypes,
	type NodeChange,
	type NodeTypes,
	type ReactFlowInstance,
} from "@xyflow/react";
import { typedKeys } from "@/lib/typed-object";
import "@xyflow/react/dist/style.css";
import { cn } from "@repo/ui/utils";
import { Check, X } from "lucide-react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type MouseEvent as ReactMouseEvent,
} from "react";
import {
	buildRenderNodes,
	collectionNodeId,
	kindFromCollectionId,
	type BoardNode,
} from "@/lib/canvas/collections";
import { useEnvironmentStatus } from "@/lib/canvas/environment-status-context";
import { useBoard } from "@/lib/canvas/store/canvas-store-provider";
import { nodeIndex, usePendingChanges } from "@/lib/canvas/store/use-board";
import { useShortcut } from "@/lib/shortcuts/use-shortcut";
import { OUT_OF_BAND, useCanvasStore } from "@/lib/stores/use-canvas-store";
import { configName } from "./graph/node-config";
import type { CanvasNode, NodeKind } from "./graph/types";
import { addableKindsFor, NODE_REGISTRY } from "./graph/node-registry";
import { ChartNode } from "./nodes/chart-node";
import { CollectionNode } from "./nodes/collection-node";
import { ServiceNode } from "./nodes/service-node";
import {
	SHORTCUT_BOARD_CONNECT,
	SHORTCUT_BOARD_OPEN,
	SHORTCUT_BOARD_REMOVE,
	SHORTCUT_BOARD_REMOVE_BACKSPACE,
} from "./nodes/board-shortcuts";
import { BoardMarksContext, type BoardMarks, type PendingMarkOp } from "./nodes/card-marks";
import { boardCardName, cardDescriptionId } from "./nodes/node-name";
import { BindingEdge } from "./edges/binding-edge";
import {
	buildBoardEdges,
	cardTitles,
	connectionsByCard,
	type BoardEdge,
} from "./edges/board-edges";
import { ChartBindingEdge } from "./edges/chart-binding-edge";
import { ConnectMenu, type ConnectMenuState } from "./edges/connect-menu";
import { BoardConnectionsContext } from "./edges/connection-context";
import {
	BINDABLE_KINDS,
	bindingsBehindEdge,
	bindingsOf,
	connectableTargets,
	evaluateConnection,
	nodeTitle,
	withBinding,
	withoutBindings,
	type BindableKind,
	type BindingTargetRef,
	type ConnectionVerdict,
} from "./edges/connection-rules";
import { DependencyEdge } from "./edges/dependency-edge";
import { GatedEdge } from "./edges/gated-edge";

// Every registry kind renders through the ONE data-driven card (ServiceNode → BaseNode), which
// reads its facts + handles from NODE_REGISTRY — so a new kind is picked up here automatically and
// this map can't drift from the SSOT. `chart` keeps its own component: BYO charts are persisted
// out-of-band and carry detach / rescan actions, so they're more than a card.
// Defined at module scope so React Flow doesn't warn about new objects per render.
const nodeTypes: NodeTypes = {
	...Object.fromEntries(
		typedKeys(NODE_REGISTRY).map((kind) => [kind, ServiceNode]),
	),
	chart: ChartNode,
	// The collapsed card for a high-cardinality kind (the Secrets vault). Synthetic — it has no
	// store row; `buildRenderNodes` creates it from the members.
	collection: CollectionNode,
};

const edgeTypes: EdgeTypes = {
	dependency: DependencyEdge,
	gated: GatedEdge,
	// W3 — a service's dotted "consumes" edge to a backing resource it binds to.
	binding: BindingEdge,
	// W5 Path A — a described chart workload's dotted binding edge to a backing resource.
	cw_binding: ChartBindingEdge,
};

/**
 * Canvas traversal mode (Excalidraw/Miro model). `handTool` is the toolbar/`H` hand tool (a sticky
 * pan mode); `spaceHeld` is the transient Space-to-pan. Either makes left-drag pan the pane and
 * shows a grab cursor; otherwise left-drag marquee-selects. Provided by `DesignProjectCanvas`
 * (which owns the state + the keyboard listeners) and consumed by the board + the controls — the
 * canvas store is deliberately not touched (this is view interaction, not design state).
 */
export interface CanvasInteraction {
	handTool: boolean;
	setHandTool: (next: boolean) => void;
	spaceHeld: boolean;
}
export const CanvasInteractionContext = createContext<CanvasInteraction>({
	handTool: false,
	setHandTool: () => {},
	spaceHeld: false,
});

export interface CanvasFlowProps {
	/**
	 * Right-click on empty board. React Flow 12 does NOT hand this to you from the DOM
	 * `contextmenu` event while `panOnDrag` is the array below: `Pane`'s own handler sees a
	 * `panOnDrag` containing button 2, calls `preventDefault()` and returns. What calls this
	 * instead is d3-zoom's pan-END, with the native **mouseup** of a right-press that did not move
	 * — so a right-DRAG pans and opens nothing, which is the behaviour the hand-tool board needs.
	 * With `panOnDrag === true` (hand tool / Space held) that array test fails and the pane's DOM
	 * `contextmenu` reaches you as a React event with no `preventDefault()` applied. Hence the
	 * `ReactMouseEvent | MouseEvent` union — React Flow's own type for this prop.
	 */
	onPaneContextMenu?: (event: ReactMouseEvent | MouseEvent) => void;
	/** Right-click on a card. A real React `contextmenu` from the node's wrapper; nothing has
	 * suppressed the browser menu, so the handler must. */
	onNodeContextMenu?: (event: ReactMouseEvent, node: BoardNode) => void;
	/** Right-click on the marquee selection rect. A real React `contextmenu`, same caveat. */
	onSelectionContextMenu?: (event: ReactMouseEvent, nodes: BoardNode[]) => void;
}


/** The board's React Flow id. React Flow builds the ids of its own description nodes from it. */
const BOARD_ID = "architecture-board";

/** The id of React Flow's "how to use a card" description, which every card also points at. */
const CARD_HELP_ID = `react-flow__node-desc-${BOARD_ID}`;

/**
 * What React Flow says about its own controls, rewritten for THIS board's key map. Its defaults
 * describe a board where Delete removes a node through React Flow and where there is no inspector.
 */
const BOARD_ARIA_LABELS: Partial<AriaLabelConfig> = {
	"node.a11yDescription.default":
		"Press Enter to open this card in the inspector. Arrow keys move it, and Shift makes the step larger. Delete removes it. On a service, press C to connect it to another card.",
	"node.a11yDescription.keyboardDisabled":
		"Press Enter to open this card in the inspector. Arrow keys move it, and Shift makes the step larger. Delete removes it. On a service, press C to connect it to another card.",
	"node.a11yDescription.ariaLiveMessage": ({ direction }) => `Moved ${direction}.`,
	"edge.a11yDescription.default":
		"Press Enter to open this connection in the inspector, or Delete to remove it.",
	"handle.ariaLabel": "Connection handle",
};

/** The focus ring a card's wrapper shows: the same ring every button in the console shows. */
const CARD_FOCUS_CLASS = "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

/** The dotted line a connection wears while it is being dragged: the binding edge's own stroke. */
const CONNECTION_LINE_STYLE = {
	stroke: "var(--foreground, #111)",
	strokeWidth: 1.5,
	strokeDasharray: "1 4",
};

/** How long a refusal stays next to the card it is about. */
const NOTICE_MS = 6000;

/** What the board says next to a card after a connection was refused. */
interface BoardNotice {
	nodeId: string;
	text: string;
}

/** The cards as React Flow receives them, by the board node each was made from. */
const boardCards = new WeakMap<BoardNode, BoardNode>();

/**
 * A board node as React Flow receives it: focusable, named, and pointing at its own description.
 * The same input object gives the same output object, so a card that did not change is not a new
 * node to React Flow — which is what keeps a drag from re-rendering every card.
 */
function boardCard(node: BoardNode): BoardNode {
	const cached = boardCards.get(node);
	if (cached) return cached;
	const card: BoardNode = {
		...node,
		focusable: true,
		className: CARD_FOCUS_CLASS,
		// The NAME is the card's two visible identifiers and nothing else; its status, its marks and
		// its connections are the DESCRIPTION, rendered by the card itself, followed by React Flow's
		// own "how to use a card".
		ariaLabel: boardCardName(node),
		domAttributes: {
			"aria-describedby": `${cardDescriptionId(node.id)} ${CARD_HELP_ID}`,
		},
	};
	boardCards.set(node, card);
	return card;
}

let lastDesign: CanvasNode[] = [];

/**
 * `nodes`, or the list last passed in when the two hold the same ids with the same data. A drag
 * gives the board a new array on every frame with the same design in it; everything the board
 * derives from the DESIGN (names, edges, marks) is keyed on this, so a drag derives nothing.
 */
function designFacts(nodes: CanvasNode[]): CanvasNode[] {
	if (
		nodes.length === lastDesign.length &&
		nodes.every((n, i) => n.id === lastDesign[i].id && n.data === lastDesign[i].data)
	) {
		return lastDesign;
	}
	lastDesign = nodes;
	return nodes;
}

/** True for the four keys React Flow moves a selected card with. */
function isArrowKey(key: string): boolean {
	return key === "ArrowUp" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowRight";
}

/** What a focus or key event on the board landed on: a card, a connection, or neither. */
function boardTarget(target: EventTarget | null): { type: "node" | "edge"; id: string } | null {
	if (!(target instanceof Element)) return null;
	const id = target.getAttribute("data-id");
	if (!id) return null;
	// Only the card or the line ITSELF. A button inside a card keeps its own keys.
	if (target.classList.contains("react-flow__node")) return { type: "node", id };
	if (target.classList.contains("react-flow__edge")) return { type: "edge", id };
	return null;
}

/**
 * True when a card or connection took the focus from the keyboard rather than from a press: the
 * browser's own answer, or — where it has none — whether the last input on the board was a key.
 */
function focusedByKeyboard(target: EventTarget, pointerLast: boolean): boolean {
	if (!pointerLast) return true;
	try {
		return target instanceof Element && target.matches(":focus-visible");
	} catch {
		return false;
	}
}

/** The element a connection was released over. A touch reports where it STARTED, so ask the page. */
function elementUnder(event: MouseEvent | TouchEvent): Element | null {
	if ("changedTouches" in event) {
		const touch = event.changedTouches[0];
		return touch ? document.elementFromPoint(touch.clientX, touch.clientY) : null;
	}
	return event.target instanceof Element ? event.target : null;
}

/** Where a connection was released, in viewport pixels. */
function releasePoint(event: MouseEvent | TouchEvent): { x: number; y: number } {
	if ("changedTouches" in event) {
		const touch = event.changedTouches[0];
		return { x: touch?.clientX ?? 0, y: touch?.clientY ?? 0 };
	}
	return { x: event.clientX, y: event.clientY };
}

/**
 * The React Flow surface, controlled by the canvas store.
 *
 * W2 — the board is a flat graph of workloads + backing infra. It draws NO region frames: one
 * environment IS one cluster (inside one VPC), so the cluster/network aren't drawn as containers or
 * cards — they're env settings (the toolbar "Cluster & network" sheet). This retired the whole
 * zone/container machinery (`lib/canvas/zones.ts`): the old VPC/cluster regions existed only to
 * explain a substrate that is now implicit. Edges are the derived service→resource bindings (the
 * cluster→leaf dependency spine went with the cluster node).
 *
 * #6835 — the board is where a connection is MADE, not only shown. A line dragged from a service's
 * handle to a card adds that service's binding as one undo step; a line that cannot be made says
 * why while the pointer is over the card and again on release; a line released on empty board
 * offers what it could connect to. Lines are selected and removed by pointer and by key. Every card
 * and line is a named focus stop, and nothing here needs a pointer.
 *
 * The node SET is still read through the legacy store selector, because the cards the design does
 * not own are mirrored there until the shell stops copying them; every write goes to the board's
 * document store, and everything derived here is keyed on the design, never on a card's position.
 */
export function CanvasFlow({
	onPaneContextMenu,
	onNodeContextMenu,
	onSelectionContextMenu,
}: CanvasFlowProps = {}) {
	const board = useBoard();
	const nodes = useCanvasStore((s) => s.nodes);
	const edges = useCanvasStore((s) => s.edges);
	const onNodesChange = useCanvasStore((s) => s.onNodesChange);
	const openInspector = useCanvasStore((s) => s.openInspector);
	const showConnections = useCanvasStore((s) => s.showConnections);
	const hiddenKinds = useCanvasStore((s) => s.hiddenKinds);
	const collectionPositions = useCanvasStore((s) => s.collectionPositions);
	const pendingChanges = usePendingChanges();

	// Traversal mode: the hand tool or a held Space turns left-drag into a pan (Excalidraw/Miro);
	// otherwise left-drag marquee-selects. Middle/right mouse always pan.
	const { handTool, spaceHeld } = useContext(CanvasInteractionContext);
	const panning = handTool || spaceHeld;

	// When a bring-your-own IaC module governs this environment it REPLACES the template (v1 replace
	// mode), so the component design is INERT — it will never be applied. It's HIDDEN, not deleted:
	// the store still holds it, so detaching the source brings it straight back.
	const iacGoverned = useEnvironmentStatus().iac !== null;

	// View state that belongs to the board alone. An edge is derived, so it has no row to hold a
	// `selected` flag; a collection card has no row either.
	const [selectedEdges, setSelectedEdges] = useState<string[]>([]);
	const [selectedCollections, setSelectedCollections] = useState<NodeKind[]>([]);
	/** The card or connection that holds the keyboard focus: `node:<id>`, `edge:<id>` or null. */
	const [focused, setFocused] = useState<string | null>(null);
	const [connectingFrom, setConnectingFrom] = useState<string | null>(null);
	const [hoveredId, setHoveredId] = useState<string | null>(null);
	const [notice, setNotice] = useState<BoardNotice | null>(null);
	const [announcement, setAnnouncement] = useState({ text: "", serial: 0 });
	const [menu, setMenu] = useState<ConnectMenuState | null>(null);

	const flow = useRef<ReactFlowInstance<BoardNode, BoardEdge> | null>(null);
	const wrapper = useRef<HTMLDivElement>(null);
	/** The service a connection is being dragged from. A ref as well: the release reads it. */
	const connecting = useRef<string | null>(null);
	/** True once `onConnect` has dealt with a connection, so `onConnectEnd` does not do it again. */
	const connectionHandled = useRef(false);
	/** True while an arrow key is held on the board. */
	const arrowHeld = useRef(false);
	/** The store nodes moved by the arrow keys since the last key release. */
	const keyMoved = useRef(new Set<string>());
	/** True from the first card moved by a held arrow key until that key is released. */
	const keyMoving = useRef(false);
	/** True when the last input on the board was a pointer press rather than a key. */
	const pointerLast = useRef(false);

	const design = designFacts(nodes);

	// Visibility layers hide whole node groups; connections toggle hides all edges. The project root
	// (data anchor: name/region/core identity) and the cluster + network (env-level substrate, edited
	// as settings) are never drawn — they persist as hidden store nodes so graphToForm/the deploy
	// snapshot are byte-identical. Edges to/from a hidden node are dropped so none dangle.
	const drawnNodes = useMemo(
		() =>
			nodes.filter(
				(n) =>
					n.data.kind !== "project" &&
					n.data.kind !== "cluster" &&
					n.data.kind !== "network" &&
					!hiddenKinds.includes(n.data.kind) &&
					!(iacGoverned && !OUT_OF_BAND.has(n.data.kind)),
			),
		[nodes, hiddenKinds, iacGoverned],
	);

	// High-cardinality kinds (secrets) collapse into ONE card. This is a VIEW transform only — the
	// store keeps a node per resource, so the diff / status / persistence machinery is untouched.
	const cards = useMemo(
		() => buildRenderNodes(drawnNodes, collectionPositions, selectedCollections).map(boardCard),
		[drawnNodes, collectionPositions, selectedCollections],
	);

	// A collapsed member has no card of its own, so an edge pointing at it would dangle: each edge is
	// re-pointed at the card that shows its end, the copies folded into one line. Keyed on which
	// cards are drawn — a string, so the key does not change while a card is only being moved.
	const cardIdKey = cards.map((n) => n.id).join("\n");
	const boardEdges = useMemo(
		() =>
			showConnections ? buildBoardEdges(edges, design, new Set(cardIdKey.split("\n"))) : [],
		[showConnections, edges, design, cardIdKey],
	);
	const visibleEdges = useMemo(
		() =>
			selectedEdges.length === 0
				? boardEdges
				: boardEdges.map((e) => (selectedEdges.includes(e.id) ? { ...e, selected: true } : e)),
		[boardEdges, selectedEdges],
	);

	// What every card needs to know about the rest of the board: which nodes have a pending change
	// and what each card is connected to. Worked out once here, read by id in each card.
	const marks = useMemo<BoardMarks>(() => {
		const pending = new Map<string, PendingMarkOp>();
		for (const change of pendingChanges) {
			if (change.op !== "removed") pending.set(change.id, change.op);
		}
		return { pending, connections: connectionsByCard(boardEdges, cardTitles(design)) };
	}, [pendingChanges, boardEdges, design]);

	/** Say `text` to a screen reader. The serial makes the same sentence announce twice in a row. */
	const announce = useCallback((text: string) => {
		setAnnouncement((previous) => ({ text, serial: previous.serial + 1 }));
	}, []);

	/** A connection was refused: say why next to the card it is about, and to a screen reader. */
	const refuse = useCallback(
		(nodeId: string, text: string) => {
			setNotice({ nodeId, text });
			announce(text);
		},
		[announce],
	);

	// A refusal is read and then gets out of the way.
	useEffect(() => {
		if (!notice) return;
		const timer = setTimeout(() => setNotice(null), NOTICE_MS);
		return () => clearTimeout(timer);
	}, [notice]);

	/** The DOM element of a card, by its id. */
	const cardElement = useCallback((id: string): HTMLElement | null => {
		const found = [...(wrapper.current?.querySelectorAll<HTMLElement>(".react-flow__node") ?? [])];
		return found.find((el) => el.getAttribute("data-id") === id) ?? null;
	}, []);

	/** Put the keyboard focus back on a card, once the board has drawn whatever just changed. */
	const focusCard = useCallback(
		(id: string) => {
			requestAnimationFrame(() => cardElement(id)?.focus());
		},
		[cardElement],
	);

	/** Add one binding to a service, as ONE undo step, and open the service's connections. */
	const bind = useCallback(
		(sourceId: string, target: BindingTargetRef, targetTitle: string) => {
			const doc = board.document.getState();
			const source = nodeIndex(doc.designNodes).get(sourceId);
			if (!source) return;
			// `transact`, not a bare edit: two connections made within a second are two steps to undo,
			// where two edits of the same field would have been folded into one.
			doc.transact("connect", () => {
				board.document
					.getState()
					.updateNodeConfig(sourceId, { bindings: withBinding(bindingsOf(source), target) });
			});
			setNotice(null);
			// The line is drawn; what it injects is the person's next choice, and that is made here.
			board.view.getState().setSubject({ kind: "node", id: sourceId }, "connections");
			announce(
				`Connected ${nodeTitle(source)} to ${targetTitle}. Choose what it injects in the inspector.`,
			);
		},
		[board, announce],
	);

	/** Add a card of `kind` at `position` AND the binding to it, as ONE undo step. */
	const createAndBind = useCallback(
		(sourceId: string, kind: BindableKind, position: { x: number; y: number }) => {
			const doc = board.document.getState();
			const source = nodeIndex(doc.designNodes).get(sourceId);
			if (!source) return;
			let createdTitle = "";
			doc.transact("connect", () => {
				const { id } = board.document
					.getState()
					.addNodeWithConfig(kind, undefined, null, position, null);
				const created = nodeIndex(board.document.getState().designNodes).get(id);
				const name = created ? configName(created.data) : undefined;
				if (!created || !name) return;
				createdTitle = nodeTitle(created);
				board.document.getState().updateNodeConfig(sourceId, {
					bindings: withBinding(bindingsOf(source), { kind, name }),
				});
			});
			if (!createdTitle) return;
			setNotice(null);
			board.view.getState().setSubject({ kind: "node", id: sourceId }, "connections");
			announce(
				`Added ${createdTitle} and connected ${nodeTitle(source)} to it. Choose what it injects in the inspector.`,
			);
		},
		[board, announce],
	);

	/** Open the connect menu for a service, or say why there is nothing to offer. */
	const openConnectMenu = useCallback(
		(options: {
			sourceId: string;
			point: { x: number; y: number };
			position: { x: number; y: number };
			fromKeyboard: boolean;
			/** Offer only these cards and this kind: the members of the vault the line ended on. */
			only?: { kind: BindableKind; candidateIds: string[] };
		}) => {
			const current = useCanvasStore.getState();
			const source = current.nodes.find((n) => n.id === options.sourceId);
			if (!source) return;
			const sourceName = configName(source.data) || nodeTitle(source);
			const offered = options.only
				? current.nodes.filter((n) => options.only?.candidateIds.includes(n.id))
				: connectableTargets(current.nodes, options.sourceId);
			// What can be ADDED is the catalogue's answer for this cloud, and nothing while a
			// bring-your-own module governs the environment.
			const addable = iacGoverned
				? []
				: addableKindsFor(current.getEffectiveProvider(options.sourceId));
			const kinds = BINDABLE_KINDS.filter(
				(kind) => addable.includes(kind) && (!options.only || options.only.kind === kind),
			);
			if (offered.length === 0 && kinds.length === 0) {
				refuse(
					options.sourceId,
					`There is nothing to connect ${sourceName} to. Add a database, cache, queue or secret first.`,
				);
				return;
			}
			setNotice(null);
			setMenu({
				point: options.point,
				sourceId: options.sourceId,
				sourceName,
				targets: offered.map((n) => ({ id: n.id, kind: n.data.kind, title: nodeTitle(n) })),
				kinds,
				position: options.position,
				fromKeyboard: options.fromKeyboard,
			});
		},
		[iacGoverned, refuse],
	);

	/** Act on what a connection would do: make it, ask which one, or say why not. */
	const resolveConnection = useCallback(
		(
			verdict: ConnectionVerdict,
			at: { point: { x: number; y: number }; fallbackNodeId: string },
		) => {
			if (verdict.outcome === "refused") {
				refuse(at.fallbackNodeId, verdict.reason);
				return;
			}
			if (verdict.outcome === "bind") {
				const target = useCanvasStore.getState().nodes.find((n) => n.id === verdict.targetId);
				bind(verdict.sourceId, verdict.target, target ? nodeTitle(target) : verdict.target.name);
				return;
			}
			openConnectMenu({
				sourceId: verdict.sourceId,
				point: at.point,
				position: flow.current?.screenToFlowPosition(at.point) ?? { x: 0, y: 0 },
				fromKeyboard: false,
				only: { kind: verdict.kind, candidateIds: verdict.candidateIds },
			});
		},
		[bind, openConnectMenu, refuse],
	);

	/** Remove the bindings the given edges stand for, as ONE undo step. */
	const removeConnections = useCallback(
		(edgeIds: string[]) => {
			const targets = boardEdges.filter((e) => edgeIds.includes(e.id));
			const locked = targets.find((e) => e.data?.locked);
			if (locked?.data?.locked) {
				refuse(locked.source, locked.data.locked);
				return;
			}
			const current = useCanvasStore.getState().nodes;
			const bySource = new Map<string, BindingTargetRef[]>();
			for (const edge of targets) {
				const refs = bindingsBehindEdge(current, edge.source, edge.target);
				bySource.set(edge.source, [...(bySource.get(edge.source) ?? []), ...refs]);
			}
			const removed = [...bySource.values()].reduce((n, refs) => n + refs.length, 0);
			if (removed === 0) return;
			const doc = board.document.getState();
			doc.transact("disconnect", () => {
				for (const [sourceId, refs] of bySource) {
					const source = nodeIndex(board.document.getState().designNodes).get(sourceId);
					board.document.getState().updateNodeConfig(sourceId, {
						bindings: withoutBindings(bindingsOf(source), refs),
					});
				}
			});
			setSelectedEdges([]);
			announce(
				removed === 1
					? "Connection removed. Undo brings it back."
					: `${removed} connections removed. Undo brings them back.`,
			);
			// The line that held the focus is gone; the service it started from is the nearest thing.
			const first = targets[0];
			if (first) focusCard(first.source);
		},
		[board, boardEdges, announce, refuse, focusCard],
	);

	const connections = useMemo(
		() => ({ remove: (edgeId: string) => removeConnections([edgeId]) }),
		[removeConnections],
	);

	/** End a move made with the arrow keys: one undo step and one draft write for the whole hold. */
	const endKeyboardMove = useCallback(() => {
		arrowHeld.current = false;
		// Only a move the KEYS started is ended here. A blur in the middle of a pointer drag must not
		// end that drag's move, or its next frame would start a second one.
		if (!keyMoving.current) return;
		keyMoving.current = false;
		const moved = [...keyMoved.current];
		keyMoved.current.clear();
		if (moved.length > 0) {
			onNodesChange(
				moved.map((id): NodeChange<CanvasNode> => ({ id, type: "position", dragging: false })),
			);
		}
		const doc = board.document.getState();
		if (doc.moving) doc.moveNodes({}, { moving: false });
	}, [board, onNodesChange]);

	/** Apply React Flow's node changes: collection cards here, everything else in the store. */
	const handleNodesChange = useCallback(
		(changes: NodeChange<BoardNode>[]) => {
			// A collection card (the Secrets vault) has NO row in the store, so its change must never
			// reach applyNodeChanges. Peel it off; everything left refers to a real store node.
			const passthrough: NodeChange<CanvasNode>[] = [];
			for (const change of changes) {
				const id = "id" in change ? change.id : null;
				const kind = id ? kindFromCollectionId(id) : null;
				if (kind) {
					if (change.type === "select") {
						setSelectedCollections((current) => {
							const without = current.filter((k) => k !== kind);
							return change.selected ? [...without, kind] : without;
						});
					}
					if (change.type === "position") {
						const doc = board.document.getState();
						// A drag, or an arrow key held down, is ONE move: the checkpoint is taken at its
						// first frame and the draft is written at its last.
						const moving = change.dragging === true || arrowHeld.current;
						if (arrowHeld.current) keyMoving.current = true;
						if (moving) {
							doc.beginMove();
							doc.moveNodes({}, { moving: true });
						}
						if (change.position) doc.setCollectionPosition(kind, change.position);
						if (!moving && board.document.getState().moving) {
							board.document.getState().moveNodes({}, { moving: false });
						}
					}
					continue;
				}
				if (change.type === "position" && arrowHeld.current && change.dragging !== true) {
					// React Flow reports each repeat of a held arrow key as a finished move. Reported as
					// part of a move in progress instead, the hold is one undo step, ended on key release.
					keyMoving.current = true;
					keyMoved.current.add(change.id);
					passthrough.push({ ...change, dragging: true });
					continue;
				}
				// React Flow types the change against the board node union; narrowing it back to a real
				// CanvasNode is sound because the only synthetic id (a collection) was just filtered out.
				// @ts-expect-error collection ids were filtered out above, so this change refers to a real CanvasNode; react-flow can't express that runtime narrowing
				passthrough.push(change);
			}
			if (passthrough.length) onNodesChange(passthrough);
		},
		[board, onNodesChange],
	);

	/** Make one card or one connection the whole selection: what a keyboard focus stop selects. */
	const selectOnly = useCallback(
		(target: { type: "node" | "edge"; id: string }) => {
			const collection = target.type === "node" ? kindFromCollectionId(target.id) : null;
			const changes: NodeChange<CanvasNode>[] = [];
			for (const node of useCanvasStore.getState().nodes) {
				const selected = target.type === "node" && node.id === target.id;
				if (!!node.selected !== selected) changes.push({ id: node.id, type: "select", selected });
			}
			if (changes.length) onNodesChange(changes);
			setSelectedCollections(collection ? [collection] : []);
			setSelectedEdges(target.type === "edge" ? [target.id] : []);
		},
		[onNodesChange],
	);

	// ── keys ──────────────────────────────────────────────────────────────────────────────────
	// Registered in the console's shortcut registry (`nodes/board-shortcuts.ts`), canvas scope.
	// Each is enabled only while it has something to act on, so a bare Enter or Delete pressed
	// anywhere else on the page is left entirely to the browser.

	const selectedNodes = nodes.filter((n) => n.selected);
	const selectedService =
		selectedNodes.length === 1 && selectedNodes[0].data.kind === "service" && !iacGoverned
			? selectedNodes[0]
			: null;

	useShortcut(
		SHORTCUT_BOARD_OPEN,
		() => {
			if (!focused) return;
			const id = focused.slice(focused.indexOf(":") + 1);
			if (focused.startsWith("node:")) {
				openInspector(id);
				return;
			}
			const edge = boardEdges.find((e) => e.id === id);
			if (!edge) return;
			// A connection is edited where it lives: on the service it starts from.
			const source = nodeIndex(board.document.getState().designNodes).get(edge.source);
			if (source?.data.kind === "service") {
				board.view.getState().setSubject({ kind: "node", id: edge.source }, "connections");
			} else {
				openInspector(edge.source);
			}
		},
		{ enabled: focused !== null },
	);

	/** Delete or Backspace with a connection — or the vault — selected. */
	const removeSelection = () => {
		if (selectedEdges.length > 0) {
			removeConnections(selectedEdges);
			return;
		}
		const kind = selectedCollections[0];
		if (!kind) return;
		const def = NODE_REGISTRY[kind];
		refuse(
			collectionNodeId(kind),
			`${def.collection?.title ?? def.label} are removed one at a time. Press Enter to open the list.`,
		);
	};
	const removable = selectedEdges.length > 0 || selectedCollections.length > 0;
	useShortcut(SHORTCUT_BOARD_REMOVE, removeSelection, { enabled: removable });
	useShortcut(SHORTCUT_BOARD_REMOVE_BACKSPACE, removeSelection, { enabled: removable });

	useShortcut(
		SHORTCUT_BOARD_CONNECT,
		() => {
			if (!selectedService) return;
			const rect = cardElement(selectedService.id)?.getBoundingClientRect();
			openConnectMenu({
				sourceId: selectedService.id,
				point: rect
					? { x: rect.left + rect.width / 2, y: rect.bottom }
					: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
				// A card added from here goes under the service, where its handle points.
				position: {
					x: selectedService.position.x,
					y: selectedService.position.y + 260,
				},
				fromKeyboard: true,
			});
		},
		{ enabled: selectedService !== null },
	);

	// What the card under a dragged connection would answer, shown while it is still being dragged.
	const hint = useMemo(
		() =>
			connectingFrom && hoveredId && hoveredId !== connectingFrom
				? evaluateConnection(design, connectingFrom, hoveredId)
				: null,
		[connectingFrom, hoveredId, design],
	);
	const hintSource = connectingFrom ? design.find((n) => n.id === connectingFrom) : undefined;

	return (
		<BoardMarksContext.Provider value={marks}>
			<BoardConnectionsContext.Provider value={connections}>
				<ReactFlow<BoardNode, BoardEdge>
					id={BOARD_ID}
					ref={wrapper}
					aria-label="Architecture board"
					nodes={cards}
					edges={visibleEdges}
					onInit={(instance) => {
						flow.current = instance;
					}}
					onNodesChange={handleNodesChange}
					onEdgesChange={(changes) => {
						// Edges are derived, so the only change the board keeps is which are selected.
						setSelectedEdges((current) => {
							let next = current;
							for (const change of changes) {
								if (change.type !== "select") continue;
								const without = next.filter((id) => id !== change.id);
								next = change.selected ? [...without, change.id] : without;
							}
							return next.length === current.length && next.every((id, i) => id === current[i])
								? current
								: next;
						});
					}}
					nodeTypes={nodeTypes}
					edgeTypes={edgeTypes}
					onNodeClick={(_, node) => openInspector(node.id)}
					onPaneClick={() => openInspector(null)}
					onPaneContextMenu={onPaneContextMenu}
					onNodeContextMenu={onNodeContextMenu}
					onSelectionContextMenu={onSelectionContextMenu}
					// ── connections ─────────────────────────────────────────────────────────────────
					// Nothing is connected while a bring-your-own module governs the environment: the
					// component design is not what gets deployed.
					nodesConnectable={!iacGoverned}
					// A wide catch radius and a drop anywhere on the card (below): the handle is where a
					// connection STARTS, it is not a target a person should have to hit to end one.
					connectionRadius={32}
					connectionLineStyle={CONNECTION_LINE_STYLE}
					isValidConnection={(connection) =>
						evaluateConnection(
							useCanvasStore.getState().nodes,
							connection.source,
							connection.target,
						).outcome !== "refused"
					}
					onConnectStart={(_, params) => {
						connecting.current = params.nodeId;
						connectionHandled.current = false;
						setConnectingFrom(params.nodeId);
						setNotice(null);
					}}
					onConnect={(connection) => {
						connectionHandled.current = true;
						const rect = cardElement(connection.target)?.getBoundingClientRect();
						resolveConnection(
							evaluateConnection(
								useCanvasStore.getState().nodes,
								connection.source,
								connection.target,
							),
							{
								point: rect
									? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
									: { x: 0, y: 0 },
								fallbackNodeId: connection.target,
							},
						);
					}}
					onConnectEnd={(event, state) => {
						const sourceId = connecting.current;
						connecting.current = null;
						setConnectingFrom(null);
						setHoveredId(null);
						if (connectionHandled.current) {
							connectionHandled.current = false;
							return;
						}
						if (!sourceId) return;
						const under = elementUnder(event);
						const point = releasePoint(event);
						// Released on a card — anywhere on it, not only on its handle — or close enough to
						// a handle for React Flow to have picked the card out.
						const targetId =
							under?.closest(".react-flow__node")?.getAttribute("data-id") ??
							state.toNode?.id ??
							null;
						if (targetId) {
							if (targetId === sourceId) return;
							resolveConnection(
								evaluateConnection(useCanvasStore.getState().nodes, sourceId, targetId),
								{ point, fallbackNodeId: targetId },
							);
							return;
						}
						// Released on empty board: offer what the service could connect to, and place a
						// new card where the pointer let go. Released anywhere else, it is a cancel.
						if (!under?.closest(".react-flow__pane")) return;
						const at = flow.current?.screenToFlowPosition(point) ?? { x: 0, y: 0 };
						openConnectMenu({
							sourceId,
							point,
							// The pointer is where the new card's target handle goes: top centre.
							position: { x: at.x - 124, y: at.y },
							fromKeyboard: false,
						});
					}}
					onNodeMouseEnter={(_, node) => {
						if (connecting.current) setHoveredId(node.id);
					}}
					onNodeMouseLeave={() => {
						if (connecting.current) setHoveredId(null);
					}}
					// ── keyboard ────────────────────────────────────────────────────────────────────
					// Every card and every connection is a focus stop, in the order the design holds
					// them, which a drag does not change. A stop reached by keyboard becomes the
					// selection, so the arrow keys move it and Delete removes it with no second step.
					nodesFocusable
					edgesFocusable
					ariaLabelConfig={BOARD_ARIA_LABELS}
					onPointerDownCapture={() => {
						pointerLast.current = true;
					}}
					onKeyDownCapture={(event) => {
						pointerLast.current = false;
						if (isArrowKey(event.key) && boardTarget(event.target)) arrowHeld.current = true;
					}}
					onKeyUpCapture={(event) => {
						if (isArrowKey(event.key)) endKeyboardMove();
					}}
					onFocusCapture={(event) => {
						const target = boardTarget(event.target);
						setFocused(target ? `${target.type}:${target.id}` : null);
						if (!target) return;
						if (focusedByKeyboard(event.target, pointerLast.current)) selectOnly(target);
					}}
					onBlurCapture={(event) => {
						// A key held while the focus leaves never reports its release.
						endKeyboardMove();
						const next = event.relatedTarget;
						if (!(next instanceof Node) || !event.currentTarget.contains(next)) setFocused(null);
					}}
					// Keyboard delete of CARDS is the canvas key handler's (design-project-canvas.tsx),
					// routed through the store's `removeNodes` so it respects `deletable: false` and
					// commits an undo step; a connection's is this file's. React Flow's own delete path
					// applied the removal straight to the node array and left no history.
					deleteKeyCode={null}
					// ── Excalidraw/Miro traversal ─────────────────────────────────────────────────────────
					// Left-drag marquee-selects (better click-state handling); Space or the hand tool turns
					// left-drag into a pan. Middle + right mouse always pan. Scroll pans (trackpad-native);
					// Ctrl/⌘+scroll and pinch zoom. This replaces the stock default where left-drag panned and
					// there was no discoverable select.
					panOnDrag={panning ? true : [1, 2]}
					selectionOnDrag={!panning}
					panActivationKeyCode="Space"
					panOnScroll
					zoomOnScroll={false}
					zoomOnPinch
					fitView
					fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
					minZoom={0.2}
					maxZoom={1.5}
					proOptions={{ hideAttribution: true }}
					className={cn("bg-background", panning && "cursor-grab active:cursor-grabbing")}
				>
					<Background
						variant={BackgroundVariant.Dots}
						gap={16}
						size={1}
						color="var(--border, #e5e5e5)"
					/>
					{/* A forty-node board needs a way to know where you are. Grayscale, like everything else. */}
					<MiniMap
						pannable
						zoomable
						ariaLabel="Architecture minimap"
						className="!border !border-border !bg-card"
						maskColor="var(--surface-sunken)"
						nodeColor="var(--border-strong)"
						nodeStrokeColor="var(--border-strong)"
					/>

					{/* While a connection is dragged over a card: what releasing it there would do. A mark
					    and a sentence, never a colour. */}
					{hint && hoveredId && (
						<NodeToolbar nodeId={hoveredId} isVisible position={Position.Top} offset={12}>
							<ConnectionNote
								refused={hint.outcome === "refused"}
								text={
									hint.outcome === "refused"
										? hint.reason
										: hint.outcome === "choose"
											? "Release to choose which one to connect"
											: `Release to connect${hintSource ? ` ${nodeTitle(hintSource)}` : ""}`
								}
							/>
						</NodeToolbar>
					)}

					{/* After a refused connection: the reason, next to the card it is about. */}
					{notice && !hint && (
						<NodeToolbar nodeId={notice.nodeId} isVisible position={Position.Top} offset={12}>
							<ConnectionNote refused text={notice.text} />
						</NodeToolbar>
					)}

					{/* What just happened on the board, for a screen reader. Keyed so that the same
					    sentence twice in a row is two announcements. */}
					<div role="status" aria-live="polite" className="sr-only">
						<span key={announcement.serial}>{announcement.text}</span>
					</div>
				</ReactFlow>

				<ConnectMenu
					state={menu}
					onClose={() => {
						if (menu?.fromKeyboard) focusCard(menu.sourceId);
						setMenu(null);
					}}
					onConnect={(state, targetId) => {
						resolveConnection(
							evaluateConnection(useCanvasStore.getState().nodes, state.sourceId, targetId),
							{ point: state.point, fallbackNodeId: state.sourceId },
						);
					}}
					onCreate={(state, kind) => createAndBind(state.sourceId, kind, state.position)}
				/>
			</BoardConnectionsContext.Provider>
		</BoardMarksContext.Provider>
	);
}

/**
 * The note beside a card about a connection: what releasing here will do, or why it cannot be
 * made. The mark is a shape — a tick or a cross — and the sentence says the rest.
 */
function ConnectionNote({ refused, text }: { refused: boolean; text: string }) {
	const Mark = refused ? X : Check;
	return (
		<div
			data-testid="connection-note"
			data-refused={refused}
			className={cn(
				"flex max-w-72 items-start gap-1.5 border bg-background px-2 py-1 text-ui-xs text-foreground",
				refused ? "border-dashed border-foreground" : "border-foreground",
			)}
		>
			<Mark aria-hidden="true" className="mt-px h-3 w-3 shrink-0" />
			<span>{text}</span>
		</div>
	);
}
