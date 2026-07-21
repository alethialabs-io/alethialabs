// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Alibaba capability enumeration (epic #928, lane #936). STUB — scaffolded by seams #932; lane #936
// implements it: DescribeRegions + DescribeAvailableResource (Status/StatusCategory) +
// DescribeInstanceTypes for specs; quota via DescribeAccountAttributes (region-wide postpaid/spot vCPU)
// and/or Quota Center ListProductQuotas (per instance-type-group) — Alibaba quota IS obtainable keyless.

import type { SyncCapabilities } from "./types";

/** Enumerate this Alibaba account's launchable regions + instance types. TODO(#936). No-op until then. */
export const syncAlibabaCapabilities: SyncCapabilities = async (_identity) => {
	// Intentionally empty — see lane #936.
};
