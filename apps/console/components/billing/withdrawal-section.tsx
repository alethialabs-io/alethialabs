"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The consumer's online withdrawal function (#7221) — the console half of the statutory withdrawal
// right whose server half is `app/server/actions/consumer-rights.ts`.
//
// What it is held to, and where each requirement is met:
//
//   · A control labelled for withdrawal. CRD art. 11a (and ЗЗП art. 52a) name the label: "withdraw
//     from contract here", and "confirm withdrawal" for the step after it
//     (docs/legal/TAX_MARKET_PRECONDITIONS.md §2.5). Both labels are those words, verbatim.
//   · Continuously available throughout the withdrawal period. The control renders whenever
//     `getWithdrawalRight` says the right is available, and only then — that read is the one the
//     server's own refusal runs, so the control cannot be offered when the action would refuse it.
//   · What withdrawing costs is shown BEFORE the consumer acts (CRD art. 6). The refund and the
//     retained amount are the server's figures from `withdrawalOutcome`, never recomputed here, and
//     the sentence explaining the split is the `basis` that function returns.
//
// Every other sentence here is either a figure the server returned or a sentence taken from the
// published Consumer rights page (apps/marketing/app/consumer-rights/page.tsx). Nothing in this
// file states a legal consequence of its own — a new claim belongs in the sealed legal text first.
//
// NOT HERE, because it is server behaviour: the acknowledgement on a durable medium. The success
// state below is on-screen only and does not claim an email was sent.
//
// This is NOT ordinary cancellation, which keeps access to the end of the paid period and refunds
// nothing. That control is the plan card's "Cancel plan"; this one ends access at once and refunds.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { formatDate, formatMoney } from "@repo/format";
import { LEGAL_ENTITY } from "@repo/legal/entity";
import { WITHDRAWAL_PERIOD_DAYS } from "@repo/legal/commerce";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";
import { Card } from "@repo/ui/card";
import { Skeleton } from "@repo/ui/skeleton";
import {
	type WithdrawalRight,
	getWithdrawalRight,
	withdrawFromContract,
} from "@/app/server/actions/consumer-rights";
import { ConfirmAction } from "@/components/confirm/confirm-action";
import { SettingsSection } from "@/components/settings/settings-ui";
import { legalUrl } from "@/lib/legal";
import { orpc } from "@/lib/rpc/client";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";

/** The query key of the withdrawal position; invalidated once a withdrawal is recorded. */
const WITHDRAWAL_RIGHT_KEY = ["consumer-rights", "withdrawal-right"] as const;

/** The section's heading. Named for the right, as the Consumer rights page names it. */
const SECTION_TITLE = "Right of withdrawal";

/** What `withdrawFromContract` returns: the split it recorded. */
type WithdrawalResult = Awaited<ReturnType<typeof withdrawFromContract>>;

/** An available right's figures, present together or not at all. */
interface WithdrawalQuote {
	readonly refundMinorUnits: number;
	readonly retainedMinorUnits: number;
	readonly currency: string;
	readonly expiresAt?: string;
	readonly basis?: string;
}

/**
 * The figures of an available right, or null when any is missing. The server always sets them
 * together; a position without them is shown as a failed read rather than with a guessed currency.
 */
function quoteOf(right: WithdrawalRight): WithdrawalQuote | null {
	const { refundMinorUnits, retainedMinorUnits, currency } = right;
	if (refundMinorUnits === undefined || retainedMinorUnits === undefined || !currency) return null;
	return { refundMinorUnits, retainedMinorUnits, currency, expiresAt: right.expiresAt, basis: right.basis };
}

/** Fetches the withdrawal position. Wrapped so the query never passes a client value to the action. */
function fetchWithdrawalRight(): Promise<WithdrawalRight> {
	return getWithdrawalRight();
}

/** The address a consumer can always withdraw by, from the operator record. */
function EmailLink() {
	return (
		<a className="underline underline-offset-4" href={`mailto:${LEGAL_ENTITY.contactEmail}`}>
			{LEGAL_ENTITY.contactEmail}
		</a>
	);
}

/**
 * The billing page's withdrawal section: the consumer's statutory right, its refund amount, and the
 * control that exercises it behind a confirmation step.
 *
 * Renders nothing where the right does not exist at all — an organization's order, or no order —
 * because a business customer has no such right and an empty section would suggest otherwise. Where
 * the right existed and is over, it says why, rather than going silent.
 */
