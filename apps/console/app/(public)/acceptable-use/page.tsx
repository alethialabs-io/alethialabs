// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { LegalShell } from "@/components/legal/legal-shell";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
	title: "Acceptable Use Policy · Alethia",
	description: "The rules governing acceptable use of the Alethia service.",
};

/**
 * Public Acceptable Use Policy page. Defines prohibited uses of the Service,
 * enforcement, and reporting channels. Jurisdiction-specific clauses are
 * flagged with a <mark> placeholder for legal review.
 */
export default function AcceptableUsePage() {
	return (
		<LegalShell title="Acceptable Use Policy" lastUpdated="June 17, 2026">
			<p>
				This Acceptable Use Policy (“AUP”) sets out the rules for using the
				Alethia control plane, the alethia CLI, and related services (the
				“Service”) provided by <strong>Alethia Labs OÜ</strong>. It is part
				of, and incorporated by reference into, our{" "}
				<Link href="/terms">Terms of Service</Link>. By using the Service you agree
				to this AUP.
			</p>

			<h2>1. Prohibited activities</h2>
			<p>You must not use the Service to:</p>
			<ul>
				<li>
					Provision or operate infrastructure for any unlawful purpose, or
					in violation of any applicable law or regulation.
				</li>
				<li>
					Host, distribute, or facilitate malware, phishing, spam, or other
					malicious or fraudulent content.
				</li>
				<li>
					Attempt to gain unauthorised access to the Service, other
					customers’ data, or the underlying systems — including any attempt
					to bypass tenant isolation or Row Level Security.
				</li>
				<li>
					Interfere with or disrupt the integrity or performance of the
					Service, for example through denial-of-service attacks or
					deliberate resource abuse.
				</li>
				<li>
					Connect cloud accounts you are not authorised to manage, or
					provision resources you are not entitled to create.
				</li>
				<li>
					Reverse engineer, probe, or scan the Service except as expressly
					permitted by law or a written agreement with us.
				</li>
				<li>
					Use the Service to infringe the intellectual property, privacy, or
					other rights of any third party.
				</li>
				<li>
					<mark>[PLACEHOLDER: any jurisdiction- or industry-specific prohibitions]</mark>
				</li>
			</ul>

			<h2>2. Your responsibilities</h2>
			<p>
				You are responsible for all activity carried out through your account
				and the cloud accounts you connect, including the lawful and secure
				operation of the infrastructure you provision and any costs your
				cloud providers charge for it.
			</p>

			<h2>3. Enforcement</h2>
			<p>
				If we believe you have violated this AUP, we may suspend or terminate
				your access to the Service, remove offending configurations, and take
				any other action we consider appropriate, with or without notice
				depending on the severity of the violation. Serious or unlawful
				violations may be reported to the relevant authorities.
			</p>

			<h2>4. Reporting abuse</h2>
			<p>
				To report a security vulnerability, contact{" "}
				<a href="mailto:security@alethialabs.io">security@alethialabs.io</a>.
				To report other violations of this AUP, contact{" "}
				<a href="mailto:legal@alethialabs.io">legal@alethialabs.io</a>.
			</p>

			<h2>5. Changes to this policy</h2>
			<p>
				We may update this AUP from time to time. Material changes will be
				reflected in the “Last updated” date above.
			</p>
		</LegalShell>
	);
}
