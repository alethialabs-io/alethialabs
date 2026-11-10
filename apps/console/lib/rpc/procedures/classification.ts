// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { z } from "zod";
import type { ValueKindCount } from "@/app/server/actions/classification/assignments";
import type { DimensionDTO } from "@/app/server/actions/classification/dimensions";
import { getPdp } from "@/lib/authz";
import { authorize, currentActor } from "@/lib/authz/guard";
import { classifiedIdsViewable, mayClassifyResource } from "@/lib/classification/resource-project";
import { withScope } from "@/lib/db";
import type { ResourceKind } from "@/lib/db/schema/enums";
import {
	type AssignedValue,
	assignmentsForKind,
	countAssignmentsByKindForValue,
	countAssignmentsByValue,
	countResourcesByDimension,
	countResourcesByKindForDimension,
	type DimensionWithValues,
	listAssignmentsFor,
	listDimensionsWithValues,
} from "@/lib/queries/classification";
import { query } from "@/lib/rpc/base";
import { resourceKindSchema } from "@/lib/validations/classification";

// THE CLASSIFICATION READS (ADR 0005 D1, #6129). Every body below MOVED here from the
// `"use server"` modules `app/server/actions/classification/dimensions.ts` (`listDimensions`) and
// `.../assignments.ts` (`canEditClassification`, `getAssignments`, `getAssignmentsForKind`,
// `getValueResourceBreakdown`, `getDimensionResourceBreakdown`) — not wrapped — so the settings page
// and every picker read over GET, and the settings route prefetches in-process. The authorization of
// each read is the one it had as an action:
//
//   · the taxonomy, a resource's chips and the usage breakdowns answer `org:view`, ENFORCED;
//   · `canEdit` is a `can()` question about `org:edit` (it records nothing);
//   · a resource that lives in a PROJECT (the project, its environments, its clusters) is also
//     asked about that project (#6281, lib/classification/resource-project.ts): its chips are read
//     only by a member who may view the project. `assignments` answers such a resource with no chips
//     — what an unknown resource answers — and `assignmentsForKind` leaves its id out, exactly as
//     before; both record the refusal.
//
// TENANCY. The actor is the one the read router bound for the request's ADDRESS (`lib/rpc/base.ts`).
// Every query runs inside `withScope({ orgId: actor.orgId })`, so RLS (org-scoped dimensions, values
// and assignments scoped through their parent dimension) is the wall. The ids an input carries — a
// resource, a value, a dimension — address rows INSIDE that org only: another org's id matches
// nothing under RLS and answers as an unknown one does (no chips, an empty breakdown).

/** Maps a hydrated dimension row to its client-safe DTO, merging usage counts. */
function toDimensionDTO(
	d: DimensionWithValues,
	byValue: Map<string, number>,
	byDimension: Map<string, number>,
): DimensionDTO {
	return {
		id: d.id,
		key: d.key,
		label: d.label,
		description: d.description,
		multi: d.multi,
		position: d.position,
		appliesTo: d.applies_to ?? [],
		resourceCount: byDimension.get(d.id) ?? 0,
		values: d.values.map((v) => ({
			id: v.id,
			dimension_id: v.dimension_id,
			value: v.value,
			label: v.label,
			color: v.color,
			enforcement: v.enforcement,
			position: v.position,
			assignmentCount: byValue.get(v.id) ?? 0,
		})),
	};
}

/**
 * The addressed org's classification dimensions with values + usage counts nested. When `search`
 * is provided the dimension list is filtered server-side (label/key or a matching value); the usage
 * counts are org-wide and merged by id, so a filtered list still shows real numbers. `org:view`.
 */
export async function readDimensions(search?: string): Promise<DimensionDTO[]> {
	const actor = await authorize("view", { type: "org" });
	const { dims, byValue, byDimension } = await withScope(
		{ ownerId: actor.userId, orgId: actor.orgId },
		async (tx) => ({
			dims: await listDimensionsWithValues(tx, search),
			byValue: await countAssignmentsByValue(tx),
			byDimension: await countResourcesByDimension(tx),
		}),
	);
	return dims.map((d) => toDimensionDTO(d, byValue, byDimension));
}

/**
 * Whether the caller may assign/clear classifications at all — the SAME `org:edit` the writes
 * enforce. The UI ANDs this with each resource's own edit gate, so a picker only shows when the user
 * can actually use it (never a control that would be refused). Non-throwing.
 */
