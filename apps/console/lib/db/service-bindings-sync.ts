// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Sync the normalized service_bindings + service_binding_injections rows for one owner (a service
// XOR a chart workload) from its ServiceBinding[] value-object array (Phase C.3). The parent tables
// still keep their `bindings` JSONB (the expand-phase rollback net); these helpers keep the child
// tables in step. `ordinal` mirrors the array index so buildConfigSnapshot re-embeds a byte-identical
// array. Used by the three binding write paths (services delete-all-reinsert; the two chart-workload
// setters, which UPDATE and so must delete-this-owner-then-reinsert).

import { eq } from "drizzle-orm";
import { serviceBindingInjections, serviceBindings } from "@/lib/db/schema";
import type { Tx } from "@/lib/db";
import type { ServiceBinding } from "@/types/jsonb.types";

/** Exactly one owner (mirrors the service_bindings XOR CHECK). */
type BindingOwner = { service_id: string } | { chart_workload_id: string };

/**
 * Insert the binding rows (+ their nested injection rows) for one owner. Caller guarantees no rows
 * exist for the owner yet (fresh insert, or a preceding delete). No-op on an empty array.
 */
export async function insertServiceBindings(
	tx: Tx,
	owner: BindingOwner,
	bindings: ServiceBinding[],
): Promise<void> {
	if (!bindings.length) return;
	const inserted = await tx
		.insert(serviceBindings)
		.values(
			bindings.map((b, i) => ({
				...owner,
				target_kind: b.target.kind,
				target_name: b.target.name,
				ordinal: i,
			})),
		)
		.returning({ id: serviceBindings.id, ordinal: serviceBindings.ordinal });
	const idByOrdinal = new Map(inserted.map((r) => [r.ordinal, r.id]));
	const injRows = bindings.flatMap((b, i) => {
		const bindingId = idByOrdinal.get(i);
		if (!bindingId) return [];
		return (b.inject ?? []).map((inj, j) => ({
			binding_id: bindingId,
			env: inj.env,
			from_facet: inj.from,
			ordinal: j,
		}));
	});
	if (injRows.length) await tx.insert(serviceBindingInjections).values(injRows);
}

/**
 * Replace one owner's binding rows: delete the owner's existing service_bindings (CASCADE removes
 * their injections), then reinsert. For the chart-workload setters, whose write is a granular UPDATE
 * rather than the services' delete-all-reinsert.
 */
export async function replaceServiceBindings(
	tx: Tx,
	owner: BindingOwner,
	bindings: ServiceBinding[],
): Promise<void> {
	await tx
		.delete(serviceBindings)
		.where(
			"service_id" in owner
				? eq(serviceBindings.service_id, owner.service_id)
				: eq(serviceBindings.chart_workload_id, owner.chart_workload_id),
		);
	await insertServiceBindings(tx, owner, bindings);
}
