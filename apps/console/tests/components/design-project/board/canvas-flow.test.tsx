// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The board itself (#6835): connections made and removed as one undo step each, refusals said in
// words, every card and line a named focus stop, and a drag that validates nothing and writes
// nothing until it ends.
//
// React Flow is replaced by a stand-in that renders what the board HANDS it — one focusable element
// per node and per edge, carrying the name and description attributes the board set, with the
// board's own node components inside — and records the props, so each test drives the callbacks
// React Flow would call. What React Flow does with a pointer is the release gate's to prove; what
// the board does when React Flow reports it is pinned here. Everything under the stand-in is real:
// the store, the cards, the status resolver, the shortcut registry and the menu.

import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Position, ReactFlowProvider, type ReactFlowProps } from "@xyflow/react";
import { createElement, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardEdge } from "@/components/design-project/canvas/edges/board-edges";
import type { BoardNode } from "@/lib/canvas/collections";

type FlowProps = ReactFlowProps<BoardNode, BoardEdge> & { ref?: Ref<HTMLDivElement> };

const flow = vi.hoisted(() => ({ capture: vi.fn<(props: FlowProps) => void>() }));

vi.mock("@xyflow/react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@xyflow/react")>();
	/** Renders what the board hands React Flow, and records the props it was handed. */
	function ReactFlow(props: FlowProps) {
		flow.capture(props);
		return (
			<div
				ref={props.ref}
				data-testid="board"
				aria-label={props["aria-label"]}
				onFocusCapture={props.onFocusCapture}
				onBlurCapture={props.onBlurCapture}
				onKeyDownCapture={props.onKeyDownCapture}
				onKeyUpCapture={props.onKeyUpCapture}
				onPointerDownCapture={props.onPointerDownCapture}
			>
				<div className="react-flow__pane" data-testid="pane" />
				<svg>
					{(props.edges ?? []).map((edge) => {
						const component = props.edgeTypes?.[edge.type ?? ""];
						return (
							<g
								key={edge.id}
								className="react-flow__edge"
								data-id={edge.id}
								data-selected={edge.selected ? "true" : "false"}
								tabIndex={edge.focusable ? 0 : undefined}
								role="group"
								aria-label={edge.ariaLabel ?? undefined}
							>
								{component &&
									createElement(component, {
										id: edge.id,
										type: edge.type,
										source: edge.source,
										target: edge.target,
										selected: edge.selected ?? false,
										data: edge.data,
										sourceX: 0,
										sourceY: 0,
										targetX: 100,
										targetY: 100,
										sourcePosition: Position.Bottom,
										targetPosition: Position.Top,
									})}
							</g>
						);
					})}
				</svg>
				{(props.nodes ?? []).map((node) => {
					const component = props.nodeTypes?.[node.type ?? ""];
					return (
						<div
							key={node.id}
							className="react-flow__node"
							data-id={node.id}
							data-selected={node.selected ? "true" : "false"}
							tabIndex={node.focusable ? 0 : undefined}
							role="group"
							aria-label={node.ariaLabel}
							{...node.domAttributes}
						>
							{component &&
								createElement(component, {
									id: node.id,
									data: node.data,
									type: node.type,
									selected: node.selected ?? false,
									dragging: false,
									draggable: true,
									selectable: true,
									deletable: node.deletable ?? true,
									zIndex: 0,
									isConnectable: true,
									positionAbsoluteX: node.position.x,
									positionAbsoluteY: node.position.y,
								})}
						</div>
					);
				})}
				{props.children}
			</div>
		);
	}
	return {
		...actual,
		ReactFlow,
		Background: () => null,
		MiniMap: () => null,
		NodeToolbar: ({ nodeId, children }: { nodeId?: string; children?: ReactNode }) => (
			<div data-testid="node-toolbar" data-node-id={nodeId}>
				{children}
			</div>
		),
		// The real one portals into a layer React Flow owns; here the label lands on the page.
		EdgeLabelRenderer: ({ children }: { children?: ReactNode }) =>
			createPortal(children, document.body),
	};
});

