// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The rail shows ONE card, chosen by the store's `card`. These pin the routing (each kind lands on
// its card), that nothing on the rail is a modal (no overlay, no dialog), that unmounting the rail
// closes the card (leaving Architecture used to need an effect in the shell for this), and the
// deep-link grammar the canvas consumes on mount.

import { act, render, renderHook, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	parseCardParam,
	useCardDeepLink,
} from "@/components/design-project/canvas/cards/card-param";
import {
	isRailOpen,
	WorkspaceRail,
} from "@/components/design-project/canvas/cards/workspace-rail";
import { useCanvasStore, type WorkspaceCard } from "@/lib/stores/use-canvas-store";

// Each card body is mocked to a labelled stub: the rail's job is to route, not to render them.
vi.mock("@/components/design-project/canvas/node-inspector", () => ({
	InspectorPanel: () => <div>inspector card</div>,
}));
vi.mock("@/components/design-project/canvas/cards/env-settings-card", () => ({
	EnvSettingsCard: () => <div>env settings card</div>,
}));
vi.mock("@/components/addons/addon-config-card", () => ({
	AddonConfigCard: ({ itemId }: { itemId: string }) => <div>addon card {itemId}</div>,
}));
vi.mock("@/components/design-project/canvas/cards/chart-scan-card", () => ({
	ChartScanCard: ({ chartId }: { chartId: string }) => <div>chart scan {chartId}</div>,
}));
vi.mock("@/components/design-project/canvas/cards/iac-scan-card", () => ({
	IacScanCard: () => <div>iac scan card</div>,
}));
vi.mock("@/components/design-project/canvas/cards/activity-card", () => ({
	ActivityCard: ({ environmentId }: { environmentId: string }) => (
		<div>activity card {environmentId}</div>
	),
}));

beforeEach(() => {
	useCanvasStore.getState().reset();
});

