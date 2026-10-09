"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Check, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
	getApprovedJob,
	tryPlanProject,
	tryProvisionProject,
} from "@/app/server/actions/projects";
import { formatMonthlyRate } from "@repo/format";
import { Button } from "@repo/ui/button";
import { track } from "@/lib/analytics/track";
import { type ClientToolName, parseClientToolOutput } from "@/lib/ai/client-tools";
import type { OperationProposal } from "@/lib/ai/operation";
import { useArtifactStore } from "@/lib/stores/use-artifact-store";
import { useElenchStore } from "@/lib/stores/use-elench-store";
import { cn } from "@repo/ui/utils";

type Phase = "idle" | "running" | "done" | "rejected" | "denied" | "already";

/**
 * The idempotency key of an approval (#5797): the proposing tool call, qualified by its thread
 * when the conversation has one. The server stores it on the job it queues, so a second Approve
 * of this proposal — after a reload, or after its output was refused — returns that job instead
 * of queuing another plan or deploy.
 */
export function approvalKeyOf(threadId: string | null, toolCallId: string): string {
	return threadId ? `${threadId}:${toolCallId}` : toolCallId;
}

/**
 * The longest prefix of `text` (whole code points, with an ellipsis when cut) for which
 * `build(prefix)` passes `toolName`'s output schema and its 4,096-byte cap (ADR 0003 §5.1 step
 * 8). A card's free text (an error message, a model-written label) can exceed either bound, and
 * an output that fails them is refused before it is stored (#5796): without this, a long error would make
 * the approval itself unsendable. Returns `text` itself when it already fits.
 */
export function fitClientToolText(
	toolName: ClientToolName,
	text: string,
	build: (text: string) => unknown,
): string {
	if (parseClientToolOutput(toolName, build(text)).ok) return text;
	const points = Array.from(text);
	const fits = (n: number) =>
		parseClientToolOutput(toolName, build(`${points.slice(0, n).join("")}…`)).ok;
	let lo = 0;
	let hi = points.length;
	// The largest n in [0, length) that fits, by binary search (fitting is monotone in n).
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (fits(mid)) lo = mid;
		else hi = mid - 1;
	}
	return `${points.slice(0, lo).join("")}…`;
}

/** A denial's output, its reason cut to fit the stored output's bounds. */
function deniedOutput(reason: string): { status: "denied"; reason: string } {
	const fitted = fitClientToolText("propose_operation", reason, (r) => ({
		status: "denied",
		reason: r,
	}));
	return { status: "denied", reason: fitted };
}

/**
 * HITL approval for an agent-proposed plan/deploy. Approve calls the PDP-gated
 * planProject/provisionProject (the M1 placement + usage gates run inside them) and opens
 * the artifact Logs tab on the returned job; a denial (Forbidden / usage cap) shows
 * the "held back" note from the action's error message.
 *
 * The operation runs against the ENVIRONMENT the proposal names, falling back to the one the
 * Elench surface is scoped to (`ctx.environmentId`, the topbar switcher's). Only when neither
 * knows does the action reach its own default — before this the card passed no environment at
 * all, so on any non-default environment it planned and deployed the default one.
 */