import { CanvasFlow } from "@/components/design-project/canvas/canvas-flow";
import { bindingsOf } from "@/components/design-project/canvas/edges/connection-rules";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import { cardDescriptionId } from "@/components/design-project/canvas/nodes/node-name";
import { EMPTY_ENVIRONMENT_STATUS } from "@/lib/canvas/component-status";
import { collectionNodeId } from "@/lib/canvas/collections";
import { EnvironmentStatusProvider } from "@/lib/canvas/environment-status-context";
import { board } from "@/lib/canvas/store/board";
import { nodeIndex } from "@/lib/canvas/store/use-board";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import { projectFormSchema } from "@/lib/validations/project-form.schema";
import { cacheNode, serviceNode } from "@/tests/fixtures/canvas/nodes";
import { awsDatabaseNode, awsProjectNode, bucketNode, secretNode } from "./fixtures";

const API = "service-api";
const ORDERS = "database-orders";
const VAULT = collectionNodeId("secret");

/** The saved design every test starts from: a service, a database, a cache, a bucket, two secrets. */
function design(bindings: Parameters<typeof serviceNode>[1] = []): CanvasNode[] {
	return [
		awsProjectNode(),
		serviceNode("api", bindings),
		awsDatabaseNode("orders"),
		cacheNode("sessions"),
		bucketNode("assets"),
		secretNode("stripe"),
		secretNode("jwt"),
	];
}

/** Load `nodes` as the saved design and draw the board. */
function renderBoard(nodes: CanvasNode[] = design()) {
	useCanvasStore.getState().setGraph({ nodes });
	return render(
		<ReactFlowProvider>
			<EnvironmentStatusProvider value={EMPTY_ENVIRONMENT_STATUS}>
				<CanvasFlow />
			</EnvironmentStatusProvider>
		</ReactFlowProvider>,
	);
}

/** The props the board last handed React Flow. */
function props(): FlowProps {
	const last = flow.capture.mock.lastCall?.[0];
	if (!last) throw new Error("the board has not rendered");
	return last;
}

/** The focusable element of a card or a line, by its id. */
function stop(id: string): HTMLElement {
	const found = [...document.querySelectorAll<HTMLElement>("[data-id]")].find(
		(el) => el.getAttribute("data-id") === id,
	);
	if (!found) throw new Error(`nothing on the board has the id ${id}`);
	return found;
}

/** The service's bindings as the design holds them now, as kind:name. */
function bound(): string[] {
	const service = nodeIndex(board.document.getState().designNodes).get(API);
	return bindingsOf(service).map((b) => `${b.target.kind}:${b.target.name}`);
}

/** How many steps there are to undo. */
function undoSteps(): number {
	return board.document.getState().history.past.length;
}

/** A mouse release whose target is `element`, as React Flow hands one to `onConnectEnd`. */
function releaseOver(element: Element): MouseEvent {
	const event = new MouseEvent("mouseup", { bubbles: true, clientX: 40, clientY: 60 });
	element.dispatchEvent(event);
	return event;
}

type ConnectEnd = NonNullable<FlowProps["onConnectEnd"]>;

/** React Flow's final connection state for a release that ended near no handle. */
const NEAR_NOTHING = { toNode: null } as unknown as Parameters<ConnectEnd>[1];

/** Drag a connection from `sourceId` and release it over `element`. */
function dragFrom(sourceId: string, element: Element) {
	const startEvent = new MouseEvent("mousedown");
	act(() => {
		props().onConnectStart?.(startEvent, { nodeId: sourceId, handleId: null, handleType: "source" });
	});
	const event = releaseOver(element);
	act(() => {
		props().onConnectEnd?.(event, NEAR_NOTHING);
	});
}

/** What the board last said to a screen reader. */
function announced(): string {
	return screen.getByRole("status").textContent ?? "";
}

beforeEach(() => {
	sessionStorage.clear();
	useCanvasStore.getState().reset();
	flow.capture.mockClear();
});

