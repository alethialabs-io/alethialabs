// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// /api/cli/classification/assignments — read (GET) and mutate (POST assign / DELETE unassign) a
// resource's classification values from the CLI. Reads gate on org `view`, mutations on `edit`.
// Org-scoped via the service DB with explicit org_id filters (RLS is bypassed here). A value is
// addressed by dimension key + value slug (friendlier than uuids); single-valued dimensions swap.

import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeCli } from "@/lib/authz/guard";
import { recordActivity } from "@/lib/authz/activity";
import { cliJson } from "@/lib/cli/respond";
import { getServiceDb } from "@/lib/db";
import {
	classificationAssignment,
	classificationDimension,
	classificationValue,
} from "@/lib/db/schema";
import type { ResourceKind } from "@/lib/db/schema/enums";
import { resourceKindSchema } from "@/lib/validations/classification";
import { cliClassificationAssignmentsResponse } from "@/lib/validations/cli-contract";

type Db = ReturnType<typeof getServiceDb>;

/** The values assigned to one resource (org-scoped), joined to their dimension. */
async function loadAssignments(
	db: Db,
	orgId: string,
	kind: ResourceKind,
	resourceId: string,
) {
	const rows = await db
		.select({
			dimension_key: classificationDimension.key,
			dimension_label: classificationDimension.label,
			value: classificationValue.value,
			value_label: classificationValue.label,
		})
		.from(classificationAssignment)
		.innerJoin(
			classificationValue,
			eq(classificationValue.id, classificationAssignment.value_id),
		)
		.innerJoin(
			classificationDimension,
			eq(classificationDimension.id, classificationAssignment.dimension_id),
		)
		.where(
			and(
				eq(classificationAssignment.org_id, orgId),
				eq(classificationAssignment.resource_kind, kind),
				eq(classificationAssignment.resource_id, resourceId),
			),
		)
		.orderBy(
			asc(classificationDimension.position),
			asc(classificationValue.position),
		);
	return rows;
}

/** Parses + validates the `kind` / `id` query params. */
function parseTarget(url: URL):
	| { kind: ResourceKind; id: string }
	| { error: NextResponse } {
	const kindRaw = url.searchParams.get("kind");
	const id = url.searchParams.get("id");
	const kind = resourceKindSchema.safeParse(kindRaw);
	if (!kind.success || !id) {
		return {
			error: NextResponse.json(
				{ error: "kind (a valid resource kind) and id are required" },
				{ status: 400 },
			),
		};
	}
	return { kind: kind.data, id };
}

export async function GET(req: Request) {
	const auth = await authorizeCli(req, "view", { type: "org" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const target = parseTarget(new URL(req.url));
	if ("error" in target) return target.error;

	try {
		const db = getServiceDb();
		const assignments = await loadAssignments(
			db,
			actor.orgId,
			target.kind,
			target.id,
		);
		return cliJson(cliClassificationAssignmentsResponse, { assignments });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

const assignBody = z.object({
	kind: resourceKindSchema,
	id: z.string().uuid(),
	dimension_key: z.string().min(1),
	value_slug: z.string().min(1),
});

export async function POST(req: Request) {
	const auth = await authorizeCli(req, "edit", { type: "org" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	const parsed = assignBody.safeParse(await req.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
	}
	const { kind, id, dimension_key, value_slug } = parsed.data;

	try {
		const db = getServiceDb();
		// Resolve the value → its dimension within the org.
		const [value] = await db
			.select({
				value_id: classificationValue.id,
				dimension_id: classificationDimension.id,
				multi: classificationDimension.multi,
			})
			.from(classificationValue)
			.innerJoin(
				classificationDimension,
				eq(classificationDimension.id, classificationValue.dimension_id),
			)
			.where(
				and(
					eq(classificationDimension.org_id, actor.orgId),
					eq(classificationDimension.key, dimension_key),
					eq(classificationValue.value, value_slug),
				),
			)
			.limit(1);
		if (!value) {
			return NextResponse.json(
				{ error: `No value "${value_slug}" on dimension "${dimension_key}"` },
				{ status: 404 },
			);
		}

		await db.transaction(async (tx) => {
			if (!value.multi) {
				await tx
					.delete(classificationAssignment)
					.where(
						and(
							eq(classificationAssignment.resource_kind, kind),
							eq(classificationAssignment.resource_id, id),
							eq(classificationAssignment.dimension_id, value.dimension_id),
						),
					);
			}
			await tx
				.insert(classificationAssignment)
				.values({
					org_id: actor.orgId,
					dimension_id: value.dimension_id,
					value_id: value.value_id,
					resource_kind: kind,
					resource_id: id,
					assigned_by: actor.userId,
				})
				.onConflictDoNothing({
					target: [
						classificationAssignment.resource_kind,
						classificationAssignment.resource_id,
						classificationAssignment.value_id,
					],
				});
		});
		recordActivity(actor, "update", { type: "org", id: actor.orgId });

		const assignments = await loadAssignments(db, actor.orgId, kind, id);
		return cliJson(cliClassificationAssignmentsResponse, { assignments });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

export async function DELETE(req: Request) {
	const auth = await authorizeCli(req, "edit", { type: "org" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const url = new URL(req.url);
	const target = parseTarget(url);
	if ("error" in target) return target.error;
	const valueSlug = url.searchParams.get("value_slug");
	if (!valueSlug) {
		return NextResponse.json(
			{ error: "value_slug is required" },
			{ status: 400 },
		);
	}

	try {
		const db = getServiceDb();
		// Find the value ids (within the org) whose slug matches, then clear them off the resource.
		const values = await db
			.select({ id: classificationValue.id })
			.from(classificationValue)
			.innerJoin(
				classificationDimension,
				eq(classificationDimension.id, classificationValue.dimension_id),
			)
			.where(
				and(
					eq(classificationDimension.org_id, actor.orgId),
					eq(classificationValue.value, valueSlug),
				),
			);
		for (const v of values) {
			await db
				.delete(classificationAssignment)
				.where(
					and(
						eq(classificationAssignment.org_id, actor.orgId),
						eq(classificationAssignment.resource_kind, target.kind),
						eq(classificationAssignment.resource_id, target.id),
						eq(classificationAssignment.value_id, v.id),
					),
				);
		}
		recordActivity(actor, "update", { type: "org", id: actor.orgId });

		const assignments = await loadAssignments(
			db,
			actor.orgId,
			target.kind,
			target.id,
		);
		return cliJson(cliClassificationAssignmentsResponse, { assignments });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
