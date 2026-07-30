// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell } from "@/components/legal/legal-shell";

export const metadata: Metadata = {
	title: "Subprocessors · Alethia",
	description: "Providers that may process personal data for Alethia.",
};

/** Current hosted-service subprocessor register and processing locations. */
export default function SubprocessorsPage() {
	return (
		<LegalShell title="Subprocessors" lastUpdated="July 29, 2026">
			<p>
				These providers may process personal data for the hosted Alethia Service.
				Actual use depends on the feature, plan, connected provider, and privacy
				choices. Customer-controlled cloud and identity providers receive data at the
				customer’s direction and may act as independent controllers rather than
				Alethia subprocessors.
			</p>

			<h2>Core service</h2>
			<h3>Hetzner Online GmbH · Germany</h3>
			<p>
				Primary compute, network, server backup, PostgreSQL, and S3-compatible object
				storage in <code>fsn1</code>, Germany. Data: hosted Service content,
				identifiers, configuration, logs, and encrypted tokens.
			</p>
			<h3>Cloudflare, Inc. · EEA and global edge network</h3>
			<p>
				DNS, content delivery, TLS termination, denial-of-service protection, secure
				tunnel, and inbound email routing. Data: IP address, request metadata,
				security events, and routed email.
			</p>
			<h3>Amazon Web Services EMEA SARL · EU region selected by Alethia</h3>
			<p>
				Amazon SES transactional email delivery. Data: recipient address, message
				content, delivery, bounce, and complaint metadata.
			</p>
			<h3>Stripe Payments Europe, Limited · EEA / United States</h3>
			<p>
				Subscription billing, invoices, tax configuration, fraud prevention, and
				payment processing. Data: billing contact, organization, transaction,
				invoice, and payment metadata. Stripe directly collects payment-card data.
			</p>

			<h2>Optional telemetry</h2>
			<h3>PostHog, Inc. · EU Cloud when configured</h3>
			<p>
				Consent-gated product analytics, performance, client-error diagnostics, and
				masked session replay. Data: pseudonymous internal identifiers, device and
				usage events. Email, name, prompt text, and model output are excluded.
			</p>
			<h3>OpenReplay, Inc. · configured cloud or self-hosted region</h3>
			<p>
				Separately consent-gated, masked session replay. Data: interface events,
				device metadata, and obscured input interactions.
			</p>
			<h3>Umami Software, Inc. · self-hosted by Alethia when configured</h3>
			<p>
				Consent-gated product analytics. Data: page and feature events, device and
				performance metadata.
			</p>

			<h2>Feature-specific providers</h2>
			<h3>Anthropic, PBC and OpenAI, L.L.C. · United States</h3>
			<p>
				AI features when enabled and requested by a user. Data: prompts, relevant
				customer context, model responses, token counts, and safety metadata. The
				active model provider is determined by Alethia configuration.
			</p>
			<h3>GitHub, Inc.; GitLab B.V.; Atlassian Pty Ltd. · selected regions</h3>
			<p>
				Repository connection, source retrieval, commit status, and supported
				identity flows when selected by the customer. Data: account identifiers,
				repository metadata, source content requested for a job, and OAuth tokens.
			</p>

			<h2>Changes</h2>
			<p>
				Material additions are posted here before processing begins where
				practicable. DPA customers may object as described in the{" "}
				<Link href="/legal/dpa">Data Processing Addendum</Link>. Send questions or a
				request for change notices to{" "}
				<a href="mailto:privacy@alethialabs.io">privacy@alethialabs.io</a>.
			</p>
		</LegalShell>
	);
}