export async function readCanEditClassification(): Promise<boolean> {
	const actor = await currentActor();
	const decision = await getPdp().can(actor, "edit", { type: "org" });
	return decision.allowed;
}

/**
 * The per-resource-kind breakdown of the resources carrying a value — e.g. "24 resources:
 * 12 projects · 8 clusters · 4 runners". `org:view`. Empty for an unused (or unknown) value.
 */
export async function readValueBreakdown(valueId: string): Promise<ValueKindCount[]> {
	const actor = await authorize("view", { type: "org" });
	return withScope({ ownerId: actor.userId, orgId: actor.orgId }, (tx) =>
		countAssignmentsByKindForValue(tx, valueId),
	);
}

/**
 * Distinct resources per kind carrying any value of a dimension — the "coverage by resource kind"
 * panel for the selected dimension. `org:view`.
 */
export async function readDimensionBreakdown(dimensionId: string): Promise<ValueKindCount[]> {
	const actor = await authorize("view", { type: "org" });
	return withScope({ ownerId: actor.userId, orgId: actor.orgId }, (tx) =>
		countResourcesByKindForDimension(tx, dimensionId),
	);
}

/**
 * The classification chips assigned to a single resource. A resource whose project the caller may
 * not view answers with no chips — what an unknown resource answers — and the refusal is recorded.
 */
export async function readAssignments(kind: ResourceKind, resourceId: string): Promise<AssignedValue[]> {
	const actor = await authorize("view", { type: "org" });
	if (!(await mayClassifyResource(actor, kind, resourceId, "view"))) return [];
	return withScope({ ownerId: actor.userId, orgId: actor.orgId }, (tx) =>
		listAssignmentsFor(tx, kind, resourceId),
	);
}

/**
 * Batched hydration for list views: the chips for MANY resources of one kind in a single
 * round-trip, keyed by resource_id (ids with no assignments are omitted). Ids whose project the
 * caller may not view are left out, like ids with no assignments.
 */
export async function readAssignmentsForKind(
	kind: ResourceKind,
	resourceIds: string[],
): Promise<Record<string, AssignedValue[]>> {
	if (resourceIds.length === 0) return {};
	const actor = await authorize("view", { type: "org" });
	const viewable = await classifiedIdsViewable(actor, kind, resourceIds);
	if (viewable.length === 0) return {};
	const map = await withScope({ ownerId: actor.userId, orgId: actor.orgId }, (tx) =>
		assignmentsForKind(tx, kind, viewable),
	);
	return Object.fromEntries(map);
}

/** The most row ids one `assignmentsForKind` read takes (see its input). */
const MAX_BATCH_IDS = 10_000;

/** A row id the classification tables address (every kind's id is a uuid). */
const rowId = z.string().uuid();

/** The classification reads (#6129). Each answers `org:view` (enforced) but `canEdit` (a `can()`). */
export const classificationRouter = {
	dimensions: query
		.input(z.object({ search: z.string().max(200).optional() }))
		.handler(({ input }) => readDimensions(input.search?.trim() || undefined)),
	canEdit: query.handler(() => readCanEditClassification()),
	assignments: query
		.input(z.object({ kind: resourceKindSchema, resourceId: rowId }))
		.handler(({ input }) => readAssignments(input.kind, input.resourceId)),
	assignmentsForKind: query
		// The bound is generous on purpose: a list hydrates the chips of EVERY row it shows in this one
		// read, and the action it replaced had no bound, so a tight one would silently drop the chips of
		// a long list. 10 000 ids sit far under Postgres's 65 535 bind parameters for the `IN` lists
		// below; an input past it is refused (BAD_REQUEST), never truncated. Past ~2 KB of ids the
		// browser client sends the read as a POST to the same route (`fallbackMethod`, lib/rpc/client.ts).
		.input(z.object({ kind: resourceKindSchema, resourceIds: z.array(rowId).max(MAX_BATCH_IDS) }))
		.handler(({ input }) => readAssignmentsForKind(input.kind, input.resourceIds)),
	valueBreakdown: query
		.input(z.object({ valueId: rowId }))
		.handler(({ input }) => readValueBreakdown(input.valueId)),
	dimensionBreakdown: query
		.input(z.object({ dimensionId: rowId }))
		.handler(({ input }) => readDimensionBreakdown(input.dimensionId)),
};
