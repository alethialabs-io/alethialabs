// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The rail shows ONE card, chosen by the store's `card`. These pin the routing (each kind lands on
// its card), that nothing on the rail is a modal (no overlay, no dialog), that unmounting the rail
// closes the card (leaving Architecture used to need an effect in the shell for this), and the
// deep-link grammar the canvas consumes on mount.

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseCardParam } from "@/components/design-project/canvas/cards/card-param";
import {
	isRailOpen,
	WorkspaceRail,
} from "@/components/design-project/canvas/cards/workspace-rail";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

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

	it("routes every card kind to its card", () => {
		render(<WorkspaceRail projectId="p1" environmentId="e1" />);
		const s = useCanvasStore.getState();

		s.openCard({ kind: "inspector", nodeId: "database-orders" });
		expect(screen.getByText("inspector card")).toBeInTheDocument();
		expect(screen.getByTestId("workspace-rail")).toHaveAttribute("data-open", "true");

		s.openCard({ kind: "env-settings" });
		expect(screen.getByText("env settings card")).toBeInTheDocument();
		expect(screen.queryByText("inspector card")).not.toBeInTheDocument();

		s.openCard({ kind: "addon", itemId: "grafana" });
		expect(screen.getByText("addon card grafana")).toBeInTheDocument();

		s.openCard({ kind: "chart-scan", chartId: "web" });
		expect(screen.getByText("chart scan web")).toBeInTheDocument();

		s.openCard({ kind: "iac-scan" });
		expect(screen.getByText("iac scan card")).toBeInTheDocument();
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("the add-on card needs a project — the create flow has none, so the rail stays empty", () => {
		render(<WorkspaceRail />);
		useCanvasStore.getState().openCard({ kind: "addon", itemId: "grafana" });
		expect(screen.queryByText(/addon card/)).not.toBeInTheDocument();
	});

	it("stays closed for the activity card until its lane lands", () => {
		expect(isRailOpen({ kind: "activity" })).toBe(false);
		expect(isRailOpen({ kind: "env-settings" })).toBe(true);
		expect(isRailOpen(null)).toBe(false);
	});

	it("unmounting the rail closes the card", () => {
		const { unmount } = render(<WorkspaceRail projectId="p1" environmentId="e1" />);
		useCanvasStore.getState().openCard({ kind: "env-settings" });
		unmount();
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
