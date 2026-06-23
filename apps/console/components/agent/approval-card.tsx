"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Check, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { planSpec, provisionSpec } from "@/app/server/actions/specs";
import { Button } from "@/components/ui/button";
import type { OperationProposal } from "@/lib/ai/operation";
import { useArtifactStore } from "@/lib/stores/use-artifact-store";
import { cn } from "@/lib/utils";

type Phase = "idle" | "running" | "done" | "rejected" | "denied";

/**
 * HITL approval for an agent-proposed plan/deploy. Approve calls the PDP-gated
 * planSpec/provisionSpec (the M1 placement + usage gates run inside them) and opens
 * the artifact Logs tab on the returned job; a denial (Forbidden / usage cap) shows
 * the "held back" note from the action's error message.
 */
export function ApprovalCard({ proposal }: { proposal: OperationProposal }) {
	const open = useArtifactStore((s) => s.open);
	const [phase, setPhase] = useState<Phase>("idle");
	const [reason, setReason] = useState<string | null>(null);

	const isDeploy = proposal.operation.operation === "provision_spec";

	const approve = async () => {
		setPhase("running");
		setReason(null);
		try {
			const op = proposal.operation;
			const { jobId } =
				op.operation === "plan_spec"
					? await planSpec(op.specId)
					: await provisionSpec(op.specId, op.planJobId);
			open({ specId: op.specId, jobId }, "logs");
			setPhase("done");
		} catch (err) {
			setPhase("denied");
			setReason(err instanceof Error ? err.message : "Operation failed.");
		}
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
					<div className="truncate text-[13px] font-medium">{proposal.label}</div>
					<div className="vx-eyebrow text-[9px]">
						{isDeploy ? "Provisions live infrastructure" : "Queues a plan"}
					</div>
				</div>
			</div>

			<div className="space-y-3 px-3.5 py-3">
				{proposal.stats && (
					<div className="flex gap-5">
						<Stat n={proposal.stats.add ?? 0} l="to add" />
						<Stat n={proposal.stats.change ?? 0} l="to change" />
						<Stat n={proposal.stats.destroy ?? 0} l="to destroy" />
						{proposal.stats.monthly != null && (
							<Stat n={proposal.stats.monthly} l="est / mo" prefix="$" />
						)}
					</div>
				)}

				{phase === "done" ? (
					<div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
						<span className="h-1.5 w-1.5 rounded-full bg-foreground" />
						{isDeploy ? "Approved · deploying…" : "Planning…"} — logs in the panel.
					</div>
				) : phase === "rejected" ? (
					<div className="font-mono text-[11px] text-muted-foreground">
						Rejected.
					</div>
				) : phase === "denied" ? (
					<div className="flex items-start gap-2.5 border border-foreground bg-muted/40 px-3 py-2.5">
						<span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center border border-foreground">
							<X className="h-3 w-3" />
						</span>
						<div className="text-[12px] leading-relaxed text-muted-foreground">
							<span className="font-medium text-foreground">
								Operation held back.
							</span>{" "}
							{reason}
						</div>
					</div>
				) : (
					<div className="flex items-center justify-between gap-3">
						<span className="text-[11px] text-muted-foreground">
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
								onClick={() => setPhase("rejected")}
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

function Stat({
	n,
	l,
	prefix,
}: {
	n: number;
	l: string;
	prefix?: string;
}) {
	return (
		<div>
			<div className="font-mono text-lg font-semibold tracking-tight">
				{prefix}
				{n}
			</div>
			<div className="vx-eyebrow text-[8px]">{l}</div>
		</div>
	);
}
