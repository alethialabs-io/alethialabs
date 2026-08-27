// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { StatusBadge, type StatusTier } from "@repo/ui/status-badge";
import { cn } from "@repo/ui/utils";
import type { SupportCaseSeverity } from "@/lib/db/schema/enums";
import { SUPPORT_SEVERITY_LABELS } from "@/lib/validations/support";

/**
 * Severity is NOT a lifecycle state — it is a four-step ordered ramp of how much this
 * hurts, which is why it keeps its own component rather than collapsing into
 * {@link CaseStatusBadge}. What it no longer keeps is its own *rendering*: it is built on
 * the shared `StatusBadge` primitive (same dot grammar, same mono voice, same grayscale)
 * instead of a second `Badge`-plus-variant-map sitting beside it.
 *
 * The tiers are chosen for MONOTONIC weight, so the ramp reads in order without colour:
 *
 *   low     → disabled  faint filled dot — present, unremarkable
 *   normal  → idle      hollow dot
 *   high    → pending   filled dot with a halo
 *   urgent  → failed    the critical mark; "production system down" is the one severity
 *                       the design system has a distinct glyph for
 *
 * `status` carries the raw enum value (so it lands in the DOM for e2e/debugging) while
 * `label` renders the human copy from the shared label map.
 */
const SEVERITY_TIER: Record<SupportCaseSeverity, StatusTier> = {
	low: "disabled",
	normal: "idle",
	high: "pending",
	urgent: "failed",
};

/** A grayscale badge rendering a support case's severity with its display label. */
export function CaseSeverityBadge({
	severity,
	className,
}: {
	severity: SupportCaseSeverity;
	className?: string;
}) {
	return (
		<StatusBadge
			status={severity}
			tier={SEVERITY_TIER[severity]}
			label={SUPPORT_SEVERITY_LABELS[severity]}
			className={cn("whitespace-nowrap", className)}
		/>
	);
}
