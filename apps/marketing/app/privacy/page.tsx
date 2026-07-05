// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { LEGAL_ENTITY, legalField } from "@repo/brand/legal";
import { LegalShell } from "@/components/legal/legal-shell";
import type { Metadata } from "next";

export const metadata: Metadata = {
	title: "Privacy Policy · Alethia",
	description:
		"How Alethia collects, uses, and protects your personal data.",
};

/**
 * Public Privacy Policy page. Data-handling details are sourced from the
 * platform's security architecture (zero-credential model, encrypted git
 * tokens, Row Level Security); facts not yet confirmed are marked with <mark>
 * placeholders for legal review.
 */
export default function PrivacyPage() {
	return (
		<LegalShell title="Privacy Policy" lastUpdated="June 17, 2026">
			<p>
				This Privacy Policy explains how <strong>{LEGAL_ENTITY.legalName}</strong> (a
				company registered in {LEGAL_ENTITY.jurisdiction}, registration number{" "}
				<mark>{legalField(LEGAL_ENTITY.registrationNumber, "company registration number (EIK)")}</mark>,
				registered office{" "}
				<mark>{legalField(LEGAL_ENTITY.registeredAddress, "registered address")}</mark>) (“we”, “us”)
				collects, uses, and protects personal data when you use the Alethia
				control plane, the alethia CLI, and related services (the “Service”).
				We act as the data controller for the personal data described here.
			</p>

			<h2>1. Data we collect</h2>
			<h3>Account and identity data</h3>
			<p>
				When you sign in we receive identity information from your chosen
				provider (GitHub, GitLab, Bitbucket, or Google) — typically your
				name, email address, avatar, and provider user ID — or, for email
				sign-in, your email address. Authentication is handled by Better
				Auth, which issues a session token (JWT).
			</p>
			<h3>Git provider tokens</h3>
			<p>
				If you connect a Git provider, we store the resulting OAuth access
				(and, where applicable, refresh) tokens so the Service can act on
				your behalf. These tokens are encrypted at rest, scoped to your
				account by Row Level Security, and refreshed or expired according to
				the provider’s policy.
			</p>
			<h3>Cloud identities</h3>
			<p>
				To provision infrastructure we store the configuration needed to
				assume short-lived, federated credentials in your cloud accounts —
				for example an AWS role ARN and External ID, a GCP Workload Identity
				Federation configuration, or an Azure federated credential.{" "}
				<strong>
					We never store static cloud access keys or secrets.
				</strong>{" "}
				Every cloud access is temporary, scoped, and revocable by you.
			</p>
			<h3>Usage and operational data</h3>
			<p>
				We process provisioning job metadata, logs, and standard technical
				data (such as IP address and browser/user-agent) needed to operate,
				secure, and debug the Service.{" "}
				<mark>[PLACEHOLDER: analytics / product telemetry, if any]</mark>
			</p>

			<h2>2. How we use your data</h2>
			<ul>
				<li>To authenticate you and operate your account.</li>
				<li>
					To provision and manage the cloud infrastructure you configure.
				</li>
				<li>To provide support and respond to your requests.</li>
				<li>
					To secure the Service, prevent abuse, and meet legal
					obligations.
				</li>
				<li>To bill you for paid plans, where applicable.</li>
			</ul>

			<h2>3. Legal bases (GDPR)</h2>
			<p>
				Where the EU General Data Protection Regulation applies, we rely on:
				performance of a contract (to provide the Service); our legitimate
				interests (to secure and improve the Service); compliance with a
				legal obligation; and your consent where specifically requested. You
				may withdraw consent at any time without affecting prior processing.
			</p>

			<h2>4. How we store and protect data</h2>
			<p>
				Data is stored in PostgreSQL and an S3-compatible object store, hosted
				on our own infrastructure and Amazon Web Services.
				Personal data and tokens are encrypted at rest, and every
				user-scoped database table is protected by Row Level Security, so a
				query can only ever return the authenticated user’s own data. Cloud
				identities are additionally segmented by provider. Our hosting region
				and primary data location are{" "}
				<mark>[PLACEHOLDER: hosting region / data residency, e.g. AWS eu-west-1]</mark>.
			</p>

			<h2>5. Sub-processors</h2>
			<p>
				We share personal data with service providers who process it on our
				behalf, including:
			</p>
			<ul>
				<li>Amazon Web Services — cloud infrastructure and hosting.</li>
				<li>
					Your chosen identity provider (GitHub, GitLab, Bitbucket, or
					Google) — sign-in.
				</li>
				<li>
					<mark>[PLACEHOLDER: email delivery, billing, and any other sub-processors]</mark>
				</li>
			</ul>

			<h2>6. International transfers</h2>
			<p>
				Some sub-processors may process data outside your country or the
				European Economic Area. Where they do, we rely on appropriate
				safeguards such as the European Commission’s Standard Contractual
				Clauses.{" "}
				<mark>[PLACEHOLDER: confirm transfer mechanisms per sub-processor]</mark>
			</p>

			<h2>7. Retention</h2>
			<p>
				We keep personal data for as long as your account is active and as
				needed to provide the Service. When you delete your account we delete
				or anonymise your personal data, except where we must retain it to
				meet legal, accounting, or security obligations.{" "}
				<mark>[PLACEHOLDER: specific retention periods]</mark>
			</p>

			<h2>8. Your rights</h2>
			<p>
				Subject to applicable law, you have the right to access, correct,
				delete, restrict, or object to the processing of your personal data,
				to data portability, and to lodge a complaint with a supervisory
				authority (in {LEGAL_ENTITY.jurisdiction}, the{" "}
				<a href={LEGAL_ENTITY.dpa.url}>{LEGAL_ENTITY.dpa.name}</a>
				). To exercise these rights, contact us using the details below.
			</p>

			<h2>9. Contact</h2>
			<p>
				For privacy questions or to exercise your rights, contact{" "}
				<a href="mailto:legal@alethialabs.io">legal@alethialabs.io</a>. Our
				data protection contact is{" "}
				<mark>[PLACEHOLDER: DPO / data protection contact, if appointed]</mark>.
			</p>

			<h2>10. Changes to this policy</h2>
			<p>
				We may update this Privacy Policy from time to time. Material changes
				will be reflected in the “Last updated” date above and, where
				appropriate, communicated to you.
			</p>
		</LegalShell>
	);
}
