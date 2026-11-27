"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The decision sheet's pinned footer (spec §1.4): the decision while a request waits, the outcome once
// it does not. It never scrolls away, and on a phone it is the thumb zone.
//
// THE SERVER DECIDES, THIS ONLY ASKS. `decideApplyApproval` re-checks everything at decision time —
// the session's age, the verb, the status, the expiry, the plan binding and the org's policy — and
// refuses with a sentence for a person. The sheet's read (`approvals.get`) answers the same policy
// question in advance (`approveBlock`), so Approve is disabled with its reason before anyone presses
// it; a stale sheet that is approved anyway is refused by the server and re-read.
//
// HOW A REFUSAL IS SHOWN. The action answers a refusal with the server's sentence AND its
// `ApprovalErrorCode` (lib/approvals/refusal.ts, carried on the result's `code` — #7643), so this
// footer names the refusal from the code ({@link REFUSAL_COPY}) and shows the server's sentence under
// it verbatim. An old sign-in (`reauthentication_required`) offers "Sign in again" at once. The
// refusal invalidates the sheet's read, and the re-read then shows the state the request is in now:
// decided by someone else, expired or replaced → the outcome; the policy changed → the Blocked alert,
// which takes the refusal's place. Nothing is inferred from the re-read any more: before #7643 the
// result carried no code, and the sign-in case was deduced by elimination.

import { zodResolver } from "@hookform/resolvers/zod";
import { formatDate } from "@repo/format";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@repo/ui/form";
import { Textarea } from "@repo/ui/textarea";
import { Check, Clock, Info, Link2, Lock, LogIn, Power } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { decideApplyApproval } from "@/app/server/actions/approvals";
import { ConfirmAction } from "@/components/confirm/confirm-action";
import { useSecondsClock } from "@/components/jobs/columns";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import type { ApproveBlock } from "@/lib/approvals/decidable";
import { type ApprovalErrorCode, isApprovalErrorCode } from "@/lib/approvals/refusal";
import { authClient } from "@/lib/auth/client";
import { signInHref } from "@/lib/auth/sign-in-href";
import { orpc } from "@/lib/rpc/client";
import type { ApprovalSheet } from "@/lib/rpc/procedures/approvals";
import { remainingAt } from "./approval-countdown";
import { requesterName } from "./approval-vocabulary";

/** The longest deny reason the server stores (`DECISION_REASON_MAX`). */
const REASON_MAX = 500;

/** The deny form: an optional reason. */
const denySchema = z.object({ reason: z.string().max(REASON_MAX, `Keep the reason under ${REASON_MAX} characters.`) });

/**
 * The title each refusal the server can raise is shown under, keyed by its code. A `Record` over every
 * code, so a new `ApprovalErrorCode` does not compile until it has its title. The body is always the
 * server's own sentence.
 */
const REFUSAL_COPY: Record<ApprovalErrorCode, { title: string; icon: typeof Lock }> = {
	not_found: { icon: Info, title: "This request isn't available" },
	plan_not_approvable: { icon: Info, title: "This plan can't be approved as it stands" },
	not_permitted: { icon: Lock, title: "This organization's agent policy doesn't allow it" },
	not_a_person: { icon: Lock, title: "Only a person signed in to the console can decide" },
	reauthentication_required: { icon: LogIn, title: "Sign in again to decide" },
	self_approval: { icon: Info, title: "Someone else needs to approve this" },
	policy_refused: { icon: Lock, title: "This organization's agent policy changed" },
	not_pending: { icon: Info, title: "This request isn't waiting any more" },
	confirmation_mismatch: { icon: Info, title: "The environment name didn't match" },
};

/** The title for a refusal that carried no approval code (an older server, or not the engine's own). */
const UNCODED_REFUSAL_TITLE = "That didn't go through";

