// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// AWS capability enumeration (epic #928, lane #933). STUB — the seams issue (#932) scaffolds this file
// so the dispatcher compiles; lane #933 implements it: DescribeRegions (opt-in) → per-region
// DescribeInstanceTypeOfferings + DescribeInstanceTypes + ListServiceQuotas (family-class code
// L-1216C47A) → tri-state `launchable` via the 3-signal AND, then upsert cloud_capability_* rows.

import type { SyncCapabilities } from "./types";

/** Enumerate this AWS account's launchable regions + instance types. TODO(#933). No-op until then. */
export const syncAwsCapabilities: SyncCapabilities = async (_identity) => {
	// Intentionally empty — see lane #933.
};
