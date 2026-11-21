// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { AVAILABLE_CLOUDS, cloudListLabel } from "@repo/cloud-catalog";
import {
	Band,
	LogoWall,
	PageClose,
	PageOpen,
	Plate,
} from "@repo/brand/site-sections";
import { JOBS, JobsTable, Wrap } from "@repo/brand/site-primitives";
import { CommandBlock } from "@repo/brand/site-command-block";

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
 * The four commands the CLI band lists. Each is a real top-level command in
 * apps/cli/cmd (login.go, apply.go for `plan` and `apply`, verify_receipt.go).
 * This used to be a pasted `verify receipt` transcript whose catalog version,
 * control count and key id disagreed with the receipt card one band below — two
 * "real" artefacts on one page that could not both be true.
 */
const CLI_COMMANDS: { command: string; what: string }[] = [
	{ command: "alethia login", what: "Sign in from the terminal." },
	{ command: "alethia plan", what: "Show what alethia.yaml would change." },
	{ command: "alethia apply", what: "Create it and deploy every environment." },
	{ command: "alethia verify receipt --latest", what: "Check the newest receipt's signature." },
];

/**
 * The CLI install line, from the recommended method on
 * /docs/get-started/install-the-cli.
 */
const CLI_INSTALL = "brew install alethialabs-io/tap/alethia";

/** The opening: headline left, three plain statements right. */
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
					// "verify offline, without us" is said by the announce line and the
					// receipt band; a third time here was one too many.
					"Every apply seals a signed receipt.",
				],
			}}
		/>
	);
}

/** The clouds Alethia provisions into, from the cloud catalog. */
export function Clouds() {
	return (
		<LogoWall
			eyebrow="Provisions into"
			providers={[...AVAILABLE_CLOUDS]}
		/>
	);
}

/** The console band: the jobs table and the designer links. */
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
				// Was "Nineteen component kinds". The console's component registry
				// (apps/console/lib/cli/project-components.ts) lists fourteen, so the
				// count was wrong; the claim no longer carries one.
				proof: {
					lead: "One Project",
					rest: " holds the clusters, databases, caches, queues and buckets of every environment.",
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

/** The CLI band: four real commands and the install line. */
export function CliBand() {
	return (
		<Band
			lines={["Or drive the whole thing", "from your shell."]}
			visual={
				<div className="space-y-6">
					<Plate label="zsh">
						<ul className="m-0 list-none p-0" style={{ background: "var(--surface-sunken)" }}>
							{CLI_COMMANDS.map((item) => (
								<li
									key={item.command}
									className="flex flex-wrap items-baseline gap-x-6 gap-y-1 px-5 py-3.5"
									style={{ borderBottom: "1px solid var(--border-faint)" }}
								>
									<code className="font-mono text-ui-sm text-text-primary">{item.command}</code>
									<span className="text-ui-sm text-text-tertiary">{item.what}</span>
								</li>
							))}
						</ul>
					</Plate>
					<CommandBlock label="Install" command={CLI_INSTALL} />
				</div>
			}
			rail={{
				proof: {
					lead: "Plan, apply, verify",
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

/** The receipt band: the sample signed receipt, labelled as a demo. */
export function ReceiptBand() {
	return (
		<Band
			// The card is the engine's real output signed with a DEMO key (see
			// lib/proof/verify-receipt-sample.ts), so the band says so.
			eyebrow="Sample receipt · demo signing key"
			lines={["Every apply", "leaves evidence."]}
			visual={<VerifyReceipt />}
			rail={{
				proof: {
					lead: "Signed ed25519",
					rest: ", the receipt verifies offline against your org's published key — without us.",
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

/** The closing line and its two actions. */
export function Close() {
	return (
		<PageClose
			line="Provision it. Prove it."
			ctas={[
				{ label: "Start free", href: "/signup" },
				{ label: "Contact", href: "/contact?topic=demo", variant: "outline" },
			]}
		/>
	);
}

/**
 * One quiet line for the services side of the company, just above the close.
 * No visual and no band headline: the product is the page, this is a pointer.
 */
export function LabsLine() {
	return (
		<section className="py-14" style={{ borderTop: "1px solid var(--border)" }}>
			<Wrap>
				<p className="m-0 flex flex-wrap items-baseline gap-x-4 gap-y-2 text-ui-md text-text-secondary">
					<span>Need hands on your platform? Alethia Labs builds and audits cloud platforms for teams.</span>
					<Link
						href="/services"
						className="vx-clamp vx-clamp--tight text-text-primary no-underline transition-colors hover:text-text-secondary"
					>
						Services ›
					</Link>
				</p>
			</Wrap>
		</section>
	);
}

/** The thin line above the fold. Home only — /pricing and /enterprise do not carry it. */
export function Announce() {
	return (
		<div className="py-2.5 text-center" style={{ borderBottom: "1px solid var(--border-faint)" }}>
			<Link
				href="/docs/concepts/elench/receipts"
				className="vx-clamp vx-clamp--tight inline-flex items-center gap-2 text-[11px] text-text-tertiary no-underline transition-colors hover:text-text-secondary"
			>
				Receipts verify offline, without us
				<span className="text-text-disabled">Read the spec ›</span>
			</Link>
		</div>
	);
}
