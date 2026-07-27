// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Read the normalized value-object child tables back into their in-memory array shapes (the JSONB
// audit's CONTRACT PHASE — the JSONB columns on the parent rows are dropped, so these readers are the
// single source for the arrays that used to live on those columns). Each loader is a batch query
// (no N+1), orders by `ordinal` so the reconstructed array matches author order, and returns `[]` for
// an owner with no rows. Callers pass their own `Db`/`Tx` handle so the read runs under the same
// RLS/owner scope as the surrounding query.
//
// Byte-stability note: the config-snapshot signature (canonicalJson, sorted keys), the CLI
// `configuration_hash` (over the Postgres-jsonb-normalized read-back) and `structuralHash`
// (stableStringify, sorted keys) are all key-order-independent, so only element *values* and array
// *order* must match the old JSONB — both of which `ordinal` guarantees.

import { eq, inArray, or } from "drizzle-orm";
import {
	clusterAdmins,
	serviceBindingInjections,
	serviceBindings,
	topicSubscriptions,
} from "@/lib/db/schema";
import type { Db, Tx } from "@/lib/db";
import type {
	ClusterAdmin,
	ServiceBinding,
	ServiceBindingOutputKeys,
	TopicSubscription,
} from "@/types/jsonb.types";

/**
 * Load the subscriptions for a set of topics, keyed by topic id, ordered by `ordinal`. Topics with no
 * subscription rows are simply absent from the map (callers default to `[]`).
 */
export async function topicSubscriptionsByTopic(
	db: Db | Tx,
	topicIds: string[],
): Promise<Map<string, TopicSubscription[]>> {
	const map = new Map<string, TopicSubscription[]>();
	if (!topicIds.length) return map;
	const rows = await db
		.select({
			topic_id: topicSubscriptions.topic_id,
			protocol: topicSubscriptions.protocol,
			endpoint: topicSubscriptions.endpoint,
		})
		.from(topicSubscriptions)
		.where(inArray(topicSubscriptions.topic_id, topicIds))
		.orderBy(topicSubscriptions.topic_id, topicSubscriptions.ordinal);
	for (const r of rows) {
		const arr = map.get(r.topic_id);
		const sub: TopicSubscription = { protocol: r.protocol, endpoint: r.endpoint };
		if (arr) arr.push(sub);
		else map.set(r.topic_id, [sub]);
	}
	return map;
}

/**
 * Load a single cluster's day-2 admins, ordered by `ordinal`. Returns `[]` when the cluster has none.
 * (project_cluster is a per-env singleton, so this reads one cluster's rows.)
 */
export async function clusterAdminsByCluster(
	db: Db | Tx,
	clusterId: string,
): Promise<ClusterAdmin[]> {
	const rows = await db
		.select({ username: clusterAdmins.username, groups: clusterAdmins.groups })
		.from(clusterAdmins)
		.where(eq(clusterAdmins.cluster_id, clusterId))
		.orderBy(clusterAdmins.ordinal);
	return rows.map((r) => ({ username: r.username, groups: r.groups }));
}

/**
 * Rebuild the BYO-IaC target's `output_keys` from the three output columns, or `undefined` when all
 * three are NULL. This mirrors the write side (`service-bindings-sync.ts`, which stores
 * `output_keys?.<k> ?? null`): a first-class-component target stored all-NULL and must round-trip with
 * NO `output_keys` key at all, while a stored value (including "") is a real key the original carried.
 */
function outputKeysFromRow(r: {
	output_endpoint: string | null;
	output_port: string | null;
	output_credential_secret: string | null;
}): ServiceBindingOutputKeys | undefined {
	if (
		r.output_endpoint === null &&
		r.output_port === null &&
		r.output_credential_secret === null
	) {
		return undefined;
	}
	const keys: ServiceBindingOutputKeys = {};
	if (r.output_endpoint !== null) keys.endpoint = r.output_endpoint;
	if (r.output_port !== null) keys.port = r.output_port;
	if (r.output_credential_secret !== null) {
		keys.credential_secret = r.output_credential_secret;
	}
	return keys;
}

