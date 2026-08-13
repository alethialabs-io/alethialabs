// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { CURRENT_LEGAL_OPERATOR } from "@repo/legal/entity";
import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell } from "@/components/legal/legal-shell";

export const metadata: Metadata = {
	title: "Acceptable Use Policy · Alethia",
	description: "Rules governing acceptable use of Alethia.",
};

/** Public rules for safe, lawful use of hosted Alethia services. */
export default function AcceptableUsePage() {
	return (
		<LegalShell title="Acceptable Use Policy" lastUpdated="July 29, 2026">
			<p>
				This policy applies to the Service provided by{" "}
				<strong>{CURRENT_LEGAL_OPERATOR}</strong> and forms part of our{" "}
				<Link href="/terms">Terms of Service</Link>. You are responsible for users,
				workloads, and cloud accounts under your organization.
			</p>

			<h2>1. Illegal and harmful activity</h2>
			<p>You must not use the Service to:</p>
			<ul>
				<li>violate law, regulation, sanctions, or another person’s rights;</li>
				<li>
					distribute malware, ransomware, phishing, spam, fraudulent content, or
					tools primarily intended to facilitate those activities;
				</li>
				<li>
					exploit, threaten, harass, or facilitate sexual abuse or exploitation,
					including any child sexual abuse material;
				</li>
				<li>
					operate infrastructure for unlawful surveillance, trafficking, weapons,
					or evasion of lawful controls;
				</li>
				<li>infringe intellectual-property, privacy, or publicity rights.</li>
			</ul>

			<h2>2. Security and platform abuse</h2>
			<ul>
				<li>
					Do not access accounts, systems, data, or cloud resources without
					authorization.
				</li>
				<li>
					Do not bypass authentication, authorization, tenant isolation, rate
					limits, safety gates, plan limits, or billing controls.
				</li>
				<li>
					Do not disrupt the Service, conduct denial-of-service activity, mine
					cryptocurrency without written approval, or create unreasonable load.
				</li>
				<li>
					Do not probe or test Alethia-owned systems without permission. Good-faith
					security research must follow <code>SECURITY.md</code> and be reported to{" "}
					<a href="mailto:security@alethialabs.io">
						security@alethialabs.io
					</a>
					.
				</li>
				<li>
					Do not connect a repository, organization, identity, or cloud account you
					are not authorized to manage.
				</li>
			</ul>

			<h2>3. High-risk use</h2>
			<p>
				Do not rely on the Service as the sole control for emergency services,
				medical devices, nuclear facilities, weapons, life-support, or another use
				where failure is reasonably likely to cause death, serious injury, or severe
				environmental harm. Review generated infrastructure plans and maintain
				appropriate human approval, backups, and recovery controls.
			</p>

			<h2>4. Enforcement</h2>
			<p>
				We may investigate suspected violations; limit, quarantine, or suspend the
				relevant account or workload; preserve evidence; and report unlawful conduct
				where required. When the risk permits, we will give notice and an opportunity
				to cure. Urgent threats may be addressed immediately. We consider context,
				intent, severity, history, and remediation.
			</p>

			<h2>5. Reporting and appeals</h2>
			<p>
				Report abuse to <a href="mailto:legal@alethialabs.io">legal@alethialabs.io</a>{" "}
				and security issues to{" "}
				<a href="mailto:security@alethialabs.io">security@alethialabs.io</a>. Include
				the affected URL or resource, time, and evidence. You may appeal an
				enforcement decision through the same address.
			</p>
		</LegalShell>
	);
}
