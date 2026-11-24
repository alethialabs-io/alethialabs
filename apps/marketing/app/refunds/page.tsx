// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { PAID_MARKETS, WITHDRAWAL_PERIOD_DAYS } from "@repo/legal/commerce";
import { CURRENT_LEGAL_OPERATOR, LEGAL_ENTITY } from "@repo/legal/entity";
import { PAID_AI_PLANS, planMeta } from "@repo/plan-catalog";
import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell } from "@/components/legal/legal-shell";

export const metadata: Metadata = {
	title: "Refund policy",
	description:
		"When Alethia refunds a payment, how to ask for one, and who processes it.",
};

/**
 * The money-back window this policy promises, in days.
 *
 * A COMMERCIAL promise, deliberately not `WITHDRAWAL_PERIOD_DAYS`: that constant is the statutory
 * consumer withdrawal period and feeds the withdrawal accounting. The two happen to be equal today;
 * reusing one for the other would let a change to either silently rewrite the other.
 */
const MONEY_BACK_DAYS = 14;

/** Where Paddle's buyers get help with an order Paddle processed. */
const PADDLE_BUYER_SUPPORT_URL = "https://paddle.net";

/** Joins names as "A, B and C". */
function listOf(names: readonly string[]): string {
	if (names.length <= 1) return names.join("");
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The public refund policy: what is refunded, how to ask, and who processes the refund.
 *
 * DERIVED where a value already has a home. The plan names come from `@repo/plan-catalog`, the
 * support address and operator from `@repo/legal/entity`, and whether anything is on sale at all
 * from `PAID_MARKETS` — the same gate the checkout reads — so the page is true before launch and
 * stays true after it without an edit.
 */
export default function RefundPolicyPage() {
	const onSale = PAID_MARKETS.length > 0;
	const subscriptionPlans = listOf([
		planMeta("team").name,
		...PAID_AI_PLANS.map((plan) => plan.name),
	]);
	const support = (
		<a href={`mailto:${LEGAL_ENTITY.supportEmail}`}>{LEGAL_ENTITY.supportEmail}</a>
	);

	return (
		<LegalShell title="Refund policy" lastUpdated="November 24, 2026">
			<p>
				This policy explains when we refund a payment for Alethia, how to ask
				for a refund, and how the money gets back to you. It is written to be
				read once and acted on, so each kind of purchase has its own section.
			</p>

			{!onSale && (
				<>
					<h2>Paid plans are not yet on sale</h2>
					<p>
						{CURRENT_LEGAL_OPERATOR} has not yet opened paid plans in any
						country, so we do not currently take payment and there is nothing to
						refund. Community remains free, and the Pro trial requires no card.
						This policy is published now so the terms are on the record before
						any money changes hands, and it applies from the first paid order.
					</p>
				</>
			)}

			<h2>What this policy covers</h2>
			<p>It covers every purchase of a paid Alethia plan:</p>
			<ul>
				<li>subscriptions to {subscriptionPlans}, billed monthly or annually;</li>
				<li>
					metered runner minutes used beyond the amount your plan includes; and
				</li>
				<li>prepaid credit packs.</li>
			</ul>

			<h2>Who processes your payment</h2>
			<p>
				Card purchases are sold through Paddle.com, which acts as our reseller
				and Merchant of Record. Paddle takes the payment, issues your invoice or
				receipt, and processes any refund. Paddle’s checkout buyer terms also
				apply to card purchases, alongside this policy.
			</p>
			<p>
				Enterprise contracts paid by bank transfer are governed by their order
				form or contract, which sets out its own refund terms.
			</p>

			<h2>{MONEY_BACK_DAYS}-day money-back</h2>
			<p>
				If Alethia is not right for you, ask within {MONEY_BACK_DAYS} days of
				your first payment for a subscription and we refund it in full. The same
				applies within {MONEY_BACK_DAYS} days of an annual renewal. You do not
				have to give a reason.
			</p>

			<h2>Monthly renewals</h2>
			<p>
				Monthly renewals are not refunded. You can cancel at any time from the
				billing settings in the console. Your plan then stays active until the
				end of the period you have already paid for, and you are not charged
				again.
			</p>

			<h2>Prepaid credit packs</h2>
			<p>
				A credit pack is refundable within {MONEY_BACK_DAYS} days of purchase if
				none of it has been used. A pack that has been partly used is not
				refunded.
			</p>

			<h2>Usage and overage charges</h2>
			<p>
				Charges for runner minutes beyond the amount your plan includes pay for
				work that has already run, so they are not refundable — except where the
				charge is a billing error, which we always correct.
			</p>

			<h2>Billing errors and duplicate charges</h2>
			<p>
				If you were charged the wrong amount, charged twice, or charged for
				something you did not order, we refund the incorrect charge in full,
				whenever you tell us.
			</p>

			<h2>How to ask for a refund</h2>
			<p>
				Write to us at {support} with the email address on your account and,
				if you have it, the order or receipt number. You can also contact
				Paddle’s buyer support at{" "}
				<a href={PADDLE_BUYER_SUPPORT_URL} rel="noopener noreferrer" target="_blank">
					paddle.net
				</a>
				, which handles orders Paddle processed.
			</p>

			<h2>How you get your money back</h2>
			<p>
				Refunds go back to the payment method you paid with. How long they take
				to appear depends on your card issuer or bank — typically 5 to 10
				business days after the refund is issued.
			</p>

			<h2>If you are a consumer</h2>
			<p>
				If you buy as an individual in the EU or the UK, nothing in this policy
				limits your statutory rights. In particular, you have a{" "}
				{WITHDRAWAL_PERIOD_DAYS}-day right to withdraw from the contract, and
				what withdrawing costs you if you asked the service to start straight
				away is set out on the <Link href="/consumer-rights">Consumer rights</Link>{" "}
				page.
			</p>
		</LegalShell>
	);
}
