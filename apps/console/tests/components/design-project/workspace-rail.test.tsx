// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The rail draws ONE inspector, chosen by the view store's `Subject`. These pin: the routing (each
// subject lands on its body, and a legacy rail card lands on the subject it maps onto), that the
// rail has one width and swaps its content in place, that nothing on it is a modal, what Escape
// and closing do to the focus, that unmounting the rail closes the inspector, and the deep-link
// grammar the canvas consumes on mount.

import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	parseCardParam,
	resolveCardParam,
	useCardDeepLink,
} from "@/components/design-project/canvas/cards/card-param";
import {
	isRailOpen,
	RAIL_GAP,
	RAIL_W,
	WorkspaceRail,
} from "@/components/design-project/canvas/cards/workspace-rail";
import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import { board } from "@/lib/canvas/store/board";
import type { Subject } from "@/lib/canvas/store/types";
import { useCanvasStore, type WorkspaceCard } from "@/lib/stores/use-canvas-store";

const { fieldLeft } = vi.hoisted(() => ({ fieldLeft: vi.fn() }));

// Each subject's body is stubbed: what is under test is which one the rail draws, not what it holds.
vi.mock("@/components/design-project/canvas/inspector-shell/node-subject", () => ({
	NodeSubject: ({ node }: { node: { id: string } }) => (
		<div>
			<p>node subject {node.id}</p>
			<input aria-label="A field" onBlur={() => fieldLeft()} />
			<button type="button">A control</button>
		</div>
	),
}));
vi.mock("@/components/design-project/canvas/cards/env-settings-card", () => ({
	EnvSettingsCard: ({ activity }: { activity?: unknown }) => (
		<div>environment subject{activity ? " with activity" : ""}</div>
	),
}));
vi.mock("@/components/addons/addon-config-card", () => ({
	AddonConfigCard: ({ itemId }: { itemId: string }) => <div>addon subject {itemId}</div>,
}));
vi.mock("@/components/design-project/canvas/cards/chart-scan-card", () => ({
	ChartScanCard: ({ chartId }: { chartId: string }) => <div>chart subject {chartId}</div>,
}));
vi.mock("@/components/design-project/canvas/cards/activity-card", () => ({
	ActivityCard: () => <div>activity</div>,
}));
vi.mock("@/components/design-project/canvas/inspector/collection-panel", () => ({
	CollectionPanel: ({ kind }: { kind: string }) => <div>collection subject {kind}</div>,
}));
vi.mock("@/components/design-project/canvas/inspector/chart-workload-panel", () => ({
	ChartWorkloadPanel: ({ nodeId }: { nodeId: string }) => <div>workload subject {nodeId}</div>,
}));
vi.mock("@/components/design-project/canvas/inspector/external-panel", () => ({
	ExternalPanel: ({ nodeId }: { nodeId: string }) => <div>external subject {nodeId}</div>,
}));
vi.mock("@/components/design-project/canvas/inspector-shell/environment-sources", () => ({
	EnvironmentSources: () => <div>sources</div>,
}));
vi.mock("@/components/design-project/canvas/inspector-shell/staged-operations-strip", () => ({
	StagedOperationsStrip: () => null,
}));

/** A design node of `kind` named `name`, as the store holds it. */
function designNode(kind: "database" | "bucket", name: string): CanvasNode {
	return {
		id: `${kind}-${name}`,
		type: kind,
		position: { x: 0, y: 0 },
		data: {
			kind,
			config: { ...NODE_REGISTRY[kind].defaultData("aws"), name },
			cloud_identity_id: null,
			provider: "aws",
		},
	} as CanvasNode;
}

/** A card the design does not own, as the canvas mirrors it into the store. */
function otherNode(id: string, kind: "chart_workload" | "external"): CanvasNode {
	return {
		id,
		type: kind,
		deletable: false,
		position: { x: 0, y: 0 },
		data: { kind, config: {}, cloud_identity_id: null, provider: null },
	} as unknown as CanvasNode;
}

/** Show `subject` in the inspector. */
function show(subject: Subject | null) {
	act(() => board.view.getState().setSubject(subject));
}

/** A stand-in for the board's card of a node: React Flow's wrapper element, focusable. */
function boardCard(id: string): HTMLElement {
	const el = document.createElement("div");
	el.className = "react-flow__node";
	el.setAttribute("data-id", id);
	el.tabIndex = 0;
	document.body.appendChild(el);
	return el;
}

const rail = () => screen.getByTestId("workspace-rail");

