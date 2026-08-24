// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	CONSUMER_ADR,
	CONSUMER_PAYMENT_OBLIGATION_LABEL,
	PAID_MARKETS,
	WITHDRAWAL_PERIOD_DAYS,
} from "@repo/legal/commerce";
import { CURRENT_LEGAL_OPERATOR, LEGAL_ENTITY } from "@repo/legal/entity";
import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell } from "@/components/legal/legal-shell";

export const metadata: Metadata = {
	title: "Consumer rights · Alethia",
	description:
		"Your statutory rights when buying Alethia as a consumer: the 14-day withdrawal right, what it costs, and where to take a dispute.",
};

/**
 * Consumer rights for a distance contract, in the words a consumer can act on.
 *
 * DERIVED, not restated. The withdrawal period, the payment-obligation wording, the dispute bodies
 * and whether we can sell to consumers at all all come from `@repo/legal/commerce` — the same module
 * the server-side gate and the withdrawal accounting read. A page that retyped them would be the
 * copy that drifts, and it would drift in the direction of whatever was easiest to write.
 */
export default function ConsumerRightsPage() {
	const sellsToConsumers = PAID_MARKETS.some((c) => c.capacity === "consumer");

	return (
		<LegalShell title="Consumer rights" lastUpdated="August 24, 2026">
			<p>
				This page is for people buying Alethia as an individual, outside a trade,
				business or profession. If you are buying on behalf of a company, these
				statutory rights do not apply to you — your{" "}
				<Link href="/terms">Terms of Service</Link> govern instead. We ask which
				you are at the point of purchase and never guess, because the answer
				changes which law applies.
			</p>

			{!sellsToConsumers && (
				<>
					<h2>We are not currently selling to consumers</h2>
					<p>
						{CURRENT_LEGAL_OPERATOR} is not yet registered for VAT, so we do not
						currently take payment from individuals in any country. Community
						remains free and
						unlimited in time, and the Pro trial requires no card. This page
						describes the rights that will apply when consumer sales open, and
						it is published now so those rights are on the record before any
						money changes hands rather than after.
					</p>
				</>
			)}

			<h2>Before you order</h2>
			<p>
				We show the total price you will pay, including any tax, before you
				order — not a price that grows at the last step. We tell you whether the
				subscription renews, when, and how to stop it. The button that places the
				order says “{CONSUMER_PAYMENT_OBLIGATION_LABEL}”, because an order that
				costs money should say so on the button and not in a paragraph above it.
			</p>
			<p>
				After you order we send you a confirmation you can keep, containing what
				you bought, what you paid, and these rights.
			</p>

			<h2>Your {WITHDRAWAL_PERIOD_DAYS}-day right to withdraw</h2>
			<p>
				You may withdraw from the contract within {WITHDRAWAL_PERIOD_DAYS} days
				of placing your order, for any reason, and you do not have to tell us
				why. You can do it from the billing settings in the console, or by
				emailing{" "}
				<a href={`mailto:${LEGAL_ENTITY.contactEmail}`}>
					{LEGAL_ENTITY.contactEmail}
				</a>
				. We show you what you will get back <em>before</em> you confirm.
			</p>

			<h3>What withdrawing costs you</h3>
			<p>
				That depends on one choice you make when you order — whether the service
				should start straight away, or wait until the {WITHDRAWAL_PERIOD_DAYS}{" "}
				days are up.
			</p>
			<ul>
				<li>
					<strong>If you asked us to wait</strong>, nothing was supplied, and you
					get the whole amount back.
				</li>
				<li>
					<strong>If you asked us to start straight away</strong> and confirmed
					you understood the consequence, you pay for the part you actually used
					— worked out day by day against the period you paid for — and we refund
					the rest. Any fraction of a cent goes to you, not to us.
				</li>
				<li>
					<strong>If you asked us to start straight away but were never asked to
					confirm that consequence</strong>, you owe nothing at all, even though
					the service ran. That is the law’s sanction on us for not asking
					properly, and we apply it to ourselves rather than making you argue
					for it.
				</li>
			</ul>
			<p>
				Withdrawing ends your access immediately, and we refund you using the
				same payment method you paid with, without a fee.
			</p>

			<h2>Cancelling is a different thing</h2>
			<p>
				After the {WITHDRAWAL_PERIOD_DAYS} days, you can still cancel at any
				time. Cancelling stops the next renewal and your access continues to the
				end of the period you have already paid for — you keep what you paid for,
				and there is no refund for the unused part. We do not offer discretionary
				refunds, because a refund that depends on who asks is not a right.
			</p>

			<h2>If something goes wrong</h2>
			<p>
				Write to us first at{" "}
				<a href={`mailto:${LEGAL_ENTITY.supportEmail}`}>
					{LEGAL_ENTITY.supportEmail}
				</a>{" "}
				— most things are faster to fix than to escalate. If that does not
				resolve it, you can take the matter to:
			</p>
			<ul>
				{CONSUMER_ADR.map((body) => (
					<li key={body.url}>
						<a href={body.url} rel="noopener noreferrer" target="_blank">
							{body.name}
						</a>{" "}
						({body.localName}) — {body.role}
					</li>
				))}
			</ul>
			<p>
				We are not obliged to use, and do not commit to, any particular
				alternative dispute resolution body; the ones above are named so you know
				where to go. The European Commission’s online dispute resolution platform
				is not listed because it was shut down in July 2025 — you may still see it
				cited on other traders’ sites.
			</p>

			<h2>Who you are contracting with</h2>
			<p>
				{LEGAL_ENTITY.legalName}, {LEGAL_ENTITY.legalForm.toLowerCase()},
				registered in {LEGAL_ENTITY.jurisdiction} under EIK{" "}
				{LEGAL_ENTITY.registrationNumber}, at {LEGAL_ENTITY.registeredAddress}.
				Full details are on the <Link href="/imprint">company information</Link>{" "}
				page.
			</p>
		</LegalShell>
	);
}