/** The title and body of an Approve block, in the sheet's words (spec §1.4, the Blocked states). */
function blockCopy(block: ApproveBlock, via: string, verb: string): { title: string; body: string; icon: typeof Lock } {
	switch (block.reason) {
		case "agent_access_disabled":
			return {
				icon: Power,
				title: "Agent access is off in this organization",
				body: `While it's off, ${via} can't ${verb} even with an approval. You can deny the request, or someone who manages agents can turn access back on in Settings → Agents.`,
			};
		case "agents_not_on_production":
			return {
				icon: Lock,
				title: "This organization keeps agents off production",
				body: `Only a person in the console can ${verb} production, so this request can only be denied.`,
			};
		case "client_not_allowed":
			return {
				icon: Lock,
				title: `${via} isn't an allowed agent app in this organization`,
				body: `This organization only lets approved apps act as agents. Deny this, or ask someone who manages agents to allow ${via} in Settings → Agents.`,
			};
		case "self_approval":
			return {
				icon: Info,
				title: "Someone else needs to approve this",
				body: `This organization requires a different person to approve requests made for you. You can still deny it, or send the link to a teammate with ${verb} access.`,
			};
	}
}

/** An inline alert: a title, a sentence, and an icon. */
function Notice({ icon: Icon, title, children }: { icon: typeof Lock; title: string; children: React.ReactNode }) {
	return (
		<Alert>
			<Icon aria-hidden />
			<AlertTitle>{title}</AlertTitle>
			<AlertDescription>{children}</AlertDescription>
		</Alert>
	);
}

/** Signs the person out and sends them to sign in, coming back to this same sheet. */
async function signInAgain(): Promise<void> {
	const here = `${window.location.pathname}${window.location.search}`;
	try {
		await authClient.signOut();
	} finally {
		window.location.assign(signInHref(here));
	}
}

/** The props every footer state reads. */
export interface ApprovalDecisionProps {
	sheet: ApprovalSheet;
	orgSlug: string;
	/** The signed-in person's id, to say "You approved this". */
	viewerId: string | null;
	/** Copies the sheet's link (the header's button, offered again for a teammate). */
	onCopyLink: () => void;
}

/**
 * The footer: the outcome when the request is no longer waiting; otherwise the decision — Deny and
 * Approve, the deny reason form, the destroy confirmation, a policy block, or a refusal.
 */
export function ApprovalDecision(props: ApprovalDecisionProps) {
	return props.sheet.approval.status === "pending" ? <PendingDecision {...props} /> : <Outcome {...props} />;
}