/**
 * Load service bindings for a set of owners — services and/or chart workloads — keyed by owner id,
 * ordered by `ordinal`, with each binding's `inject[]` reconstructed from `service_binding_injections`
 * (also ordinal-ordered). Owners with no bindings are absent from the map (callers default to `[]`).
 *
 * A binding row is owned by a service XOR a chart workload (the `service_bindings_one_owner_ck`
 * constraint), and service/workload ids are distinct uuids, so one map keyed on the non-null owner id
 * serves both caller kinds without collision. Two batch queries (bindings, then their injections) —
 * no N+1. The reconstructed `{ target: { kind, name, address?, output_keys? }, inject }` shape is
 * byte-identical to the dropped `bindings` JSONB: `address`/`output_keys` are OMITTED when their
 * columns are NULL (a first-class-component target round-trips as `{ kind, name }`).
 */
export async function serviceBindingsByOwner(
	db: Db | Tx,
	owners: { serviceIds: string[]; chartWorkloadIds: string[] },
): Promise<Map<string, ServiceBinding[]>> {
	const map = new Map<string, ServiceBinding[]>();
	const clauses = [];
	if (owners.serviceIds.length) {
		clauses.push(inArray(serviceBindings.service_id, owners.serviceIds));
	}
	if (owners.chartWorkloadIds.length) {
		clauses.push(
			inArray(serviceBindings.chart_workload_id, owners.chartWorkloadIds),
		);
	}
	if (!clauses.length) return map;

	const bindingRows = await db
		.select({
			id: serviceBindings.id,
			service_id: serviceBindings.service_id,
			chart_workload_id: serviceBindings.chart_workload_id,
			target_kind: serviceBindings.target_kind,
			target_name: serviceBindings.target_name,
			target_address: serviceBindings.target_address,
			output_endpoint: serviceBindings.output_endpoint,
			output_port: serviceBindings.output_port,
			output_credential_secret: serviceBindings.output_credential_secret,
		})
		.from(serviceBindings)
		.where(clauses.length === 1 ? clauses[0] : or(...clauses))
		.orderBy(
			serviceBindings.service_id,
			serviceBindings.chart_workload_id,
			serviceBindings.ordinal,
		);
	if (!bindingRows.length) return map;

	// Batch-load the injections for every binding in one query, grouped by binding id in ordinal order.
	const injectionsByBinding = new Map<
		string,
		ServiceBinding["inject"]
	>();
	const injectionRows = await db
		.select({
			binding_id: serviceBindingInjections.binding_id,
			env: serviceBindingInjections.env,
			from_facet: serviceBindingInjections.from_facet,
		})
		.from(serviceBindingInjections)
		.where(
			inArray(
				serviceBindingInjections.binding_id,
				bindingRows.map((b) => b.id),
			),
		)
		.orderBy(
			serviceBindingInjections.binding_id,
			serviceBindingInjections.ordinal,
		);
	for (const r of injectionRows) {
		const arr = injectionsByBinding.get(r.binding_id);
		const inj = { env: r.env, from: r.from_facet };
		if (arr) arr.push(inj);
		else injectionsByBinding.set(r.binding_id, [inj]);
	}

	for (const r of bindingRows) {
		const owner = r.service_id ?? r.chart_workload_id;
		if (owner === null) continue; // one-owner check constraint guarantees this never trips
		const target: ServiceBinding["target"] = {
			kind: r.target_kind,
			name: r.target_name,
		};
		if (r.target_address !== null) target.address = r.target_address;
		const outputKeys = outputKeysFromRow(r);
		if (outputKeys) target.output_keys = outputKeys;
		const binding: ServiceBinding = {
			target,
			inject: injectionsByBinding.get(r.id) ?? [],
		};
		const arr = map.get(owner);
		if (arr) arr.push(binding);
		else map.set(owner, [binding]);
	}
	return map;
}
