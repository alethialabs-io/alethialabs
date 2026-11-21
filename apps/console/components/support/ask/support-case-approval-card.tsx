"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ArrowUpRight, Check, LifeBuoy, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { z } from "zod";
import { fitClientToolText } from "@/components/agent/approval-card";
import { formatCaseNumber } from "@/components/support/cases/case-query";
import { useSubmitCase } from "@/components/support/use-submit-case";
import { type ActionError, describeActionError } from "@/lib/actions/result";
import { createSupportCaseOutputSchema } from "@/lib/ai/client-tools";
import type { SupportCaseProposal } from "@/lib/ai/support/case";
import { globalHref } from "@/lib/routing";
import {
	SUPPORT_CASE_TYPE_LABELS,
	SUPPORT_CATEGORY_LABELS,
	SUPPORT_SEVERITY_LABELS,
} from "@/lib/validations/support";
import { Button } from "@repo/ui/button";
import { cn } from "@repo/ui/utils";

type Phase = "idle" | "running" | "done" | "rejected" | "denied";

/** What the card has settled to, as it was fed back to the model. */
type Outcome = z.infer<typeof createSupportCaseOutputSchema>;

/** The card's state on screen. */
interface CardState {
	phase: Phase;
	/** The sentence shown under a refusal, or above the buttons after a failure that can be retried. */
	reason: string | null;
	caseNumber: number | null;
	caseId: string | null;
	/** The call was sent and not answered, so the case may exist: the refusal points at the list. */
	unconfirmed: boolean;
}

/** The card before anything was decided. */
const IDLE: CardState = { phase: "idle", reason: null, caseNumber: null, caseId: null, unconfirmed: false };

/**
 * The card's state from the outcome already recorded on its tool part, so a card drawn again — the
 * conversation restored after "View case", or any remount — shows what happened instead of offering
 * to open the same case a second time (G-10, G-11).
 */
export function cardStateFromOutput(output: unknown): CardState {
	const parsed = createSupportCaseOutputSchema.safeParse(output);
	if (!parsed.success) return IDLE;
	const outcome: Outcome = parsed.data;
	switch (outcome.status) {
		case "submitted":
			return { ...IDLE, phase: "done", caseNumber: outcome.caseNumber, caseId: outcome.caseId };
		case "failed":
			return { ...IDLE, phase: "denied", reason: outcome.reason };
		case "dismissed":
			return { ...IDLE, phase: "rejected" };
	}
}

/**
 * Whether a failure left nothing behind and can simply be tried again: the session ended before the
 * call, or the browser was offline so nothing was sent. Such a failure keeps the buttons and is not
 * reported to the model as final (G-02). A call that was sent but not answered may have opened the
 * case, so it is NOT retryable from here — the card says to check the cases list instead.
 */
export function isRetryableFailure(error: ActionError): boolean {
	return error.kind === "unauthenticated" || (error.kind === "network" && !error.sent);
}

/**
 * HITL approval for an assistant-proposed support case. Approve opens the case through the
 * mutation contract (`useSubmitCase` → `submitCase`; the model only PROPOSED the case; the write
 * happens on the user's click, mirroring the plan/deploy `ApprovalCard`) and then links to the
 * created case at `/{org}/~/support/cases/{id}`. A refusal surfaces the action's own message.
 *
 * Every failure ends in a usable card: one that sent nothing (offline, session ended) returns to
 * its buttons with the reason above them; any other is shown in place and fed back to the model,
 * so the conversation continues (G-02). `output` is the outcome already on the tool part: a card
 * drawn again starts from it.
 */
