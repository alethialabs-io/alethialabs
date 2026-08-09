// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { CURRENT_LEGAL_OPERATOR } from "@repo/brand/legal";
import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell } from "@/components/legal/legal-shell";

export const metadata: Metadata = {
	title: "Security · Alethia",
	description:
		"How Alethia is built: zero stored cloud credentials, short-lived federated identity, sealed per-job execution, and signed evidence you can verify offline.",
};

/**
 * The public security page.
 *
 * Deliberately makes no certification claim, because none is held. Every
 * statement here is architectural and checkable — the control plane is AGPL, so
 * a reader can go and confirm any of it rather than take our word for it. That
 * is the honest version of a trust page for a product whose entire argument is
 * "don't trust us, verify."
 */
export default function SecurityPage() {
	return (
		<LegalShell title="Security" lastUpdated="August 5, 2026">
			<p>
				Alethia provisions infrastructure into <strong>your</strong> cloud account.
				That makes the most valuable thing we could lose the one thing we
				deliberately never hold: your cloud credentials. This page describes how
				that works, what we do hold, and what to do if you find a problem.
			</p>

			<h2>1. We store no cloud credentials</h2>
			<p>
				There is no access key, service-account JSON, or client secret anywhere in
				the platform. The control plane is its own OIDC identity provider: it mints
				a short-lived, audience-scoped assertion per operation, and your cloud
				federates against it directly.
			</p>
			<ul>
				<li>
					<strong>AWS</strong> — <code>AssumeRoleWithWebIdentity</code> straight
					into your role, against an IAM OIDC provider you create. No Alethia AWS
					account is involved and there is no ExternalId to leak.
				</li>
				<li>
					<strong>Google Cloud</strong> — Workload Identity Federation token
					exchange.
				</li>
				<li>
					<strong>Azure</strong> — a client assertion into your own user-assigned
					managed identity via a federated credential. No Alethia Entra app.
				</li>
				<li>
					<strong>Alibaba Cloud</strong> — anonymous{" "}
					<code>AssumeRoleWithOIDC</code>, with no AccessKey and no Alethia
					Alibaba account.
				</li>
			</ul>
			<p>
				Each exchange returns a credential of roughly one hour, refreshed for the
				life of a job. The assertion itself is scoped by audience, so a token minted
				for one cloud cannot be replayed at another.
			</p>

			<h2>2. What we do hold</h2>
			<p>
				One long-lived secret: the signing key of the OIDC issuer. Its private half
				never leaves the control plane, and clouds verify assertions against the
				public JWKS we publish. It is rotatable with zero downtime. Everything else
				an operation needs is derived at run time and expires.
			</p>

			<h2>3. Revocation is yours, not ours</h2>
			<p>
				Because the trust lives in your account, so does the off switch. Delete the
				IAM role, the workload-identity binding, the federated credential, or the
				RAM role, and our access ends immediately — no ticket, no waiting on us to
				delete anything. There is nothing on our side that could be stolen and
				replayed afterwards.
			</p>

			<h2>4. Your own code runs sealed</h2>
			<p>
				When you bring your own OpenTofu, Terraform providers, or Helm charts, that
				code is arbitrary and we treat it that way. On the managed fleet each job
				runs in a per-job sandbox with no shared secrets, no access to the cloud
				instance metadata service, and default-deny egress restricted to an
				allowlist. Your provisioning code cannot reach the platform&rsquo;s secrets or
				the open internet.
			</p>

			<h2>5. Tenant isolation</h2>
			<p>
				Tenant data is separated in the database by row-level security, so isolation
				is enforced by the database rather than by application code remembering to
				filter. Authorization is relationship-based (ReBAC) and evaluated by a
				dedicated policy engine, so a permission decision is a lookup rather than a
				scattered set of conditionals.
			</p>

			<h2>6. Evidence, not assurances</h2>
			<p>
				Every apply passes a deterministic, fail-closed gate between plan and apply,
				and seals an evidence receipt. The receipt is bound to the hash of the exact
				plan that ran and to the version of the control catalog that judged it, and
				it is signed with ed25519 — so anyone holding the public key can verify it
				offline, later, without trusting our console. A verdict is reproducible given
				the same plan.
			</p>
			<p>
				We are precise about the limits of this: a receipt is evidence that named,
				versioned controls passed on a specific plan. It is not a claim of
				compliance, and the gate reports what it could not evaluate rather than
				passing it silently.
			</p>

			<h2>7. Certifications</h2>
			<p>
				<strong>
					Alethia holds no SOC 2, ISO 27001, or equivalent certification today, and
					we will not imply otherwise.
				</strong>{" "}
				We are an early company and an audit is not yet in scope. What we offer
				instead is verifiability: the control plane is open source under AGPL-3.0,
				so every claim on this page can be read in the source rather than accepted on
				trust. If your procurement process requires a certified vendor, we would
				rather tell you now.
			</p>

			<h2>8. Self-hosting</h2>
			<p>
				If your requirements do not permit a third-party control plane at all, run
				ours. The whole platform is self-hostable — see{" "}
				<Link href="/open-source">Open source</Link> — which makes data residency and
				vendor risk questions yours to answer directly.
			</p>

			<h2>9. Reporting a vulnerability</h2>
			<p>
				Please do not open a public issue or discussion. Email{" "}
				<a href="mailto:security@alethialabs.io">security@alethialabs.io</a> with the
				affected component and version or commit, reproduction steps and proof of
				impact, any known exploitation or disclosure, and a safe way to reach you.
			</p>
			<p>
				We aim to acknowledge receipt within five business days. No bounty or payment
				is promised unless agreed in writing before work is performed. Security fixes
				target the current hosted release and the current stable CLI and runner
				releases; self-hosted operators are responsible for applying published
				updates.
			</p>

			<h2>10. Related documents</h2>
			<ul>
				<li>
					<Link href="/legal/dpa">Data Processing Agreement</Link> — the terms under
					which we process personal data on your behalf.
				</li>
				<li>
					<Link href="/legal/subprocessors">Subprocessors</Link> — every third party
					that may process customer data.
				</li>
				<li>
					<Link href="/privacy">Privacy Policy</Link> and{" "}
					<Link href="/cookies">Cookie Notice</Link>.
				</li>
				<li>
					<Link href="/acceptable-use">Acceptable Use Policy</Link> — what the
					Service may not be used for.
				</li>
			</ul>
			<p>
				This page describes the Service as operated by{" "}
				<strong>{CURRENT_LEGAL_OPERATOR}</strong>. It is a description of
				architecture, not a warranty; the binding commitments are in the{" "}
				<Link href="/terms">Terms</Link> and the DPA.
			</p>
		</LegalShell>
	);
}
