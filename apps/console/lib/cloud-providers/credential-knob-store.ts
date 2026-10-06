// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The database half of the #5565 write guard: which credential-shaped `provider_config` values a
// project ALREADY stores, so `credentialRefusal` can let an unchanged legacy value through and refuse
// a new one. Server-only — it reads component tables through the caller's scoped transaction.

import "server-only";
import { eq } from "drizzle-orm";
import type { NodeKind } from "@/components/design-project/canvas/graph/types";
import {
	assertNoNewCredentials,
	type CredentialEntry,
	credentialEntriesOf,
	credentialKeysInDesign,
} from "@/lib/cloud-providers/credential-knobs";
import type { Tx } from "@/lib/db";
import {
	projectCaches,
	projectCluster,
	projectContainerRegistries,
	projectDatabases,
	projectDns,
	projectHelmRegistries,
	projectNosqlTables,
	projectQueues,
	projectSecrets,
	projectStorageBuckets,
	projectTopics,
} from "@/lib/db/schema";

/** One stored component's `provider_config`, as the loader reads it. */
type StoredRow = { provider_config: unknown };

/**
 * Reads every `provider_config` of one kind in one project (all environments). One typed query per
 * kind rather than a table lookup, so each select stays checked against its own table's columns.
 */
const READ_PROVIDER_CONFIGS: Readonly<
	Partial<Record<NodeKind, (tx: Tx, projectId: string) => Promise<StoredRow[]>>>
> = {
	cluster: (tx, id) =>
		tx.select({ provider_config: projectCluster.provider_config }).from(projectCluster).where(eq(projectCluster.project_id, id)),
	dns: (tx, id) =>
		tx.select({ provider_config: projectDns.provider_config }).from(projectDns).where(eq(projectDns.project_id, id)),
	database: (tx, id) =>
		tx.select({ provider_config: projectDatabases.provider_config }).from(projectDatabases).where(eq(projectDatabases.project_id, id)),
	cache: (tx, id) =>
		tx.select({ provider_config: projectCaches.provider_config }).from(projectCaches).where(eq(projectCaches.project_id, id)),
	queue: (tx, id) =>
		tx.select({ provider_config: projectQueues.provider_config }).from(projectQueues).where(eq(projectQueues.project_id, id)),
	topic: (tx, id) =>
		tx.select({ provider_config: projectTopics.provider_config }).from(projectTopics).where(eq(projectTopics.project_id, id)),
	nosql: (tx, id) =>
		tx.select({ provider_config: projectNosqlTables.provider_config }).from(projectNosqlTables).where(eq(projectNosqlTables.project_id, id)),
	secret: (tx, id) =>
		tx.select({ provider_config: projectSecrets.provider_config }).from(projectSecrets).where(eq(projectSecrets.project_id, id)),
	bucket: (tx, id) =>
		tx.select({ provider_config: projectStorageBuckets.provider_config }).from(projectStorageBuckets).where(eq(projectStorageBuckets.project_id, id)),
	registry: (tx, id) =>
		tx
			.select({ provider_config: projectContainerRegistries.provider_config })
			.from(projectContainerRegistries)
			.where(eq(projectContainerRegistries.project_id, id)),
	helm_registry: (tx, id) =>
		tx
			.select({ provider_config: projectHelmRegistries.provider_config })
			.from(projectHelmRegistries)
			.where(eq(projectHelmRegistries.project_id, id)),
};

/**
 * The credential entries the project already stores, for the kinds `design` writes a credential
 * key on. Returns `[]` without a query when the design carries no credential key at all — the case
 * for every save the canvas itself makes, so the guard costs nothing on the normal path.
 */
export async function storedCredentialEntries(
	tx: Tx,
	projectId: string,
	design: unknown,
): Promise<CredentialEntry[]> {
	const kinds = new Set(credentialKeysInDesign(design).map((e) => e.kind));
	const stored: CredentialEntry[] = [];
	for (const kind of kinds) {
		const read = READ_PROVIDER_CONFIGS[kind];
		if (!read) continue;
		for (const row of await read(tx, projectId)) {
			stored.push(...credentialEntriesOf(kind, kind, row.provider_config));
		}
	}
	return stored;
}

/**
 * Refuses (throws `CredentialKnobRefusedError`) a design that writes a credential into a component's
 * `provider_config`, unless the value is already stored unchanged in the same project. Call it
 * BEFORE any delete of the environment's rows, so a value the save is about to rewrite is still
 * there to be recognised.
 */
export async function assertDesignStoresNoNewCredentials(
	tx: Tx,
	projectId: string,
	design: unknown,
): Promise<void> {
	assertNoNewCredentials(design, await storedCredentialEntries(tx, projectId, design));
}
