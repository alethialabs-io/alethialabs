// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { LEGAL_ENTITY } from "@repo/brand/legal";
import type { Metadata } from "next";
import { LegalShell } from "@/components/legal/legal-shell";

export const metadata: Metadata = {
	title: "Privacy requests · Alethia",
	description: "Exercise a privacy right or ask Alethia a data-protection question.",
};

/** Safe intake instructions for privacy rights without collecting identity documents in a web form. */
export default function PrivacyRequestsPage() {
	const subject = encodeURIComponent("Privacy request");
	const body = encodeURIComponent(
		"Request type:\nAlethia account email:\nOrganization (if applicable):\nCountry of residence:\nDetails:\n",
	);

	return (
		<LegalShell title="Privacy requests" lastUpdated="July 29, 2026">
			<p>
				Use this channel to request access, correction, deletion, restriction,
				portability, or objection; withdraw consent; or ask a privacy question. You
				can change analytics and replay consent immediately with the{" "}
				<strong>Privacy settings</strong> control in the site footer.
			</p>

			<h2>1. Send the request</h2>
			<p>
				Email{" "}
				<a href={`mailto:privacy@alethialabs.io?subject=${subject}&body=${body}`}>
					privacy@alethialabs.io
				</a>{" "}
				from the address associated with your Alethia account. State the right you
				want to exercise, your organization if relevant, country of residence, and
				enough detail to locate the data. Do not email passwords, API keys, cloud
				credentials, government identity documents, or payment-card data.
			</p>

			<h2>2. Verification</h2>
			<p>
				We normally verify through the signed-in account or a one-time message to the
				account email. If the request is made by an authorized agent, we may ask for
				proof of authority and separately verify the account holder. We ask only for
				information proportionate to the risk of disclosing or deleting data.
			</p>

			<h2>3. Timing and outcome</h2>
			<p>
				We acknowledge requests promptly and normally respond within one month under
				the GDPR. A complex or numerous request may take up to two additional months;
				if so, we will explain the extension within the first month. Requests are
				generally free, but manifestly unfounded or excessive requests may be refused
				or charged as permitted by law.
			</p>
			<p>
				We will explain any data we cannot change or delete because of another
				person’s rights, security, legal claims, tax or accounting duties, or another
				lawful exemption. You may complain to the{" "}
				<a href={LEGAL_ENTITY.dpa.url}>{LEGAL_ENTITY.dpa.name}</a> or your local
				supervisory authority.
			</p>

			<h2>4. Business-customer data</h2>
			<p>
				If your organization controls the data, contact its administrator first.
				When Alethia is the organization’s processor, we will refer the request to
				the organization and assist it under the Data Processing Addendum.
			</p>
		</LegalShell>
	);
}