describe("every card and line is a named focus stop", () => {
	it("a card's focusable element carries its name, and points at its own description", () => {
		renderBoard();

		const card = screen.getByRole("group", { name: "Service api" });
		expect(card).toHaveAttribute("tabindex", "0");
		const describedBy = card.getAttribute("aria-describedby") ?? "";
		expect(describedBy.split(" ")).toEqual([
			cardDescriptionId(API),
			"react-flow__node-desc-architecture-board",
		]);
		expect(document.getElementById(cardDescriptionId(API))).toHaveTextContent(
			"Status: Ready. Not connected.",
		);
	});

	it("exactly one element answers to a card's name", () => {
		renderBoard();

		// The card inside the wrapper must not be a second named group: a query for the card would
		// find two, and a screen reader would say it twice.
		expect(screen.getAllByRole("group", { name: /^Database/ })).toHaveLength(1);
		expect(screen.getAllByRole("group", { name: /^Secrets/ })).toHaveLength(1);
	});

	it("a card says what it is connected to, and a line names both its ends", () => {
		renderBoard(design([{ target: { kind: "database", name: "orders" }, inject: [] }]));

		expect(document.getElementById(cardDescriptionId(ORDERS))).toHaveTextContent(
			"Connected to Service api.",
		);
		expect(
			screen.getByRole("group", { name: "Connection from Service api to Database orders" }),
		).toHaveAttribute("tabindex", "0");
	});

	it("turns on React Flow's focus stops and describes this board's keys, not React Flow's", () => {
		renderBoard();

		expect(props().nodesFocusable).toBe(true);
		expect(props().edgesFocusable).toBe(true);
		expect(props().ariaLabelConfig?.["node.a11yDescription.default"]).toContain("inspector");
		expect(props().ariaLabelConfig?.["edge.a11yDescription.default"]).toContain("Delete");
		expect(props()["aria-label"]).toBe("Architecture board");
	});

	it("keeps the focus stops in the order the design holds them while a card is dragged", () => {
		renderBoard();
		const before = (props().nodes ?? []).map((n) => n.id);

		act(() => {
			props().onNodesChange?.([
				{ id: ORDERS, type: "position", position: { x: 900, y: 900 }, dragging: false },
			]);
		});

		expect((props().nodes ?? []).map((n) => n.id)).toEqual(before);
	});

	it("a card that did not change is the same node object after another card moved", () => {
		renderBoard();
		const cache = (props().nodes ?? []).find((n) => n.id === "cache-sessions");

		act(() => {
			props().onNodesChange?.([
				{ id: ORDERS, type: "position", position: { x: 5, y: 5 }, dragging: false },
			]);
		});

		expect((props().nodes ?? []).find((n) => n.id === "cache-sessions")).toBe(cache);
	});
});

describe("making a connection", () => {
	it("a line from a service to a database adds exactly one binding and one undo step", () => {
		renderBoard();
		const steps = undoSteps();

		act(() => {
			props().onConnect?.({ source: API, target: ORDERS, sourceHandle: null, targetHandle: null });
		});

		expect(bound()).toEqual(["database:orders"]);
		expect(undoSteps()).toBe(steps + 1);
		expect((props().edges ?? []).map((e) => e.id)).toEqual([`bind:${API}->${ORDERS}`]);
		// The inspector opens where the next choice is made: the service's connections.
		expect(board.view.getState().subject).toEqual({ kind: "node", id: API });
		expect(board.view.getState().tab).toBe("connections");
		expect(announced()).toBe(
			"Connected Service api to Database orders. Choose what it injects in the inspector.",
		);

		act(() => {
			board.document.getState().undo();
		});
		expect(bound()).toEqual([]);
	});

	it("two connections made one after the other are two undo steps", () => {
		renderBoard();
		const steps = undoSteps();

		act(() => {
			props().onConnect?.({ source: API, target: ORDERS, sourceHandle: null, targetHandle: null });
			props().onConnect?.({
				source: API,
				target: "cache-sessions",
				sourceHandle: null,
				targetHandle: null,
			});
		});

		expect(bound()).toEqual(["database:orders", "cache:sessions"]);
		expect(undoSteps()).toBe(steps + 2);
	});

	it("the connected service is marked as edited", () => {
		renderBoard();

		act(() => {
			props().onConnect?.({ source: API, target: ORDERS, sourceHandle: null, targetHandle: null });
		});

		expect(stop(API).querySelector('[data-testid="pending-mark"]')).toHaveTextContent("~Edited");
		expect(stop(ORDERS).querySelector('[data-testid="pending-mark"]')).toBeNull();
	});

	it("releasing anywhere on the target card connects, not only on its handle", () => {
		renderBoard();

		dragFrom(API, stop(ORDERS));

		expect(bound()).toEqual(["database:orders"]);
	});

	it("releasing on the service it started from does nothing", () => {
		renderBoard();
		const steps = undoSteps();

		dragFrom(API, stop(API));

		expect(bound()).toEqual([]);
		expect(undoSteps()).toBe(steps);
		expect(screen.queryByTestId("connection-note")).not.toBeInTheDocument();
	});
});

