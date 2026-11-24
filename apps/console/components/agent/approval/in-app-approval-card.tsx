"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from "@hookform/resolvers/zod";
import { formatMonthlyRate, formatRelative } from "@repo/format";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { decideApplyApproval } from "@/app/server/actions/approvals";
import { type InAppApprovalDetail, readInAppApproval, startInAppApproval } from "@/lib/agent/approval-actions";
import type { InAppApprovalOutput } from "@/lib/agent/approval-output";
import { IN_APP_APPROVAL_KEY } from "@/lib/query/topics";
import { useArtifactStore } from "@/lib/stores/use-artifact-store";

/** The `requested` arm of the approval tools' output: what the card is drawn for. */
type RequestedApproval = Extract<InAppApprovalOutput, { status: "requested" }>;

/** The destroy confirmation: the environment's name, typed by the person. */
const confirmSchema = z.object({ environmentName: z.string().max(200) });

/** The sentence an action refusal is shown as. */
function refusalText(error: { kind: string; message?: string }): string {
	return error.message ?? "That did not go through. Try again.";
}

/**
 * The in-product agent's approval request, in the conversation (agent surface §4.6).
 *
 * The facts come from the plan job the approval is bound to — its add / change / destroy counts, its
 * cost, its verify verdict and its digest — never from the agent's account of them; the agent's note
 * is shown as untrusted text. Approve is a person's decision (`decideApplyApproval`, the one decision
 * path: a console session, a recent sign-in, the verb on the project, and a different person when the
 * org requires one). Once approved, the requester's click starts the job, queued as the assistant's
 * credential with the approval presented, so the queue gate consumes it once.
 *
 * Where the request stands is a query under {@link IN_APP_APPROVAL_KEY}, which the `environments`
 * topic invalidates whenever the approval row changes (lib/realtime/README.md, rule 1): a teammate's
 * decision reaches this card without a poll. `expired` is computed at read time, so the card re-reads
 * once when the request's window closes.
 */
