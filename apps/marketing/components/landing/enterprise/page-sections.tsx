// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	Band,
	Eyebrow,
	LogoWall,
	PageOpen,
	Plate,
	PointGrid,
	Section,
} from "@repo/brand/site-sections";
import { mono } from "@repo/brand/site-primitives";
import { StatusBadge } from "@repo/ui/status-badge";
import { ContactForm } from "@/components/contact/contact-form";

/**
 * The enterprise page.
 *
 * This file was 2,084 lines of inline `style={{}}` objects with `!important`
 * media patches in the app stylesheet. Most of that was chrome, not content: a
 * 126-line fake browser Frame, a 133-line decision-trace panel, two hand-rolled
 * `display: grid` "tables" with no `<th scope>`, a four-tile pillar band that
 * restated the five sections beneath it, and a plan card that duplicated
 * /pricing's Enterprise tier with a different and partly wrong feature list.
 *
 * ── The `Reveal` contract, which fails silently ──────────────────────────────
 * `app/enterprise/page.tsx` wraps this in `<Reveal>`, which does
 * `querySelectorAll(":scope > section")` and `.slice(1)`. So this component MUST
 * return a flat fragment of `<section>` elements with the hero first. Wrap a run
 * of them in a layout <div> and every scroll animation on the page dies — with
 * no type error, no lint error and no build failure. Every primitive imported
 * above renders `<section>` as its outermost element.
 */

const SALES = "/contact/sales";

/* ============ Grants — the one visual on the page ============ */

interface Grant {
	principal: string;
	role: string;
	scope: string;
	effect: "allow" | "deny";
}

/**
 * The last row is the argument: an explicit deny that outranks the allow above
 * it. Without it this is just a list of permissions.
 */
const GRANTS: Grant[] = [
	{ principal: "team:platform", role: "admin", scope: "org · Acme Cloud", effect: "allow" },
	{ principal: "team:payments", role: "operator", scope: "project:production", effect: "allow" },
	{ principal: "dana@acme.cloud", role: "viewer", scope: "project:api-backend", effect: "allow" },
	{ principal: "contractor@ext", role: "operator", scope: "project:staging", effect: "allow" },
	{ principal: "contractor@ext", role: "—", scope: "project:* · destroy", effect: "deny" },
];

/**
 * A real `<table>`, with `<th scope>` on both axes.
 *
 * The two data structures this page used to render — a capability matrix and an
 * audit log — were stacks of `display: grid` divs, so a screen reader received an
 * undifferentiated run of text with no way to tell which cell belonged to which
 * column. `pricing.tsx` had the same bug and it was fixed there; this is that fix.
 */
