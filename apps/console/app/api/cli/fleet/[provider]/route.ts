// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from "drizzle-orm";
import { z } from "zod";
import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { fleetPools } from "@/lib/db/schema";
import { cloudProvider } from "@/lib/db/schema/enums";
import { wakeFleetScaler } from "@/lib/fleet/scaler";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { cliFleetPoolResponse } from "@/lib/validations/cli-contract";
import { isFleetOperatorDeployment, toFleetPoolWire } from "../route";

/** Body of PUT /api/cli/fleet/:provider — the editable subset of a pool's config. A
 * pinned `version` and a release `channel` are mutually exclusive (a version pin wins). */
const updateFleetBody = z.object({
	warm_min: z.number().int().min(0).optional(),
	max: z.number().int().min(0).optional(),
	slots_per_runner: z.number().int().min(1).optional(),
	enabled: z.boolean().optional(),
	channel: z.string().min(1).nullable().optional(),
	version: z.string().min(1).nullable().optional(),
});

/** Builds the partial update patch (only provided fields), enforcing version/channel
 * mutual exclusivity (a version pin clears the channel). Mirrors fleet.ts toUpdatePatch. */
function toUpdatePatch(
	body: z.infer<typeof updateFleetBody>,
): Partial<typeof fleetPools.$inferInsert> {
	const patch: Partial<typeof fleetPools.$inferInsert> = { updated_at: new Date() };
	if (body.warm_min !== undefined) patch.warm_min = body.warm_min;
	if (body.max !== undefined) patch.max = body.max;
	if (body.slots_per_runner !== undefined) patch.slots_per_runner = body.slots_per_runner;
	if (body.enabled !== undefined) patch.enabled = body.enabled;
	if (body.version !== undefined || body.channel !== undefined) {
		patch.version = body.version ?? null;
		patch.channel = body.version ? null : (body.channel ?? null);
	}
	return patch;
}

/**
 * Updates the managed warm pool for `provider` (resize, pin a version / channel, pause).
 * Gated on `edit` of the global `fleet` resource (owner/admin only — operators/viewers are
 * denied); only reachable on self-managed deployments (the platform fleet is never editable
 * by hosted tenants). 404 when no pool is configured for the provider. Wakes the controller
 * to converge immediately.
 */
export async function PUT(
	req: Request,
	{ params }: { params: Promise<{ provider: string }> },
) {
	const auth = await authorizeCli(req, "edit", { type: "fleet" });
	if ("error" in auth) return auth.error;

	if (!isFleetOperatorDeployment()) {
		return NextResponse.json(
			{ error: "The managed fleet is not available on this deployment." },
			{ status: 403 },
		);
	}

	const { provider } = await params;
	const providerParsed = z.enum(cloudProvider.enumValues).safeParse(provider);
	if (!providerParsed.success) {
		return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
	}

	const parsed = updateFleetBody.safeParse(await req.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
	}

	try {
		const [row] = await getServiceDb()
			.update(fleetPools)
			.set(toUpdatePatch(parsed.data))
			.where(eq(fleetPools.provider, providerParsed.data))
			.returning();
		if (!row) {
			return NextResponse.json(
				{ error: `No fleet pool configured for ${providerParsed.data}.` },
				{ status: 404 },
			);
		}
		// Converge the live fleet toward the new target on the next controller tick.
		wakeFleetScaler();
		return cliJson(cliFleetPoolResponse, { pool: toFleetPoolWire(row) });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