export function InAppApprovalCard({ request }: { request: RequestedApproval }) {
	const open = useArtifactStore((s) => s.open);
	const queryClient = useQueryClient();
	const queryKey = [...IN_APP_APPROVAL_KEY, request.approval_id];
	const { data: detail = null, dataUpdatedAt } = useQuery({
		queryKey,
		queryFn: async (): Promise<InAppApprovalDetail | null> => {
			const res = await readInAppApproval({ approvalId: request.approval_id });
			return res.ok ? res.data : null;
		},
	});
	const [message, setMessage] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const now = dataUpdatedAt ? new Date(dataUpdatedAt) : null;
	const form = useForm<z.infer<typeof confirmSchema>>({
		resolver: zodResolver(confirmSchema),
		defaultValues: { environmentName: "" },
	});

	const isDestroy = request.operation === "destroy";
	const status = detail?.approval.status ?? request.approval_status;
	const digest = detail?.approval.digest_prefix ?? request.digest_prefix;

	const refresh = useCallback(
		() => queryClient.invalidateQueries({ queryKey: [...IN_APP_APPROVAL_KEY, request.approval_id] }),
		[queryClient, request.approval_id],
	);

	// `expired` is computed when the approval is read, so no change hint announces it: read once more
	// when the window closes. One timer per open request, not a poll.
	const live = status === "pending" || status === "approved";
	useEffect(() => {
		if (!live) return;
		const wait = Date.parse(request.expires_at) - Date.now();
		if (!(wait > 0)) return;
		const timer = setTimeout(() => void refresh(), wait + 1_000);
		return () => clearTimeout(timer);
	}, [live, request.expires_at, refresh]);

	/** Queues the approved job as the assistant's credential and opens its logs. */
	const startJob = async () => {
		const started = await startInAppApproval({ approvalId: request.approval_id });
		if (!started.ok) {
			setMessage(refusalText(started.error));
			return;
		}
		open({ projectId: request.project_id, jobId: started.data.jobId }, "logs");
	};

	const approve = form.handleSubmit(async ({ environmentName }) => {
		setBusy(true);
		setMessage(null);
		try {
			const decided = await decideApplyApproval({
				approvalId: request.approval_id,
				decision: "approve",
				confirmEnvironmentName: isDestroy ? environmentName : null,
			});
			if (!decided.ok) {
				setMessage(refusalText(decided.error));
				return;
			}
			if (detail?.requestedByReader) await startJob();
		} finally {
			setBusy(false);
			await refresh();
		}
	});

	const reject = async () => {
		setBusy(true);
		setMessage(null);
		try {
			const decided = await decideApplyApproval({ approvalId: request.approval_id, decision: "reject" });
			if (!decided.ok) setMessage(refusalText(decided.error));
		} finally {
			setBusy(false);
			await refresh();
		}
	};

	const start = async () => {
		setBusy(true);
		setMessage(null);
		try {
			await startJob();
		} finally {
			setBusy(false);
			await refresh();
		}
	};

	const plan = detail?.plan;
	const where = plan?.projectName && plan.environmentName ? `${plan.projectName} / ${plan.environmentName}` : null;
	const verb = isDestroy ? "destroy" : "deploy";
	const consumedJob = detail?.approval.consumed_job_id ?? null;

	return (
		<div data-slot="in-app-approval" className="w-full border border-foreground">
			<div className="flex items-center gap-2.5 border-b border-border px-3.5 py-3">
				<span className="flex h-7 w-7 flex-none items-center justify-center border border-foreground">
					<ShieldCheck className="h-3.5 w-3.5" />
				</span>
				<div className="min-w-0">
					<div className="truncate text-ui-md font-medium">
						Approve {verb}
						{where ? ` — ${where}` : ""}
					</div>
					<div className="vx-eyebrow text-ui-3xs">
						Requested by the assistant · digest {digest}
						{now && live
							? ` · expires ${formatRelative(request.expires_at, now)}`
							: ""}
					</div>
				</div>
			</div>

			<div className="space-y-3 px-3.5 py-3">
				{plan && (
					/* One mono line, as on the plan proposal card: the plan job's own counts and cost. */
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-ui-xs text-muted-foreground">
						<span className="text-foreground">{plan.add ?? 0} to add</span>
						<span aria-hidden>·</span>
						<span className="text-foreground">{plan.change ?? 0} to change</span>
						<span aria-hidden>·</span>
						<span className="text-foreground">{plan.destroy ?? 0} to destroy</span>
						{plan.monthly != null && (
							<>
								<span aria-hidden>·</span>
								<span className="text-foreground">{formatMonthlyRate(plan.monthly, "exact")} est.</span>
							</>
						)}
						<span aria-hidden>·</span>
						<span className="text-foreground">verify {plan.verifyVerdict ?? "not run"}</span>
						<Button
							variant="link"
							size="sm"
							className="h-auto p-0 font-mono text-ui-xs"
							onClick={() => open({ projectId: request.project_id, jobId: request.plan_job_id }, "plan")}
						>
							View plan
						</Button>
					</div>
				)}

				{detail?.reason && (
					<div className="text-ui-xs text-muted-foreground">
						<span className="font-medium">Assistant&apos;s note (untrusted):</span>{" "}
						<span className="whitespace-pre-wrap break-words">{detail.reason}</span>
					</div>
				)}

				{message && (
					<div role="alert" className="flex items-start gap-2.5 border border-foreground bg-muted/40 px-3 py-2.5">
						<span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center border border-foreground">
							<X className="h-3 w-3" />
						</span>
						<div className="text-ui-sm leading-relaxed text-muted-foreground">{message}</div>
					</div>
				)}

				{status === "pending" ? (
					<form onSubmit={approve} className="space-y-2">
						{isDestroy && (
							<Input
								aria-label="Environment name"
								placeholder={plan?.environmentName ? `Type ${plan.environmentName} to confirm` : "Type the environment's name to confirm"}
								className="h-8 rounded-none"
								autoComplete="off"
								{...form.register("environmentName")}
							/>
						)}
						<div className="flex items-center justify-between gap-3">
							<span className="text-ui-xs text-muted-foreground">
								{isDestroy
									? "Approving tears down this environment's cloud resources."
									: "The deploy applies exactly this plan, and only this plan."}
							</span>
							<div className="flex flex-none gap-2">
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="h-8 rounded-none"
									disabled={busy}
									onClick={reject}
								>
									Reject
								</Button>
								<Button type="submit" size="sm" className="h-8 gap-1.5 rounded-none" disabled={busy || !detail}>
									<Check className="h-3.5 w-3.5" />
									Approve and {verb}
								</Button>
							</div>
						</div>
					</form>
				) : status === "approved" ? (
					detail?.requestedByReader ? (
						<div className="flex items-center justify-between gap-3">
							<span className="text-ui-xs text-muted-foreground">Approved by a person. Nothing runs until you start it.</span>
							<Button size="sm" className="h-8 rounded-none" disabled={busy} onClick={start}>
								Start {verb}
							</Button>
						</div>
					) : (
						<div className="font-mono text-ui-xs text-muted-foreground">
							Approved — the person who asked the assistant starts it.
						</div>
					)
				) : status === "consumed" ? (
					<div className="flex items-center justify-between gap-3">
						<span className="font-mono text-ui-xs text-muted-foreground">Approved — the {verb} has started.</span>
						{consumedJob && (
							<Button
								variant="outline"
								size="sm"
								className="h-8 rounded-none"
								onClick={() => open({ projectId: request.project_id, jobId: consumedJob }, "logs")}
							>
								View logs
							</Button>
						)}
					</div>
				) : (
					<div className="font-mono text-ui-xs text-muted-foreground">
						{status === "rejected"
							? "Rejected. Nothing was changed."
							: status === "expired"
								? "The request expired before it was decided. Nothing was changed; ask the assistant to request it again."
								: "A newer plan or a change to the environment replaced this request. Nothing was changed."}
					</div>
				)}
			</div>
		</div>
	);
}
