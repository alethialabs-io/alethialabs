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
	// publicProcessingParties() returns active parties AND the conditional customer-directed ones.
	// They MUST NOT render under one heading: "we send your data to this provider" and "we would
	// send your data to a provider of this kind if you connected one" are different statements, and
	// collapsing them makes the register read as a list of relationships Alethia does not have.
	const published = publicProcessingParties();
	const parties = published.filter((party) => party.status === "active");
	const conditional = published.filter(
		(party) => party.status === "customer-directed",
	);

	return (
		<LegalShell title="Subprocessors" lastUpdated="August 12, 2026">
			<p>
				These providers may process personal data for the hosted Alethia
				Service. <strong>Current providers</strong> process data for the hosted
				Service today. <strong>Customer-directed providers</strong> receive data
				only if you connect them, at your direction, and may act as independent
				controllers rather than Alethia subprocessors. Actual use also depends on
				the feature, the plan, and your privacy choices.
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
				These are conditional. Nothing below receives data unless you connect it
				yourself, and then only for the feature you request. They are listed as{" "}
				<em>categories</em> rather than company names on purpose: Alethia has no
				agreement with, and no knowledge of, which particular provider you
				choose, so naming one here would assert a relationship that does not
				exist. Depending on the service and your contract, the provider you
				choose may act as your processor or as an independent controller.
			</p>
			{conditional.map((party) => (
				<section key={party.id}>
					<h3>
						{party.name} · {party.region}
					</h3>
					<p>Applies only if you connect one.</p>
					<ul>
						{party.purposes.map((purpose) => (
							<li key={purpose.name}>
								{purpose.name}. Legal basis:{" "}
								{purpose.lawfulBasis.replace("-", " ")}.
							</li>
						))}
					</ul>
				</section>
			))}

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
