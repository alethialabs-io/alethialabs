// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GCP capability enumeration (epic #928, lane #935). STUB — scaffolded by seams #932; lane #935
// implements it: regions.list → machineTypes.aggregatedList (offered) + Cloud Quotas quotaInfos
// (dimensioned per {region, vm_family}; classic families via regions.get.quotas[]) → tri-state
// `launchable`, then upsert cloud_capability_* rows.

import type { SyncCapabilities } from "./types";

/** Enumerate this GCP project's launchable regions + machine types. TODO(#935). No-op until then. */
export const syncGcpCapabilities: SyncCapabilities = async (_identity) => {
	// Intentionally empty — see lane #935.
};
