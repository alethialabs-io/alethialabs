// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Badge } from "@repo/ui/badge";
import { cn } from "@repo/ui/utils";
import type { SupportCaseSeverity } from "@/lib/db/schema/enums";
import { SUPPORT_SEVERITY_LABELS } from "@/lib/validations/support";

/**
 * Maps each severity to a grayscale `Badge` weight. Low/normal are quiet (outline);
 * high/urgent carry more contrast (solid/secondary) so the eye lands on them first —
 * emphasis via weight, never colour.
 */
const SEVERITY_VARIANT: Record<
	SupportCaseSeverity,
	"default" | "secondary" | "outline"
> = {
	low: "outline",
	normal: "outline",
	high: "secondary",
	urgent: "default",
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
		<Badge
			variant={SEVERITY_VARIANT[severity]}
			className={cn(
				(severity === "low" || severity === "normal") &&
					"text-muted-foreground",
				className,
			)}
		>
			{SUPPORT_SEVERITY_LABELS[severity]}
		</Badge>
	);
}
