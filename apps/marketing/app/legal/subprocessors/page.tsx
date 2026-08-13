// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { publicProcessingParties } from "@repo/legal/processing";
import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell } from "@/components/legal/legal-shell";

export const metadata: Metadata = {
	title: "Subprocessors · Alethia",
	description: "Providers that may process personal data for Alethia.",
};

/** Current hosted-service subprocessor register and processing locations. */
export default function SubprocessorsPage() {
	const parties = publicProcessingParties();

	return (
		<LegalShell title="Subprocessors" lastUpdated="August 12, 2026">
			<p>
				These providers may process personal data for the hosted Alethia
				Service. Actual use depends on the feature, plan, connected provider,
				and privacy choices. Customer-controlled cloud and identity providers
				receive data at the customer’s direction and may act as independent
				controllers rather than Alethia subprocessors.
			</p>

			<h2>Current providers</h2>
			{parties.map((party) => (
				<section key={party.id}>
					<h3>
						{party.name} · {party.region}
					</h3>
					<p>
						Role:{" "}
						{party.role === "subprocessor"
							? "subprocessor"
							: "independent controller"}
						.
					</p>
					<ul>
						{party.purposes.map((purpose) => (
							<li key={purpose.name}>
								{purpose.name}. Legal basis:{" "}
								{purpose.lawfulBasis.replace("-", " ")}
								{purpose.consentRequired
									? "; used only after the relevant consent"
									: ""}
								.
							</li>
						))}
					</ul>
				</section>
			))}

			<h2>Customer-directed providers</h2>
			<p>
				If you connect a cloud, source-control, identity, payment, or AI
				provider, data is sent to that provider only for the feature you
				request. Depending on the service and contract, that provider may act as
				your processor or as an independent controller. We do not list an
				integration here merely because the software supports it.
			</p>

			<h2>Changes</h2>
			<p>
				Material additions are posted here before processing begins where
				practicable. DPA customers may object as described in the{" "}
				<Link href="/legal/dpa">Data Processing Addendum</Link>. Send questions
				or a request for change notices to{" "}
				<a href="mailto:privacy@alethialabs.io">privacy@alethialabs.io</a>.
			</p>
		</LegalShell>
	);
}