describe("a connection that cannot be made", () => {
	it("isValidConnection refuses an invalid pair and accepts a valid one", () => {
		renderBoard();
		const valid = props().isValidConnection;

		expect(
			valid?.({ source: API, target: "bucket-assets", sourceHandle: null, targetHandle: null }),
		).toBe(false);
		expect(valid?.({ source: API, target: ORDERS, sourceHandle: null, targetHandle: null })).toBe(
			true,
		);
		expect(valid?.({ source: ORDERS, target: API, sourceHandle: null, targetHandle: null })).toBe(
			false,
		);
	});

	it("says why while the connection is still being dragged over the card", () => {
		renderBoard();
		const bucket = (props().nodes ?? []).find((n) => n.id === "bucket-assets");
		if (!bucket) throw new Error("no bucket on the board");

		act(() => {
			props().onConnectStart?.(new MouseEvent("mousedown"), {
				nodeId: API,
				handleId: null,
				handleType: "source",
			});
		});
		act(() => {
			props().onNodeMouseEnter?.(
				// The handler reads the node, never the event.
				{} as Parameters<NonNullable<FlowProps["onNodeMouseEnter"]>>[0],
				bucket,
			);
		});

		const note = screen.getByTestId("connection-note");
		expect(note).toHaveAttribute("data-refused", "true");
		expect(note).toHaveTextContent(
			"A service connects to a database, cache, queue or secret. Bucket cannot be a connection target.",
		);
		expect(screen.getByTestId("node-toolbar")).toHaveAttribute("data-node-id", "bucket-assets");
	});

	it("says what releasing will do while it is dragged over a card it can connect to", () => {
		renderBoard();
		const database = (props().nodes ?? []).find((n) => n.id === ORDERS);
		if (!database) throw new Error("no database on the board");

		act(() => {
			props().onConnectStart?.(new MouseEvent("mousedown"), {
				nodeId: API,
				handleId: null,
				handleType: "source",
			});
		});
		act(() => {
			props().onNodeMouseEnter?.(
				{} as Parameters<NonNullable<FlowProps["onNodeMouseEnter"]>>[0],
				database,
			);
		});

		const note = screen.getByTestId("connection-note");
		expect(note).toHaveAttribute("data-refused", "false");
		expect(note).toHaveTextContent("Release to connect Service api");
	});

	it("released on a card it cannot connect to: nothing changes, and the reason stays on screen", () => {
		renderBoard();
		const steps = undoSteps();

		dragFrom(API, stop("bucket-assets"));

		expect(bound()).toEqual([]);
		expect(undoSteps()).toBe(steps);
		const reason =
			"A service connects to a database, cache, queue or secret. Bucket cannot be a connection target.";
		expect(screen.getByTestId("connection-note")).toHaveTextContent(reason);
		expect(screen.getByTestId("node-toolbar")).toHaveAttribute("data-node-id", "bucket-assets");
		expect(announced()).toBe(reason);
	});

	it("connecting the same pair twice is refused the second time, naming both ends", () => {
		renderBoard(design([{ target: { kind: "database", name: "orders" }, inject: [] }]));
		const steps = undoSteps();

		dragFrom(API, stop(ORDERS));

		expect(bound()).toEqual(["database:orders"]);
		expect(undoSteps()).toBe(steps);
		expect(announced()).toBe("api is already connected to Database orders.");
	});

	it("nothing is connectable while a bring-your-own module governs the environment", () => {
		useCanvasStore.getState().setGraph({ nodes: design() });
		render(
			<ReactFlowProvider>
				<EnvironmentStatusProvider
					value={{
						...EMPTY_ENVIRONMENT_STATUS,
						iac: {
							source: null,
							groups: [],
							costByAddress: {},
							outputs: [],
						} as unknown as NonNullable<(typeof EMPTY_ENVIRONMENT_STATUS)["iac"]>,
					}}
				>
					<CanvasFlow />
				</EnvironmentStatusProvider>
			</ReactFlowProvider>,
		);

		expect(props().nodesConnectable).toBe(false);
	});
});

