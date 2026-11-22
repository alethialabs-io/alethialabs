// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// W5 Path A (Lane 3) — the inspector on a described chart workload. Its Status view is the
// READ-ONLY description from the real read model (image / kind / rendered env keys); its Settings
// view is the editable overlay (the reused W3 BindingsField, replicas, env, value paths).
//
// The overlay is STAGED (#6834): an edit becomes a staged operation in the document when the field
// is left and when the panel goes away, and there is no Save button. These pin that, against the
// real ChartWorkloadNodeConfig shape.

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { ByoChartCanvasProvider } from "@/components/design-project/byo/byo-chart-canvas-context";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import type { ServiceBinding } from "@/components/design-project/canvas/inspector/bindings-field";
import { ChartWorkloadPanel } from "@/components/design-project/canvas/inspector/chart-workload-panel";
import { board } from "@/lib/canvas/store/board";
import { BoardSourcesProvider } from "@/lib/canvas/store/canvas-store-provider";

/** The cards the design does not own, as the canvas hands them from their queries. */
let others: CanvasNode[] = [];
const NO_OUTPUTS: string[] = [];

/** The panel inside the board's BYO-chart context (a project to stage the overlay for). */
function InBoard({ children }: { children: ReactNode }) {
	return (
		<ByoChartCanvasProvider value={{ projectId: "proj-1", environmentId: "env-1" }}>
			<BoardSourcesProvider others={others} iacOutputs={NO_OUTPUTS}>
				{children}
			</BoardSourcesProvider>
		</ByoChartCanvasProvider>
	);
}

/** A described-workload node, as `outOfBandNodes` builds it from the workloads read. */
function workloadNode(
	bindings: ServiceBinding[] = [],
	config: { replicas?: number } = {},
): CanvasNode {
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
				bindings,
				config,
				valuePaths: {},
			},
			cloud_identity_id: null,
			provider: null,
		},
	} as unknown as CanvasNode;
}

/** The operations staged in the document. */
const staged = () => board.document.getState().operations;

beforeEach(() => {
	board.reset();
	others = [workloadNode()];
});

describe("ChartWorkloadPanel", () => {
	it("opens on the editable overlay, in the inspector's frame", () => {
		render(<ChartWorkloadPanel nodeId="cw-w1" />, { wrapper: InBoard });
		expect(screen.getByRole("heading", { name: "web" })).toBeInTheDocument();
		expect(screen.getByText("Chart workload")).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Bindings" })).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Value paths" })).toBeInTheDocument();
		expect(screen.getByText("Bind a resource")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
	});

	it("has no commit button: the changes bar is where the overlay is applied", () => {
		render(<ChartWorkloadPanel nodeId="cw-w1" />, { wrapper: InBoard });
		expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
	});

	it("shows the read-only description from the real read model on Status", async () => {
		const user = userEvent.setup();
		render(<ChartWorkloadPanel nodeId="cw-w1" />, { wrapper: InBoard });
		await user.click(screen.getByRole("tab", { name: "Status" }));
		expect(screen.getByText("ghcr.io/acme/web:1.2.3")).toBeInTheDocument();
		expect(screen.getByText("LOG_LEVEL")).toBeInTheDocument();
		expect(screen.getByText("DB_URL")).toBeInTheDocument();
		expect(screen.queryByLabelText("Replicas")).not.toBeInTheDocument();
	});

	it("offers the `database` facet, which only the chart lane resolves (#6467)", () => {
		others = [
			workloadNode([
				{
					target: { kind: "database", name: "orders" },
					inject: [{ env: "DB_NAME", from: "database" }],
				},
			]),
		];
		render(<ChartWorkloadPanel nodeId="cw-w1" />, { wrapper: InBoard });
		expect(screen.getByText("database name")).toBeInTheDocument();
	});

	it("returns nothing for an unknown node id", () => {
		const { container } = render(<ChartWorkloadPanel nodeId="cw-missing" />, { wrapper: InBoard });
		expect(container).toBeEmptyDOMElement();
	});
});

