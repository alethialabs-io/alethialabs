// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The small marks the approvals list and the decision sheet share. Seriousness without colour (spec
// §0): Production is a filled ink pill, Destroy a filled ink tag; a status is a `StatusBadge` with an
// explicit tier, because `expired`, `superseded` and `consumed` are not in `STATUS_TIER`.

import { StatusBadge } from "@repo/ui/status-badge";
import { cn } from "@repo/ui/utils";
import { KeyRound, type LucideIcon, MessageSquare, MonitorSmartphone, SquareTerminal } from "lucide-react";
import { AgentIcon } from "@/components/agents/agent-icon";
import { agentAppFor } from "@/lib/agents/catalog";
import type { ApplyOperation, ApprovalStatus } from "@/lib/approvals/types";
import type { CredentialKind } from "@/lib/authz/types";
import { APPROVAL_STATUS, CREDENTIAL_LABEL, OPERATION_LABEL } from "./approval-vocabulary";

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

/** The fields of an approval that say what asked, enough to draw its mark. */
interface RequesterMarkSource {
	requester_credential: CredentialKind;
	requester_credential_name: string | null;
	requester_credential_ref: string | null;
	requester_credential_icon: string | null;
}

/** The neutral glyph of each credential that is not a connected agent: Alethia's own surfaces and tokens. */
const CREDENTIAL_GLYPH: Record<Exclude<CredentialKind, "agent_oauth">, LucideIcon> = {
	session: MonitorSmartphone,
	cli_session: SquareTerminal,
	agent_in_app: MessageSquare,
	service_token: KeyRound,
};

/**
 * The mark of what asked. A connected agent is drawn by the shared `AgentIcon`, keyed by its OAuth
 * client id: the app's brand mark when the agent catalogue knows it, otherwise the icon the app
 * registered, otherwise a neutral glyph — never a letter placeholder (spec ruling 6). Every other
 * credential gets a neutral glyph. Decorative everywhere: the app's NAME sits beside it and carries
 * the identity, so the mark is hidden from assistive tech rather than announcing the name twice.
 */
export function RequesterMark({
	approval,
	size = 14,
	className,
}: {
	approval: RequesterMarkSource;
	/** Rendered size in px. */
	size?: number;
	className?: string;
}) {
	if (approval.requester_credential === "agent_oauth") {
		const app = approval.requester_credential_ref ? agentAppFor(approval.requester_credential_ref) : null;
		return (
			<AgentIcon
				mark={app?.mark ?? null}
				icon={app ? null : approval.requester_credential_icon}
				name={app?.name ?? approval.requester_credential_name ?? CREDENTIAL_LABEL.agent_oauth}
				size={size}
				decorative
				className={className}
			/>
		);
	}
	const Icon = CREDENTIAL_GLYPH[approval.requester_credential];
	return (
		<Icon
			aria-hidden
			width={size}
			height={size}
			data-mark="credential"
			className={cn("shrink-0 text-text-tertiary", className)}
		/>
	);
}
