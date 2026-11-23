// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// LEGAL TEXT — the English wording was approved by the maintainer's legal review on 2026-11-23 (#7351).
//
// The acknowledgement of a withdrawal on a durable medium: CRD art. 11a and ЗЗП art. 52a require the
// trader to acknowledge receipt of a withdrawal, and ЗЗП art. 52a requires it "не по-късно от края на
// работния ден" (docs/legal/TAX_MARKET_PRECONDITIONS.md §2.5). It is sent by
// `lib/email/withdrawal-email.ts` once `withdrawFromContract` has recorded the withdrawal, in English,
// or in Bulgarian when the order's billing country is BG (`consumerLocaleFor`).
//
// WHERE EVERY WORD COMES FROM. The email states no legal consequence of its own:
//
//   · Every prose sentence is in {@link PAGE_SENTENCES} or {@link SUPPORT_SENTENCE}, copied verbatim
//     from the sealed Consumer rights page (apps/marketing/app/consumer-rights/page.tsx): the English
//     sentences from its English half, the Bulgarian ones from its Bulgarian section (`#bg`).
//     tests/lib/email/withdrawal-acknowledgement.test.ts fails if one stops appearing there. The
//     contracting-party line is that page's "Who you are contracting with" sentence (or its
//     Bulgarian twin), built from the same `LEGAL_ENTITY` fields in the same order.
//   · The `basis` line is `withdrawalOutcome`'s own sentence from `@repo/legal/commerce`, in the
//     email's language — the same computation that produced the figures, so it cannot disagree
//     with them.
//   · Every figure is what the server recorded: the refund and retained amounts `withdrawFromContract`
//     computed, and the instant it recorded the withdrawal.
//   · The ONLY words written here are the subject, the eyebrow, the heading and the four table labels
//     in {@link NON_PAGE_WORDING}, per language. They name what the email is and which figure is
//     which; they make no promise. The English ones are the approved text; the Bulgarian ones are
//     their translation, reviewed with this change.
//
// The owed-refund sentence ({@link PAGE_SENTENCES}`.refundArranged`) is sent ONLY when an owed refund
// could not be issued automatically (`refundIssued: false` — the order carried no payment to refund
// against). Then the server has also alerted the operator, which is what makes "we contact you within
// 14 days" happen.

import { Heading, Link, Text } from "@react-email/components";
import { EmailLayout } from "@repo/email/components/layout";
import { text } from "@repo/email/components/theme";
import type { ConsumerLocale } from "@repo/legal/commerce";
import { LEGAL_ENTITY } from "@repo/legal/entity";
import { BillingLegal, SummaryTable } from "./billing-shared";

/**
 * The sentences this email takes from the sealed Consumer rights page, verbatim, per language. A test
 * reads the page's source and requires each one there, so an edit here that drifts from the sealed
 * text fails.
 */
export const PAGE_SENTENCES = {
	en: {
		/** Page §"What withdrawing costs you", last paragraph. */
		accessAndRefund:
			"Withdrawing ends your access immediately, and we refund you using the same payment method you paid with, without a fee.",
		/** Same paragraph. Sent only when `refundIssued` is false. */
		refundArranged:
			"If we cannot refund automatically, for example because there was no card payment to refund against, we contact you within 14 days to arrange it.",
	},
	"bg-BG": {
		/** Page §"Какво Ви струва отказът", last paragraph. */
		accessAndRefund:
			"Отказът прекратява достъпа Ви незабавно и Ви възстановяваме сумата чрез същото платежно средство, с което сте платили, без такса.",
		/** Same paragraph. Sent only when `refundIssued` is false. */
		refundArranged:
			"Ако не можем да възстановим сумата автоматично, например защото няма плащане с карта, срещу което да я възстановим, се свързваме с Вас в срок от 14 дни, за да уредим възстановяването.",
	},
} as const satisfies Record<ConsumerLocale, { accessAndRefund: string; refundArranged: string }>;

/**
 * The page's "If something goes wrong" sentence, in the two halves either side of the support address
 * the page interpolates, per language. Both halves are checked against the page source.
 */
export const SUPPORT_SENTENCE = {
	en: {
		before: "Write to us first at",
		after: "— most things are faster to fix than to escalate.",
	},
	"bg-BG": {
		before: "Първо ни пишете на",
		after: "— повечето проблеми се решават по-бързо така, отколкото с жалба.",
	},
} as const satisfies Record<ConsumerLocale, { before: string; after: string }>;

/**
 * The link to the Consumer rights page: its English title, or its Bulgarian section's heading, and
 * where each lives. Both labels are checked against the page source.
 */
export const CONSUMER_RIGHTS_LINK = {
	en: { label: "Consumer rights", href: "https://alethialabs.io/consumer-rights" },
	"bg-BG": { label: "Права на потребителите", href: "https://alethialabs.io/consumer-rights#bg" },
} as const satisfies Record<ConsumerLocale, { label: string; href: string }>;

/** The only words in this email that are not on the sealed page, per language. See the file header. */
export const NON_PAGE_WORDING = {
	en: {
		eyebrow: "Withdrawal received",
		heading: "You have withdrawn from the contract.",
		withdrawnAtLabel: "Withdrawn on",
		orderLabel: "Order reference",
		refundLabel: "Refund",
		retainedLabel: "Retained for the service supplied",
	},
	"bg-BG": {
		eyebrow: "Получен отказ",
		heading: "Вие се отказахте от договора.",
		withdrawnAtLabel: "Дата на отказа",
		orderLabel: "Номер на поръчката",
		refundLabel: "Сума за възстановяване",
		retainedLabel: "Задържана сума за предоставената услуга",
	},
} as const satisfies Record<
	ConsumerLocale,
	{
		eyebrow: string;
		heading: string;
		withdrawnAtLabel: string;
		orderLabel: string;
		refundLabel: string;
		retainedLabel: string;
	}
