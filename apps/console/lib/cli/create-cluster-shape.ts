// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from "drizzle-orm";
import type { Tx } from "@/lib/db";
import { projectCluster, projectEnvironments } from "@/lib/db/schema";
import type { NodeSize } from "@/types/jsonb.types";

/**
 * The node shape a project-create caller asked for (#5266): a concrete machine type for the
 * project's cloud, OR a cloud-indifferent size the resolver maps to the nearest catalog machine at
 * provision time. Never both — the route refuses that before this is reached, because the Go
 * resolver prefers `instance_types` and would silently ignore the size.
 */
export type CreateClusterShape =
	| { instance_type: string; node_size?: undefined }
	| { node_size: NodeSize; instance_type?: undefined };

/** Thrown when a create asks for a node shape but no environment provisions a cluster to carry it. */
export class NoDedicatedEnvironmentError extends Error {
	/** Builds the refusal; the message names the remedy. */
	constructor() {
		super(
			"A node shape was given, but no environment is `dedicated`, so none provisions a cluster to carry it. Make one environment dedicated, or drop the node shape.",
		);
		this.name = "NoDedicatedEnvironmentError";
	}
}

/**
 * Writes the requested node shape as an explicit cluster row on every `dedicated` environment of a
 * project that was JUST created, inside the create's own transaction. Returns how many rows it wrote.
 *
 * Only `dedicated` environments get a row because only they provision a cluster: a `namespace` or
 * `vcluster` environment is placed onto a dedicated environment's Fabric and resolves that cluster
 * through `fabric_id` (lib/queries/cluster-for-env.ts), so a row of its own would be a second cluster
 * the placement model says does not exist. `fabric_id` is written here for the same reason
 * `writeComponents` and `insertProjectComponent` write it: nothing else fills it at runtime.
 *
 * CREATE ONLY. The project is new, so there is no existing row to overwrite, and this is a plain
 * INSERT with no ON CONFLICT branch. No path ever writes a default on UPDATE (#5266): when the caller
 * gives no shape, this is not called at all and no row is written — the snapshot then carries
 * `instance_types: []` and the template default, which equals the catalog default, applies.
 */
export async function insertCreateTimeClusters(
	tx: Tx,
	projectId: string,
	shape: CreateClusterShape,
): Promise<number> {
	const dedicated = await tx
		.select({ id: projectEnvironments.id, fabric_id: projectEnvironments.fabric_id })
		.from(projectEnvironments)
		.where(
			and(
				eq(projectEnvironments.project_id, projectId),
				eq(projectEnvironments.placement_mode, "dedicated"),
			),
		);
	if (dedicated.length === 0) throw new NoDedicatedEnvironmentError();

	await tx.insert(projectCluster).values(
		dedicated.map((env) => ({
			project_id: projectId,
			environment_id: env.id,
			fabric_id: env.fabric_id,
			...(shape.instance_type !== undefined
				? { instance_types: [shape.instance_type] }
				: { node_size: shape.node_size }),
		})),
	);
	return dedicated.length;
}
