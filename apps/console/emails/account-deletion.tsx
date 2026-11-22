// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button, Heading, Text } from "@react-email/components";
import { EmailLayout } from "@repo/email/components/layout";
import { primaryButton, text } from "@repo/email/components/theme";

/** The footer line every account-deletion email carries: why it was sent, and that it cannot be muted. */
const LEGAL =
	"You receive this because someone asked, from your signed-in Alethia account, for it to be deleted. " +
	"Messages about your account's deletion are always sent.";

/** The four stages a deletion email describes. */
export type AccountDeletionStage = "scheduled" | "reminder" | "cancelled" | "deleted";

/** The subject line for each stage, e.g. "Your Alethia account will be deleted on 5 Dec 2026". */
export function subject(stage: AccountDeletionStage, dateLabel: string): string {
	switch (stage) {
		case "scheduled":
			return `Your Alethia account will be deleted on ${dateLabel}`;
		case "reminder":
			return `Reminder: your Alethia account will be deleted on ${dateLabel}`;
		case "cancelled":
			return "Your Alethia account will not be deleted";
		case "deleted":
			return "Your Alethia account has been deleted";
	}
}

export interface AccountDeletionEmailProps {
	stage: AccountDeletionStage;
	/** The case reference, quoted if the person writes to us about it. */
	reference: string;
	/** When the deletion runs (scheduled, reminder) or ran (deleted), already formatted. */
	dateLabel: string;
	/** The page that cancels the deletion. Present for `scheduled` and `reminder`. */
	cancelUrl?: string;
}

/**
 * The emails of a self-serve account deletion: confirmation that it is scheduled (with the cancel
 * link), the reminder halfway through the grace period, the confirmation that it was cancelled,
 * and the confirmation that it ran.
 */
export function AccountDeletionEmail({
	stage,
	reference,
	dateLabel,
	cancelUrl,
}: AccountDeletionEmailProps) {
	const heading =
		stage === "scheduled"
			? "Your account is scheduled for deletion."
			: stage === "reminder"
				? "Your account will be deleted soon."
				: stage === "cancelled"
					? "Your account will not be deleted."
					: "Your account has been deleted.";
	return (
		<EmailLayout preview={subject(stage, dateLabel)} legal={LEGAL}>
			<Text className="a-text-3" style={text.eyebrow}>
				Account deletion · {reference}
			</Text>
			<Heading as="h2" className="a-text" style={text.heading}>
				{heading}
			</Heading>
			{stage === "scheduled" || stage === "reminder" ? (
				<>
					<Text className="a-text-2" style={text.body}>
						Your Alethia account and the personal data tied to it will be deleted on{" "}
						<strong>{dateLabel}</strong>. You have been signed out everywhere.
					</Text>
					<Text className="a-text-2" style={text.body}>
						To keep your account, sign in again before then, or use the button below. Either one
						cancels the deletion. If you do nothing, the deletion runs by itself and cannot be
						undone.
					</Text>
					<Text className="a-text-2" style={text.body}>
						Invoices, orders and the record of which terms you accepted are kept for as long as the
						law requires, without your name or address on your account.
					</Text>
					{cancelUrl ? (
						<Button href={cancelUrl} className="a-btn" style={primaryButton}>
							Keep my account →
						</Button>
					) : null}
				</>
			) : null}
			{stage === "cancelled" ? (
				<Text className="a-text-2" style={text.body}>
					The deletion you asked for has been cancelled and your account works as before. If you
					did not cancel it, sign in and request deletion again from your account settings.
				</Text>
			) : null}
			{stage === "deleted" ? (
				<Text className="a-text-2" style={text.body}>
					Your Alethia account was deleted on {dateLabel}. You cannot sign in to it again. Invoices,
					orders and the record of which terms you accepted are kept for as long as the law
					requires, without your name or address on your account. This is the last email we send to
					this address about the account.
				</Text>
			) : null}
		</EmailLayout>
	);
}

AccountDeletionEmail.PreviewProps = {
	stage: "scheduled",
	reference: "DSR-1A2B3C4D",
	dateLabel: "5 Dec 2026",
	cancelUrl: "https://alethialabs.io/account/deletion?t=example",
} satisfies AccountDeletionEmailProps;

export default AccountDeletionEmail;