>;

/** The subject line, per language. Written here, not taken from the page — see {@link NON_PAGE_WORDING}. */
export const SUBJECT = {
	en: "We received your withdrawal from the contract",
	"bg-BG": "Потвърждение за получен отказ от договора",
} as const satisfies Record<ConsumerLocale, string>;

export interface WithdrawalAcknowledgementEmailProps {
	/** When the server recorded the withdrawal, already formatted with its time zone. */
	withdrawnAtLabel: string;
	/** The order withdrawn from — its id, so the consumer can name the contract back to us. */
	orderReference: string;
	/** What the consumer is owed back, as `withdrawalOutcome` computed it, already formatted. */
	refundLabel: string;
	/** What was retained for the service supplied, already formatted. */
	retainedLabel: string;
	/** `withdrawalOutcome`'s `basis`, computed in {@link locale}. */
	basis: string;
	/**
	 * Whether the owed refund was issued at Stripe (or none was owed). False adds the page's
	 * "we contact you within 14 days" sentence.
	 */
	refundIssued: boolean;
	/** The language of the whole email; `en` unless the order's billing country is BG. */
	locale?: ConsumerLocale;
	consumerRightsUrl?: string;
}

/**
 * The page's contracting-party sentence in the email's language, from the same `LEGAL_ENTITY` fields
 * the page renders, in the same order.
 */
function contractingParty(locale: ConsumerLocale): string {
	if (locale === "bg-BG") {
		return (
			`${LEGAL_ENTITY.legalNameBulgarian}, ${LEGAL_ENTITY.legalFormBulgarian.toLowerCase()}, ` +
			`регистрирано в ${LEGAL_ENTITY.jurisdictionBulgarian} с ЕИК ${LEGAL_ENTITY.registrationNumber}, ` +
			`със седалище и адрес на управление ${LEGAL_ENTITY.registeredAddressBulgarian}.`
		);
	}
	return (
		`${LEGAL_ENTITY.legalName}, ${LEGAL_ENTITY.legalForm.toLowerCase()}, registered in ` +
		`${LEGAL_ENTITY.jurisdiction} under EIK ${LEGAL_ENTITY.registrationNumber}, at ` +
		`${LEGAL_ENTITY.registeredAddress}.`
	);
}

/**
 * The durable acknowledgement of a statutory withdrawal (CRD art. 11a, ЗЗП art. 52a). Its prose is
 * the sealed Consumer rights page's own, in the consumer's language; its figures are the server's
 * recorded split.
 */
export function WithdrawalAcknowledgementEmail({
	withdrawnAtLabel,
	orderReference,
	refundLabel,
	retainedLabel,
	basis,
	refundIssued,
	locale = "en",
	consumerRightsUrl,
}: WithdrawalAcknowledgementEmailProps) {
	const wording = NON_PAGE_WORDING[locale];
	const sentences = PAGE_SENTENCES[locale];
	const support = SUPPORT_SENTENCE[locale];
	const link = CONSUMER_RIGHTS_LINK[locale];
	return (
		<EmailLayout preview={wording.heading} legal={<BillingLegal />}>
			<Text className="a-text-3" style={text.eyebrow}>
				{wording.eyebrow}
			</Text>
			<Heading as="h2" className="a-text" style={text.heading}>
				{wording.heading}
			</Heading>

			<SummaryTable
				rows={[
					{ label: wording.withdrawnAtLabel, value: withdrawnAtLabel },
					{ label: wording.orderLabel, value: orderReference },
					{ label: wording.refundLabel, value: refundLabel, strong: true },
					{ label: wording.retainedLabel, value: retainedLabel },
				]}
			/>

			<Text className="a-text-2" style={text.body}>
				{basis}
			</Text>
			<Text className="a-text-2" style={text.body}>
				{sentences.accessAndRefund}
			</Text>
			{refundIssued ? null : (
				<Text className="a-text-2" style={text.body}>
					{sentences.refundArranged}
				</Text>
			)}
			<Text className="a-text-2" style={text.body}>
				{support.before}{" "}
				<Link href={`mailto:${LEGAL_ENTITY.supportEmail}`}>{LEGAL_ENTITY.supportEmail}</Link>{" "}
				{support.after}
			</Text>
			<Text className="a-text-2" style={text.body}>
				{contractingParty(locale)}
			</Text>
			<Text className="a-text-3" style={text.body}>
				<Link href={consumerRightsUrl ?? link.href}>{link.label}</Link>
			</Text>
		</EmailLayout>
	);
}

WithdrawalAcknowledgementEmail.PreviewProps = {
	withdrawnAtLabel: "24 Aug 2026, 12:00 UTC",
	orderReference: "3f6c1d2e-0000-4000-8000-000000000001",
	refundLabel: "€100.00",
	retainedLabel: "€20.00",
	basis:
		"Immediate performance was requested and the proportional charge acknowledged, so the amount for 5 of 30 day(s) supplied is retained and the rest refunded.",
	refundIssued: true,
	locale: "en",
} satisfies WithdrawalAcknowledgementEmailProps;

export default WithdrawalAcknowledgementEmail;
