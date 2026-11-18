"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The cards the design does not own, read where they live: in TanStack Query (#6764).
//
// BYO charts, their described workloads, installed add-ons and a BYO-IaC module's external cards
// are each a GET procedure the Architecture page prefetches. They used to be copied into the canvas
// store by one effect each, which is how an undo could take an installed add-on off the board. Here
// they are a `useMemo` over the query data, so there is no copy to fall out of step.

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import { useEnvironmentStatus } from "@/lib/canvas/environment-status-context";
import { useAddonsQuery } from "@/lib/query/use-addons-query";
import { environmentStatusInput } from "@/lib/query/use-environment-status-query";
import { orpc } from "@/lib/rpc/client";
import { outOfBandNodes, type AddonCard } from "./out-of-band";

/** Which environment's cards to read, and which of the reads are enabled for it. */
export interface BoardSourcesInput {
	projectId: string;
	environmentId?: string | null;
	/** Whether bring-your-own Helm charts are enabled (server flag). */
	byoHelmEnabled?: boolean;
	/** Whether chart-workload describe is enabled (server flag). */
	byoDescribeEnabled?: boolean;
}

/**
 * The board's out-of-band cards, each at its default place, from the four reads behind them. The
 * same array until one of the reads returns new data. Needs an `EnvironmentStatusProvider` above
 * it for the BYO-IaC cards; without one there are none.
 */
export function useOutOfBandNodes(input: BoardSourcesInput): CanvasNode[] {
	const envInput = environmentStatusInput(input.projectId, input.environmentId);
	const charts = useQuery({
		...orpc.canvas.byoCharts.queryOptions({ input: envInput }),
		enabled: !!input.byoHelmEnabled,
	}).data?.charts;
	const workloads = useQuery({
		...orpc.canvas.chartWorkloads.queryOptions({ input: envInput }),
		enabled: !!input.byoDescribeEnabled,
	}).data?.workloads;
	const addonItems = useAddonsQuery(input.projectId, input.environmentId).data?.items;
	const iacGroups = useEnvironmentStatus().iac?.groups;

	const addons = useMemo<AddonCard[]>(
		() =>
			(addonItems ?? [])
				.filter((a) => a.install?.enabled)
				.map((a) => ({
					id: a.id,
					name: a.name,
					version: a.version,
					namespace: a.namespace,
					status: a.install?.status,
					health: a.install?.health ?? null,
					sync: a.install?.sync ?? null,
				})),
		[addonItems],
	);

	return useMemo(
		() => outOfBandNodes({ charts, workloads, addons, iacGroups }),
		[charts, workloads, addons, iacGroups],
	);
}

/** The BYO-IaC module's root output names: the choices a service binding offers. */
export function useIacOutputs(): string[] {
	const outputs = useEnvironmentStatus().iac?.outputs;
	return useMemo(() => outputs ?? [], [outputs]);
}
