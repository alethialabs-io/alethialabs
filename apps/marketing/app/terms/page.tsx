// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { CURRENT_LEGAL_OPERATOR, LEGAL_ENTITY } from "@repo/legal/entity";
import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell } from "@/components/legal/legal-shell";

export const metadata: Metadata = {
	title: "Terms of Service · Alethia",
	description: "Terms governing use of Alethia's hosted service.",
};

/** Public hosted-service terms, distinct from the software licences. */
export default function TermsPage() {
	return (
		<LegalShell title="Terms of Service" lastUpdated="August 12, 2026">
			<p>
				These Terms govern the hosted Alethia control plane, websites, support,
				and related services (the “Service”) provided by{" "}
				<strong>{CURRENT_LEGAL_OPERATOR}</strong>, a{" "}
				{LEGAL_ENTITY.legalForm.toLowerCase()}
				registered in Bulgaria under EIK {LEGAL_ENTITY.registrationNumber}, at{" "}
				{LEGAL_ENTITY.registeredAddress}. The company is not registered for VAT.
				By creating an account, placing an order, or using the Service, you
				agree to these Terms.
			</p>

			<h2>1. Eligibility and accounts</h2>
			<p>
				You must have legal capacity to contract and be at least 18. If you use
				the Service for an organization, you represent that you can bind it.
				Keep your sign-in account secure, provide accurate information, and
				promptly report unauthorized use.
			</p>

			<h2>2. The Service and your cloud accounts</h2>
			<p>
				Alethia configures and operates infrastructure in accounts you
				authorize. You control those accounts and are responsible for
				permissions, approvals, workloads, lawful use, backups, and all charges
				billed by cloud or other providers. Estimates and generated plans are
				informational; review a plan before applying it. Alethia uses
				short-lived federation and does not store static cloud access keys.
			</p>

			<h2>3. Your content</h2>
			<p>
				You retain rights in configurations, code, data, and instructions you
				submit. You grant us a non-exclusive, worldwide licence to host, copy,
				transmit, and process that content only as needed to provide, secure,
				and support the Service. You represent that you have the necessary
				rights and will not submit unlawful material or secrets where they are
				not requested.
			</p>

			<h2>4. Acceptable use</h2>
			<p>
				You must comply with our{" "}
				<Link href="/acceptable-use">Acceptable Use Policy</Link>. We may
				investigate abuse and suspend access where reasonably necessary to
				protect the Service, other customers, or third parties.
			</p>

			<h2>5. Plans, billing, and taxes</h2>
			<p>
				The public Service does not currently accept paid subscriptions. Paid
				conversion is enabled per country and per payer capacity, and only where
				the tax, payment, contractual, and consumer-rights conditions for that
				combination are in place; where it is not enabled, no order can be
				placed. Before any order, we show the total price payable including tax,
				the billing period, whether the subscription renews, and how to end it.
			</p>
			<p>
				Ordinary cancellation stops the next renewal and access continues to the
				end of the period already paid for; there is no refund for the unused
				part and we do not offer discretionary refunds. If you are a consumer,
				this is separate from — and does not replace — your statutory right to
				withdraw, described in section 13 and on the{" "}
				<Link href="/consumer-rights">Consumer rights</Link> page.
			</p>

			<h2>6. Open-source and enterprise software</h2>
			<p>
				The community core is licensed under <strong>GNU AGPL v3.0 only</strong>
				. Enterprise modules are subject to the commercial licence in the source
				repository or your order. Software licence terms govern copying,
				modification, and distribution; these Terms govern the hosted Service.
				See <Link href="/legal/source">Source and licences</Link>.
			</p>

			<h2>7. Data protection</h2>
			<p>
				Our <Link href="/privacy">Privacy Policy</Link> explains controller
				processing. If we process personal data on behalf of a business
				customer, the <Link href="/legal/dpa">Data Processing Addendum</Link>{" "}
				applies and is incorporated into these Terms.
			</p>

			<h2>8. Service changes and availability</h2>
			<p>
				We may improve or change the Service and may discontinue a material
				feature on reasonable notice when practicable. No service-level
				commitment applies unless stated in a signed order. We may perform
				maintenance and may suspend the Service for security, legal,
				non-payment, or operational reasons.
			</p>

			<h2>9. Confidentiality</h2>
			<p>
				Each party will protect non-public information identified as
				confidential or that should reasonably be understood to be confidential,
				use it only for the agreement, and disclose it only to personnel and
				providers who need it and are bound to protect it. This does not cover
				information lawfully public, already known without restriction,
				independently developed, or rightfully received from another source.
			</p>

			<h2>10. Warranties and disclaimers</h2>
			<p>
				We will provide the Service with reasonable care and skill. Except for
				that commitment and rights that cannot legally be excluded, the Service
				is provided “as is” and “as available.” We disclaim implied warranties
				of merchantability, fitness for a particular purpose, non-infringement,
				and uninterrupted or error-free operation to the maximum extent
				permitted by law.
			</p>

			<h2>11. Liability</h2>
			<p>
				Neither party is liable for indirect, incidental, special, exemplary,
				punitive, or consequential loss, or lost profit, revenue, goodwill, or
				data, to the extent permitted by law. Each party’s total aggregate
				liability arising from the Service is limited to the greater of EUR 100
				and the fees paid or payable for the Service in the 12 months before the
				event giving rise to liability. These exclusions do not apply to fraud,
				wilful misconduct, death or personal injury caused by negligence, breach
				of confidentiality, your payment obligations, or liability that law does
				not permit us to limit.
			</p>

			<h2>12. Term and termination</h2>
			<p>
				You may stop using the Service and request account closure at any time.
				We may terminate for material breach if it is not cured within 15 days
				after notice, or immediately for serious abuse, illegality, insolvency,
				or an urgent security risk. On termination, access ends and outstanding
				fees remain due. You should export content before termination. We will
				delete or return personal data as described in the DPA and Privacy
				Policy.
			</p>

			<h2>13. Law, disputes, and consumers</h2>
			<p>
				Bulgarian law governs these Terms, excluding conflict rules. The
				competent courts in Sofia, Bulgaria have exclusive jurisdiction, except
				where mandatory consumer law gives you another venue or right. Nothing
				in these Terms limits mandatory rights available to consumers.
			</p>
			<p>
				If you order as a consumer, you have a statutory right to withdraw from
				the contract within 14 days without giving a reason. If you ask us to
				begin the service during those 14 days and confirm that you understand
				the consequence, you pay only for the part supplied before you withdraw;
				if we did not ask you to confirm it, you owe nothing. Full details,
				including how to withdraw and where to take a dispute, are on the{" "}
				<Link href="/consumer-rights">Consumer rights</Link> page. We do not
				commit to any particular alternative dispute resolution body.
			</p>

			<h2>14. General</h2>
			<p>
				Neither party may assign the agreement without the other’s consent,
				except to an affiliate or in connection with a merger, reorganization,
				or sale of substantially all relevant assets. Neither party is liable
				for delay caused by events outside reasonable control. If a provision is
				unenforceable, the remaining provisions continue. Failure to enforce is
				not a waiver. These Terms, the AUP, DPA, order, and referenced policies
				form the entire agreement.
			</p>

			<h2>15. Contact and changes</h2>
			<p>
				Contact <a href="mailto:legal@alethialabs.io">legal@alethialabs.io</a>.
				We may update these Terms. Material changes apply prospectively after
				reasonable notice; continued use after the effective date constitutes
				acceptance where permitted by law.
			</p>
		</LegalShell>
	);
}