export function SupportCaseApprovalCard({
	proposal,
	orgSlug,
	output,
	onResolve,
}: {
	proposal: SupportCaseProposal;
	orgSlug: string;
	/** The tool part's recorded output, when it has one. */
	output?: unknown;
	/** Feed the outcome back to the model (closes the HITL loop → it continues). */
	onResolve?: (output: Outcome) => void;
}) {
	const router = useRouter();
	const [state, setState] = useState<CardState>(() => cardStateFromOutput(output));
	const { phase, reason, caseNumber, caseId, unconfirmed } = state;
	const casesHref = `${globalHref(orgSlug, "support")}/my-cases`;

	const submit = useSubmitCase(orgSlug, { navigate: false });

	/** Opens the case through the mutation contract, once, and settles the card on the answer. */
	const approve = () => {
		if (submit.isPending || phase === "running") return;
		setState({ ...IDLE, phase: "running" });
		submit.mutate(
			{
				values: {
					type: proposal.type,
					category: proposal.category,
					severity: proposal.severity,
					subject: proposal.subject,
					description: proposal.description,
					context: proposal.context ?? {},
				},
			},
			{
				onSuccess: ({ id, caseNumber: opened }) => {
					setState({ ...IDLE, phase: "done", caseNumber: opened, caseId: id });
					onResolve?.({ status: "submitted", caseId: id, caseNumber: opened });
				},
				onError: (failure) => {
					const message = describeActionError(failure.error);
					if (isRetryableFailure(failure.error)) {
						setState({ ...IDLE, reason: message });
						return;
					}
					setState({
						...IDLE,
						phase: "denied",
						reason: message,
						unconfirmed: failure.error.kind === "network",
					});
					// Cut to the stored output's bounds, so a long error never makes the card unsendable.
					const fitted = fitClientToolText("create_support_case", message, (r) => ({
						status: "failed",
						reason: r,
					}));
					onResolve?.({ status: "failed", reason: fitted });
				},
			},
		);
	};

	/** Declines the proposal and tells the model so. */
	const dismiss = () => {
		if (phase === "running") return;
		setState({ ...IDLE, phase: "rejected" });
		onResolve?.({ status: "dismissed" });
	};

	return (
		<div
			className={cn(
				"w-full border",
				phase === "denied" ? "border-border" : "border-foreground",
			)}
		>
			<div className="flex items-center gap-2.5 border-b border-border px-3.5 py-3">
				<span className="flex h-7 w-7 flex-none items-center justify-center border border-foreground">
					<LifeBuoy className="h-3.5 w-3.5" />
				</span>
				<div className="min-w-0">
					<div className="truncate text-ui-md font-medium">{proposal.subject}</div>
					<div className="vx-eyebrow text-ui-3xs">
						{SUPPORT_CASE_TYPE_LABELS[proposal.type]} · {SUPPORT_CATEGORY_LABELS[proposal.category]} ·{" "}
						{SUPPORT_SEVERITY_LABELS[proposal.severity]}
					</div>
				</div>
			</div>

			<div className="space-y-3 px-3.5 py-3">
				<p className="whitespace-pre-wrap text-ui-sm leading-relaxed text-muted-foreground">
					{proposal.description}
				</p>

				{phase === "done" ? (
					<div className="flex items-center justify-between gap-3">
						<div className="flex items-center gap-2 font-mono text-ui-xs text-muted-foreground">
							<span className="h-1.5 w-1.5 rounded-full bg-foreground" />
							{caseNumber != null ? `${formatCaseNumber(caseNumber)} opened.` : "Case opened."}
						</div>
						{caseId && (
							<Button
								size="sm"
								className="h-8 gap-1.5 rounded-none"
								onClick={() => router.push(`${globalHref(orgSlug, "support")}/cases/${caseId}`)}
							>
								View case
								<ArrowUpRight className="h-3.5 w-3.5" />
							</Button>
						)}
					</div>
				) : phase === "rejected" ? (
					<div className="font-mono text-ui-xs text-muted-foreground">
						Dismissed.
					</div>
				) : phase === "denied" ? (
					<div className="flex items-start gap-2.5 border border-foreground bg-muted/40 px-3 py-2.5">
						<span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center border border-foreground">
							<X className="h-3 w-3" />
						</span>
						<div className="text-ui-sm leading-relaxed text-muted-foreground">
							<span className="font-medium text-foreground">
								Case not opened.
							</span>{" "}
							{reason}
							{unconfirmed ? (
								<>
									{" "}
									<Link href={casesHref} className="underline underline-offset-4 hover:text-foreground">
										Check your cases
									</Link>{" "}
									before asking again.
								</>
							) : null}
						</div>
					</div>
				) : (
					<div className="flex items-center justify-between gap-3">
						<span role={reason ? "alert" : undefined} className="text-ui-xs text-muted-foreground">
							{reason ?? "Review the details, then submit this case to support."}
						</span>
						<div className="flex flex-none gap-2">
							<Button
								variant="ghost"
								size="sm"
								className="h-8 rounded-none"
								disabled={phase === "running"}
								onClick={dismiss}
							>
								Dismiss
							</Button>
							<Button
								size="sm"
								className="h-8 gap-1.5 rounded-none"
								disabled={phase === "running"}
								onClick={approve}
							>
								<Check className="h-3.5 w-3.5" />
								Submit case
							</Button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
