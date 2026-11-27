// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The BYO chart node's scan chip (#7873). "Scanning…" is a STATUS, not a wait: the chip renders a
// StatusBadge in its pending tier — the haloed dot and a mono label — and no spinning icon. Every
// other state reads through the same badge, by the dot's shape and the label, never by hue.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { describe, expect, it, vi } from "vitest";
import { ChartNode } from "@/components/design-project/canvas/nodes/chart-node";
import { type CanvasNode, nodeOfKind } from "@/components/design-project/canvas/graph/types";
import type { VerifyReport } from "@/types/jsonb.types";
import { withBoardSources } from "@/tests/fixtures/canvas/board";
import { chartNode } from "@/tests/fixtures/canvas/nodes";

vi.mock("@/app/server/actions/byo-charts", () => ({
	detachByoChartAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc({}).orpc };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

/** A verify report with the given fail / warn counts and nothing else of note. */
function report(fail: number, warn: number): VerifyReport {
	return {
		verdict: fail > 0 ? "fail" : warn > 0 ? "warn" : "pass",
		catalog_version: "test",
		provider: "helm",
		summary: { fail, warn, pass: 3, not_evaluable: 0 },
		controls: [],
	};
}

/** The fixture chart `web` on the board, with the given scan lifecycle and report. */
function scannedChart(scanStatus: string, scanReport: VerifyReport | null): CanvasNode<"chart"> {
	const base = nodeOfKind(chartNode("web"), "chart");
	if (!base) throw new Error("chartNode fixture is not a chart");
	return { ...base, data: { ...base.data, config: { ...base.data.config, scanStatus, scanReport } } };
}

/** Renders the chart node for `node` with the board and query context it reads. */
function renderChart(node: CanvasNode<"chart">) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<ReactFlowProvider>
				{withBoardSources(
					<ChartNode
						id={node.id}
						data={node.data}
						type="chart"
						selected={false}
						dragging={false}
						draggable={false}
						selectable
						deletable={false}
						zIndex={0}
						isConnectable={false}
						positionAbsoluteX={0}
						positionAbsoluteY={0}
					/>,
					{ others: [node] },
				)}
			</ReactFlowProvider>
		</QueryClientProvider>,
	);
}

/** The StatusBadge inside the chart's scan chip. */
function chipBadge(): Element | null {
	return screen.getByTitle("Chart safety scan").querySelector(".vx-status");
}

describe("ChartNode scan chip", () => {
	it("renders a running scan as a pending StatusBadge, not a spinner", () => {
		renderChart(scannedChart("scanning", null));
		const chip = screen.getByTitle("Chart safety scan");
		expect(chipBadge()).toHaveClass("vx-status--pending");
		expect(chipBadge()).toHaveTextContent("Scanning…");
		expect(chip.querySelector(".animate-spin")).toBeNull();
		expect(chip.querySelector("svg")).toBeNull();
	});

	it("reads a failed scan run as the failed tier", () => {
		renderChart(scannedChart("failed", null));
		expect(chipBadge()).toHaveClass("vx-status--failed");
		expect(chipBadge()).toHaveTextContent("Scan failed");
	});

	it("reads a failing control as failed and warnings alone as active, both with the issue count", () => {
		const { unmount } = renderChart(scannedChart("done", report(1, 1)));
		expect(chipBadge()).toHaveClass("vx-status--failed");
		expect(chipBadge()).toHaveTextContent("2 issues");
		unmount();
		renderChart(scannedChart("done", report(0, 1)));
		expect(chipBadge()).toHaveClass("vx-status--active");
		expect(chipBadge()).toHaveTextContent("1 issue");
	});

	it("reads a clean chart as active and an unscanned one as idle", () => {
		const { unmount } = renderChart(scannedChart("done", report(0, 0)));
		expect(chipBadge()).toHaveClass("vx-status--active");
		expect(chipBadge()).toHaveTextContent("Clean");
		unmount();
		renderChart(scannedChart("unscanned", null));
		expect(chipBadge()).toHaveClass("vx-status--idle");
		expect(chipBadge()).toHaveTextContent("Not scanned");
	});
});
