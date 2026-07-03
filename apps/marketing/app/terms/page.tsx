// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { LegalShell } from "@/components/legal/legal-shell";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
	title: "Terms of Service · Alethia",
	description: "The terms governing your use of the Alethia hosted service.",
};

/**
 * Public Terms of Service page. Content is sourced from the repository's
 * licensing model (LICENSING.md) and known company facts; unresolved details
 * are marked with <mark> placeholders for legal review.
 */
export default function TermsPage() {
	return (
		<LegalShell title="Terms of Service" lastUpdated="June 17, 2026">
			<p>
				These Terms of Service (“Terms”) govern your access to and use of
				the Alethia hosted control plane, the alethia command-line
				interface, and related websites and services (together, the
				“Service”) provided by{" "}
				<strong>Alethia Labs OÜ</strong>, a private limited company
				registered in Estonia (registration number{" "}
				<mark>[PLACEHOLDER: company registration number]</mark>, registered
				office <mark>[PLACEHOLDER: registered address]</mark>) (“Alethia
				Labs”, “we”, “us”). By creating an account or using the Service you
				agree to these Terms. If you do not agree, do not use the Service.
			</p>

			<h2>1. The Service</h2>
			<p>
				Alethia lets you configure multi-cloud Kubernetes infrastructure in
				the browser and deploy it from the terminal. The Service connects to
				your own cloud accounts using short-lived, federated credentials and
				never stores static cloud access keys. You are responsible for the
				cloud resources you provision and for all charges your cloud
				providers bill you for them.
			</p>

			<h2>2. Accounts</h2>
			<p>
				You sign in through a supported identity provider (GitHub, GitLab,
				Bitbucket, or Google) or via a one-time code sent to your email.
				You are
				responsible for maintaining the security of the identity you use to
				authenticate and for all activity that occurs under your account.
				You must be at least 18 years old, or the age of majority in your
				jurisdiction, to use the Service.
			</p>

			<h2>3. Acceptable use</h2>
			<p>
				Your use of the Service is subject to our{" "}
				<Link href="/acceptable-use">Acceptable Use Policy</Link>, which is
				incorporated into these Terms by reference. You must not misuse the
				Service, attempt to bypass tenant isolation, or use it to provision
				unlawful infrastructure.
			</p>

			<h2>4. Software licensing</h2>
			<p>
				Alethia is open core. The core of the software is free and open
				source under the{" "}
				<strong>GNU Affero General Public License v3.0 (AGPL-3.0-only)</strong>
				. A small set of enterprise features (the <code>ee/</code> directory
				of our source code) is commercially licensed and requires a paid
				subscription for production use. Alethia Labs OÜ owns the copyright
				to the codebase; contributions are consolidated under a Contributor
				License Agreement.
			</p>
			<p>
				Because we run the hosted Service over a network, AGPL §13 requires
				us to offer users the Corresponding Source of the exact version we
				run. We publish that source for the tagged build each deployment is
				produced from and surface an in-app source offer linking to it. The
				commercially-licensed <code>ee/</code> code is a separate work and is
				not part of the AGPL Corresponding Source. Your use of the
				open-source core under AGPL-3.0-only is governed by that license, not
				these Terms.
			</p>

			<h2>5. Subscriptions and fees</h2>
			<p>
				Paid plans, their features, and pricing are described at the time of
				purchase. Fees, billing cycles, taxes, and refund terms are set out
				in the applicable order or plan description{" "}
				<mark>[PLACEHOLDER: link to pricing / plan terms]</mark>. We may
				change pricing on a going-forward basis with reasonable notice.
			</p>

			<h2>6. Your content and cloud accounts</h2>
			<p>
				You retain all rights to the configurations, infrastructure
				definitions, and other content you submit to the Service. You grant
				us a limited licence to process that content solely to operate and
				provide the Service to you. You are responsible for ensuring you have
				the right to connect any cloud account and to provision resources
				within it.
			</p>

			<h2>7. Availability and changes</h2>
			<p>
				We may modify, suspend, or discontinue any part of the Service at any
				time. We aim for high availability but, unless a separate written
				service-level agreement applies{" "}
				<mark>[PLACEHOLDER: SLA terms, if any]</mark>, the Service is provided
				without an availability guarantee.
			</p>

			<h2>8. Disclaimer of warranties</h2>
			<p>
				The Service is provided “as is” and “as available” without
				warranties of any kind, whether express, implied, or statutory,
				including any implied warranties of merchantability, fitness for a
				particular purpose, and non-infringement, to the maximum extent
				permitted by applicable law.
			</p>

			<h2>9. Limitation of liability</h2>
			<p>
				To the maximum extent permitted by law, Alethia Labs OÜ will not be
				liable for any indirect, incidental, special, consequential, or
				punitive damages, or for any loss of profits, revenue, data, or
				goodwill, arising out of or related to your use of the Service. Our
				total aggregate liability for any claim arising out of or relating to
				the Service is limited to the amounts you paid us for the Service in
				the twelve months preceding the event giving rise to the claim, or{" "}
				<mark>[PLACEHOLDER: liability cap for free-tier users]</mark> if you
				use the Service free of charge.
			</p>

			<h2>10. Termination</h2>
			<p>
				You may stop using the Service at any time. We may suspend or
				terminate your access if you breach these Terms or the Acceptable Use
				Policy. On termination, the rights granted to you under these Terms
				end; provisions that by their nature should survive (including
				licensing, disclaimers, and limitation of liability) will survive.
			</p>

			<h2>11. Governing law</h2>
			<p>
				These Terms are governed by the laws of Estonia, without regard to
				conflict-of-laws rules. The courts of{" "}
				<mark>[PLACEHOLDER: dispute venue / competent court]</mark> will have
				exclusive jurisdiction over any dispute arising out of or relating to
				these Terms, except where mandatory consumer-protection law provides
				otherwise.
			</p>

			<h2>12. Changes to these Terms</h2>
			<p>
				We may update these Terms from time to time. When we make material
				changes we will update the “Last updated” date above and, where
				appropriate, notify you. Your continued use of the Service after
				changes take effect constitutes acceptance of the revised Terms.
			</p>

			<h2>13. Contact</h2>
			<p>
				Questions about these Terms can be sent to{" "}
				<a href="mailto:legal@alethialabs.io">legal@alethialabs.io</a>.
			</p>
		</LegalShell>
	);
}
