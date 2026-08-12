// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { CURRENT_LEGAL_OPERATOR, LEGAL_ENTITY } from "@repo/brand/legal";
import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell } from "@/components/legal/legal-shell";

export const metadata: Metadata = {
	title: "Privacy Policy · Alethia",
	description:
		"How Alethia collects, uses, shares, and protects personal data.",
};

/** Public GDPR privacy notice for Alethia's website and hosted service. */
export default function PrivacyPage() {
	return (
		<LegalShell title="Privacy Policy" lastUpdated="August 12, 2026">
			<p>
				This notice explains how <strong>{CURRENT_LEGAL_OPERATOR}</strong>, at{" "}
				{LEGAL_ENTITY.registeredAddress} (“Alethia Labs”, “we”, “us”), processes
				personal data for alethialabs.io, the hosted Alethia control plane, the
				alethia CLI, and support services (the “Service”). We are the controller
				for account, website, billing, security, and support data. When Alethia
				processes infrastructure data solely on a business customer’s
				instructions, that customer is the controller and we are its processor
				under our <Link href="/legal/dpa">Data Processing Addendum</Link>.
			</p>
			<p>
				{CURRENT_LEGAL_OPERATOR} is registered in Bulgaria under EIK{" "}
				{LEGAL_ENTITY.registrationNumber} and is the controller and contracting
				operator for the Service.
			</p>

			<h2>1. Data we process</h2>
			<h3>Account and organization data</h3>
			<p>
				Email address, name, avatar, provider identifier, authentication events,
				organization membership, role, and account preferences. Social sign-in
				may come from GitHub, GitLab, Bitbucket, or Google. Email sign-in uses a
				one-time code.
			</p>
			<h3>Infrastructure and service data</h3>
			<p>
				Project configuration, repositories and commit references, provisioning
				jobs, infrastructure plans, state, evidence receipts, audit events,
				operational logs, support conversations, and the metadata needed to
				manage your environments. Customer-supplied content can contain personal
				data, so you should submit only what is needed.
			</p>
			<h3>Credentials and connected services</h3>
			<p>
				Git-provider OAuth tokens are encrypted at rest. Cloud connections
				retain only federation configuration such as role, tenant, project,
				audience, and issuer identifiers.{" "}
				<strong>Alethia does not store static cloud access keys.</strong> Cloud
				access uses short-lived, federated credentials. Payment-card details are
				collected by Stripe and are not stored by Alethia.
			</p>
			<h3>Device, security, and optional telemetry data</h3>
			<p>
				We process IP address, user agent, request timing, security events, and
				diagnostic logs needed to deliver and protect the Service. Product
				analytics and masked session replay are optional, disabled by default,
				and controlled separately through <strong>Privacy settings</strong>.
				Analytics uses internal account and organization identifiers rather than
				names or email addresses. Prompts and model outputs are not sent to
				product analytics.
			</p>

			<h2>2. Purposes and legal bases</h2>
			<ul>
				<li>
					<strong>Contract:</strong> create accounts, authenticate users,
					provide the Service, execute requested deployments, provide support,
					and bill paid plans.
				</li>
				<li>
					<strong>Legitimate interests:</strong> secure the Service, prevent
					abuse, maintain reliability, investigate failures, and keep
					proportionate business and audit records.
				</li>
				<li>
					<strong>Legal obligation:</strong> tax, accounting, fraud prevention,
					lawful requests, and protection of legal rights.
				</li>
				<li>
					<strong>Consent:</strong> optional product analytics, optional session
					replay, and any marketing communication that requires consent. Consent
					can be withdrawn at any time through Privacy settings.
				</li>
			</ul>

			<h2>3. Where data is processed</h2>
			<p>
				The primary hosted control plane, PostgreSQL database, and S3-compatible
				object storage run in Hetzner’s <code>fsn1</code> location in Germany.
				Cloudflare processes edge-network and security data. Transactional email
				is delivered through Amazon SES. Other providers are listed on our{" "}
				<Link href="/legal/subprocessors">Subprocessors page</Link>.
			</p>

			<h2>4. Sharing and international transfers</h2>
			<p>
				We disclose data only to service providers needed to run the Service, to
				connected providers at your direction, during a lawful corporate
				transaction, to protect rights or safety, or when legally required. Some
				providers may process data outside the EEA. Where required, transfers
				rely on an adequacy decision, the European Commission’s Standard
				Contractual Clauses, and supplementary technical and organizational
				measures.
			</p>

			<h2>5. Retention</h2>
			<ul>
				<li>
					Account, organization, project, and billing records: while the account
					is active, then deleted or anonymized after closure unless law or a
					dispute requires longer retention.
				</li>
				<li>Provisioning job logs: 30 days by default.</li>
				<li>Fleet-action records: 90 days by default.</li>
				<li>Authorization activity records: 365 days by default.</li>
				<li>
					Removed cloud inventory and capability observations: 7 days by
					default.
				</li>
				<li>
					Support and contractual correspondence: up to 3 years after the matter
					closes; invoices and tax records: the period required by Bulgarian
					law.
				</li>
				<li>
					Optional telemetry: according to the provider retention configured by
					Alethia, never longer than 12 months for product analytics or 30 days
					for session replay.
				</li>
			</ul>
			<p>
				Self-hosted operators choose their own retention periods and are
				responsible for their own privacy notices. Deletion from encrypted
				backups may occur on the backup rotation rather than immediately;
				restored data is re-subjected to the deletion request.
			</p>

			<h2>6. Security</h2>
			<p>
				We use encryption in transit and at rest, encrypted integration tokens,
				short-lived cloud credentials, tenant-scoped authorization, Row Level
				Security, least-privilege access, audit records, secret scrubbing, and
				bounded retention. No system is completely secure. Report suspected
				vulnerabilities to{" "}
				<a href="mailto:security@alethialabs.io">security@alethialabs.io</a>.
			</p>

			<h2>7. Your rights</h2>
			<p>
				Depending on applicable law, you may request access, correction,
				deletion, restriction, portability, or objection; withdraw consent; and
				complain to a supervisory authority. We may need to verify identity and
				may retain data where an exemption or legal duty applies. Start a
				request at <Link href="/privacy/requests">Privacy requests</Link>.
			</p>
			<p>
				In Bulgaria, the supervisory authority is the{" "}
				<a href={LEGAL_ENTITY.dpa.url}>
					{LEGAL_ENTITY.dpa.name} ({LEGAL_ENTITY.dpa.localName})
				</a>
				. You may also contact the authority where you live or work.
			</p>

			<h2>8. Automated decisions and children</h2>
			<p>
				We do not make decisions producing legal or similarly significant
				effects solely by automated means. The Service is for business and
				professional use and is not directed to children under 16.
			</p>

			<h2>9. Contact and changes</h2>
			<p>
				Privacy questions may be sent to{" "}
				<a href="mailto:privacy@alethialabs.io">privacy@alethialabs.io</a> or by
				post to {LEGAL_ENTITY.registeredAddress}. We have not appointed a Data
				Protection Officer because our current processing does not require one.
				We will update the date above and provide additional notice when a
				material change requires it.
			</p>
		</LegalShell>
	);
}
