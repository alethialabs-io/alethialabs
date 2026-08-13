// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { LEGAL_ENTITY } from "@repo/legal/entity";
import type { Metadata } from "next";
import { LegalShell } from "@/components/legal/legal-shell";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
	title: "Company information · Alethia",
	description: "Registered company and contact information for Alethia Labs.",
};

/** Publishes the registered operator details required for the hosted service. */
export default function ImprintPage() {
	const publicPhone = process.env[LEGAL_ENTITY.publicPhoneEnvironmentVariable];

	return (
		<LegalShell title="Company information" lastUpdated="August 12, 2026">
			<h2>Service operator</h2>
			<p>
				<strong>{LEGAL_ENTITY.legalName}</strong> (
				{LEGAL_ENTITY.legalNameBulgarian})
				<br />
				{LEGAL_ENTITY.legalForm} ({LEGAL_ENTITY.legalFormBulgarian})
				<br />
				Bulgarian Unified Identification Code (EIK):{" "}
				{LEGAL_ENTITY.registrationNumber}
				<br />
				VAT registration: not registered
				<br />
				Manager: {LEGAL_ENTITY.manager} ({LEGAL_ENTITY.managerBulgarian})
			</p>

			<h2>Registered office and contact</h2>
			<p>
				{LEGAL_ENTITY.registeredAddress}
				<br />
				{LEGAL_ENTITY.registeredAddressBulgarian}
				<br />
				Email:{" "}
				<a href={`mailto:${LEGAL_ENTITY.contactEmail}`}>
					{LEGAL_ENTITY.contactEmail}
				</a>
				{publicPhone ? (
					<>
						<br />
						Phone: <a href={`tel:${publicPhone}`}>{publicPhone}</a>
					</>
				) : null}
			</p>

			<p>
				Self-hosted deployments are operated by the person or organization that
				deploys them; that operator is responsible for its own company and
				privacy information.
			</p>
		</LegalShell>
	);
}
