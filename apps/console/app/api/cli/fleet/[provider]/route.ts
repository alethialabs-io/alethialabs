// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { authorizeCli } from "@/lib/authz/guard";
import { fleetPools } from "@/lib/db/schema";
import { cloudProvider } from "@/lib/db/schema/enums";
import { upsertFleetPool } from "@/lib/fleet/pools-db";
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
 * Creates or updates (upsert) the managed warm pool for `provider` — resize, pin a
 * version / channel, pause, or configure a provider that has no pool yet. This is the ONLY
 * way a pool is born once the DB is live: `FLEET_POOLS` only seeds an EMPTY table on boot,
 * so without a create path a provider that was never seeded could never be enabled without a
 * redeploy. On conflict with the live pool (partial unique `provider WHERE deleting = false`)
 * only the provided fields change; otherwise a new pool is inserted with schema defaults for
 * everything the caller omitted (`warm_min` 1, `max` 10, `enabled` true, …) — and, per that
 * partial index, it is born alongside any still-draining pool for the same provider rather
 * than colliding with it. Gated on `edit` of the global `fleet` resource (owner/admin only —
 * operators/viewers are denied); only reachable on self-managed deployments (the platform
 * fleet is never editable by hosted tenants). Wakes the controller to converge immediately.
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
		// Upsert: an existing live pool gets only the provided fields; a provider with none yet
		// gets a fresh pool (provided fields + schema defaults). See upsertFleetPool for the
		// partial-unique-index handling that lets a create coexist with a still-draining pool.
		const row = await upsertFleetPool(providerParsed.data, toUpdatePatch(parsed.data));
		// Converge the live fleet toward the new target on the next controller tick.
		wakeFleetScaler();
		return cliJson(cliFleetPoolResponse, { pool: toFleetPoolWire(row) });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