export function ApprovalCard({
	proposal,
	onResolve,
}: {
	proposal: OperationProposal;
	/** Feed the outcome back to the model (closes the HITL loop → it continues). */
	onResolve?: (output: unknown) => void;
}) {
	const open = useArtifactStore((s) => s.open);
	const ctx = useElenchStore((s) => s.ctx);
	const threadId = useElenchStore((s) => s.threadId);
	const [phase, setPhase] = useState<Phase>("idle");
	const [reason, setReason] = useState<string | null>(null);
	// The job this proposal already queued, found on mount (a re-render after a reload).
	const [existingJobId, setExistingJobId] = useState<string | null>(null);

	const isDeploy = proposal.operation.operation === "provision_project";
	const approvalKey = approvalKeyOf(threadId, proposal.id);
	const { operation: opName, projectId: opProjectId } = proposal.operation;

	// A transcript can come back without this approval's output (its continuation refused, or the
	// page reloaded first), which leaves the card actionable again. Ask the server whether this
	// proposal already queued a job, and show that job instead of an active Approve. A failed
	// lookup leaves Approve in place: the server dedupes a second Approve on the same key anyway.
	useEffect(() => {
		let cancelled = false;
		getApprovedJob(opProjectId, opName, approvalKey)
			.then((found) => {
				if (cancelled || !found) return;
				setExistingJobId(found.jobId);
				setPhase((p) => (p === "idle" ? "already" : p));
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [opProjectId, opName, approvalKey]);

	const approve = async () => {
		track("elench_tool_approved", { tool: "propose_operation" });
		setPhase("running");
		setReason(null);
		try {
			const op = proposal.operation;
			const envId =
				op.environmentId ??
				(ctx.kind === "project" ? ctx.environmentId : null) ??
				undefined;
			const res =
				op.operation === "plan_project"
					? await tryPlanProject(op.projectId, undefined, envId, approvalKey)
					: await tryProvisionProject(
							op.projectId,
							op.planJobId,
							undefined,
							envId,
							approvalKey,
						);
			if (!res.ok) {
				// The gate's own sentence (#5445) — thrown, a production build reduced it to a digest.
				setPhase("denied");
				setReason(res.error);
				onResolve?.(deniedOutput(res.error));
				return;
			}
			const { jobId } = res;
			open({ projectId: op.projectId, jobId }, "logs");
			setPhase("done");
			onResolve?.({
				status: "approved",
				operation: op.operation,
				projectId: op.projectId,
				environmentId: envId ?? null,
				jobId,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : "Operation failed.";
			setPhase("denied");
			setReason(message);
			onResolve?.(deniedOutput(message));
		}
	};

	const reject = () => {
		track("elench_tool_denied", { tool: "propose_operation" });
		setPhase("rejected");
		onResolve?.({ status: "rejected" });
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
					<ShieldCheck className="h-3.5 w-3.5" />
				</span>
				<div className="min-w-0">
					<div className="truncate text-ui-md font-medium">{proposal.label}</div>
					<div className="vx-eyebrow text-ui-3xs">
						{isDeploy ? "Provisions live infrastructure" : "Queues a plan"}
					</div>
				</div>
			</div>

			<div className="space-y-3 px-3.5 py-3">
				{proposal.stats && (
					/* One mono line, not a stat strip. §6 bans the strips with no qualifier, and
					   the reason is this card exactly: it asks for a decision, and a row of four
					   18px numbers takes the space above the Approve button to tell you what is
					   countable instead of what you are agreeing to. The same four facts read in
					   a sentence, at the weight of the sentence beside them. The money goes
					   through `formatMonthlyRate` in the `"exact"` register, so this card and the
					   plan panel's Est. cannot disagree about the symbol, the separators or the
					   cents. `"exact"` and not the default `"estimate"` because this IS the plan
					   panel's total — the agent is told to copy `costSummary.totalMonthlyCost`
					   into `stats.monthly`, and `artifact-panel` renders that same number exact.
					   On the default the two read `<$1/mo` against `$0.75/mo`, and `$0/mo`
					   against `$0.00/mo`, for one plan.

					   What `"exact"` does NOT buy is the sign: it clamps `<= 0`, so a negative
					   `monthly` renders `$0.00/mo` and a teardown's saving reads as nothing.
					   `stats.monthly` is declared to the model as an absolute total for that
					   reason (`lib/ai/operation.ts`); showing a saving would need a credit
					   register in `@repo/format`, which does not exist in either language. */
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-ui-xs text-muted-foreground">
						<span className="text-foreground">
							{proposal.stats.add ?? 0} to add
						</span>
						<span aria-hidden>·</span>
						<span className="text-foreground">
							{proposal.stats.change ?? 0} to change
						</span>
						<span aria-hidden>·</span>
						<span className="text-foreground">
							{proposal.stats.destroy ?? 0} to destroy
						</span>
						{proposal.stats.monthly != null && (
							<>
								<span aria-hidden>·</span>
								<span className="text-foreground">
									{formatMonthlyRate(proposal.stats.monthly, "exact")} est.
								</span>
							</>
						)}
					</div>
				)}

				{phase === "already" && existingJobId ? (
					<div className="flex items-center justify-between gap-3">
						<span className="font-mono text-ui-xs text-muted-foreground">
							Already approved — this proposal queued its job.
						</span>
						<Button
							variant="outline"
							size="sm"
							className="h-8 rounded-none"
							onClick={() =>
								open({ projectId: opProjectId, jobId: existingJobId }, "logs")
							}
						>
							View logs
						</Button>
					</div>
				) : phase === "done" ? (
					<div className="flex items-center gap-2 font-mono text-ui-xs text-muted-foreground">
						<span className="h-1.5 w-1.5 rounded-full bg-foreground" />
						{isDeploy ? "Approved · deploying…" : "Planning…"} — logs in the panel.
					</div>
				) : phase === "rejected" ? (
					<div className="font-mono text-ui-xs text-muted-foreground">
						Rejected.
					</div>
				) : phase === "denied" ? (
					<div className="flex items-start gap-2.5 border border-foreground bg-muted/40 px-3 py-2.5">
						<span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center border border-foreground">
							<X className="h-3 w-3" />
						</span>
						<div className="text-ui-sm leading-relaxed text-muted-foreground">
							<span className="font-medium text-foreground">
								Operation held back.
							</span>{" "}
							{reason}
						</div>
					</div>
				) : (
					<div className="flex items-center justify-between gap-3">
						<span className="text-ui-xs text-muted-foreground">
							{isDeploy
								? "The agent will apply the plan exactly as shown."
								: "Review the plan in the panel after it runs."}
						</span>
						<div className="flex flex-none gap-2">
							<Button
								variant="ghost"
								size="sm"
								className="h-8 rounded-none"
								disabled={phase === "running"}
								onClick={reject}
							>
								Reject
							</Button>
							<Button
								size="sm"
								className="h-8 gap-1.5 rounded-none"
								disabled={phase === "running"}
								onClick={approve}
							>
								<Check className="h-3.5 w-3.5" />
								{isDeploy ? "Approve & deploy" : "Approve & plan"}
							</Button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
