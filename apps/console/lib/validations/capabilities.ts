// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Insert validators for the per-tenant capabilities catalog (epic #928). Derived from the Drizzle schema
// via drizzle-zod so the enum columns can't hold a value the pg enum rejects. The per-cloud enumeration
// lanes normalize their SDK responses through these before upserting.

import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import {
	capabilityLaunchable,
	capabilityLaunchableReason,
	cloudCapabilityInstanceTypes,
	cloudCapabilityRegions,
} from "@/lib/db/schema";

/** Mirror of the `capability_launchable` pg enum. */
export const capabilityLaunchableSchema = z.enum(
	capabilityLaunchable.enumValues,
);
/** Mirror of the `capability_launchable_reason` pg enum. */
export const capabilityLaunchableReasonSchema = z.enum(
	capabilityLaunchableReason.enumValues,
);

/** A validated `cloud_capability_regions` insert row. */
export const capabilityRegionInsert = createInsertSchema(cloudCapabilityRegions);

/** A validated `cloud_capability_instance_types` insert row (tri-state launchable + bounded reason). */
export const capabilityInstanceTypeInsert = createInsertSchema(
	cloudCapabilityInstanceTypes,
	{
		launchable: capabilityLaunchableSchema,
		launchable_reason: capabilityLaunchableReasonSchema.nullish(),
	},
);
