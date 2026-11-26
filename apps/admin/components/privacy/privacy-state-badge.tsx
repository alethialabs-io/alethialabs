// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { StatusBadge, type StatusTier } from "@repo/ui/status-badge";
import type { PrivacyState } from "@/app/privacy/constants";

/**
 * The tier each case state reads as. Explicit, because none of these words is in the shared
 * STATUS_TIER map and an unmapped status silently renders `idle` — an open request and a refused
 * one would look the same.
 */
const TIER: Record<PrivacyState, StatusTier> = {
	received: "pending",
	identity_pending: "pending",
	in_review: "pending",
	fulfilled: "active",
	refused: "failed",
	withdrawn: "disabled",
};

/** What each state is called on screen. */
const LABEL: Record<PrivacyState, string> = {
	received: "received",
	identity_pending: "identity pending",
	in_review: "in review",
	fulfilled: "fulfilled",
	refused: "refused",
	withdrawn: "withdrawn",
};

/** A privacy case's state as a status pill. */
export function PrivacyStateBadge({ state }: { state: PrivacyState }) {
	return <StatusBadge status={state} tier={TIER[state]} label={LABEL[state]} />;
}