function GrantsTable() {
	return (
		<table className="w-full border-collapse text-left">
			<caption className="sr-only">
				Example access grants — principal, role, scope, and effect
			</caption>
			<thead>
				<tr style={{ borderBottom: "1px solid var(--border-faint)" }}>
					{["Principal", "Role", "Scope", "Effect"].map((head) => (
						<th
							key={head}
							scope="col"
							className="vx-eyebrow px-4 py-2.5"
							style={{ fontSize: 9, fontWeight: 400 }}
						>
							{head}
						</th>
					))}
				</tr>
			</thead>
			<tbody>
				{GRANTS.map((grant) => (
					<tr
						key={`${grant.principal}-${grant.scope}`}
						style={{ borderBottom: "1px solid var(--border-faint)" }}
					>
						<th
							scope="row"
							className="px-4 py-[11px] text-[11.5px] font-normal text-text-primary"
							style={mono}
						>
							{grant.principal}
						</th>
						<td
							className="px-4 py-[11px] text-[11px]"
							style={{
								...mono,
								color: grant.role === "—" ? "var(--text-disabled)" : "var(--text-secondary)",
							}}
						>
							{grant.role}
						</td>
						<td className="px-4 py-[11px] text-[11px] text-text-tertiary" style={mono}>
							{grant.scope}
						</td>
						<td className="px-4 py-[11px]">
							{/* Fill and shape, never hue — the house rule for status. `label` is
							    required: StatusBadge defaults its label to the status string, so
							    without it this column reads "ACTIVE"/"FAILED" rather than the
							    effect it is reporting. */}
							<StatusBadge
								status={grant.effect === "allow" ? "active" : "failed"}
								label={grant.effect}
							/>
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

/* ============ Sections ============ */

function Hero() {
	return (
		<PageOpen
			lines={["Production access,", "on the record,", "organization-wide."]}
			ctaSide="right"
			side={{
				kind: "lede",
				text: "Single sign-on, custom roles over OpenFGA, granular IAM, and an audit trail you can export. Access maps to who needs it, and every decision is written down.",
			}}
			ctas={[
				{ label: "Talk to sales", href: SALES },
				{ label: "Request a trial", href: "#trial", variant: "outline" },
			]}
		/>
	);
}

function Clouds() {
	return (
		<LogoWall
			eyebrow="Provisions into"
			providers={["aws", "gcp", "azure", "hetzner", "alibaba"]}
		/>
	);
}

function Organizations() {
	return (
		<Band
			eyebrow="Organizations"
			lines={["One org, many teams.", "Grants target groups."]}
			visual={
				<Plate label="alethialabs.io/access">
					<GrantsTable />
				</Plate>
			}
			rail={{
				proof: {
					lead: "Membership is the source of truth",
					rest: " — remove someone from the team and the access goes with them. A deny anywhere outranks every allow.",
				},
				label: "Access",
				links: [
					{ label: "Organizations", href: "/docs/access-control/organizations" },
					{ label: "Teams", href: "/docs/access-control/teams" },
					{ label: "Grants and scopes", href: "/docs/access-control/grants-and-scopes" },
					{ label: "The access portal", href: "/docs/access-control/access-portal" },
				],
			}}
		/>
	);
}

function Identity() {
	return (
		<Band
			eyebrow="Identity"
			lines={["Bring your identity provider.", "Enforce it org-wide."]}
			visual={
				<PointGrid
					points={[
						{
							title: "OIDC and SAML 2.0",
							body: "Wire your provider once, for the whole organization. Standards-based, so there is no per-IdP integration to wait on.",
						},
						{
							title: "Enforced, not optional",
							body: "Turn it on and password sign-in is disabled org-wide. Every member arrives through your directory.",
						},
						{
							// Was "SCIM keeps membership in sync automatically". SCIM is not
							// built — docs/standards/scim-saml.mdx says so in an error
							// callout, and there is no /scim/v2 endpoint. This is what
							// actually happens.
							title: "Just-in-time membership",
							body: "A member is created on their first successful sign-in through SSO. Removal is an admin action today, not a directory push.",
						},
						{
							title: "Least privilege on arrival",
							body: "First-login role is viewer. Grants raise it deliberately, per team or per project.",
						},
					]}
				/>
			}
		/>
	);
}

function Roles() {
	return (
		<Band
			eyebrow="Roles"
			lines={["Four roles out of the box.", "Define your own."]}
			visual={
				<PointGrid
					points={[
						{
							title: "owner, admin, operator, viewer",
							body: "Four built-in roles that cover most teams without any configuration at all.",
						},
						{
							title: "Custom roles",
							body: "Compose allow and deny down to a single capability, on a single project.",
						},
						{
							title: "Deny wins",
							body: "A deny anywhere in the graph beats every allow above it. Exclusions stay measurable.",
						},
						{
							title: "OpenFGA over Postgres RBAC",
							body: "Relationship checks, not a role string on a row — so a grant can target a team and every member inherits it.",
						},
					]}
				/>
			}
		/>
	);
}

function Audit() {
	return (
		<Band
			eyebrow="Audit"
			lines={["Every authorization decision,", "written down."]}
			visual={
				<PointGrid
					points={[
						{
							title: "Who, what, which resource",
							body: "And whether it was allowed or denied — for every check, not a sample.",
						},
						{
							title: "The grant that decided it",
							body: "Not just the verdict. The record names the grant the decision resolved through.",
						},
						{
							title: "Append-only",
							body: "The record is not editable after the fact, by anyone, including us.",
						},
						{
							title: "Exportable",
							body: "Filter it, export it, and take it to your own SIEM.",
						},
					]}
				/>
			}
		/>
	);
}

function Deployment() {
	return (
		<Band
			eyebrow="Deployment"
			lines={["Run it where", "your data lives."]}
			visual={
				<PointGrid
					points={[
						{
							title: "Keyless on AWS, GCP, Azure and Alibaba",
							body: "The runner mints a short-lived assertion per job — cross-account IAM role, workload identity federation, or federated identity. No access key touches disk.",
						},
						{
							// The page used to generalise this to "every cloud … no access
							// keys on disk or in our database", which is false for the
							// token clouds. See docs/runner/cloud-credentials.
							title: "Token clouds can stay yours",
							body: "Hetzner, DigitalOcean and Civo have no federation, so a scoped token is stored encrypted at rest. Run a self-managed runner and it never reaches us at all.",
						},
						{
							// Was "run the entire control plane … air-gapped". The docs
							// support air-gapped for the RUNNER; there is no air-gapped
							// control-plane guide.
							title: "Hosted or self-managed",
							body: "Run the control plane inside your own perimeter, single-tenant. Runners can sit on-premises or air-gapped.",
						},
						{
							title: "AGPL core",
							body: "The complete single-tenant product is open source. Governance is the commercial ee/ tier.",
						},
					]}
				/>
			}
			rail={{
				proof: {
					lead: "Your cloud account, your state",
					rest: " — Alethia provisions into infrastructure you already own and can walk away with.",
				},
				label: "Security",
				links: [
					{ label: "How credentials work", href: "/docs/runner/cloud-credentials" },
					{ label: "Self-hosted runners", href: "/docs/runner/self-hosted" },
					{ label: "SSO and SAML", href: "/docs/standards/scim-saml" },
					{ label: "Open core, honestly", href: "/open-source" },
				],
			}}
		/>
	);
}

/**
 * The trial form.
 *
 * `<ContactForm>` and not `<ContactSection>`: the latter renders its own `<h1>`
 * plus a pitch rail and is a page hero, so dropping it here would ship a second
 * `<h1>` on a page that already has one. The form itself renders no heading at
 * all, so it sits under this `<h2>` cleanly. It posts the same
 * `type: "enterprise"` lead through the same server action as
 * `/contact/enterprise`, which stays as its own route.
 */
function Trial() {
	return (
		<Section id="trial">
			<Eyebrow>Enterprise trial</Eyebrow>
			<h2
				className="font-grotesk text-display-sm font-bold tracking-[-0.025em] text-text-primary"
				style={{ margin: 0, maxWidth: "18ch", lineHeight: 1.02 }}
			>
				Tell us how your org is shaped.
			</h2>
			<p className="mt-5 max-w-[46ch] text-[13px] leading-[1.6] text-text-secondary">
				Your identity provider, your teams, and where your data has to live. We map it to
				Alethia and stand it up with you.
			</p>
			<div className="mt-12 max-w-[560px]">
				<ContactForm type="enterprise" submitLabel="Request your trial" />
			</div>
		</Section>
	);
}

/** Enterprise page body. Flat fragment of sections — see the note at the top. */
export function EnterpriseSections() {
	return (
		<>
			<Hero />
			<Clouds />
			<Organizations />
			<Identity />
			<Roles />
			<Audit />
			<Deployment />
			<Trial />
		</>
	);
}
