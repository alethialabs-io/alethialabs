// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Input validators for fleet-pool CRUD. Reuses the same field shape as the legacy
// FLEET_POOLS env schema (lib/fleet/config.ts) so the DB-backed and env paths never drift.

import { poolSchema } from "@/lib/fleet/config";
import { z } from "zod";

/** Create a pool: the full spec, plus an optional display name. `provider` is required. */
export const fleetPoolCreateSchema = poolSchema.extend({
	name: z.string().trim().min(1).max(60).optional(),
});

/** Edit a pool: any subset of the create fields (provider stays fixed once created). */
export const fleetPoolUpdateSchema = fleetPoolCreateSchema.partial();

export type FleetPoolCreateInput = z.infer<typeof fleetPoolCreateSchema>;
export type FleetPoolUpdateInput = z.infer<typeof fleetPoolUpdateSchema>;
