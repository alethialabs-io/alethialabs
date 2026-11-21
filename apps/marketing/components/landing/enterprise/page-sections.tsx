// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { AVAILABLE_CLOUDS } from "@repo/cloud-catalog";
import {
	Band,
	LogoWall,
	PageClose,
	PageOpen,
	Plate,
	PointGrid,
} from "@repo/brand/site-sections";
import { mono } from "@repo/brand/site-primitives";
import { StatusBadge } from "@repo/ui/status-badge";

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
 * It is now five sections: hero, clouds, the grants band, one grid of four
 * points, close. The Identity / Roles / Audit / Deployment bands were sixteen
 * points restating the docs; the inline trial form is gone because every
 * "talk to us" path on the site is the one /contact form.
 *
 * ── The `Reveal` contract, which fails silently ──────────────────────────────
 * `app/enterprise/page.tsx` wraps this in `<Reveal>`, which does
 * `querySelectorAll(":scope > section")` and `.slice(1)`. So this component MUST
 * return a flat fragment of `<section>` elements with the hero first. Wrap a run
 * of them in a layout <div> and every scroll animation on the page dies — with
 * no type error, no lint error and no build failure. Every primitive imported
 * above renders `<section>` as its outermost element.
 */

/** The one contact form, with the enterprise topic preset. */
const CONTACT = "/contact?topic=enterprise";

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

/** The opening: the headline, one sentence, and the two actions. */
function Hero() {
	return (
		<PageOpen
			lines={["Production access,", "on the record,", "organization-wide."]}
			ctaSide="right"
			side={{
				kind: "lede",
				text: "SSO, custom roles and an exportable audit trail across every cloud you run.",
			}}
			ctas={[
				{ label: "Contact", href: CONTACT },
				{ label: "Read the docs", href: "/docs/guides/access/organizations", variant: "outline" },
			]}
		/>
	);
}

/** The clouds Alethia provisions into, from the cloud catalog. */
function Clouds() {
	return (
		<LogoWall
			eyebrow="Provisions into"
			providers={[...AVAILABLE_CLOUDS]}
		/>
	);
}

/** The one proof band: example grants, with a deny that outranks an allow. */
function Organizations() {
	return (
		<Band
			eyebrow="Organizations"
			lines={["One org, many teams.", "Grants target groups."]}
			visual={
				<Plate label="alethialabs.io/access">
					{/* The table is wider than a phone; it scrolls inside the plate. */}
					<div className="overflow-x-auto">
						<GrantsTable />
					</div>
				</Plate>
			}
			rail={{
				proof: {
					lead: "Membership is the source of truth",
					rest: " — remove someone from the team and the access goes with them. A deny anywhere outranks every allow.",
				},
				label: "Access",
				links: [
					{ label: "Organizations", href: "/docs/guides/access/organizations" },
					{ label: "Teams", href: "/docs/guides/access/teams" },
					{ label: "Grants and scopes", href: "/docs/guides/access/grants-and-scopes" },
					{ label: "The access portal", href: "/docs/guides/access/access-portal" },
				],
			}}
		/>
	);
}

/**
 * Four points, one sentence each. Every claim here is narrower than the bands it
 * replaced, on purpose:
 * - SSO says what is registered, not that it is enforced — nothing in the
 *   console turns password sign-in off for an org today.
 * - The audit point says what `lib/authz/activity.ts` records: every denial and
 *   every non-read action. Successful reads are skipped, so "every check" was
 *   false, and the row carries a reason code, not the grant that decided it.
 */
function Governance() {
	return (
		<Band
			eyebrow="Governance"
			lines={["Identity, roles, audit,", "and where it runs."]}
			visual={
				<PointGrid
					points={[
						{
							title: "Your identity provider",
							body: "OIDC or SAML 2.0, registered once for the organization.",
						},
						{
							title: "Custom roles, deny wins",
							body: "Allow or deny down to one capability on one project; a deny outranks every allow.",
						},
						{
							title: "Every change on the record",
							body: "Who did what to which resource, and every denied attempt — exportable as CSV for your SIEM.",
						},
						{
							title: "Hosted or self-managed",
							body: "A single-tenant control plane inside your perimeter, keyless on AWS, GCP and Azure.",
						},
					]}
				/>
			}
		/>
	);
}

/** The closing line and the one action. */
function Close() {
	return (
		<PageClose
			line="Bring your identity provider. We'll map the rest."
			ctas={[{ label: "Contact", href: CONTACT }]}
		/>
	);
}

/** Enterprise page body. Flat fragment of sections — see the note at the top. */
export function EnterpriseSections() {
	return (
		<>
			<Hero />
			<Clouds />
			<Organizations />
			<Governance />
			<Close />
		</>
	);
}
