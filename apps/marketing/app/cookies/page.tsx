// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { CURRENT_LEGAL_OPERATOR } from "@repo/brand/legal";
import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell } from "@/components/legal/legal-shell";

export const metadata: Metadata = {
	title: "Cookie Notice · Alethia",
	description: "The cookies and similar technologies used by Alethia.",
};

/** Public notice for essential storage, consent, analytics, and replay. */
export default function CookiesPage() {
	return (
		<LegalShell title="Cookie Notice" lastUpdated="July 29, 2026">
			<p>
				This notice explains how <strong>{CURRENT_LEGAL_OPERATOR}</strong> uses
				cookies, browser storage, scripts, and similar technologies on Alethia. Read
				it with our <Link href="/privacy">Privacy Policy</Link>.
			</p>

			<h2>1. Your control</h2>
			<p>
				Essential storage is active because the Service cannot securely operate
				without it. Product analytics and session replay are disabled until you opt
				in. They have separate controls. Use the <strong>Privacy choices</strong>{" "}
				button at the lower-left of any page to change or withdraw a choice. Reject
				non-essential is presented alongside Accept all on first visit.
			</p>

			<h2>2. Essential storage</h2>
			<ul>
				<li>
					<code>better-auth.session_token</code> and secure-prefixed variants:
					authenticate the session and protect access to the console. Duration is
					set by the authentication session and may be refreshed while signed in.
				</li>
				<li>
					Authentication flow cookies: short-lived state, PKCE, one-time-code, and
					redirect values used to complete a secure sign-in.
				</li>
				<li>
					<code>alethia_consent_v1</code>: records analytics and replay choices,
					the policy version, and decision time for 183 days.
				</li>
				<li>
					Interface storage: theme, selected workspace, and local interface state
					needed to remember settings on the device.
				</li>
			</ul>

			<h2>3. Product analytics</h2>
			<p>
				If you consent, Alethia may load PostHog or a self-hosted Umami instance to
				measure page visits, feature events, performance, and client errors. We use
				internal identifiers and low-cardinality plan or role attributes, not email
				addresses, names, prompt text, or model output. Provider storage names can
				change as their SDKs evolve; commonly they begin with <code>ph_</code> or{" "}
				<code>umami</code>. Analytics retention is capped at 12 months.
			</p>

			<h2>4. Session replay</h2>
			<p>
				If you separately consent, Alethia may load PostHog Session Replay or
				OpenReplay to reproduce interface failures. Inputs are masked and PostHog
				text capture is masked. Do not enter secrets in free-text fields. Replay is
				capped at 30 days and remains off when replay consent is off, even if
				analytics is on.
			</p>

			<h2>5. Browser settings and signals</h2>
			<p>
				You can delete or block storage in browser settings, but blocking essential
				cookies can prevent sign-in. We honor the choices stored in the Alethia
				consent control. Because there is not yet one universally implemented
				technical interpretation of Global Privacy Control for all consent purposes,
				use Privacy choices to make an explicit selection.
			</p>

			<h2>6. Contact</h2>
			<p>
				Questions may be sent to{" "}
				<a href="mailto:privacy@alethialabs.io">privacy@alethialabs.io</a>.
			</p>
		</LegalShell>
	);
}
