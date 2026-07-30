// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { CURRENT_LEGAL_OPERATOR, LEGAL_ENTITY } from "@repo/brand/legal";
import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell } from "@/components/legal/legal-shell";

export const metadata: Metadata = {
	title: "Data Processing Addendum · Alethia",
	description: "Alethia's GDPR data-processing terms for business customers.",
};

/** Self-serve Article 28 data-processing terms for business customers. */
export default function DpaPage() {
	return (
		<LegalShell title="Data Processing Addendum" lastUpdated="July 29, 2026">
			<p>
				This Data Processing Addendum (“DPA”) forms part of the agreement between the
				business customer using the hosted Alethia Service (“Customer”) and{" "}
				<strong>{CURRENT_LEGAL_OPERATOR}</strong>, at{" "}
				{LEGAL_ENTITY.registeredAddress} (“Alethia”). It applies when Alethia
				processes personal data on Customer’s behalf. It is effective when Customer
				accepts the <Link href="/terms">Terms</Link>, signs an order referencing it,
				or otherwise agrees to this DPA.
			</p>

			<h2>1. Roles and instructions</h2>
			<p>
				Customer is the controller and Alethia is the processor, except where
				Customer is itself a processor, in which case Alethia is a subprocessor.
				Alethia will process Customer Personal Data only on documented instructions
				in the agreement, Customer’s configuration and use of the Service, and
				written support requests, unless EU or Member State law requires otherwise.
				We will notify Customer if an instruction appears to infringe applicable data
				protection law.
			</p>

			<h2>2. Processing details</h2>
			<ul>
				<li>
					<strong>Subject:</strong> hosting and operating infrastructure control,
					provisioning, observability, support, and related account services.
				</li>
				<li>
					<strong>Duration:</strong> the agreement plus the deletion and backup
					rotation periods described below.
				</li>
				<li>
					<strong>People:</strong> Customer users, personnel, contractors, end
					users, and other people whose data Customer submits.
				</li>
				<li>
					<strong>Data:</strong> identifiers, contact and account details,
					infrastructure configuration, repository metadata, logs, audit data,
					support content, and any personal data contained in Customer content.
				</li>
				<li>
					<strong>Operations:</strong> collection, recording, organization,
					storage, retrieval, consultation, transmission, restriction, deletion,
					and other processing needed to provide the Service.
				</li>
			</ul>
			<p>
				The Service is not designed for special-category data, criminal-conviction
				data, payment-card data, or government identifiers. Customer must not submit
				such data unless Alethia has agreed in writing to appropriate additional
				safeguards.
			</p>

			<h2>3. Confidentiality and security</h2>
			<p>
				Alethia ensures that people authorized to process Customer Personal Data are
				bound by confidentiality and receive access only as needed. Measures include
				encrypted transport and storage, short-lived cloud federation, encrypted
				integration tokens, tenant-scoped authorization and Row Level Security,
				least-privilege administration, audit records, vulnerability management,
				secret scrubbing, backups, recovery procedures, and bounded retention.
			</p>

			<h2>4. Subprocessors</h2>
			<p>
				Customer gives general authorization for the providers listed on the{" "}
				<Link href="/legal/subprocessors">Subprocessors page</Link>. Alethia will
				impose materially equivalent data-protection duties on each subprocessor and
				remains responsible for its performance. We will post a new subprocessor at
				least 14 days before it begins processing Customer Personal Data where
				practicable. Customer may object on reasonable data-protection grounds
				during that period. We will work in good faith on an alternative; if none is
				reasonably available, either party may terminate the affected Service.
			</p>

			<h2>5. International transfers</h2>
			<p>
				Processing is primarily in Germany. For a restricted transfer from the EEA
				to a country without an adequacy decision, the 2021 EU Standard Contractual
				Clauses are incorporated by reference: Module Two applies where Customer is
				controller, Module Three where Customer is processor; the optional docking
				clause applies; the competent supervisory authority and governing law are
				Bulgarian; disputes are heard in Bulgaria; Annex I is completed by this DPA,
				the agreement, and the parties’ contact details; Annex II is section 3; and
				Annex III is the Subprocessors page.
			</p>

			<h2>6. Assistance and incidents</h2>
			<p>
				Taking into account the nature of processing and information available,
				Alethia will reasonably assist Customer with data-subject requests,
				security, breach notifications, impact assessments, and supervisory
				consultations. We will notify Customer without undue delay after confirming
				a Personal Data Breach affecting Customer Personal Data and provide
				available information about its nature, likely consequences, affected data,
				and remediation. Notification is not an admission of fault.
			</p>

			<h2>7. Return and deletion</h2>
			<p>
				During the subscription, Customer can access or export data through available
				Service functions. On termination and written request, Alethia will return or
				delete Customer Personal Data unless law requires retention. Residual copies
				in encrypted backups remain protected, are not used for other purposes, and
				are deleted on the normal rotation; restored data is re-subjected to the
				deletion instruction.
			</p>

			<h2>8. Information and audits</h2>
			<p>
				Alethia will provide information reasonably necessary to demonstrate Article
				28 compliance. Customer should first use current security documentation and
				questionnaires. No more than once annually, unless required after a
				confirmed incident or by an authority, Customer may request a remote audit
				on reasonable notice. Audits must protect other customers, security, and
				confidentiality and be conducted during business hours at Customer’s cost.
			</p>

			<h2>9. Priority, liability, and contact</h2>
			<p>
				This DPA controls over conflicting data-processing terms; the Standard
				Contractual Clauses control over this DPA. Liability is subject to the
				agreement’s limitations to the extent legally permitted. Contact{" "}
				<a href="mailto:privacy@alethialabs.io">privacy@alethialabs.io</a> for
				privacy matters and{" "}
				<a href="mailto:security@alethialabs.io">security@alethialabs.io</a> for
				security incidents.
			</p>
		</LegalShell>
	);
}
