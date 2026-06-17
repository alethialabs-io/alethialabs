// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { LegalShell } from "@/components/legal/legal-shell";
import type { Metadata } from "next";

export const metadata: Metadata = {
	title: "Cookie Policy · Alethia",
	description: "How Alethia uses cookies and similar technologies.",
};

/**
 * Public Cookie Policy page. Reflects the essential-only cookie usage of the
 * Service (Supabase auth session and the app's auth redirect cookie); any
 * future analytics/marketing cookies are flagged with a <mark> placeholder.
 */
export default function CookiesPage() {
	return (
		<LegalShell title="Cookie Policy" lastUpdated="June 17, 2026">
			<p>
				This Cookie Policy explains how <strong>Alethia Labs OÜ</strong> uses
				cookies and similar technologies on the Alethia control plane and
				related websites (the “Service”). It should be read together with our{" "}
				<a href="/privacy">Privacy Policy</a>.
			</p>

			<h2>1. What cookies are</h2>
			<p>
				Cookies are small text files placed on your device when you visit a
				website. They let the site remember your actions and preferences —
				such as keeping you signed in — across requests.
			</p>

			<h2>2. Cookies we use</h2>
			<p>
				We use only the cookies that are strictly necessary to operate the
				Service:
			</p>
			<ul>
				<li>
					<strong>Authentication / session cookies</strong> — set by our
					authentication provider (Supabase) to keep you securely signed in
					and to refresh your session as you navigate.
				</li>
				<li>
					<strong>Redirect cookie</strong> — a short-lived cookie (
					<code>auth_return_to</code>) that remembers where to send you back
					after you sign in.
				</li>
			</ul>
			<p>
				These cookies are essential: without them you could not sign in or
				use authenticated parts of the Service, so they do not require
				consent under EU law.
			</p>

			<h2>3. Analytics and marketing cookies</h2>
			<p>
				<mark>
					[PLACEHOLDER: we currently do not use analytics or marketing
					cookies — update this section if such cookies are introduced, and
					add a consent banner where required]
				</mark>
			</p>

			<h2>4. Managing cookies</h2>
			<p>
				Most browsers let you block or delete cookies through their settings.
				Because the cookies we use are essential, blocking them will prevent
				you from signing in to the Service.
			</p>

			<h2>5. Contact</h2>
			<p>
				Questions about this Cookie Policy can be sent to{" "}
				<a href="mailto:legal@alethialabs.io">legal@alethialabs.io</a>.
			</p>
		</LegalShell>
	);
}
