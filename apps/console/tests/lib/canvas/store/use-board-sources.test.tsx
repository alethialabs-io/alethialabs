// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The cards the design does not own, read from their queries (#6764). These used to be copied into
// the canvas store by one effect per read; here they are a `useMemo` over the query data, and this
// pins what comes out of it and that a read which is switched off is not made.

import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	handlers: {} as Record<string, (input: unknown) => Promise<unknown>>,
	calls: [] as { path: string; input: unknown }[],
}));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc(h.handlers, h.calls).orpc };
});

import {
	EMPTY_ENVIRONMENT_STATUS,
	type EnvironmentStatus,
	type IacEnvironment,
} from "@/lib/canvas/component-status";
import { EnvironmentStatusProvider } from "@/lib/canvas/environment-status-context";
import {
	addonNodes,
	chartNodes,
	chartWorkloadNodes,
	iacNodes,
	outOfBandNodes,
} from "@/lib/canvas/store/out-of-band";
import { useIacOutputs, useOutOfBandNodes } from "@/lib/canvas/store/use-board-sources";
import { queryWrapper } from "@/tests/helpers/query-wrapper";

const PROJECT = "proj-1";
const ENVIRONMENT = "env-a";

const CHART = {
	id: "pg",
	repoUrl: "https://github.com/acme/charts",
	chartPath: "charts/pg",
	ref: "main",
	namespace: "default",
	status: "ACTIVE",
	health: "Healthy",
	sync: "Synced",
	scanStatus: "done",
	scanReport: null,
};

const WORKLOAD = {
	id: "w1",
	chartId: "pg",
	name: "web",
	kind: "deployment",
	rendered: { image: "ghcr.io/acme/web:1", ports: [], env_keys: [] },
	bindings: [],
	config: {},
	valuePaths: {},
};

const GROUP = { key: "database", kind: "database", module: "", source: "plan", members: [] };

const ADDONS = {
	environmentId: ENVIRONMENT,
	hasAppsRepo: false,
	items: [
		{
			id: "grafana",
			name: "Grafana",
			version: "8.1.2",
			namespace: "monitoring",
			install: { enabled: true, status: "ACTIVE", health: "Healthy", sync: "Synced" },
		},
		// In the catalog, not installed: no card.
		{ id: "loki", name: "Loki", version: "6.0.0", namespace: "monitoring", install: null },
		// Installed once, since disabled: no card.
		{
			id: "tempo",
			name: "Tempo",
			version: "1.0.0",
			namespace: "monitoring",
			install: { enabled: false, status: "DESTROYED" },
		},
	],
};

/** A query client, with the environment status the board publishes. */
function wrapperWith(status: Partial<EnvironmentStatus>) {
	const Query = queryWrapper();
	return function Wrapper({ children }: { children: ReactNode }) {
		return (
			<Query>
				<EnvironmentStatusProvider value={{ ...EMPTY_ENVIRONMENT_STATUS, ...status }}>
					{children}
				</EnvironmentStatusProvider>
			</Query>
		);
	};
}

beforeEach(() => {
	h.calls.length = 0;
	h.handlers["canvas.byoCharts"] = async () => ({ charts: [CHART] });
	h.handlers["canvas.chartWorkloads"] = async () => ({ workloads: [WORKLOAD] });
	h.handlers["canvas.addons"] = async () => ADDONS;
});

describe("useOutOfBandNodes", () => {
	it("builds one card per chart, workload, installed add-on and external group", async () => {
		const iac = { groups: [GROUP], outputs: ["db_url"] } as unknown as IacEnvironment;
		const { result } = renderHook(
			() =>
				useOutOfBandNodes({
					projectId: PROJECT,
					environmentId: ENVIRONMENT,
					byoHelmEnabled: true,
					byoDescribeEnabled: true,
				}),
			{ wrapper: wrapperWith({ iac }) },
		);

		await waitFor(() => expect(result.current).toHaveLength(4));
		expect(result.current.map((n) => n.id)).toEqual([
			"chart-pg",
			"cw-w1",
			"addon-grafana",
			"external-database",
		]);
		expect(result.current.every((n) => n.deletable === false)).toBe(true);
		// Every read asked for this project and environment.
		expect(new Set(h.calls.map((c) => JSON.stringify(c.input)))).toEqual(
			new Set([JSON.stringify({ projectId: PROJECT, environmentId: ENVIRONMENT })]),
		);
	});

	it("does not read charts or workloads while their flags are off", async () => {
		const { result } = renderHook(
			() => useOutOfBandNodes({ projectId: PROJECT, environmentId: ENVIRONMENT }),
			{ wrapper: wrapperWith({}) },
		);

		await waitFor(() => expect(result.current.map((n) => n.id)).toEqual(["addon-grafana"]));
		expect(h.calls.map((c) => c.path)).toEqual(["canvas.addons"]);
	});

	it("is the same array across a re-render that brought no new data", async () => {
		const { result, rerender } = renderHook(
			() => useOutOfBandNodes({ projectId: PROJECT, environmentId: ENVIRONMENT }),
			{ wrapper: wrapperWith({}) },
		);
		await waitFor(() => expect(result.current).toHaveLength(1));
		const first = result.current;
		rerender();
		expect(result.current).toBe(first);
	});
});

describe("useIacOutputs", () => {
	it("is the module's output names, and empty without a BYO-IaC module", () => {
		const iac = { groups: [], outputs: ["db_url", "vpc_id"] } as unknown as IacEnvironment;
		expect(renderHook(() => useIacOutputs(), { wrapper: wrapperWith({ iac }) }).result.current).toEqual([
			"db_url",
			"vpc_id",
		]);
		expect(renderHook(() => useIacOutputs(), { wrapper: wrapperWith({}) }).result.current).toEqual([]);
	});
});

describe("the builders", () => {
	it("stack a chart's workloads beneath it, and in a column when the chart is not there yet", () => {
		const charts = chartNodes([CHART] as unknown as Parameters<typeof chartNodes>[0]);
		const workloads = [WORKLOAD, { ...WORKLOAD, id: "w2" }] as unknown as Parameters<
			typeof chartWorkloadNodes
		>[0];
		const [first, second] = chartWorkloadNodes(workloads, charts);
		expect(first.position).toEqual({ x: charts[0].position.x + 40, y: charts[0].position.y + 150 });
		expect(second.position.y - first.position.y).toBe(130);
		expect(chartWorkloadNodes(workloads, [])[0].position).toEqual({ x: 940, y: 310 });
	});

	it("carry what each card shows", () => {
		const [addon] = addonNodes([
			{ id: "grafana", name: "Grafana", version: "8.1.2", namespace: "monitoring", health: "Degraded" },
		]);
		expect(addon.data.kind === "addon" ? addon.data.config.health : null).toBe("Degraded");
		const [external] = iacNodes([GROUP] as unknown as Parameters<typeof iacNodes>[0]);
		expect(external.data.kind === "external" ? external.data.config.mappedKind : null).toBe("database");
	});

	it("an absent read contributes no cards", () => {
		expect(outOfBandNodes({})).toEqual([]);
	});
});
