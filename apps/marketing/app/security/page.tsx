// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { CURRENT_LEGAL_OPERATOR } from "@repo/legal/entity";
import type { Metadata } from "next";
import Link from "next/link";
import { SiteShell } from "@repo/brand/site-shell";
import { PageCTA, PageHero, Section } from "@repo/brand/site-sections";

export const metadata: Metadata = {
	title: "Security",
	description:
		"How Alethia is built: no stored cloud keys on AWS, GCP or Azure, short-lived federated identity, sealed per-job execution, and signed evidence you can verify offline.",
};

/** One architectural claim: what it is, in two sentences, and where the detail lives. */
interface Claim {
	title: string;
	body: string;
	href: string;
}

/**
 * The six claims. Each is architectural and checkable against the AGPL source,
 * and each links to the docs page that carries the detail the old ten-section
 * prose version spelled out inline.
 *
 * Card 1 states the Hetzner exception in the same terms as the pricing FAQ —
 * the two pages used to be the only places that disagreed about it. Card 3 no
 * longer names a RAM role: Alibaba is hidden from the cloud catalog. Card 5 says
 * "one policy engine" rather than "relationship-based": the community engine is
 * the Postgres RBAC one and OpenFGA is an optional Enterprise engine.
 */
const CLAIMS: Claim[] = [
	{
		title: "No cloud keys on AWS, GCP or Azure",
		body: "Each job gets a per-job, audience-scoped federated credential of about an hour, refreshed for the job. Hetzner has no federation, so its scoped API token is encrypted at rest and decrypted only for the job — a self-managed runner keeps it from reaching us at all.",
		href: "/docs/concepts/runner/cloud-credentials",
	},
	{
		title: "One secret we do hold",
		body: "The OIDC issuer's signing key. Its private half never leaves the control plane, the public JWKS is published, and the key rotates without downtime.",
		href: "/docs/reference/standards/workload-identity",
	},
	{
		title: "Revocation is yours",
		body: "The trust lives in your account, and so does the off switch. Delete the IAM role, the workload-identity binding or the federated credential and our access ends.",
		href: "/docs/guides/connectors",
	},
	{
		title: "Your code runs sealed",
		body: "On the managed fleet, bring-your-own OpenTofu and Helm run in a per-job sandbox. No shared secrets, no instance metadata, default-deny egress.",
		href: "/docs/concepts/isolated-execution",
	},
	{
		title: "Tenant isolation",
		body: "Postgres row-level security keeps each organization's rows apart, beneath the application. Every permission check goes through one policy engine.",
		href: "/docs/concepts/security",
	},
	{
		title: "Evidence, not assurances",
		body: "A fail-closed gate sits between plan and apply and seals an ed25519 receipt bound to the plan hash. It reports what it could not evaluate; it is not a compliance claim.",
		href: "/docs/concepts/elench/receipts",
	},
];

/** One claim card: title, two sentences, a docs link. */
function ClaimCard({ claim }: { claim: Claim }) {
	return (
		<div
			className="flex flex-col p-6"
			style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--surface)" }}
		>
			<p className="m-0 mb-2 font-grotesk text-ui-lg font-semibold text-text-primary">{claim.title}</p>
			<p className="m-0 text-ui-md leading-[1.6] text-text-secondary">{claim.body}</p>
			<Link
				href={claim.href}
				className="vx-clamp vx-clamp--tight mt-auto self-start pt-5 text-ui-md text-text-primary no-underline transition-colors hover:text-text-secondary"
			>
				Details →
			</Link>
		</div>
	);
}

/** The related documents, in the order a security review reads them. */
const RELATED: { label: string; href: string }[] = [
	{ label: "Data Processing Addendum", href: "/legal/dpa" },
	{ label: "Subprocessors", href: "/legal/subprocessors" },
	{ label: "Privacy Policy", href: "/privacy" },
	{ label: "Cookie Notice", href: "/cookies" },
	{ label: "Acceptable Use Policy", href: "/acceptable-use" },
	{ label: "Self-hosting", href: "/open-source" },
];

/**
 * The public security page.
 *
 * Deliberately makes no certification claim, because none is held. Every
 * statement here is architectural and checkable — the control plane is AGPL, so
 * a reader can go and confirm any of it rather than take our word for it.
 *
 * It was ten numbered prose sections; it is now six claim cards, a
 * certifications block, a disclosure block and the related documents, with the
 * long-form detail one link away in the docs.
 */
export default async function SecurityPage() {
	return (
		<SiteShell>
			<PageHero
				kicker="alethia · security"
				status="keyless on AWS, GCP, Azure"
				headline={{ lead: "The credentials we", muted: "deliberately never hold." }}
				lede="Alethia provisions into your cloud account with short-lived federated identity, so there is no access key to leak."
				ctas={[
					{ label: "Read the architecture", href: "/docs/reference/standards/workload-identity", icon: "arrow" },
					{ label: "Report a vulnerability", href: "mailto:security@alethialabs.io", variant: "outline", icon: "shield", iconBefore: true },
				]}
				footnote="Last updated · November 21, 2026"
				paddingBottom={24}
			/>

			<Section bordered={false}>
				<div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
					{CLAIMS.map((claim) => (
						<ClaimCard key={claim.title} claim={claim} />
					))}
				</div>
			</Section>

			<Section>
				<div className="grid grid-cols-1 gap-12 md:grid-cols-2">
					<div>
						<p className="vx-eyebrow mb-4">Certifications</p>
						<p className="m-0 max-w-[48ch] text-ui-md leading-[1.6] text-text-secondary">
							<strong className="text-text-primary">
								Alethia holds no SOC 2, ISO 27001, or equivalent certification today, and we will
								not imply otherwise.
							</strong>{" "}
							What we offer instead is verifiability: every claim above can be read in the AGPL
							source.
						</p>
					</div>
					<div>
						<p className="vx-eyebrow mb-4">Report a vulnerability</p>
						<p className="m-0 max-w-[48ch] text-ui-md leading-[1.6] text-text-secondary">
							Email <a href="mailto:security@alethialabs.io" className="text-text-primary">security@alethialabs.io</a>,
							not a public issue, with the affected version, reproduction steps and a way to reach
							you. We aim to acknowledge within five business days. No bounty is promised unless
							agreed in writing first.
						</p>
					</div>
				</div>
			</Section>

			<Section>
				<p className="vx-eyebrow mb-4">Related</p>
				<ul className="m-0 flex list-none flex-wrap gap-x-8 gap-y-3 p-0">
					{RELATED.map((doc) => (
						<li key={doc.href}>
							<Link
								href={doc.href}
								className="vx-clamp vx-clamp--tight text-ui-md text-text-secondary no-underline transition-colors hover:text-text-primary"
							>
								{doc.label}
							</Link>
						</li>
					))}
				</ul>
				<p className="m-0 mt-10 max-w-[64ch] text-ui-sm leading-[1.6] text-text-tertiary">
					This page describes the Service as operated by {CURRENT_LEGAL_OPERATOR}. It is a
					description of architecture, not a warranty; the binding commitments are in the{" "}
					<Link href="/terms" className="text-text-secondary">Terms</Link> and the DPA.
				</p>
			</Section>

			<PageCTA
				headline="Verify it yourself."
				lede="The control plane is open source. Read the federation code, run it in your own account, and check the receipt offline."
				ctas={[
					{ label: "Read the docs", href: "/docs", icon: "arrow" },
					{ label: "Self-host it", href: "/open-source", variant: "outline" },
				]}
			/>
		</SiteShell>
	);
}