beforeEach(() => {
	fieldLeft.mockReset();
	useCanvasStore.getState().reset();
	useCanvasStore.setState({
		nodes: [
			designNode("database", "orders"),
			designNode("bucket", "assets"),
			otherNode("cw-w1", "chart_workload"),
			otherNode("external-network", "external"),
		],
	});
});

afterEach(() => {
	for (const el of document.querySelectorAll(".react-flow__node, [data-outside]")) el.remove();
});

describe("WorkspaceRail", () => {
	it("is closed with no subject, and never renders a dialog or an overlay", () => {
		render(<WorkspaceRail projectId="p1" environmentId="e1" />);
		expect(rail()).toHaveAttribute("data-open", "false");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(document.querySelector("[data-slot=sheet-overlay]")).toBeNull();
	});

	it("draws the body of every subject", () => {
		render(<WorkspaceRail projectId="p1" environmentId="e1" />);

		show({ kind: "node", id: "database-orders" });
		expect(screen.getByText("node subject database-orders")).toBeInTheDocument();
		expect(rail()).toHaveAttribute("data-open", "true");

		show({ kind: "environment" });
		expect(screen.getByText("environment subject with activity")).toBeInTheDocument();
		expect(screen.queryByText(/node subject/)).not.toBeInTheDocument();

		show({ kind: "node", id: "addon-grafana" });
		expect(screen.getByText("addon subject grafana")).toBeInTheDocument();

		show({ kind: "node", id: "chart-web" });
		expect(screen.getByText("chart subject web")).toBeInTheDocument();

		show({ kind: "node", id: "cw-w1" });
		expect(screen.getByText("workload subject cw-w1")).toBeInTheDocument();

		show({ kind: "node", id: "external-network" });
		expect(screen.getByText("external subject external-network")).toBeInTheDocument();

		show({ kind: "collection", nodeKind: "secret" });
		expect(screen.getByText("collection subject secret")).toBeInTheDocument();

		show({ kind: "selection", ids: ["database-orders", "bucket-assets"] });
		expect(screen.getByRole("heading", { name: "2 selected" })).toBeInTheDocument();
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("says so when the subject names a node that is not on the board", () => {
		render(<WorkspaceRail projectId="p1" environmentId="e1" />);
		show({ kind: "node", id: "database-gone" });
		expect(rail()).toHaveAttribute("data-open", "true");
		expect(screen.getByText("This is no longer on the board")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
	});

	it("shows each legacy rail card as the subject it maps onto", () => {
		render(<WorkspaceRail projectId="p1" environmentId="e1" />);
		const open = (card: WorkspaceCard) => act(() => useCanvasStore.getState().openCard(card));

		open({ kind: "inspector", nodeId: "database-orders" });
		expect(screen.getByText("node subject database-orders")).toBeInTheDocument();

		open({ kind: "env-settings" });
		expect(screen.getByText("environment subject with activity")).toBeInTheDocument();
		expect(board.view.getState().tab).toBeNull();

		open({ kind: "activity" });
		expect(screen.getByText("environment subject with activity")).toBeInTheDocument();
		expect(board.view.getState().tab).toBe("activity");

		open({ kind: "iac-scan" });
		expect(screen.getByText("environment subject with activity")).toBeInTheDocument();
		expect(board.view.getState().tab).toBe("sources");

		open({ kind: "addon", itemId: "grafana" });
		expect(screen.getByText("addon subject grafana")).toBeInTheDocument();

		open({ kind: "chart-scan", chartId: "web" });
		expect(screen.getByText("chart subject web")).toBeInTheDocument();
	});

	it("has one width for every subject, and swaps the content in place", () => {
		render(<WorkspaceRail projectId="p1" environmentId="e1" />);
		const width = `${RAIL_W + RAIL_GAP}px`;
		expect(rail()).toHaveClass("workspace-rail");
		expect(rail()).toHaveStyle({ width: "0px" });

		show({ kind: "node", id: "database-orders" });
		const region = screen.getByRole("complementary", { name: "Inspector" });
		expect(rail()).toHaveStyle({ width });
		expect(
			screen.getByText("node subject database-orders").closest(".workspace-card-in"),
		).not.toBeNull();

		const subjects: Subject[] = [
			{ kind: "node", id: "bucket-assets" },
			{ kind: "environment" },
			{ kind: "node", id: "addon-grafana" },
			{ kind: "collection", nodeKind: "secret" },
			{ kind: "selection", ids: ["database-orders"] },
		];
		const seen: { open: string | null; sameRegion: boolean; width: string }[] = [];
		for (const subject of subjects) {
			show(subject);
			seen.push({
				open: rail().getAttribute("data-open"),
				sameRegion: screen.getByRole("complementary", { name: "Inspector" }) === region,
				width: rail().style.width,
			});
		}
		expect(seen).toEqual(subjects.map(() => ({ open: "true", sameRegion: true, width })));
		expect(screen.queryByText(/node subject/)).not.toBeInTheDocument();
	});

	it("an add-on needs a project to read its catalog from, so without one the rail stays shut", () => {
		render(<WorkspaceRail />);
		show({ kind: "node", id: "addon-grafana" });
		expect(screen.queryByText(/addon subject/)).not.toBeInTheDocument();
		expect(rail()).toHaveAttribute("data-open", "false");
	});

	it("offers the environment's activity only when it has a project and an environment to read", () => {
		render(<WorkspaceRail projectId="p1" />);
		act(() => useCanvasStore.getState().openCard({ kind: "activity" }));
		expect(rail()).toHaveAttribute("data-open", "true");
		expect(screen.getByText("environment subject")).toBeInTheDocument();
	});

	it("agrees with the board's seam about every legacy card", () => {
		const full = { projectId: "p1", environmentId: "e1" };
		const addon: WorkspaceCard = { kind: "addon", itemId: "grafana" };
		expect(isRailOpen(addon, {})).toBe(false);
		expect(isRailOpen(addon, full)).toBe(true);
		expect(isRailOpen({ kind: "activity" }, {})).toBe(true);
		expect(isRailOpen({ kind: "env-settings" }, {})).toBe(true);
		expect(isRailOpen({ kind: "iac-scan" }, {})).toBe(true);
		expect(isRailOpen({ kind: "inspector", nodeId: "n" }, {})).toBe(true);
		expect(isRailOpen(null, full)).toBe(false);
	});

	it("unmounting the rail closes the inspector", () => {
		const { unmount } = render(<WorkspaceRail projectId="p1" environmentId="e1" />);
		show({ kind: "environment" });
		act(() => unmount());
		expect(board.view.getState().subject).toBeNull();
		expect(useCanvasStore.getState().card).toBeNull();
	});
});

describe("WorkspaceRail — Escape, closing and the focus", () => {
	it("Escape inside the rail closes it and returns the focus to the subject's card", () => {
		const card = boardCard("database-orders");
		render(<WorkspaceRail projectId="p1" environmentId="e1" />);
		show({ kind: "node", id: "database-orders" });

		const control = screen.getByRole("button", { name: "A control" });
		act(() => control.focus());
		fireEvent.keyDown(control, { key: "Escape" });

		expect(board.view.getState().subject).toBeNull();
		expect(rail()).toHaveAttribute("data-open", "false");
		expect(document.activeElement).toBe(card);
	});

	it("Escape in a field leaves the field first, so what was typed is committed", () => {
		boardCard("database-orders");
		render(<WorkspaceRail projectId="p1" environmentId="e1" />);
		show({ kind: "node", id: "database-orders" });

		const field = screen.getByLabelText("A field");
		act(() => field.focus());
		fireEvent.keyDown(field, { key: "Escape" });

		expect(fieldLeft).toHaveBeenCalledTimes(1);
		expect(board.view.getState().subject).toBeNull();
	});

	it("closing with the focus in the rail returns it to where the person came from", () => {
		const outside = document.createElement("button");
		outside.setAttribute("data-outside", "");
		document.body.appendChild(outside);
		render(<WorkspaceRail projectId="p1" environmentId="e1" />);
		show({ kind: "environment" });

		// The environment has no card on the board: the focus goes back to the control it left.
		act(() => outside.focus());
		const region = screen.getByRole("complementary", { name: "Inspector" });
		act(() => region.focus());
		// The browser names where the focus came from; said here outright so the case does not
		// depend on how completely the test DOM fills `relatedTarget` in.
		fireEvent.focusIn(region, { relatedTarget: outside });
		show(null);

		expect(document.activeElement).toBe(outside);
	});

	it("closing from outside the rail leaves the focus where it is", () => {
		boardCard("database-orders");
		const outside = document.createElement("button");
		outside.setAttribute("data-outside", "");
		document.body.appendChild(outside);
		render(<WorkspaceRail projectId="p1" environmentId="e1" />);
		show({ kind: "node", id: "database-orders" });

		act(() => outside.focus());
		show(null);

		expect(document.activeElement).toBe(outside);
	});

	it("Escape that a menu or a select opened from the rail owns does not close the inspector", () => {
		render(<WorkspaceRail projectId="p1" environmentId="e1" />);
		show({ kind: "node", id: "database-orders" });

		const control = screen.getByRole("button", { name: "A control" });
		control.setAttribute("aria-haspopup", "listbox");
		control.setAttribute("aria-expanded", "true");
		fireEvent.keyDown(control, { key: "Escape" });

		expect(board.view.getState().subject).toEqual({ kind: "node", id: "database-orders" });
	});
});

describe("parseCardParam", () => {
	it("reads every deep-link shape and rejects everything else", () => {
		expect(parseCardParam("activity")).toEqual({ kind: "activity" });
		expect(parseCardParam("env-settings")).toEqual({ kind: "env-settings" });
		expect(parseCardParam("iac-scan")).toEqual({ kind: "iac-scan" });
		expect(parseCardParam("node:database-orders")).toEqual({
			kind: "inspector",
			nodeId: "database-orders",
		});
		expect(parseCardParam("addon:grafana")).toEqual({ kind: "addon", itemId: "grafana" });
		expect(parseCardParam("chart:web")).toEqual({ kind: "chart-scan", chartId: "web" });
		expect(parseCardParam(null)).toBeNull();
		expect(parseCardParam("")).toBeNull();
		expect(parseCardParam("node:")).toBeNull();
		expect(parseCardParam("bogus:1")).toBeNull();
		expect(parseCardParam("inspector")).toBeNull();
	});
});

describe("resolveCardParam", () => {
	it("resolves every old ?card= value to a subject and the tab it opens on", () => {
		expect(resolveCardParam("activity")).toEqual({
			subject: { kind: "environment" },
			tab: "activity",
		});
		expect(resolveCardParam("env-settings")).toEqual({
			subject: { kind: "environment" },
			tab: null,
		});
		expect(resolveCardParam("node:database-orders")).toEqual({
			subject: { kind: "node", id: "database-orders" },
			tab: null,
		});
		expect(resolveCardParam("addon:grafana")).toEqual({
			subject: { kind: "node", id: "addon-grafana" },
			tab: null,
		});
	});

	it("resolves the values added with the one inspector, and a collection's card id", () => {
		expect(resolveCardParam("iac-scan")).toEqual({
			subject: { kind: "environment" },
			tab: "sources",
		});
		expect(resolveCardParam("chart:web")).toEqual({
			subject: { kind: "node", id: "chart-web" },
			tab: "status",
		});
		expect(resolveCardParam("node:collection:secret")).toEqual({
			subject: { kind: "collection", nodeKind: "secret" },
			tab: null,
		});
	});

	it("answers null for a value that names nothing", () => {
		expect(resolveCardParam(null)).toBeNull();
		expect(resolveCardParam("bogus:1")).toBeNull();
	});
});

describe("useCardDeepLink", () => {
	it("opens the card AFTER a parent's mount effect has seeded the graph", async () => {
		const search = new URLSearchParams("environment_id=e1&card=env-settings");
		const openCard = (card: WorkspaceCard) => useCanvasStore.getState().openCard(card);

		renderHook(() => useCardDeepLink(search, openCard));
		// A parent's mount effect runs after the child's and clears the card (what `setGraph` does).
		act(() => useCanvasStore.setState({ card: null }));

		await Promise.resolve();
		expect(useCanvasStore.getState().card).toEqual({ kind: "env-settings" });
		expect(board.view.getState().subject).toEqual({ kind: "environment" });
	});

	it("strips only `card`, and without a router navigation", () => {
		const replaceState = vi.spyOn(window.history, "replaceState");
		const search = new URLSearchParams("environment_id=e1&card=activity");

		renderHook(() => useCardDeepLink(search, () => {}));

		expect(replaceState).toHaveBeenCalledTimes(1);
		const url = String(replaceState.mock.calls[0]?.[2]);
		expect(url).toContain("environment_id=e1");
		expect(url).not.toContain("card=");
		replaceState.mockRestore();
	});

	it("does nothing at all without the param", () => {
		const replaceState = vi.spyOn(window.history, "replaceState");
		renderHook(() => useCardDeepLink(new URLSearchParams("environment_id=e1"), () => {}));
		expect(replaceState).not.toHaveBeenCalled();
		replaceState.mockRestore();
	});
});