describe("ChartWorkloadPanel — the overlay is staged, not saved (#6834)", () => {
	it("stages only the part that changed when the field is left", async () => {
		const user = userEvent.setup();
		render(<ChartWorkloadPanel nodeId="cw-w1" />, { wrapper: InBoard });
		await user.type(screen.getByLabelText("Replicas"), "2");
		expect(staged()).toEqual([]);
		await user.tab();

		expect(staged()).toEqual([
			{
				id: "chart-workload:w1",
				target: "chart-workload",
				verb: "overlay",
				targetId: "w1",
				summary: "Chart workload web: replicas and env",
				input: { projectId: "proj-1", workloadId: "w1", config: { replicas: 2 } },
			},
		]);
		expect(screen.getByRole("status")).toHaveTextContent("Overlay staged.");
	});

	it("stages what was typed when the panel goes away without the field being left", async () => {
		const user = userEvent.setup();
		const { unmount } = render(<ChartWorkloadPanel nodeId="cw-w1" />, { wrapper: InBoard });
		await user.type(screen.getByLabelText("Replicas"), "4");
		act(() => unmount());

		expect(staged().map((o) => o.input)).toEqual([
			{ projectId: "proj-1", workloadId: "w1", config: { replicas: 4 } },
		]);
	});

	it("staging is one undo step, and undoing it takes the overlay off the changeset", async () => {
		const user = userEvent.setup();
		render(<ChartWorkloadPanel nodeId="cw-w1" />, { wrapper: InBoard });
		await user.type(screen.getByLabelText("Replicas"), "2");
		await user.tab();
		expect(staged()).toHaveLength(1);

		act(() => {
			board.document.getState().undo();
		});
		expect(staged()).toEqual([]);
	});

	it("a field put back to what is saved takes the overlay off the changeset", async () => {
		const user = userEvent.setup();
		render(<ChartWorkloadPanel nodeId="cw-w1" />, { wrapper: InBoard });
		const replicas = screen.getByLabelText("Replicas");
		await user.type(replicas, "2");
		await user.tab();
		expect(staged()).toHaveLength(1);

		await user.clear(replicas);
		await user.tab();
		expect(staged()).toEqual([]);
	});

	it("Discard puts the form back to what is saved and unstages the overlay", async () => {
		const user = userEvent.setup();
		render(<ChartWorkloadPanel nodeId="cw-w1" />, { wrapper: InBoard });
		await user.type(screen.getByLabelText("Replicas"), "2");
		await user.tab();
		await user.click(screen.getByRole("button", { name: "Discard" }));

		expect(staged()).toEqual([]);
		expect(screen.getByLabelText("Replicas")).toHaveValue(null);
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("says why a value may not be staged, under the field, and stages nothing", async () => {
		const user = userEvent.setup();
		render(<ChartWorkloadPanel nodeId="cw-w1" />, { wrapper: InBoard });
		await user.type(screen.getByLabelText("Replicas"), "-1");
		await user.tab();

		expect(screen.getByText("Replicas is a whole number, 0 or more.")).toBeInTheDocument();
		expect(screen.getByLabelText("Replicas")).toHaveAttribute("aria-invalid", "true");
		expect(staged()).toEqual([]);
	});

	it("reopens on what is staged, laid over what is saved", async () => {
		const user = userEvent.setup();
		const first = render(<ChartWorkloadPanel nodeId="cw-w1" />, { wrapper: InBoard });
		await user.type(screen.getByLabelText("Replicas"), "5");
		await user.tab();
		act(() => first.unmount());

		render(<ChartWorkloadPanel nodeId="cw-w1" />, { wrapper: InBoard });
		expect(screen.getByLabelText("Replicas")).toHaveValue(5);
		expect(screen.getByRole("status")).toHaveTextContent("Overlay staged.");
	});

	it("adding an env row stages nothing until the row has a name", async () => {
		const user = userEvent.setup();
		render(<ChartWorkloadPanel nodeId="cw-w1" />, { wrapper: InBoard });
		await user.click(screen.getByRole("button", { name: "Add env var" }));
		await user.tab();
		expect(staged()).toEqual([]);

		await user.type(screen.getByLabelText("Environment variable name"), "LOG_LEVEL");
		await user.type(screen.getByLabelText("Environment variable value"), "debug");
		await user.tab();
		expect(staged().map((o) => o.input)).toEqual([
			{
				projectId: "proj-1",
				workloadId: "w1",
				config: { env: [{ name: "LOG_LEVEL", value: "debug" }] },
			},
		]);
	});

	it("without a project it is read-only, says so, and stages nothing", async () => {
		const user = userEvent.setup();
		// The card is on the board, but no BYO-chart context names a project to stage it for.
		render(
			<BoardSourcesProvider others={others} iacOutputs={NO_OUTPUTS}>
				<ChartWorkloadPanel nodeId="cw-w1" />
			</BoardSourcesProvider>,
		);
		expect(screen.getByRole("status")).toHaveTextContent("Read-only");
		expect(screen.getByLabelText("Replicas")).toBeDisabled();
		await user.tab();
		expect(staged()).toEqual([]);
	});
});
