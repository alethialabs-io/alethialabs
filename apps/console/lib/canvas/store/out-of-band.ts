// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The cards the design does not own (#6764): BYO charts, their described workloads, installed
// add-ons and the external cards of a BYO-IaC module. Each builder turns one server read into
// board nodes. They are pure, so the same node set comes out of a `useMemo` over query data as out
// of anything else that holds the read — and none of it is ever written into the document, which
// is what keeps these cards out of the draft, the diff and the undo history.

import type { ByoChartState, ChartWorkloadState } from "@/app/server/actions/byo-charts";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import type { IacGroup } from "@/lib/canvas/iac-inventory";

/** An installed marketplace add-on, as much of it as its card shows. */
export interface AddonCard {
	id: string;
	name: string;
	version: string;
	namespace: string;
	status?: string;
	health?: string | null;
	sync?: string | null;
}

/** The four server reads behind the out-of-band cards. An absent read contributes no cards. */
export interface OutOfBandSources {
	charts?: ByoChartState[];
	workloads?: ChartWorkloadState[];
	addons?: AddonCard[];
	iacGroups?: IacGroup[];
}

/** One node per BYO chart. */
export function chartNodes(charts: ByoChartState[]): CanvasNode[] {
	return charts.map((c, i) => ({
		id: `chart-${c.id}`,
		type: "chart",
		// Non-deletable: detaching is out-of-band (detachByoChart) via the node's own
		// action, so a stray keyboard-delete can't orphan a project_addons row.
		deletable: false,
		position: { x: 900, y: 160 + i * 150 },
		data: {
			kind: "chart",
			config: {
				id: c.id,
				repoUrl: c.repoUrl,
				chartPath: c.chartPath,
				ref: c.ref,
				namespace: c.namespace,
				status: c.status,
				health: c.health,
				sync: c.sync,
				scanStatus: c.scanStatus,
				scanReport: c.scanReport,
			},
			cloud_identity_id: null,
			provider: null,
		},
	}));
}

/**
 * One node per described chart workload, stacked beneath its parent `chart-` node (a column when
 * the chart node is not among `others` yet — the two reads arrive independently). Like chart nodes,
 * these are non-deletable: they're an out-of-band description, not a staged change, so a stray
 * Backspace must not orphan the render.
 */
export function chartWorkloadNodes(
	workloads: ChartWorkloadState[],
	others: CanvasNode[],
): CanvasNode[] {
	const perChart = new Map<string, number>();
	return workloads.map((w) => {
		const parent = others.find((n) => n.id === `chart-${w.chartId}`);
		const i = perChart.get(w.chartId) ?? 0;
		perChart.set(w.chartId, i + 1);
		const px = parent?.position.x ?? 900;
		const py = parent?.position.y ?? 160;
		return {
			id: `cw-${w.id}`,
			type: "chart_workload",
			deletable: false,
			position: { x: px + 40, y: py + 150 + i * 130 },
			data: {
				kind: "chart_workload",
				config: {
					id: w.id,
					chartId: w.chartId,
					name: w.name,
					kind: w.kind,
					rendered: w.rendered,
					bindings: w.bindings,
					config: w.config,
					valuePaths: w.valuePaths,
				},
				cloud_identity_id: null,
				provider: null,
			},
		};
	});
}

/** One node per installed add-on. */
export function addonNodes(addons: AddonCard[]): CanvasNode[] {
	return addons.map((a, i) => ({
		id: `addon-${a.id}`,
		type: "addon",
		// Not keyboard-deletable: an add-on is removed by disabling it (which tears down its
		// ArgoCD Application), never by a stray Backspace on the board.
		deletable: false,
		position: { x: 120 + (i % 2) * 270, y: 520 + Math.floor(i / 2) * 150 },
		data: {
			kind: "addon",
			config: {
				id: a.id,
				name: a.name,
				version: a.version,
				namespace: a.namespace,
				status: a.status,
				health: a.health,
				sync: a.sync,
			},
			cloud_identity_id: null,
			provider: null,
		},
	}));
}

/**
 * One read-only card per group of a BYO-IaC module's resources. The customer's module owns these:
 * there is nothing to delete here — removing a resource means editing their Terraform, not this
 * board.
 */
export function iacNodes(groups: IacGroup[]): CanvasNode[] {
	return groups.map((g, i) => ({
		id: `external-${g.key}`,
		type: "external",
		deletable: false,
		position: { x: 120 + (i % 3) * 300, y: 340 + Math.floor(i / 3) * 190 },
		data: {
			kind: "external",
			config: {
				key: g.key,
				mappedKind: g.kind,
				module: g.module,
				source: g.source,
				members: g.members,
			},
			cloud_identity_id: null,
			provider: null,
		},
	}));
}

/**
 * Every out-of-band card the reads describe, each at its DEFAULT place. Where a person dragged one
 * to is in the document's `positions`, applied when the board's nodes are joined — so a refetch
 * refreshes a card's content and never moves it.
 */
export function outOfBandNodes(sources: OutOfBandSources): CanvasNode[] {
	const charts = chartNodes(sources.charts ?? []);
	return [
		...charts,
		...chartWorkloadNodes(sources.workloads ?? [], charts),
		...addonNodes(sources.addons ?? []),
		...iacNodes(sources.iacGroups ?? []),
	];
}
