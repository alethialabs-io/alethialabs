// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared zod validators for the ArgoCD health/sync domains the runner mirrors onto
// execution_metadata (gitops_status, addon_status) and project_addons. The runtime arrays are
// kept in lockstep with the jsonb.types unions via `satisfies`, so the finite type is declared
// once. External ArgoCD values parse through `.catch("Unknown")` — an unexpected state degrades
// that one field to Unknown rather than failing the whole status parse.

import { z } from "zod";
import type { ArgocdHealthStatus, ArgocdSyncStatus } from "@/types/jsonb.types";

const ARGOCD_HEALTH = [
	"Healthy",
	"Progressing",
	"Degraded",
	"Suspended",
	"Missing",
	"Unknown",
] as const satisfies readonly ArgocdHealthStatus[];

const ARGOCD_SYNC = [
	"Synced",
	"OutOfSync",
	"Unknown",
] as const satisfies readonly ArgocdSyncStatus[];

/** ArgoCD Application/resource health, defaulting an unknown value to "Unknown". */
export const argocdHealth = z.enum(ARGOCD_HEALTH).catch("Unknown");

/** ArgoCD sync state, defaulting an unknown value to "Unknown". */
export const argocdSync = z.enum(ARGOCD_SYNC).catch("Unknown");

/** `execution_metadata.addon_status` — per-add-on ArgoCD health/sync keyed by Application name. */
export const addonStatusSchema = z.record(
	z.string(),
	z.object({ health: argocdHealth, sync: argocdSync }),
);
