// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// W5 Path A (Lane 3) — the described chart-workload inspector panel. It renders the READ-ONLY
// description from the real read model (image / kind / rendered env keys) and the editable overlay
// (the reused W3 BindingsField + a Save action). These pin that the panel mounts against the real
// ChartWorkloadNodeConfig shape and shows the read-mostly surface.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryWrapper } from "@/tests/helpers/query-wrapper";

// The persist action pulls in the server DB/authz chain — mock it so the panel mounts in jsdom. It is
// on the mutation contract (#6119): one action per Save, answering an `ActionResult`.
const { saveOverlay, toast } = vi.hoisted(() => ({
	saveOverlay: vi.fn(),
	toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/app/server/actions/byo-charts", () => ({
	saveChartWorkloadOverlayAction: (input: unknown) => saveOverlay(input),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc({}).orpc };
});
vi.mock("sonner", () => ({ toast }));

import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import { ChartWorkloadPanel } from "@/components/design-project/canvas/inspector/chart-workload-panel";
import { ByoChartCanvasProvider } from "@/components/design-project/byo/byo-chart-canvas-context";

/** The panel inside a query client and the board's BYO-chart context (edit mode). */
function inBoard(): (props: { children: ReactNode }) => ReactNode {
	const Query = queryWrapper();
	const ctx = { projectId: "proj-1", environmentId: "env-1" };
	return function Board({ children }: { children: ReactNode }) {
		return (
			<Query>
				<ByoChartCanvasProvider value={ctx}>{children}</ByoChartCanvasProvider>
			</Query>
		);
	};
}

/** A described-workload node seeded straight into the store (as the loader would build it). */
function workloadNode(): CanvasNode {
	return {
		id: "cw-w1",
		type: "chart_workload",
		deletable: false,
		position: { x: 0, y: 0 },
		data: {
			kind: "chart_workload",
			config: {
				id: "w1",
				chartId: "web-chart",
				name: "web",
				kind: "deployment",
				rendered: {
					image: "ghcr.io/acme/web:1.2.3",
					ports: [{ container_port: 8080 }],
					env_keys: ["LOG_LEVEL", "DB_URL"],
					replicas: 3,
				},
				bindings: [],
				config: {},
				valuePaths: {},
			},
			cloud_identity_id: null,
			provider: null,
		},
	} as unknown as CanvasNode;
}

beforeEach(() => {
	saveOverlay.mockReset();
	saveOverlay.mockResolvedValue({ ok: true, data: { workloadId: "w1" } });
	toast.success.mockReset();
	toast.error.mockReset();
	useCanvasStore.getState().reset();
	useCanvasStore.setState({ nodes: [workloadNode()] });
});

describe("ChartWorkloadPanel", () => {
	it("renders the read-only description from the real read model", () => {
		render(<ChartWorkloadPanel nodeId="cw-w1" />, { wrapper: queryWrapper() });
		// Name + the not-owned "Chart workload" eyebrow.
		expect(screen.getByText("web")).toBeInTheDocument();
		expect(screen.getByText("Chart workload")).toBeInTheDocument();
		// The rendered description (read-only).
		expect(screen.getByText("ghcr.io/acme/web:1.2.3")).toBeInTheDocument();
		// Env is shown as KEY NAMES only.
		expect(screen.getByText("LOG_LEVEL")).toBeInTheDocument();
		expect(screen.getByText("DB_URL")).toBeInTheDocument();
	});

	it("surfaces the editable overlay (bindings + save)", () => {
		render(<ChartWorkloadPanel nodeId="cw-w1" />, { wrapper: queryWrapper() });
		expect(screen.getByText("Bindings")).toBeInTheDocument();
		expect(screen.getByText("Value paths")).toBeInTheDocument();
		// The reused W3 binding editor's add affordance.
		expect(screen.getByText("Bind a resource")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /save overlay/i })).toBeInTheDocument();
	});

	it("returns nothing for an unknown node id", () => {
		const { container } = render(<ChartWorkloadPanel nodeId="cw-missing" />, {
			wrapper: queryWrapper(),
		});
		expect(container).toBeEmptyDOMElement();
	});
});

describe("ChartWorkloadPanel — Save is one write on the mutation contract (#6119)", () => {
	it("sends only the part that changed, and confirms it", async () => {
		const user = userEvent.setup();
		render(<ChartWorkloadPanel nodeId="cw-w1" />, { wrapper: inBoard() });
		await user.type(screen.getByLabelText("Replicas"), "2");
		await user.click(screen.getByRole("button", { name: /save overlay/i }));

		await waitFor(() => expect(saveOverlay).toHaveBeenCalledTimes(1));
		expect(saveOverlay.mock.calls[0][0]).toEqual({
			projectId: "proj-1",
			workloadId: "w1",
			config: { replicas: 2 },
		});
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Workload overlay saved."));
	});

	it("says a refusal under the Save button and toasts nothing", async () => {
		saveOverlay.mockResolvedValue({
			ok: false,
			error: { kind: "not-found", message: "Chart workload not found" },
		});
		const user = userEvent.setup();
		render(<ChartWorkloadPanel nodeId="cw-w1" />, { wrapper: inBoard() });
		await user.type(screen.getByLabelText("Replicas"), "2");
		await user.click(screen.getByRole("button", { name: /save overlay/i }));

		expect(await screen.findByRole("alert")).toHaveTextContent("Chart workload not found");
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("holds Save disabled while the write is in flight", async () => {
		let settle: (v: unknown) => void = () => {};
		saveOverlay.mockReturnValue(new Promise((resolve) => (settle = resolve)));
		const user = userEvent.setup();
		render(<ChartWorkloadPanel nodeId="cw-w1" />, { wrapper: inBoard() });
		await user.type(screen.getByLabelText("Replicas"), "2");
		await user.click(screen.getByRole("button", { name: /save overlay/i }));

		await waitFor(() => expect(screen.getByRole("button", { name: /saving/i })).toBeDisabled());
		expect(saveOverlay).toHaveBeenCalledTimes(1);
		settle({ ok: true, data: { workloadId: "w1" } });
	});
});
