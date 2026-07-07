// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared status marks for the Evidence surface. Grayscale-first: meaning is carried by the
// icon + label, with `destructive` reserved for a genuine failing/drifted state so the eye
// lands on what needs attention.

import {
	ShieldAlert,
	ShieldCheck,
	ShieldQuestion,
	TriangleAlert,
} from "lucide-react";
import { Badge } from "@repo/ui/badge";
import type { VerifyStatus } from "@/types/jsonb.types";

const VERDICT_META: Record<
	VerifyStatus,
	{ label: string; icon: typeof ShieldCheck; variant: "secondary" | "outline" | "destructive" }
> = {
	pass: { label: "Verified", icon: ShieldCheck, variant: "secondary" },
	warn: { label: "Warnings", icon: TriangleAlert, variant: "outline" },
	fail: { label: "Failing", icon: ShieldAlert, variant: "destructive" },
	not_evaluable: {
		label: "Not evaluable",
		icon: ShieldQuestion,
		variant: "outline",
	},
};

/** Renders a verification verdict as an icon + label badge. */
export function VerdictBadge({ verdict }: { verdict: VerifyStatus }) {
	const { label, icon: Icon, variant } = VERDICT_META[verdict];
	return (
		<Badge variant={variant} className="gap-1.5">
			<Icon className="h-3.5 w-3.5" />
			{label}
		</Badge>
	);
}

/** The muted "never verified" placeholder for an env with no report on record. */
export function UnverifiedBadge() {
	return (
		<Badge variant="outline" className="gap-1.5 text-muted-foreground">
			<ShieldQuestion className="h-3.5 w-3.5" />
			Not verified
		</Badge>
	);
}

/** Renders a drift posture: in-sync, an N-drifted count, or an unknown placeholder. */
export function DriftBadge({
	inSync,
	drifted,
}: {
	inSync: boolean;
	drifted: number;
}) {
	if (inSync) {
		return (
			<Badge variant="secondary" className="gap-1.5">
				<ShieldCheck className="h-3.5 w-3.5" />
				In sync
			</Badge>
		);
	}
	return (
		<Badge variant="destructive" className="gap-1.5">
			<TriangleAlert className="h-3.5 w-3.5" />
			{drifted} drifted
		</Badge>
	);
}

/** The muted "never scanned" placeholder for an env with no drift row. */
export function DriftUnknownBadge() {
	return (
		<Badge variant="outline" className="gap-1.5 text-muted-foreground">
			<ShieldQuestion className="h-3.5 w-3.5" />
			Not scanned
		</Badge>
	);
}
