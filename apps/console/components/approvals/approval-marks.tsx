// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The small marks the approvals list and the decision sheet share. Seriousness without colour (spec
// §0): Production is a filled ink pill, Destroy a filled ink tag; a status is a `StatusBadge` with an
// explicit tier, because `expired`, `superseded` and `consumed` are not in `STATUS_TIER`.

import { StatusBadge } from "@repo/ui/status-badge";
import { cn } from "@repo/ui/utils";
import { Bot, KeyRound, MessageSquare, MonitorSmartphone, SquareTerminal } from "lucide-react";
import type { ApplyOperation, ApprovalStatus } from "@/lib/approvals/types";
import type { CredentialKind } from "@/lib/authz/types";
import { APPROVAL_STATUS, OPERATION_LABEL } from "./approval-vocabulary";

/** An approval's effective status. */
export function ApprovalStatusBadge({ status }: { status: ApprovalStatus }) {
	const { label, tier } = APPROVAL_STATUS[status];
	return <StatusBadge status={status} tier={tier} label={label} />;
}

/** The operation: Destroy is a filled ink tag, Deploy an outlined one. */
export function OperationTag({ operation }: { operation: ApplyOperation }) {
	return (
		<span
			data-operation={operation}
			className={cn(
				"inline-flex shrink-0 items-center rounded border px-1.5 font-mono text-ui-2xs uppercase tracking-wide",
				operation === "destroy" ? "border-foreground bg-foreground text-background" : "border-border text-text-secondary",
			)}
		>
			{OPERATION_LABEL[operation]}
		</span>
	);
}

/** The Production stage pill: filled ink, the one stage that is marked. */
export function ProductionPill() {
	return (
		<span className="inline-flex shrink-0 items-center rounded-full bg-foreground px-2 font-mono text-ui-2xs uppercase tracking-wide text-background">
			Production
		</span>
	);
}

/**
 * A neutral glyph for what asked. A connected agent's real brand mark belongs here once the connected
 * agents catalogue (#7625) lands; until then every credential gets a neutral, recognisable glyph, and
 * the app's NAME always carries the identity — never a letter placeholder (spec ruling 6).
 */
export function CredentialGlyph({ credential, className }: { credential: CredentialKind; className?: string }) {
	const Icon = {
		session: MonitorSmartphone,
		cli_session: SquareTerminal,
		agent_oauth: Bot,
		agent_in_app: MessageSquare,
		service_token: KeyRound,
	}[credential];
	return <Icon aria-hidden className={cn("size-3.5 shrink-0 text-text-tertiary", className)} />;
}