describe("a connection released on empty board", () => {
	it("offers what the service can connect to, and adds the new card and its binding as ONE step", async () => {
		const user = userEvent.setup();
		renderBoard();
		const steps = undoSteps();
		const cards = board.document.getState().designNodes.length;

		dragFrom(API, screen.getByTestId("pane"));
		await user.click(await screen.findByRole("menuitem", { name: "New cache" }));

		const nodes = board.document.getState().designNodes;
		expect(nodes).toHaveLength(cards + 1);
		const created = nodes[nodes.length - 1];
		expect(created.data.kind).toBe("cache");
		expect(bound()).toHaveLength(1);
		expect(bound()[0]).toMatch(/^cache:/);
		expect(undoSteps()).toBe(steps + 1);

		act(() => {
			board.document.getState().undo();
		});
		expect(board.document.getState().designNodes).toHaveLength(cards);
		expect(bound()).toEqual([]);
	});

	it("lists the cards already on the board first, and connecting to one adds no card", async () => {
		const user = userEvent.setup();
		renderBoard();
		const cards = board.document.getState().designNodes.length;

		dragFrom(API, screen.getByTestId("pane"));
		await user.click(await screen.findByRole("menuitem", { name: "Database orders" }));

		expect(bound()).toEqual(["database:orders"]);
		expect(board.document.getState().designNodes).toHaveLength(cards);
	});

	it("offers only the four kinds a service binds to as new cards", async () => {
		renderBoard();

		dragFrom(API, screen.getByTestId("pane"));
		await screen.findByRole("menu");

		const offered = screen
			.getAllByRole("menuitem")
			.map((item) => item.textContent ?? "")
			.filter((text) => text.startsWith("New "));
		expect(offered).toEqual(["New database", "New cache", "New queue", "New secret"]);
	});
});

describe("the vault", () => {
	it("a line released on it asks which secret, and connects to the one chosen", async () => {
		const user = userEvent.setup();
		renderBoard(design([{ target: { kind: "secret", name: "stripe" }, inject: [] }]));

		act(() => {
			props().onConnect?.({ source: API, target: VAULT, sourceHandle: null, targetHandle: null });
		});
		await screen.findByRole("menu");

		// The secret already connected is not offered again.
		expect(screen.queryByRole("menuitem", { name: "Secret stripe" })).not.toBeInTheDocument();
		await user.click(screen.getByRole("menuitem", { name: "Secret jwt" }));

		expect(bound()).toEqual(["secret:stripe", "secret:jwt"]);
	});

	it("is selected in its own right, so Delete can never reach the secrets inside it", () => {
		renderBoard();

		act(() => {
			props().onNodesChange?.([{ id: VAULT, type: "select", selected: true }]);
		});

		expect((props().nodes ?? []).find((n) => n.id === VAULT)?.selected).toBe(true);
		expect(useCanvasStore.getState().selectedIds).toEqual([]);

		fireEvent.keyDown(stop(VAULT), { key: "Delete" });

		expect(board.document.getState().designNodes.filter((n) => n.data.kind === "secret")).toHaveLength(
			2,
		);
		expect(announced()).toBe("Secrets are removed one at a time. Press Enter to open the list.");
	});
});

