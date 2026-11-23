// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ⚠ LEGAL TEXT — AWAITING THE MAINTAINER'S LEGAL REVIEW (#7339). Do not edit the wording, and do not
// treat it as approved, until that review has happened and this banner has been removed by it.
//
// The acknowledgement of a withdrawal on a durable medium: CRD art. 11a and ЗЗП art. 52a require the
// trader to acknowledge receipt of a withdrawal, and ЗЗП art. 52a requires it "не по-късно от края на
// работния ден" (docs/legal/TAX_MARKET_PRECONDITIONS.md §2.5). It is sent by
// `lib/email/withdrawal-email.ts` once `withdrawFromContract` has recorded the withdrawal.
//
// WHERE EVERY WORD COMES FROM. The email states no legal consequence of its own:
//
//   · Every prose sentence is in {@link PAGE_SENTENCES} or {@link SUPPORT_SENTENCE}, copied verbatim
//     from the sealed Consumer rights page (apps/marketing/app/consumer-rights/page.tsx), and
//     tests/lib/email/withdrawal-acknowledgement.test.ts fails if one stops appearing there. The
//     contracting-party line is that page's "Who you are contracting with" sentence, built from the
//     same `LEGAL_ENTITY` fields in the same order.
//   · Every figure is what the server recorded: the refund and retained amounts `withdrawFromContract`
//     computed, and the instant it recorded the withdrawal.
//   · The ONLY words written here are the subject, the eyebrow, the heading and the four table labels
//     in {@link NON_PAGE_WORDING}. They name what the email is and which figure is which; they make no
//     promise. They are the part the legal review most needs to read.
//
// NOT HERE, and listed for the maintainer on #7339: a Bulgarian-language version (ЗЗП art. 52a), and a
// sentence for an owed refund that could not be issued automatically (`refundIssued: false` — the order
// carried no payment to refund against). The sealed page has no sentence for that case, so the email
// shows the owed amount and says nothing it would have to invent.

import { Heading, Link, Text } from "@react-email/components";
import { EmailLayout } from "@repo/email/components/layout";
import { text } from "@repo/email/components/theme";
import { LEGAL_ENTITY } from "@repo/legal/entity";
import { BillingLegal, SummaryTable } from "./billing-shared";

/**
 * The sentences this email takes from the sealed Consumer rights page, verbatim. A test reads the
 * page's source and requires each one there, so an edit here that drifts from the sealed text fails.
 */
export const PAGE_SENTENCES = {
	/** Page §"What withdrawing costs you", last paragraph. */
	accessAndRefund:
		"Withdrawing ends your access immediately, and we refund you using the same payment method you paid with, without a fee.",
} as const;

/**
 * The page's "If something goes wrong" sentence, in the two halves either side of the support address
 * the page interpolates. Both halves are checked against the page source.
 */
export const SUPPORT_SENTENCE = {
	before: "Write to us first at",
	after: "— most things are faster to fix than to escalate.",
} as const;

/** The only words in this email that are not on the sealed page. See the file header. */
export const NON_PAGE_WORDING = {
	eyebrow: "Withdrawal received",
	heading: "You have withdrawn from the contract.",
	withdrawnAtLabel: "Withdrawn on",
	orderLabel: "Order reference",
	refundLabel: "Refund",
	retainedLabel: "Retained for the service supplied",
} as const;

/** The subject line. Written here, not taken from the page — see {@link NON_PAGE_WORDING}. */
export const subject = "We received your withdrawal from the contract";

export interface WithdrawalAcknowledgementEmailProps {
	/** When the server recorded the withdrawal, already formatted with its time zone. */
	withdrawnAtLabel: string;
	/** The order withdrawn from — its id, so the consumer can name the contract back to us. */
	orderReference: string;
	/** What the consumer is owed back, as `withdrawalOutcome` computed it, already formatted. */
	refundLabel: string;
	/** What was retained for the service supplied, already formatted. */
	retainedLabel: string;
	consumerRightsUrl?: string;
}

/**
 * The durable acknowledgement of a statutory withdrawal (CRD art. 11a, ЗЗП art. 52a). Its prose is
 * the sealed Consumer rights page's own; its figures are the server's recorded split.
 */
export function WithdrawalAcknowledgementEmail({
	withdrawnAtLabel,
	orderReference,
	refundLabel,
	retainedLabel,
	consumerRightsUrl = "https://alethialabs.io/consumer-rights",
}: WithdrawalAcknowledgementEmailProps) {
	return (
		<EmailLayout preview={NON_PAGE_WORDING.heading} legal={<BillingLegal />}>
			<Text className="a-text-3" style={text.eyebrow}>
				{NON_PAGE_WORDING.eyebrow}
			</Text>
			<Heading as="h2" className="a-text" style={text.heading}>
				{NON_PAGE_WORDING.heading}
			</Heading>

			<SummaryTable
				rows={[
					{ label: NON_PAGE_WORDING.withdrawnAtLabel, value: withdrawnAtLabel },
					{ label: NON_PAGE_WORDING.orderLabel, value: orderReference },
					{ label: NON_PAGE_WORDING.refundLabel, value: refundLabel, strong: true },
					{ label: NON_PAGE_WORDING.retainedLabel, value: retainedLabel },
				]}
			/>

			<Text className="a-text-2" style={text.body}>
				{PAGE_SENTENCES.accessAndRefund}
			</Text>
			<Text className="a-text-2" style={text.body}>
				{SUPPORT_SENTENCE.before}{" "}
				<Link href={`mailto:${LEGAL_ENTITY.supportEmail}`}>{LEGAL_ENTITY.supportEmail}</Link>{" "}
				{SUPPORT_SENTENCE.after}
			</Text>
			<Text className="a-text-2" style={text.body}>
				{LEGAL_ENTITY.legalName}, {LEGAL_ENTITY.legalForm.toLowerCase()}, registered in{" "}
				{LEGAL_ENTITY.jurisdiction} under EIK {LEGAL_ENTITY.registrationNumber}, at{" "}
				{LEGAL_ENTITY.registeredAddress}.
			</Text>
			<Text className="a-text-3" style={text.body}>
				<Link href={consumerRightsUrl}>Consumer rights</Link>
			</Text>
		</EmailLayout>
	);
}

WithdrawalAcknowledgementEmail.PreviewProps = {
	withdrawnAtLabel: "24 Aug 2026, 12:00 UTC",
	orderReference: "3f6c1d2e-0000-4000-8000-000000000001",
	refundLabel: "€100.00",
	retainedLabel: "€20.00",
} satisfies WithdrawalAcknowledgementEmailProps;

export default WithdrawalAcknowledgementEmail;