describe("WorkspaceRail", () => {
	it("is closed with no card, and never renders a dialog or an overlay", () => {
		render(<WorkspaceRail projectId="p1" environmentId="e1" />);
		expect(screen.getByTestId("workspace-rail")).toHaveAttribute("data-open", "false");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(document.querySelector("[data-slot=sheet-overlay]")).toBeNull();
	});

	// Every store write goes through `act`. A zustand write from outside it does reach the store, but
	// React is never told to flush, so the rail renders its INITIAL state and the assertion reads a
	// closed rail — which looks exactly like a routing bug in the component under test.
	it("routes every card kind to its card", () => {
		render(<WorkspaceRail projectId="p1" environmentId="e1" />);
		const open = (card: WorkspaceCard) =>
			act(() => useCanvasStore.getState().openCard(card));

		open({ kind: "inspector", nodeId: "database-orders" });
		expect(screen.getByText("inspector card")).toBeInTheDocument();
		expect(screen.getByTestId("workspace-rail")).toHaveAttribute("data-open", "true");

		open({ kind: "env-settings" });
		expect(screen.getByText("env settings card")).toBeInTheDocument();
		expect(screen.queryByText("inspector card")).not.toBeInTheDocument();

		open({ kind: "addon", itemId: "grafana" });
		expect(screen.getByText("addon card grafana")).toBeInTheDocument();

		open({ kind: "chart-scan", chartId: "web" });
		expect(screen.getByText("chart scan web")).toBeInTheDocument();

		open({ kind: "iac-scan" });
		expect(screen.getByText("iac scan card")).toBeInTheDocument();

		open({ kind: "activity" });
		expect(screen.getByText("activity card e1")).toBeInTheDocument();
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	// The rail must be SHUT, not merely empty. It was open-and-blank: 392px of nothing, with no
	// header and no close button, reachable in the create flow through `?card=addon:grafana`.
	it("the add-on and activity cards need a project — the create flow has none, so the rail stays shut", () => {
		render(<WorkspaceRail />);
		act(() => useCanvasStore.getState().openCard({ kind: "addon", itemId: "grafana" }));
		expect(screen.queryByText(/addon card/)).not.toBeInTheDocument();
		expect(screen.getByTestId("workspace-rail")).toHaveAttribute("data-open", "false");

		act(() => useCanvasStore.getState().openCard({ kind: "activity" }));
		expect(screen.queryByText(/activity card/)).not.toBeInTheDocument();
		expect(screen.getByTestId("workspace-rail")).toHaveAttribute("data-open", "false");
	});

	// `isRailOpen` and `CardBody` have to give ONE answer. Every kind a body can decline must be
	// declined here too, or the rail opens onto a card that renders nothing.
	it("agrees with the body about every card kind it can decline", () => {
		const full = { projectId: "p1", environmentId: "e1" };
		const addon: WorkspaceCard = { kind: "addon", itemId: "grafana" };
		expect(isRailOpen(addon, {})).toBe(false);
		expect(isRailOpen(addon, full)).toBe(true);
		// Activity reads ONE environment's jobs, so it needs both halves.
		expect(isRailOpen({ kind: "activity" }, {})).toBe(false);
		expect(isRailOpen({ kind: "activity" }, { projectId: "p1" })).toBe(false);
		expect(isRailOpen({ kind: "activity" }, full)).toBe(true);
		// Cards whose subject is the canvas itself need nothing from the host.
		expect(isRailOpen({ kind: "env-settings" }, {})).toBe(true);
		expect(isRailOpen({ kind: "iac-scan" }, {})).toBe(true);
		expect(isRailOpen({ kind: "inspector", nodeId: "n" }, {})).toBe(true);
		expect(isRailOpen(null, full)).toBe(false);
	});

	it("unmounting the rail closes the card", () => {
		const { unmount } = render(<WorkspaceRail projectId="p1" environmentId="e1" />);
		act(() => useCanvasStore.getState().openCard({ kind: "env-settings" }));
		act(() => unmount());
		expect(useCanvasStore.getState().card).toBeNull();
	});
});

describe("parseCardParam", () => {
	it("reads the four deep-link shapes and rejects everything else", () => {
		expect(parseCardParam("activity")).toEqual({ kind: "activity" });
		expect(parseCardParam("env-settings")).toEqual({ kind: "env-settings" });
		expect(parseCardParam("node:database-orders")).toEqual({
			kind: "inspector",
			nodeId: "database-orders",
		});
		expect(parseCardParam("addon:grafana")).toEqual({ kind: "addon", itemId: "grafana" });
		expect(parseCardParam(null)).toBeNull();
		expect(parseCardParam("")).toBeNull();
		expect(parseCardParam("node:")).toBeNull();
		expect(parseCardParam("bogus:1")).toBeNull();
		expect(parseCardParam("inspector")).toBeNull();
	});
});

describe("useCardDeepLink", () => {
	// The regression this pins: the canvas is a CHILD of the workbench, whose mount effect seeds the
	// graph and clears the open card. React runs the child's effects first, so opening the card
	// synchronously was undone a moment later and the link silently did nothing.
	it("opens the card AFTER a parent's mount effect has seeded the graph", async () => {
		const search = new URLSearchParams("environment_id=e1&card=env-settings");
		const openCard = (card: WorkspaceCard) => useCanvasStore.getState().openCard(card);

		renderHook(() => useCardDeepLink(search, openCard));
		// What the workbench does to the store immediately after this effect runs.
		act(() => useCanvasStore.setState({ card: null }));

		await Promise.resolve();
		expect(useCanvasStore.getState().card).toEqual({ kind: "env-settings" });
	});

	it("strips only `card`, and without a router navigation", () => {
		const replaceState = vi.spyOn(window.history, "replaceState");
		const search = new URLSearchParams("environment_id=e1&card=activity");

		renderHook(() => useCardDeepLink(search, () => {}));

		// `router.replace` would re-render the server component, hand the workbench a fresh
		// `sourceProject` and re-run its seeding effect — clearing the card a second time for a URL
		// change the user never made. Editing the address bar directly is all this needs.
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
