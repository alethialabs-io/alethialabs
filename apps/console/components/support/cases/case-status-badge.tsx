// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { StatusBadge, type StatusTier } from "@repo/ui/status-badge";
import { cn } from "@repo/ui/utils";
import type { SupportCaseStatus } from "@/lib/db/schema/enums";
import { SUPPORT_STATUS_LABELS } from "@/lib/validations/support";

/**
 * Support-case status onto the shared grayscale status tiers. This used to be a private
 * `Badge` + variant map — a fourth dialect of "show a state" beside the one @repo/ui
 * already owns; only the mapping below is domain knowledge, so only the mapping stays here.
 *
 * Every value needs an EXPLICIT tier: `statusTier()` knows none of these five strings
 * ("open", "pending_support", … are not in its table), so leaving it to auto-resolve
 * would silently render all five identically as `idle`.
 *
 *   open, pending_support  → pending   in flight, waiting on Alethia
 *   pending_customer       → active    waiting on YOU — the one row that wants action
 *   resolved               → idle      settled, still reopenable (hollow dot)
 *   closed                 → disabled  inert
 */
const STATUS_TIER: Record<SupportCaseStatus, StatusTier> = {
	open: "pending",
	pending_support: "pending",
	pending_customer: "active",
	resolved: "idle",
	closed: "disabled",
};

/** A grayscale status badge for a support case's lifecycle state. */
export function CaseStatusBadge({
	status,
	className,
}: {
	status: SupportCaseStatus;
	className?: string;
}) {
	return (
		<StatusBadge
			status={status}
			tier={STATUS_TIER[status]}
			label={SUPPORT_STATUS_LABELS[status]}
			className={cn("whitespace-nowrap", className)}
		/>
	);
}
