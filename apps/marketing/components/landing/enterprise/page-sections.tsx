// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	ActionLink,
	Actions,
	Block,
	Cell,
	Close,
	EditorialStatement,
	RowHead,
	Rows,
	RuleHead,
	Steps,
	TableBox,
	type Row,
	type Step,
} from "@/components/landing/editorial";

/**
 * The enterprise page, editorial: a statement, four capabilities as a ruled list, the one visual
 * that earns its place (who can do what, with a deny that wins), how a trial works, contact.
 *
 * Every claim is narrower than the bands it replaced, on purpose:
 * - SSO says what is registered, not that it is enforced — nothing in the console turns password
 *   sign-in off for an org today.
 * - The record row says what `lib/authz/activity.ts` records: every denial and every non-read
 *   action. Successful reads are skipped.
 */

/** The one contact form, with the enterprise topic preset. */
const CONTACT = "/contact?topic=enterprise";

/** The four capabilities. Plain rows, not links: the docs link sits in the statement. */
const CAPABILITIES: Row[] = [
	{ d: "01", k: "Identity", t: "Single sign-on with OIDC or SAML 2.0, set once for the organization" },
	{ d: "02", k: "Access", t: "Teams, custom roles and grants down to one action on one project — a deny always wins" },
	{ d: "03", k: "Record", t: "Every change and every denied attempt on the record, exportable to your SIEM" },
	{ d: "04", k: "Deployment", t: "Hosted, or a single-tenant control plane inside your own perimeter" },
];

/** One example grant. */
interface Grant {
	principal: string;
	role: string;
	scope: string;
	effect: "allow" | "deny";
}

/**
 * The last row is the argument: an explicit deny that outranks the allow above it. Without it
 * this is just a list of permissions.
 */
const GRANTS: Grant[] = [
	{ principal: "team:platform", role: "admin", scope: "org · Acme", effect: "allow" },
	{ principal: "team:payments", role: "operator", scope: "project:production", effect: "allow" },
	{ principal: "dana@acme.cloud", role: "viewer", scope: "project:api", effect: "allow" },
	{ principal: "contractor@ext", role: "operator", scope: "project:staging", effect: "allow" },
	{ principal: "contractor@ext", role: "—", scope: "project:* · destroy", effect: "deny" },
];

/** How a trial runs, in three steps. */
const TRIAL: Step[] = [
	{ title: "Tell us your shape", body: "Your identity provider, your teams, where your data has to live. By email." },
	{ title: "Pilot on one team", body: "We set it up with you on real infrastructure, keyless from day one." },
	{ title: "Roll out", body: "Bring the other teams in; your grants and audit trail come with them." },
];

/** The opening statement and the two actions. */
function Opening() {
	return (
		<EditorialStatement
			lead="Every cloud account, every team, every change — governed in one place."
			rest="Bring your identity provider; Alethia maps who can do what, and writes down every decision."
		>
			<Actions>
				<ActionLink link={{ label: "Talk to us", href: CONTACT }} />
				<ActionLink
					variant="outline"
					link={{ label: "Read the access docs ↗", href: "/docs/guides/access/organizations", external: true }}
				/>
			</Actions>
		</EditorialStatement>
	);
}

/** The four capabilities, as ruled rows. */
function WhatYouGet() {
	return (
		<Block label="What you get">
			<RuleHead title="What you get" />
			<Rows rows={CAPABILITIES} />
		</Block>
	);
}

/**
 * Example grants as a real table. The effect is told by fill and shape (● / ○), never by hue —
 * the house rule for status.
 */
function WhoCanDoWhat() {
	return (
		<Block label="Who can do what">
			<RuleHead title="Who can do what" aside="example organization" />
			<TableBox caption="Example access grants: who, role, where, and effect" columns={["Who", "Role", "Where", "Effect"]} minWidth={520}>
				{GRANTS.map((g) => (
					<tr key={`${g.principal}-${g.scope}`}>
						<RowHead>{g.principal}</RowHead>
						<Cell tone={g.role === "—" ? "quiet" : undefined}>{g.role}</Cell>
						<Cell isMono>{g.scope}</Cell>
						{g.effect === "allow" ? <Cell tone="strong">● allow</Cell> : <Cell>○ deny — wins</Cell>}
					</tr>
				))}
			</TableBox>
		</Block>
	);
}

/** How a trial works. */
function Trial() {
	return (
		<Block label="How a trial works">
			<RuleHead title="How a trial works" />
			<Steps steps={TRIAL} />
		</Block>
	);
}

/** The close: the headline, the one action, and how we answer. */
function Closing() {
	return (
		<Close lines={["Bring your identity provider.", "We will map the rest."]}>
			<ActionLink link={{ label: "Talk to us", href: CONTACT }} />
			<span className="text-ui-md text-text-secondary">We reply by email.</span>
		</Close>
	);
}

/** Enterprise page body, in order. */
export function EnterpriseSections() {
	return (
		<>
			<Opening />
			<WhatYouGet />
			<WhoCanDoWhat />
			<Trial />
			<Closing />
		</>
	);
}
