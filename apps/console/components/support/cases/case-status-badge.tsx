// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Badge } from "@repo/ui/badge";
import { cn } from "@repo/ui/utils";
import type { SupportCaseStatus } from "@/lib/db/schema/enums";
import { SUPPORT_STATUS_LABELS } from "@/lib/validations/support";

/**
 * Maps each support-case status to a grayscale `Badge` variant. Open/pending are the
 * "live" states (outline, emphasised); resolved/closed are settled (muted secondary),
 * so the list reads at a glance without any colour.
 */
const STATUS_VARIANT: Record<
	SupportCaseStatus,
	"default" | "secondary" | "outline"
> = {
	open: "outline",
	pending_support: "outline",
	pending_customer: "default",
	resolved: "secondary",
	closed: "secondary",
};

/** A grayscale badge rendering a support case's lifecycle status with its display label. */
export function CaseStatusBadge({
	status,
	className,
}: {
	status: SupportCaseStatus;
	className?: string;
}) {
	return (
		<Badge
			variant={STATUS_VARIANT[status]}
			className={cn(
				(status === "resolved" || status === "closed") &&
					"text-muted-foreground",
				className,
			)}
		>
			{SUPPORT_STATUS_LABELS[status]}
		</Badge>
	);
}