export function WithdrawalSection() {
	const right = useQuery({
		queryKey: WITHDRAWAL_RIGHT_KEY,
		queryFn: fetchWithdrawalRight,
		retry: false,
	});
	const [result, setResult] = useState<WithdrawalResult | null>(null);

	if (result) return <WithdrawnNotice result={result} />;

	if (right.isPending) {
		return (
			<SettingsSection title={SECTION_TITLE}>
				<Skeleton className="h-24 w-full" />
			</SettingsSection>
		);
	}

	const quote = right.data?.available ? quoteOf(right.data) : null;
	if (right.isError || (right.data.available && !quote)) {
		// The read is gated on the billing permission the page already checked, so a failure here
		// is not a refusal — and the right does not lapse because a read failed. Say how else to use it.
		return (
			<SettingsSection title={SECTION_TITLE}>
				<Alert>
					<AlertTitle>Couldn&apos;t load your withdrawal right</AlertTitle>
					<AlertDescription>
						<p>
							If you bought as a consumer, you can also withdraw by emailing <EmailLink />.
						</p>
						<Button variant="outline" size="sm" className="mt-2" onClick={() => void right.refetch()}>
							Try again
						</Button>
					</AlertDescription>
				</Alert>
			</SettingsSection>
		);
	}

	const data = right.data;
	if (quote) return <AvailableRight quote={quote} onWithdrawn={setResult} />;
	if (data.reason === "period_expired") {
		return (
			<SettingsSection title={SECTION_TITLE}>
				<Card className="p-6 text-ui-md text-muted-foreground">
					The {WITHDRAWAL_PERIOD_DAYS}-day withdrawal period for this order ended
					{data.expiresAt ? ` on ${formatDate(data.expiresAt, "datetime")}` : ""}. You can still cancel
					at any time; access then continues to the end of the period you have already paid for.
				</Card>
			</SettingsSection>
		);
	}
	if (data.reason === "already_ended") {
		return (
			<SettingsSection title={SECTION_TITLE}>
				<Card className="p-6 text-ui-md text-muted-foreground">
					This order has already ended, so there is nothing to withdraw from.
				</Card>
			</SettingsSection>
		);
	}
	return null;
}

/** The right while it can be exercised: the figures, the basis, and the withdrawal control. */
function AvailableRight({
	quote,
	onWithdrawn,
}: {
	quote: WithdrawalQuote;
	onWithdrawn: (result: WithdrawalResult) => void;
}) {
	const queryClient = useQueryClient();
	const fetchWorkspace = useWorkspaceStore((s) => s.fetchWorkspace);
	const [confirmOpen, setConfirmOpen] = useState(false);

	const refund = formatMoney(quote.refundMinorUnits, quote.currency);
	const retained = formatMoney(quote.retainedMinorUnits, quote.currency);

	/** Exercises the right; on success records the outcome and refreshes everything it changed. */
	const withdraw = async (): Promise<void> => {
		try {
			const outcome = await withdrawFromContract({ reason: null });
			onWithdrawn(outcome);
			// The plan, its history and the usage readout all change when the subscription ends; the
			// shell's plan badge reads the workspace store.
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: WITHDRAWAL_RIGHT_KEY }),
				queryClient.invalidateQueries({ queryKey: orpc.billing.summary.key() }),
				queryClient.invalidateQueries({ queryKey: orpc.billing.planHistory.key() }),
				queryClient.invalidateQueries({ queryKey: orpc.usage.org.key() }),
			]);
			void fetchWorkspace();
		} catch (error) {
			// The server's reason does not survive a production server-action boundary, so this does
			// not guess at it, and it does not claim nothing changed — it names the other way to withdraw.
			toast.error("The withdrawal could not be completed.", {
				description: `Try again, or withdraw by emailing ${LEGAL_ENTITY.contactEmail}.`,
			});
			throw error;
		}
	};

	return (
		<SettingsSection title={SECTION_TITLE}>
			<Card className="space-y-4 p-6" data-testid="withdrawal-right">
				<div className="space-y-2 text-ui-md">
					<p>
						You may withdraw from the contract within {WITHDRAWAL_PERIOD_DAYS} days of placing your
						order, for any reason, and you do not have to tell us why.
						{quote.expiresAt ? ` Your withdrawal period ends ${formatDate(quote.expiresAt, "datetime")}.` : ""}
					</p>
					<dl className="space-y-1">
						<div className="flex flex-wrap gap-x-2">
							<dt className="text-muted-foreground">Refunded if you withdraw now:</dt>
							<dd className="font-medium tabular-nums">{refund}</dd>
						</div>
						<div className="flex flex-wrap gap-x-2">
							<dt className="text-muted-foreground">Retained for the service supplied:</dt>
							<dd className="tabular-nums">{retained}</dd>
						</div>
					</dl>
					{quote.basis ? <p className="text-muted-foreground">{quote.basis}</p> : null}
					<p className="text-muted-foreground">
						Withdrawing ends your access immediately, and we refund you using the same payment method
						you paid with, without a fee.{" "}
						<a
							className="underline underline-offset-4"
							href={legalUrl("/consumer-rights")}
							target="_blank"
							rel="noreferrer"
						>
							Consumer rights
						</a>
					</p>
				</div>
				<Button variant="destructive" onClick={() => setConfirmOpen(true)}>
					Withdraw from contract here
				</Button>
			</Card>
			<ConfirmAction
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
				title="Withdraw from this contract?"
				description={`You will be refunded ${refund} and ${retained} will be retained for the service supplied. Withdrawing ends your access immediately, and we refund you using the same payment method you paid with, without a fee.`}
				confirmLabel="Confirm withdrawal"
				pendingLabel="Withdrawing…"
				severity={{ level: "confirm" }}
				run={withdraw}
			/>
		</SettingsSection>
	);
}

/** What the consumer sees once the withdrawal is recorded: the figures the server actually moved. */
function WithdrawnNotice({ result }: { result: WithdrawalResult }) {
	return (
		<SettingsSection title={SECTION_TITLE}>
			<Alert data-testid="withdrawal-recorded">
				<AlertTitle>You have withdrawn from the contract</AlertTitle>
				<AlertDescription>
					<p>
						Refund: {formatMoney(result.refundMinorUnits, result.currency)}, to the payment method you
						paid with. Retained for the service supplied:{" "}
						{formatMoney(result.retainedMinorUnits, result.currency)}. Your access has ended.
					</p>
				</AlertDescription>
			</Alert>
		</SettingsSection>
	);
}
