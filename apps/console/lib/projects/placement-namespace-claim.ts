// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The create side of the namespace a namespace placement and a host BYO chart must not share (#6575).
//
// Attaching a chart (attachByoChart) reads the placements on the Fabric; creating a placement reads the
// host's chart namespaces. Each reads before the other inserts, so run side by side both checks passed
// and both rows were stored. Every placement writer calls this in the transaction that inserts the
// placement, and attachByoChart takes the same project lock in its own: the second writer then waits
// for the first to commit, and its check reads the row the first stored.

import "server-only";
import type { Tx } from "@/lib/db";
import { lockProjectPreviewNamespaces } from "@/lib/projects/preview-namespace-lock";
import {
	placementHostNamespaces,
	placementNamespacesOnFabric,
} from "@/lib/queries/placement-host-namespaces";
import {
	placementNamespaceMessage,
	placementNamespaceTakenMessage,
} from "@/lib/validations/placement-namespace";

/**
 * Takes the project's namespace lock in `tx`, then returns why a namespace placement on `fabricId` may
 * not deploy into `namespace` (reserved on the host cluster, a host BYO chart's, or another placement's),
 * or `null` when it may. The caller inserts the placement in the same `tx`, so the lock is held from
 * this read until that insert commits.
 */
export async function claimPlacementNamespace(
	tx: Tx,
	projectId: string,
	fabricId: string,
	namespace: string,
): Promise<string | null> {
	await lockProjectPreviewNamespaces(tx, projectId);
	const reserved = placementNamespaceMessage(
		namespace,
		await placementHostNamespaces(tx, projectId, fabricId),
	);
	if (reserved) return reserved;
	// No two namespace placements on one Fabric may resolve to the same namespace (#6551).
	const holder = (await placementNamespacesOnFabric(tx, projectId, fabricId)).find(
		(p) => p.namespace === namespace,
	);
	return holder ? placementNamespaceTakenMessage(namespace, holder.environment) : null;
}
