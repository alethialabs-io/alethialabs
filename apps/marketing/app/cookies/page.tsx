// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { CURRENT_LEGAL_OPERATOR } from "@repo/legal/entity";
import { CONSENT_COOKIE_NAME } from "@repo/legal/processing";
import { CONSENT_LABELS } from "@repo/privacy/consent";
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
		<LegalShell title="Cookie Notice" lastUpdated="August 12, 2026">
			<p>
				This notice explains how <strong>{CURRENT_LEGAL_OPERATOR}</strong> uses
				cookies, browser storage, scripts, and similar technologies on Alethia.
				Read it with our <Link href="/privacy">Privacy Policy</Link>.
			</p>

			<h2>1. Your control</h2>
			<p>
				Essential storage is active because the Service cannot securely operate
				without it. There is exactly one optional choice — product analytics —
				and it is off until you turn it on. Use <strong>Privacy settings</strong>{" "}
				in the site footer — or, in the console, the Privacy settings item in
				your account menu — to change or withdraw it at any time. Withdrawing it
				deletes the analytics provider’s identifiers and browser storage from
				this device. Accept and reject are presented side by side, with the same
				prominence, on first visit.
			</p>

			<h2>2. Essential storage</h2>
			<ul>
				<li>
					<code>better-auth.session_token</code> and secure-prefixed variants:
					authenticate the session and protect access to the console. Duration
					is set by the authentication session and may be refreshed while signed
					in.
				</li>
				<li>
					Authentication flow cookies: short-lived state, PKCE, one-time-code,
					and redirect values used to complete a secure sign-in.
				</li>
				<li>
					<code>{CONSENT_COOKIE_NAME}</code>: records the analytics choice, the
					policy version, and the decision time for 183 days.
				</li>
				<li>
					Interface storage: theme, selected workspace, and local interface
					state needed to remember settings on the device.
				</li>
			</ul>

			<h2>3. Product analytics</h2>
			<p>
				If you consent, the hosted Alethia service loads PostHog EU Cloud to
				measure page visits, feature events, performance, and client errors. We
				use internal identifiers and low-cardinality plan or role attributes,
				not email addresses, names, prompt text, or model output. Provider
				storage names can change as its SDK evolves; commonly they begin with{" "}
				<code>ph_</code>. Retention is limited by the configured PostHog project
				retention and reviewed quarterly; the current period is available from
				privacy@alethialabs.io.
			</p>

			<h2>4. Session replay</h2>
			<p>
				<strong>Alethia does not record your session.</strong> There is no
				session-replay provider, no replay choice to make, and the analytics SDK
				is configured so that recording cannot start. An earlier version of this
				notice described an optional masked replay; that feature was removed
				rather than switched off.
			</p>

			<h2>5. Browser settings and signals</h2>
			<p>
				You can delete or block storage in browser settings, but blocking
				essential cookies can prevent sign-in. We honour the choice stored in
				the Alethia consent control, and we honour{" "}
				<strong>Global Privacy Control</strong>: if your browser sends the GPC
				signal, optional analytics stays off and the stored choice cannot
				override it — including an acceptance made before you enabled the
				signal. GPC is treated as a standing opt-out, not as a default you can
				click past.
			</p>

			<h2>6. Contact</h2>
			<p>
				Questions may be sent to{" "}
				<a href="mailto:privacy@alethialabs.io">privacy@alethialabs.io</a>.
			</p>
		</LegalShell>
	);
}