describe("removing a connection", () => {
	const BOUND = [
		{ target: { kind: "database" as const, name: "orders" }, inject: [] },
		{ target: { kind: "cache" as const, name: "sessions" }, inject: [] },
	];
	const EDGE = `bind:${API}->${ORDERS}`;

	it("by pointer: selecting the line shows its Remove control, which removes that one binding", async () => {
		const user = userEvent.setup();
		renderBoard(design(BOUND));
		const steps = undoSteps();

		act(() => {
			props().onEdgesChange?.([{ id: EDGE, type: "select", selected: true }]);
		});
		await user.click(screen.getByRole("button", { name: "Remove connection" }));

		expect(bound()).toEqual(["cache:sessions"]);
		expect(undoSteps()).toBe(steps + 1);
		expect(announced()).toBe("Connection removed. Undo brings it back.");

		act(() => {
			board.document.getState().undo();
		});
		expect(bound()).toEqual(["database:orders", "cache:sessions"]);
	});

	it("by keyboard: focusing the line selects it, and Delete removes it", () => {
		renderBoard(design(BOUND));

		fireEvent.focus(stop(EDGE));
		expect(stop(EDGE)).toHaveAttribute("data-selected", "true");

		fireEvent.keyDown(stop(EDGE), { key: "Delete" });

		expect(bound()).toEqual(["cache:sessions"]);
	});

	it("Backspace removes it as well", () => {
		renderBoard(design(BOUND));

		fireEvent.focus(stop(EDGE));
		fireEvent.keyDown(stop(EDGE), { key: "Backspace" });

		expect(bound()).toEqual(["cache:sessions"]);
	});

	it("the line to the vault removes every secret binding behind it, as ONE step", async () => {
		const user = userEvent.setup();
		renderBoard(
			design([
				{ target: { kind: "secret", name: "stripe" }, inject: [] },
				{ target: { kind: "database", name: "orders" }, inject: [] },
				{ target: { kind: "secret", name: "jwt" }, inject: [] },
			]),
		);
		const steps = undoSteps();
		const toVault = (props().edges ?? []).find((e) => e.target === VAULT);
		if (!toVault) throw new Error("no line to the vault");

		act(() => {
			props().onEdgesChange?.([{ id: toVault.id, type: "select", selected: true }]);
		});
		await user.click(screen.getByRole("button", { name: "Remove 2 connections" }));

		expect(bound()).toEqual(["database:orders"]);
		expect(undoSteps()).toBe(steps + 1);
	});

	it("Delete with no line selected is left to the browser and to the card handler", () => {
		renderBoard(design(BOUND));
		const steps = undoSteps();

		const event = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
		document.body.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(false);
		expect(undoSteps()).toBe(steps);
	});
});

describe("keys on a focused card", () => {
	it("a card reached by keyboard becomes the selection", () => {
		renderBoard();

		fireEvent.focus(stop(ORDERS));

		expect(useCanvasStore.getState().selectedIds).toEqual([ORDERS]);

		fireEvent.focus(stop("cache-sessions"));

		expect(useCanvasStore.getState().selectedIds).toEqual(["cache-sessions"]);
	});

	it("a card focused by a press is left to React Flow's own click selection", () => {
		renderBoard();

		fireEvent.pointerDown(stop(ORDERS));
		fireEvent.focus(stop(ORDERS));

		expect(useCanvasStore.getState().selectedIds).toEqual([]);
	});

	it("Enter opens the inspector on the focused card", () => {
		renderBoard();

		fireEvent.focus(stop(ORDERS));
		fireEvent.keyDown(stop(ORDERS), { key: "Enter" });

		expect(board.view.getState().subject).toEqual({ kind: "node", id: ORDERS });
	});

	it("Enter on the vault opens the collection", () => {
		renderBoard();

		fireEvent.focus(stop(VAULT));
		fireEvent.keyDown(stop(VAULT), { key: "Enter" });

		expect(board.view.getState().subject).toEqual({ kind: "collection", nodeKind: "secret" });
	});

	it("Enter on a focused line opens the service it starts from, on its connections", () => {
		renderBoard(design([{ target: { kind: "database", name: "orders" }, inject: [] }]));

		fireEvent.focus(stop(`bind:${API}->${ORDERS}`));
		fireEvent.keyDown(stop(`bind:${API}->${ORDERS}`), { key: "Enter" });

		expect(board.view.getState().subject).toEqual({ kind: "node", id: API });
		expect(board.view.getState().tab).toBe("connections");
	});

	it("Enter is not taken from the rest of the page while no card or line has the focus", () => {
		renderBoard();

		const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
		document.body.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(false);
		expect(board.view.getState().subject).toBeNull();
	});

	it("C on a selected service opens the connect menu, with no pointer involved", async () => {
		const user = userEvent.setup();
		renderBoard();

		fireEvent.focus(stop(API));
		fireEvent.keyDown(stop(API), { key: "c" });
		await user.click(await screen.findByRole("menuitem", { name: "Cache sessions" }));

		expect(bound()).toEqual(["cache:sessions"]);
	});

	it("C does nothing on a card that cannot start a connection", () => {
		renderBoard();

		fireEvent.focus(stop(ORDERS));
		const event = new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true });
		stop(ORDERS).dispatchEvent(event);

		expect(event.defaultPrevented).toBe(false);
		expect(screen.queryByRole("menu")).not.toBeInTheDocument();
	});
});

