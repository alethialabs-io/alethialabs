// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { CommandBlock } from "@repo/brand/site-command-block";
import { mono } from "@repo/brand/site-primitives";
import {
	ActionLink,
	Actions,
	Block,
	Card,
	Cell,
	EditorialStatement,
	RowHead,
	Rows,
	RuleHead,
	TableBox,
	type Row,
} from "@/components/landing/editorial";

/**
 * The /open-source page, editorial: one statement with the install command, an honest table of
 * what is open and what is commercial, the ways to run it, and the licence.
 */

const REPO_URL = "https://github.com/alethialabs-io/alethialabs";

/**
 * The self-host installer, the one place the site spells it.
 *
 * It depends on the `get.alethialabs.io/self-host` route serving `deploy/install.sh`; if that
 * route moves or stops answering, this command breaks for everyone who copies it.
 */
export const SELF_HOST_INSTALL_COMMAND = "curl -fsSL https://get.alethialabs.io/self-host | sh";

/** One row of the open/commercial table. `enterprise: null` means nothing extra is licensed. */
interface Part {
	name: string;
	open: string;
	enterprise: string | null;
}

/**
 * The split follows /docs/editions/feature-matrix: SSO, custom roles, audit export, alerting and
 * the managed runner pool are the licensed rows; everything else is AGPL.
 */
const PARTS: Part[] = [
	{ name: "Console", open: "Full control plane, project designer, GitOps", enterprise: "Organizations with many members" },
	{ name: "alethia CLI", open: "Every command", enterprise: null },
	{ name: "Runner", open: "The runner and multi-cloud provisioning", enterprise: "The managed runner pool" },
	{ name: "Identity", open: "Sign-in, built-in roles", enterprise: "SSO (OIDC, SAML), custom roles" },
	{ name: "Record", open: "Activity log", enterprise: "Audit export, alerting" },
];

/**
 * The four documented ways to run a self-hosted control plane. The OpenTofu row is scoped to
 * the per-cloud stacks on purpose: the one-click templates open 22/80/443.
 */
const WAYS: Row[] = [
	{ d: "One VM", k: "Docker Compose", t: "The whole bundle behind Caddy, one command", href: "/docs/self-host" },
	{ d: "Per cloud", k: "OpenTofu", t: "Version-controlled, closed-origin behind a tunnel", href: "/docs/self-host/terraform" },
	{ d: "Existing cluster", k: "Helm", t: "The same bundle on Kubernetes you already run", href: "/docs/self-host/helm" },
	{ d: "AWS · Azure", k: "One-click", t: "Launch from a prefilled template", href: "/docs/self-host/one-click" },
];

/** The opening statement, the install command and the two actions. */
function Opening() {
	return (
		<EditorialStatement
			lead="The control plane is open source."
			rest="Run it on your own infrastructure, read every line of it, and keep it for as long as you like."
		>
			<div className="min-w-0 max-w-[640px]">
				<CommandBlock command={SELF_HOST_INSTALL_COMMAND} />
			</div>
			<Actions>
				<ActionLink link={{ label: "Self-hosting guide ↗", href: "/docs/self-host", external: true }} />
				<ActionLink variant="outline" link={{ label: "View on GitHub ↗", href: REPO_URL, external: true }} />
			</Actions>
		</EditorialStatement>
	);
}

/** What is AGPL and what is commercial, part by part, and where the boundary is enforced. */
function WhatIsOpen() {
	return (
		<Block label="What is open, and what is not">
			<RuleHead title="What is open, and what is not" action={{ label: "Editions ↗", href: "/docs/editions", external: true }} />
			<TableBox
				caption="What is open source and what is commercial, part by part"
				columns={["Part", "Open source (AGPL-3.0)", "Enterprise (ee/, commercial)"]}
				minWidth={560}
			>
				{PARTS.map((p) => (
					<tr key={p.name}>
						<RowHead>{p.name}</RowHead>
						<Cell tone="strong">{p.open}</Cell>
						{p.enterprise === null ? (
							<Cell tone="quiet">
								<span aria-hidden="true">—</span>
								<span className="sr-only">Nothing extra</span>
							</Cell>
						) : (
							<Cell>{p.enterprise}</Cell>
						)}
					</tr>
				))}
			</TableBox>
			<p className="m-0 mt-3.5 text-sm text-text-secondary">
				The commercial code lives in one directory, <span style={mono}>ee/</span>, and a CI check fails
				any change that lets the open core depend on it.
			</p>
		</Block>
	);
}

/** The ways to run it, as ruled link rows into the self-hosting guides. */
function WaysToRun() {
	return (
		<Block label="Ways to run it">
			<RuleHead title="Ways to run it" action={{ label: "All guides ↗", href: "/docs/self-host", external: true }} />
			<Rows rows={WAYS} />
		</Block>
	);
}

/** The licence, and the hosted service for anyone who would rather not run it. */
function LicenceAndHosted() {
	return (
		<Block label="Licence and hosted service">
			<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
				<Card label="Licence" title="GNU AGPL-3.0">
					OSI-approved open source, not source-available. Use it, change it, run it commercially;
					share changes you serve to others.
				</Card>
				<Card
					label="Rather not run it?"
					title="Use the hosted service"
					action={<ActionLink variant="outline" link={{ label: "See pricing", href: "/pricing" }} />}
				>
					The same product, operated by us on our infrastructure.
				</Card>
			</div>
		</Block>
	);
}

/** All sections of the /open-source page, in order. */
export function OpenSourceSections() {
	return (
		<>
			<Opening />
			<WhatIsOpen />
			<WaysToRun />
			<LicenceAndHosted />
		</>
	);
}