/** The footer of a request that is still waiting. */
function PendingDecision({ sheet, orgSlug, onCopyLink }: ApprovalDecisionProps) {
	const { approval, canDecide, approveBlock } = sheet;
	const via = requesterName(approval);
	const verb = approval.operation;
	const isDestroy = approval.operation === "destroy";
	const now = useSecondsClock();
	const left = now === null ? null : remainingAt(approval.expires_at, now);
	const until = formatDate(approval.expires_at, "time");

	const [denying, setDenying] = useState(false);
	const [confirming, setConfirming] = useState(false);
	// The last refusal: the server's sentence, and its code when it carried an approval code.
	const [refusal, setRefusal] = useState<{ message: string; code: ApprovalErrorCode | null } | null>(null);

	const decide = useActionMutation(decideApplyApproval, {
		invalidates: [orpc.approvals.key()],
		onRefusal: (error) => {
			setRefusal({ message: error.message, code: isApprovalErrorCode(error.code) ? error.code : null });
			setConfirming(false);
			setDenying(false);
		},
	});

	const form = useForm<z.infer<typeof denySchema>>({ resolver: zodResolver(denySchema), defaultValues: { reason: "" } });

	if (!canDecide) {
		return (
			<div className="space-y-3">
				<p className="text-ui-md text-text-primary">
					Deciding needs {verb} access to {approval.project_name}. Anyone with it can decide.
				</p>
				<Button variant="outline" className="w-full" onClick={onCopyLink}>
					<Link2 aria-hidden />
					Copy link for a teammate
				</Button>
			</div>
		);
	}

	if (refusal?.code === "reauthentication_required") {
		const copy = REFUSAL_COPY.reauthentication_required;
		return (
			<div className="space-y-3">
				<Notice icon={copy.icon} title={copy.title}>
					{refusal.message} Approvals need a sign-in from the last 24 hours. You&apos;ll come straight back to this
					request.
				</Notice>
				<Button size="lg" className="w-full" onClick={() => void signInAgain()}>
					<LogIn aria-hidden />
					Sign in again
				</Button>
			</div>
		);
	}

	if (denying) {
		const submit = form.handleSubmit(({ reason }) => {
			decide.submit({ approvalId: approval.id, decision: "reject", reason: reason.trim() || null });
		});
		return (
			<Form {...form}>
				<form onSubmit={submit} className="space-y-3" aria-label="Deny this request">
					<FormField
						control={form.control}
						name="reason"
						render={({ field }) => (
							<FormItem>
								<FormLabel>
									Reason for denying <span className="font-normal text-text-tertiary">(optional)</span>
								</FormLabel>
								<FormControl>
									<Textarea
										{...field}
										maxLength={REASON_MAX}
										rows={3}
										placeholder="For example: wrong environment, plan again from main."
									/>
								</FormControl>
								<FormDescription>
									Shown to {approval.requester_name ?? "the requester"} and to {via}.
								</FormDescription>
								<FormMessage />
							</FormItem>
						)}
					/>
					<div className="flex justify-end gap-2">
						<Button type="button" variant="ghost" disabled={decide.isPending} onClick={() => setDenying(false)}>
							Back
						</Button>
						<Button type="submit" disabled={decide.isPending} aria-busy={decide.isPending || undefined}>
							{decide.isPending ? "Denying…" : "Deny request"}
						</Button>
					</div>
				</form>
			</Form>
		);
	}

	const block = approveBlock ? blockCopy(approveBlock, via, verb) : null;
	const lede = isDestroy ? (
		<>
			Approving lets <b className="text-text-primary">{via}</b> destroy{" "}
			<span className="font-mono text-text-primary">{approval.environment_name}</span> once, before {until}.
		</>
	) : (
		<>
			Approving lets <b className="text-text-primary">{via}</b> deploy this exact plan to{" "}
			<span className="font-mono text-text-primary">{approval.environment_name}</span> once, before {until}. If the plan
			changes first, the approval stops working.
		</>
	);

	return (
		<div className="space-y-3">
			{refusal && !block ? (
				<Notice
					icon={refusal.code ? REFUSAL_COPY[refusal.code].icon : Info}
					title={refusal.code ? REFUSAL_COPY[refusal.code].title : UNCODED_REFUSAL_TITLE}
				>
					{refusal.message}
				</Notice>
			) : null}
			{block ? (
				<Notice icon={block.icon} title={block.title}>
					{block.body}
				</Notice>
			) : null}
			{left?.soon && !block ? (
				<Notice icon={Clock} title="Expires in under 5 minutes">
					After {until} it can&apos;t be approved and {via} has to ask again.
				</Notice>
			) : null}
			{!block ? <p className="text-ui-md text-text-secondary">{lede}</p> : null}
			{isDestroy && !block ? (
				<ul className="list-disc space-y-1 pl-5 text-ui-md text-text-secondary">
					<li>
						Every resource in <span className="font-mono text-text-primary">{approval.environment_name}</span> is removed from
						your cloud.
					</li>
					<li>Data in its databases and volumes is deleted unless you back it up first.</li>
					<li>You&apos;ll type the environment name to confirm.</li>
				</ul>
			) : null}
			<div className="grid grid-cols-2 gap-2">
				<Button variant="outline" size="lg" disabled={decide.isPending} onClick={() => setDenying(true)}>
					Deny
				</Button>
				<Button
					size="lg"
					disabled={block !== null || decide.isPending}
					aria-busy={(decide.isPending && !confirming) || undefined}
					onClick={() => (isDestroy ? setConfirming(true) : decide.submit({ approvalId: approval.id, decision: "approve" }))}
				>
					{isDestroy ? null : <Check aria-hidden />}
					{isDestroy ? "Approve destroy…" : decide.isPending ? "Approving…" : "Approve deploy"}
				</Button>
			</div>
			{approveBlock?.reason === "self_approval" ? (
				<Button variant="ghost" className="w-full" onClick={onCopyLink}>
					<Link2 aria-hidden />
					Copy link for a teammate
				</Button>
			) : null}
			<p className="text-ui-sm text-text-tertiary">
				Anyone with {verb} access to {approval.project_name} can decide. Decisions are recorded in{" "}
				<Link className="underline underline-offset-2" href={`/${orgSlug}/~/settings/activity`}>
					Activity
				</Link>
				.
			</p>
			{isDestroy ? (
				<ConfirmAction
					open={confirming}
					onOpenChange={setConfirming}
					title={`Approve destroying ${approval.environment_name}?`}
					description={`${via} will be able to destroy ${approval.project_name} / ${approval.environment_name} once, before ${until}.`}
					confirmLabel="Approve destroy"
					pendingLabel="Approving…"
					severity={{
						level: "destroy",
						subject: approval.environment_name,
						consequences: [
							"Removes every resource this environment runs.",
							"Deletes data in its databases and volumes.",
						],
					}}
					mutation={decide}
					variables={{ approvalId: approval.id, decision: "approve", confirmEnvironmentName: approval.environment_name }}
				/>
			) : null}
		</div>
	);
}

