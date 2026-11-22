// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { CURRENT_LEGAL_OPERATOR } from "@repo/legal/entity";
import type { Metadata } from "next";
import Link from "next/link";
import { mono, Wrap } from "@repo/brand/site-primitives";
import { SiteShell } from "@repo/brand/site-shell";
import { Block, Card, Cell, EditorialStatement, RowHead, TableBox } from "@/components/landing/editorial";

export const metadata: Metadata = {
	title: "Security",
	description:
		"The credentials Alethia deliberately never holds: exactly what is stored for AWS, Google Cloud, Azure and Hetzner, how Alethia gets in, and how you revoke it. No certification is claimed; vulnerabilities go to security@alethialabs.io.",
};

/**
 * Read by `scripts/check-legal-set.mjs` as this page's displayed date — it matches the first
 * "Last updated", a middle dot, then a long date closed by a double quote — so it stays one string
 * literal in that exact shape, and no other text in this file may spell that prefix.
 */
const LAST_UPDATED = "Last updated · November 22, 2026";

/** One cloud's row in the ledger. `holdsNothing` marks the clouds where nothing is stored. */
interface LedgerRow {
	cloud: string;
	access: string;
	stored: string;
	holdsNothing: boolean;
	revoke: string;
}

/**
 * The ledger, cloud by cloud. Hetzner is the one exception: it has no federation, so its scoped
 * API token is encrypted at rest and decrypted only for the job — and a self-managed runner keeps
 * it from reaching us at all. Same terms as the pricing FAQ, which used to be the only other page
 * that stated it, and disagreed.
 */
const LEDGER: LedgerRow[] = [
	{ cloud: "AWS", access: "Short-lived role assumed per job (OIDC)", stored: "Nothing", holdsNothing: true, revoke: "Delete the IAM role" },
	{ cloud: "Google Cloud", access: "Workload Identity Federation per job", stored: "Nothing", holdsNothing: true, revoke: "Remove the binding" },
	{ cloud: "Azure", access: "Federated credential on your managed identity", stored: "Nothing", holdsNothing: true, revoke: "Delete the federated credential" },
	{ cloud: "Hetzner", access: "A scoped API token (no federation exists)", stored: "Encrypted at rest; never with a self-managed runner", holdsNothing: false, revoke: "Revoke the token" },
];

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
 * The public security page: one statement, then a single table of what Alethia holds and does
 * not hold, cloud by cloud, then what we do hold, certifications and disclosure.
 *
 * Deliberately makes no certification claim, because none is held. Every statement is
 * architectural and checkable against the AGPL source.
 */
export default function SecurityPage() {
	return (
		<SiteShell>
			<EditorialStatement
				lead="The credentials we deliberately never hold."
				rest="Here is exactly what Alethia stores for each cloud, and what it does not."
			/>

			<Block label="What Alethia stores, cloud by cloud">
				<TableBox
					caption="What Alethia stores for each cloud, how it gets in, and how you revoke it"
					columns={["Cloud", "How Alethia gets in", "Stored by Alethia", "How you revoke it"]}
					minWidth={640}
				>
					{LEDGER.map((row) => (
						<tr key={row.cloud}>
							<RowHead>{row.cloud}</RowHead>
							<Cell>{row.access}</Cell>
							<Cell tone={row.holdsNothing ? "strong" : undefined}>{row.stored}</Cell>
							<Cell>{row.revoke}</Cell>
						</tr>
					))}
				</TableBox>
				<div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
					<Card label="What we do hold">
						The signing key for our identity provider: the private half never leaves the control
						plane, and the public keys are published. We also hold the credentials you give us
						for the git provider and the connectors you choose to connect.
					</Card>
					<Card label="Certifications">
						No SOC 2 or ISO 27001 today, and we will not imply otherwise. The code is open for you
						to check instead.
					</Card>
					<Card label="Report a vulnerability">
						<a href="mailto:security@alethialabs.io" className="text-text-primary" style={mono}>
							security@alethialabs.io
						</a>{" "}
						— acknowledged within five business days.
					</Card>
				</div>
			</Block>

			<section aria-label="Related documents" className="pb-20 max-[640px]:pb-14">
				<Wrap>
					<div className="grid gap-4 pt-6" style={{ borderTop: "1px solid var(--border)" }}>
						<p className="m-0 text-ui-sm text-text-tertiary" style={mono}>
							{LAST_UPDATED}
						</p>
						<ul className="m-0 flex list-none flex-wrap gap-x-6 gap-y-2 p-0">
							{RELATED.map((doc) => (
								<li key={doc.href}>
									<Link href={doc.href} className="text-ui-sm text-text-secondary no-underline hover:text-text-primary">
										{doc.label}
									</Link>
								</li>
							))}
						</ul>
						<p className="m-0 max-w-[64ch] text-ui-sm leading-[1.6] text-text-tertiary">
							This page describes the Service as operated by {CURRENT_LEGAL_OPERATOR}. It is a
							description of architecture, not a warranty; the binding commitments are in the{" "}
							<Link href="/terms" className="text-text-secondary">
								Terms
							</Link>{" "}
							and the DPA.
						</p>
					</div>
				</Wrap>
			</section>
		</SiteShell>
	);
}
