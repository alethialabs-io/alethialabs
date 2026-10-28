"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { authorize } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { fleetPools, type FleetPool } from "@/lib/db/schema";
import { wakeFleetScaler } from "@/lib/fleet/scaler";
import { assertFleetOperable } from "@/lib/rpc/procedures/runners";
import {
	fleetPoolCreateSchema,
	fleetPoolUpdateSchema,
	type FleetPoolCreateInput,
	type FleetPoolUpdateInput,
} from "@/lib/validations/fleet";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

/** Map a validated create input to the insert row (camelCase project → snake_case columns). */
function toInsertRow(input: FleetPoolCreateInput) {
	return {
		provider: input.provider,
		name: input.name ?? null,
		warm_min: input.warmMin,
		max: input.max,
		slots_per_runner: input.slotsPerRunner,
		locations: input.locations,
		min_per_location: input.minPerLocation,
		surge: input.surge,
		buffer: input.buffer,
		scale_down_grace_ticks: input.scaleDownGraceTicks,
		version: input.version ?? null,
		channel: input.version ? null : (input.channel ?? null),
	};
}

/** Build a partial update patch from a validated edit input (only set provided fields). */
function toUpdatePatch(input: FleetPoolUpdateInput): Partial<typeof fleetPools.$inferInsert> {
	const patch: Partial<typeof fleetPools.$inferInsert> = { updated_at: new Date() };
	if (input.name !== undefined) patch.name = input.name ?? null;
	if (input.warmMin !== undefined) patch.warm_min = input.warmMin;
	if (input.max !== undefined) patch.max = input.max;
	if (input.slotsPerRunner !== undefined) patch.slots_per_runner = input.slotsPerRunner;
	if (input.locations !== undefined) patch.locations = input.locations;
	if (input.minPerLocation !== undefined) patch.min_per_location = input.minPerLocation;
	if (input.surge !== undefined) patch.surge = input.surge;
	if (input.buffer !== undefined) patch.buffer = input.buffer;
	if (input.scaleDownGraceTicks !== undefined)
		patch.scale_down_grace_ticks = input.scaleDownGraceTicks;
	// version + channel are mutually exclusive: a version pin clears the channel.
	if (input.version !== undefined || input.channel !== undefined) {
		patch.version = input.version ?? null;
		patch.channel = input.version ? null : (input.channel ?? null);
	}
	return patch;
}

/** Create a warm pool. Provisions real VMs once a cloud provider is wired, so it's gated to
 *  owner/admin (the `fleet` resource). Wakes the controller to converge immediately. */
export async function createFleetPool(input: FleetPoolCreateInput): Promise<FleetPool> {
	assertFleetOperable();
	await authorize("create", { type: "fleet" });
	const data = fleetPoolCreateSchema.parse(input);
	const [row] = await getServiceDb()
		.insert(fleetPools)
		.values(toInsertRow(data))
		.returning();
	wakeFleetScaler();
	revalidatePath("/[org]/~/runners", "page");
	return row;
}

/** Edit a warm pool's project (resize, pin a version, change locations). Converges live. */
export async function updateFleetPool(
	id: string,
	input: FleetPoolUpdateInput,
): Promise<FleetPool> {
	assertFleetOperable();
	await authorize("edit", { type: "fleet", id });
	const data = fleetPoolUpdateSchema.parse(input);
	const [row] = await getServiceDb()
		.update(fleetPools)
		.set(toUpdatePatch(data))
		.where(eq(fleetPools.id, id))
		.returning();
	wakeFleetScaler();
	revalidatePath("/[org]/~/runners", "page");
	return row;
}

/** Pause/resume a pool. A paused pool is reconciled as a teardown target — the controller drains
 *  its warm VMs to zero (closing each runner's usage session) rather than merely skipping it, so
 *  pausing never leaves billable orphans; resuming rebuilds the warm floor over a few ticks. */
export async function setFleetPoolEnabled(id: string, enabled: boolean): Promise<FleetPool> {
	assertFleetOperable();
	await authorize("edit", { type: "fleet", id });
	const [row] = await getServiceDb()
		.update(fleetPools)
		.set({ enabled, updated_at: new Date() })
		.where(eq(fleetPools.id, id))
		.returning();
	wakeFleetScaler();
	revalidatePath("/[org]/~/runners", "page");
	return row;
}

/**
 * Delete a pool. This is a SOFT delete: it marks the row `deleting = true` (and pauses it) rather
 * than removing it, so the controller keeps seeing the pool and reconciles it as a teardown target
 * — draining every VM to zero and closing each runner's usage session (retireRunner) before
 * `reapDeletedPools` physically removes the empty row on a later tick. A hard DELETE (the old
 * behavior) removed the row instantly, so the scaler no longer knew about the pool and never
 * destroyed its VMs (perpetual Hetzner spend) or closed their metered sessions (billed forever).
 * The partial unique index on `provider` (WHERE deleting = false) lets a fresh pool for the same
 * provider be created while the old one still drains.
 */
export async function deleteFleetPool(id: string): Promise<{ success: true }> {
	assertFleetOperable();
	await authorize("destroy", { type: "fleet", id });
	await getServiceDb()
		.update(fleetPools)
		.set({ deleting: true, enabled: false, updated_at: new Date() })
		.where(eq(fleetPools.id, id));
	wakeFleetScaler();
	revalidatePath("/[org]/~/runners", "page");
	return { success: true };
}

// ── The console's mutation contract (ADR 0005 D4, #6123) ────────────────────────────────────────
//
// The Pools column calls these through `useActionMutation`: each validates its input with the same
// schema the function above re-checks, runs that function (so the deployment gate and the `fleet`
// authorization are the ones above), and answers an `ActionResult`. A validation failure reaches the
// pool wizard's fields instead of a toast.

// Each action is a plain async function whose body builds its contract inline, so the
// action-boundary guard follows it to the function it runs (and that function's `authorize`).

const poolId = z.string().uuid();

/** Creates a warm pool. */
export async function createFleetPoolAction(raw: z.input<typeof fleetPoolCreateSchema>) {
	return defineAction({ input: fleetPoolCreateSchema, run: ({ input }) => createFleetPool(input) })(raw);
}

const updateInput = z.object({ id: poolId, input: fleetPoolUpdateSchema });

/** Edits a warm pool's knobs. */
export async function updateFleetPoolAction(raw: z.input<typeof updateInput>) {
	return defineAction({ input: updateInput, run: ({ input }) => updateFleetPool(input.id, input.input) })(raw);
}

const enabledInput = z.object({ id: poolId, enabled: z.boolean() });

/** Pauses or resumes a pool. */
export async function setFleetPoolEnabledAction(raw: z.input<typeof enabledInput>) {
	return defineAction({ input: enabledInput, run: ({ input }) => setFleetPoolEnabled(input.id, input.enabled) })(raw);
}

const deleteInput = z.object({ id: poolId });

/** Soft-deletes a pool (the controller drains it first). */
export async function deleteFleetPoolAction(raw: z.input<typeof deleteInput>) {
	return defineAction({ input: deleteInput, run: ({ input }) => deleteFleetPool(input.id) })(raw);
}