/** The footer of a request that is no longer waiting: how it ended. Announced when it changes. */
function Outcome({ sheet, orgSlug, viewerId }: ApprovalDecisionProps) {
	const { approval } = sheet;
	const via = requesterName(approval);
	const at = (iso: string | null) => (iso ? formatDate(iso, "time") : "an earlier time");
	const approver = approval.approver_user_id !== null && approval.approver_user_id === viewerId ? "You" : (approval.approver_name ?? "A teammate");
	const action = approval.operation === "destroy" ? `destroy ${approval.environment_name}` : "deploy this plan";
	const until = formatDate(approval.expires_at, "time");

	let body: React.ReactNode;
	let sub: React.ReactNode = null;
	let extra: React.ReactNode = null;
	switch (approval.status) {
		case "approved":
			body = `${approver} approved this at ${at(approval.decided_at)}. ${via} can ${action} once, before ${until}.`;
			sub = `If it doesn't start by ${until}, the approval expires.`;
			break;
		case "consumed":
			body = `Approved by ${approver === "You" ? "you" : approver} at ${at(approval.decided_at)}. The ${approval.operation} has started.`;
			sub = "Each approval runs one job once.";
			extra = approval.consumed_job_id ? (
				<Button
					variant="outline"
					className="w-full"
					nativeButton={false}
					render={<Link href={`/${orgSlug}/~/jobs/${approval.consumed_job_id}`} />}
				>
					Open {approval.operation} job <span className="font-mono">{approval.consumed_job_id.slice(0, 8)}</span>
				</Button>
			) : null;
			break;
		case "rejected":
			body = `${approver} denied this at ${at(approval.decided_at)}.`;
			extra = approval.decision_reason ? (
				<figure className="rounded-md border border-dashed p-3">
					<figcaption className="font-mono text-ui-2xs uppercase tracking-wide text-text-tertiary">
						Reason from {approver === "You" ? "you" : approver}
					</figcaption>
					<blockquote className="mt-1 whitespace-pre-wrap break-words text-ui-md text-text-primary">
						{approval.decision_reason}
					</blockquote>
				</figure>
			) : null;
			break;
		case "expired":
			body = approval.approver_user_id
				? `${approver} approved this, but it wasn't used before ${until}, so it expired.`
				: `Nobody decided before ${until}, so this request can't be approved any more.`;
			sub = `Ask ${via} to request a new approval.`;
			break;
		case "superseded":
			body = `The plan behind this request is no longer the current plan for ${approval.project_name} / ${approval.environment_name}, so it no longer describes what would run.`;
			sub = `Decide the newer request instead, or ask ${via} to request approval for the current plan.`;
			break;
		case "pending":
			body = null;
	}
	return (
		<div aria-live="polite" className="space-y-2" data-outcome={approval.status}>
			<p className="text-ui-md text-text-primary">{body}</p>
			{sub ? <p className="text-ui-sm text-text-secondary">{sub}</p> : null}
			{extra}
		</div>
	);
}
