// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/cli/classification/dimensions — the org's classification taxonomy (dimensions +
// values + applies_to) for the CLI. Gated on org `view`; org-scoped via the service DB with an
// explicit org_id filter (RLS is bypassed on this path). Mirrors listDimensions (web).

import { asc, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { authorizeCli } from "@/lib/authz/guard";
import { cliJson } from "@/lib/cli/respond";
import { getServiceDb } from "@/lib/db";
import { classificationDimension, classificationValue } from "@/lib/db/schema";
import { cliClassificationDimensionsResponse } from "@/lib/validations/cli-contract";

export async function GET(req: Request) {
	const auth = await authorizeCli(req, "view", { type: "org" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	try {
		const db = getServiceDb();
		const dims = await db
			.select()
			.from(classificationDimension)
			.where(eq(classificationDimension.org_id, actor.orgId))
			.orderBy(
				asc(classificationDimension.position),
				asc(classificationDimension.created_at),
			);
		const values = dims.length
			? await db
					.select()
					.from(classificationValue)
					.where(
						inArray(
							classificationValue.dimension_id,
							dims.map((d) => d.id),
						),
					)
					.orderBy(
						asc(classificationValue.position),
						asc(classificationValue.created_at),
					)
			: [];

		const byDim = new Map<string, typeof values>();
		for (const v of values) {
			const list = byDim.get(v.dimension_id) ?? [];
			list.push(v);
			byDim.set(v.dimension_id, list);
		}

		return cliJson(cliClassificationDimensionsResponse, {
			dimensions: dims.map((d) => ({
				id: d.id,
				key: d.key,
				label: d.label,
				description: d.description,
				multi: d.multi,
				applies_to: d.applies_to ?? [],
				values: (byDim.get(d.id) ?? []).map((v) => ({
					id: v.id,
					value: v.value,
					label: v.label,
				})),
			})),
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