describe("moving a card costs nothing until the move ends", () => {
	it("a 30-frame drag runs no validation and writes no draft; the drag's end is one undo step", () => {
		renderBoard();
		const steps = undoSteps();
		const validate = vi.spyOn(projectFormSchema, "safeParse");
		const write = vi.spyOn(Storage.prototype, "setItem");

		for (let frame = 1; frame <= 30; frame++) {
			act(() => {
				props().onNodesChange?.([
					{ id: ORDERS, type: "position", position: { x: frame * 7, y: frame * 3 }, dragging: true },
				]);
			});
		}

		expect(validate).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();

		act(() => {
			props().onNodesChange?.([
				{ id: ORDERS, type: "position", position: { x: 210, y: 90 }, dragging: false },
			]);
		});

		expect(validate).not.toHaveBeenCalled();
		expect(write).toHaveBeenCalledTimes(1);
		expect(undoSteps()).toBe(steps + 1);
		expect(board.document.getState().positions[ORDERS]).toEqual({ x: 210, y: 90 });
		validate.mockRestore();
		write.mockRestore();
	});

	it("a drag rebuilds no edge", () => {
		renderBoard(design([{ target: { kind: "database", name: "orders" }, inject: [] }]));
		const edges = props().edges;

		act(() => {
			props().onNodesChange?.([
				{ id: ORDERS, type: "position", position: { x: 40, y: 40 }, dragging: true },
			]);
		});

		expect(props().edges).toBe(edges);
	});

	it("an arrow key held down is one undo step and one draft write, made when the key is released", () => {
		renderBoard();
		fireEvent.focus(stop(ORDERS));
		const steps = undoSteps();
		const write = vi.spyOn(Storage.prototype, "setItem");

		fireEvent.keyDown(stop(ORDERS), { key: "ArrowRight" });
		// React Flow reports each repeat of the held key as a finished move.
		for (let repeat = 1; repeat <= 5; repeat++) {
			act(() => {
				props().onNodesChange?.([
					{ id: ORDERS, type: "position", position: { x: repeat * 5, y: 0 }, dragging: false },
				]);
			});
		}

		expect(undoSteps()).toBe(steps + 1);
		expect(write).not.toHaveBeenCalled();

		fireEvent.keyUp(stop(ORDERS), { key: "ArrowRight" });

		expect(undoSteps()).toBe(steps + 1);
		expect(write).toHaveBeenCalledTimes(1);
		expect(board.document.getState().moving).toBe(false);
		expect(board.document.getState().positions[ORDERS]).toEqual({ x: 25, y: 0 });
		write.mockRestore();
	});

	it("dragging the vault writes no draft until the drag ends", () => {
		renderBoard();
		const write = vi.spyOn(Storage.prototype, "setItem");

		for (let frame = 1; frame <= 10; frame++) {
			act(() => {
				props().onNodesChange?.([
					{ id: VAULT, type: "position", position: { x: frame, y: frame }, dragging: true },
				]);
			});
		}
		expect(write).not.toHaveBeenCalled();

		act(() => {
			props().onNodesChange?.([
				{ id: VAULT, type: "position", position: { x: 11, y: 11 }, dragging: false },
			]);
		});

		expect(write).toHaveBeenCalledTimes(1);
		expect(board.document.getState().collectionPositions.secret).toEqual({ x: 11, y: 11 });
		write.mockRestore();
	});
});
