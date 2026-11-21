// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { AVAILABLE_CLOUDS, cloudListLabel } from "@repo/cloud-catalog";
import { Badge } from "@repo/ui/badge";
import {
	Band,
	LogoWall,
	PageClose,
	PageOpen,
	Plate,
} from "@repo/brand/site-sections";
import { JOBS, JobsTable } from "@repo/brand/site-primitives";

import { VerifyReceipt } from "./verify-receipt";

/**
 * The home page, in four moves: state what it is, show what it runs on, show
 * three things, stop.
 *
 * Everything here is a server component and must stay one — the <h1> is the LCP
 * element and has to arrive in the initial HTML. The page used to open on a
 * 615-line canvas physics simulation (falling plan-subject chips, drag and
 * throw, an auto-demo attract loop, a rAF loop over a full-viewport canvas with
 * `touch-action: none`); it is gone, along with the readout panel it drove.
 */

/**
 * Real `alethia verify receipt` output, copied verbatim from
 * apps/docs/content/docs/reference/cli/verify.mdx. If the CLI's output changes,
 * this changes with it — it is a quotation, not a mock-up.
 */
const VERIFY_TRANSCRIPT = `$ alethia verify receipt --job 4f3c2b1a

alethia · verify receipt
  Signature        ✓ signature verified against your organization's own recorded key
  Trust            org
  Algorithm        ed25519
  Key ID           9f2c4a1b7e5d3068
  Verdict          pass
  Sealed to plan   3b1f...c204
  Control catalog  elench-controls-0.5.2
  Controls         14 pass, 0 fail, 0 warn, 0 n/a`;

export function Hero() {
	return (
		<PageOpen
			lines={["Infrastructure,", "cross-examined."]}
			ctaSide="left"
			ctas={[
				{ label: "Start free", href: "/signup" },
				{ label: "Read the docs", href: "/docs", variant: "outline" },
			]}
			side={{
				kind: "lines",
				items: [
					// The offered clouds come from packages/core/catalog (availability), so a
					// hidden cloud drops out of this line by itself.
					`Into your own cloud account — ${cloudListLabel()}.`,
					// Deliberately scoped. Hetzner is a token cloud: the scoped token is
					// encrypted at rest in our database unless you self-manage the runner.
					// See docs/runner/cloud-credentials.
					"Keyless on AWS, GCP and Azure — no access key on disk.",
					"Every apply seals a receipt you can verify offline.",
				],
			}}
		/>
	);
}

export function Clouds() {
	return (
		<LogoWall
			eyebrow="Provisions into"
			providers={[...AVAILABLE_CLOUDS]}
		/>
	);
}

export function ConsoleBand() {
	return (
		<Band
			lines={["Configure it once.", "Watch it apply."]}
			visual={
				<Plate label="alethialabs.io/jobs">
					<JobsTable rows={JOBS} compact />
				</Plate>
			}
			rail={{
				proof: {
					lead: "Nineteen component kinds",
					rest: " from one Project — clusters, databases, caches, queues, buckets.",
				},
				label: "Console",
				links: [
					{ label: "The Project designer", href: "/docs/guides/design-project" },
					{ label: "Plan and apply", href: "/docs/guides/jobs/plan-and-apply" },
					{ label: "GitOps with ArgoCD", href: "/docs/concepts/gitops-argocd" },
					{ label: "Runners", href: "/docs/concepts/runner" },
				],
			}}
		/>
	);
}

export function CliBand() {
	return (
		<Band
			lines={["Or drive the whole thing", "from your shell."]}
			visual={
				<Plate label="zsh">
					<pre
						className="m-0 overflow-x-auto p-5 font-mono text-[12px] leading-[1.75] text-text-secondary"
						style={{ background: "var(--surface-sunken)" }}
					>
						{VERIFY_TRANSCRIPT}
					</pre>
				</Plate>
			}
			rail={{
				proof: {
					lead: "Plan, apply, destroy, verify",
					rest: " — the same operations the console runs, from your terminal.",
				},
				label: "Commands",
				links: [
					{ label: "Install the CLI", href: "/docs/get-started/install-the-cli" },
					{ label: "Plan and apply", href: "/docs/reference/cli/plan-and-apply" },
					{ label: "Verify a receipt", href: "/docs/reference/cli/verify" },
					{ label: "Command reference", href: "/docs/reference/cli" },
				],
			}}
		/>
	);
}

export function ReceiptBand() {
	return (
		<Band
			lines={["Every apply", "leaves evidence."]}
			visual={<VerifyReceipt />}
			rail={{
				proof: {
					lead: "Signed ed25519",
					rest: ", the receipt verifies offline against the published key — without us.",
				},
				label: "Receipts",
				links: [
					{ label: "What a receipt binds", href: "/docs/concepts/elench/receipts" },
					{ label: "The control catalog", href: "/docs/reference/control-catalog" },
					{ label: "Verify from the CLI", href: "/docs/reference/cli/verify" },
					{ label: "Elench, the engine", href: "/docs/concepts/elench" },
				],
			}}
		/>
	);
}

export function Close() {
	return (
		<PageClose
			line="Provision it. Prove it."
			ctas={[
				{ label: "Start free", href: "/signup" },
				// Was /contact/enterprise, which is the TRIAL form, not a demo.
				{ label: "Talk to sales", href: "/contact/sales", variant: "outline" },
			]}
		/>
	);
}

/**
 * The thin line above the fold, and the page's Beta label. Home only — /pricing
 * and /enterprise do not carry it.
 *
 * It says two things a visitor should know before they sign up: the product is in
 * beta, with no uptime SLA, and which clouds it runs on. The cloud names come from
 * `@repo/cloud-catalog`, so a cloud that is hidden drops out of this line by itself.
 * It names no launch date, because the date can still move (decision M15, 2026-11-17).
 */
export function Announce() {
	return (
		<div className="py-2.5 text-center" style={{ borderBottom: "1px solid var(--border-faint)" }}>
			<Link
				href="/docs/get-started"
				className="vx-clamp vx-clamp--tight inline-flex flex-wrap items-center justify-center gap-2 text-[11px] text-text-tertiary no-underline transition-colors hover:text-text-secondary"
			>
				<Badge variant="outline" className="vx-badge-mono px-1.5 py-px">
					Beta
				</Badge>
				{`On ${cloudListLabel()}. No uptime SLA during the beta.`}
				<span className="text-text-disabled">Get started ›</span>
			</Link>
		</div>
	);
}
