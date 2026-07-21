// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Azure capability enumeration (epic #928, lane #934). STUB — scaffolded by seams #932; lane #934
// implements it: list-locations → Microsoft.Compute/skus resourceSkus.list (restrictions[] empty ⇒
// launchable; NotAvailableForSubscription/QuotaId ⇒ not_launchable) AND Compute usages (limit==0 ⇒
// quota_zero), then upsert cloud_capability_* rows.

import type { SyncCapabilities } from "./types";

/** Enumerate this Azure subscription's launchable regions + VM sizes. TODO(#934). No-op until then. */
export const syncAzureCapabilities: SyncCapabilities = async (_identity) => {
	// Intentionally empty — see lane #934.
};
