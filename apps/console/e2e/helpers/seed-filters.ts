// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Rows for the live filter-standard pass (F8–F10, `e2e/audit/filters.spec.ts`, #4278).
//
// A filter over ONE row cannot narrow anything, so F8 ("the narrowed list survives a reload") and
// F9 ("facet counts do not move") are only askable over a list of at least two rows whose facet
// values DIFFER. This file writes that minimum for the lists it can reach with a plain insert, and
// nothing else: every extra row is a page some other audit can no longer read the empty state of.
//
// WHAT IT DOES NOT SEED, AND WHY THAT IS NOT SILENT. Members, connectors, roles and org-level
// access are not written here: the rows other fixtures already put in the run's org give each of
// them a narrowing option (measured on run 36052124183), and a second copy would only move counts
// `inert.spec.ts` reads. The activity feeds (org and project) are not seeded, for two reasons that
// each suffice: their bar renders no counted facet at all, so no row could make them measurable;
// and `authz_activity_log` is append-only — a DELETE outside the retention GC raises, so a row
// written here could never be removed again (measured on run 36055847035). The spec does not
// guess: a list that still renders fewer than two rows — or a bar with no counted option — is
// recorded NOT MEASURED naming why, so the gap is a column in the scoreboard rather than a PASS over
// nothing. Extending coverage is adding a row here, not editing a verdict.
//
// Invoices are NOT a Stripe object here: the billing UI reads `invoice`, the local mirror the Stripe
// webhook writes (`lib/db/schema/invoices.ts`), so a plain insert reaches the page. This header said
// otherwise until #5045, and the page stayed unmeasured on the strength of the sentence.
//
// EVERY ROW IS REMOVED AGAIN. The spec shares an organisation with `inert.spec.ts` (R8), which runs
// after it in the same `audit-interaction` project and counts the controls each list renders; rows
// left behind here would move that count. `cleanFilterFixtures()` deletes exactly the ids it wrote.

import { db } from "./db";
import { seedCloudIdentity, seedJob, seedProject, type Owner, type SeededProject } from "./seed";
import { seedChannel, seedRule } from "./seed-alerts";

/** What one seeding pass wrote — the ids `cleanFilterFixtures()` removes, and the project a `[project]` route needs. */
export interface FilterFixtures {
	project: SeededProject;
	jobIds: string[];
	runnerIds: string[];
	channelIds: string[];
	ruleIds: string[];
	supportCaseIds: string[];
	cloudIdentityIds: string[];
	teamIds: string[];
	grantIds: string[];
	ssoProviderIds: string[];
	invoiceIds: string[];
}

/**
 * Write two rows with differing facet values into every list a plain insert reaches.
 *
 * The facet each pair differs on is named beside it, because "two rows" is not the requirement —
 * two rows that are identical on every facet give F9 nothing to compare and F8 nothing to narrow.
 *
 * Every id is recorded the moment its row is written, and an insert that throws midway deletes the
 * rows already written before the error propagates: the caller never receives a `FilterFixtures` in
 * that case, so without this the partial set would stay in the org `inert.spec.ts` counts next.
 */
export async function seedFilterFixtures(owner: Owner): Promise<FilterFixtures> {
	const stamp = Date.now();
	const project = await seedProject(owner, { name: `Filters ${stamp}` });
	const written: FilterFixtures = {
		project,
		jobIds: [],
		runnerIds: [],
		channelIds: [],
		ruleIds: [],
		supportCaseIds: [],
		cloudIdentityIds: [],
		teamIds: [],
		grantIds: [],
		ssoProviderIds: [],
		invoiceIds: [],
	};
	try {
		await seedRows(owner, stamp, written);
	} catch (err) {
		await cleanFilterFixtures(written).catch(() => {});
		throw err;
	}
	return written;
}

/** Write the rows `seedFilterFixtures()` promises into `written`'s project, recording each id as it lands. */
async function seedRows(owner: Owner, stamp: number, written: FilterFixtures): Promise<void> {
	const sql = db();
	const { project } = written;

	// Jobs (`/[org]/~/jobs`, `/[org]/[project]/jobs`): differ on STATUS and TYPE.
	written.jobIds.push((await seedJob(owner, { projectId: project.projectId, envId: project.envId, status: "SUCCESS", jobType: "DEPLOY" })).id);
	written.jobIds.push(
		(await seedJob(owner, { projectId: project.projectId, envId: project.envId, status: "FAILED", jobType: "DESTROY", errorMessage: "e2e filter fixture" })).id,
	);

	// Runners (`/[org]/~/runners`): differ on STATUS and VERSION. Inserted directly rather than
	// through `seed-runners.ts`'s `seedRunner`, whose module-level sweep list belongs to the runner
	// specs — a second owner of that list is how one spec's cleanup deletes another's rows.
	/** Insert one self-operated runner in the given status, at the given version. */
	const runner = async (name: string, status: string, version: string) => {
		const [row] = await sql<{ id: string }[]>`
			insert into runners ${sql({
				user_id: owner.userId,
				org_id: owner.orgId,
				name,
				operator: "self",
				provisioning: "registered",
				token_hash: `e2e-filters-${Math.random().toString(36).slice(2)}`,
				status,
				version,
				is_default: false,
				metadata: sql.json({}),
			})}
			returning id`;
		return row.id;
	};
	written.runnerIds.push(await runner(`filters-a-${stamp}`, "ONLINE", "1.0.0"));
	written.runnerIds.push(await runner(`filters-b-${stamp}`, "OFFLINE", "1.1.0"));

	// Alerts (`/[org]/~/alerts`): channels differ on TYPE and ENABLED, policies on ENABLED.
	const mail = await seedChannel(owner, { type: "email", name: `filters-mail-${stamp}`, enabled: true });
	written.channelIds.push(mail.id);
	written.channelIds.push((await seedChannel(owner, { type: "webhook", name: `filters-hook-${stamp}`, enabled: false })).id);
	written.ruleIds.push((await seedRule(owner, { name: `filters-on-${stamp}`, enabled: true, channelIds: [mail.id] })).id);
	written.ruleIds.push((await seedRule(owner, { name: `filters-off-${stamp}`, enabled: false })).id);

	// Support cases (`/[org]/~/support/my-cases`): differ on SEVERITY and TYPE.
	/** Insert one open support case with the given severity and type. */
	const supportCase = async (subject: string, severity: string, type: string) => {
		const [row] = await sql<{ id: string }[]>`
			insert into support_cases ${sql({
				user_id: owner.userId,
				org_id: owner.orgId,
				type,
				category: "other",
				severity,
				status: "open",
				subject,
				context: sql.json({}),
				contact: sql.json({ email: "audit@alethia.test" }),
			})}
			returning id`;
		return row.id;
	};
	written.supportCaseIds.push(await supportCase(`Filters fixture A ${stamp}`, "normal", "technical"));
	written.supportCaseIds.push(await supportCase(`Filters fixture B ${stamp}`, "high", "billing"));

	// Evidence (`/[org]/~/evidence`): one row per ENVIRONMENT, and every other project in the run's
	// org is unconnected, so every row read "Other" on the Cloud facet — the only facet the pass can
	// reach, because a `FunnelFilter`'s descent opens its FIRST facet. Connecting THIS project to an
	// AWS identity makes "AWS" an option narrower than the list. The identity is written first and
	// linked by an update, so a failure between the two still leaves an id `cleanFilterFixtures`
	// can remove.
	const identity = await seedCloudIdentity(owner, { provider: "aws", name: `filters-aws-${stamp}` });
	written.cloudIdentityIds.push(identity.id);
	await sql`update projects set cloud_identity_id = ${identity.id} where id = ${project.projectId}`;

	// Teams (`/[org]/~/settings/teams`): the run's org already has teams, all in the 1–5 bucket, so
	// the Size facet had nothing narrower than the list. An EMPTY team puts a row in "No members"
	// and makes "1–5 members" narrower. It is also the principal of the access grants below —
	// a team nobody is in, so a deny bound to it can change no one's access.
	const [emptyTeam] = await sql<{ id: string }[]>`
		insert into team ${sql({ name: `Filters empty team ${stamp}`, organization_id: owner.orgId })}
		returning id`;
	written.teamIds.push(emptyTeam.id);

	// Project access (`/[org]/[project]/settings/access`): project-scoped grants, differing on
	// EFFECT. Bound to the empty team above, with neither a role nor a permission key, so they
	// grant and deny nothing to anybody — the owner's own access to this project is untouched.
	/** Insert one project-scoped grant with the given effect, bound to the empty team. */
	const grant = async (effect: "allow" | "deny") => {
		const [row] = await sql<{ id: string }[]>`
			insert into grants ${sql({
				org_id: owner.orgId,
				principal_type: "team",
				principal_id: emptyTeam.id,
				effect,
				role_id: null,
				permission_key: null,
				resource_type: "project",
				resource_id: project.projectId,
			})}
			returning id`;
		return row.id;
	};
	written.grantIds.push(await grant("allow"));
	written.grantIds.push(await grant("deny"));

	// SSO (`/[org]/~/settings/sso`): differ on TYPE (OIDC vs SAML) and STATUS (verified vs pending).
	// Two rows of its own rather than one beside `fixtures-destructive.ts`'s: that fixture is written
	// on demand by another spec, so whether it exists when this pass reaches the page is an ordering
	// accident. The domains are `.invalid`, so no sign-in can ever be routed to them.
	/** Insert one org-scoped SSO provider of the given protocol and verification state. */
	const sso = async (kind: "oidc" | "saml", verified: boolean) => {
		const [row] = await sql<{ id: string }[]>`
			insert into sso_provider ${sql({
				issuer: `https://idp-${kind}-${stamp}.invalid`,
				domain: `filters-${kind}-${stamp}.invalid`,
				provider_id: `filters-${kind}-${stamp}`,
				oidc_config: kind === "oidc" ? JSON.stringify({ clientId: "filters-client" }) : null,
				saml_config: kind === "saml" ? JSON.stringify({ entryPoint: `https://idp-saml-${stamp}.invalid/sso` }) : null,
				user_id: owner.userId,
				organization_id: owner.orgId,
				domain_verified: verified,
			})}
			returning id`;
		return row.id;
	};
	written.ssoProviderIds.push(await sso("oidc", true));
	written.ssoProviderIds.push(await sso("saml", false));

	// Invoices (`/[org]/~/settings/billing/invoices`): differ on STATUS. Paid now, so the default
	// "All time" window holds both.
	/** Insert one mirrored invoice in the given status. */
	const invoice = async (suffix: string, status: "paid" | "refunded") => {
		const [row] = await sql<{ id: string }[]>`
			insert into invoice ${sql({
				organization_id: owner.orgId,
				stripe_invoice_id: `in_e2e_filters_${suffix}_${stamp}`,
				number: `E2E-FILTERS-${suffix.toUpperCase()}`,
				status,
				amount_total: 1200,
				currency: "usd",
				description: "e2e filter fixture",
				paid_at: new Date(),
			})}
			returning id`;
		return row.id;
	};
	written.invoiceIds.push(await invoice("a", "paid"));
	written.invoiceIds.push(await invoice("b", "refunded"));
}

/**
 * Delete exactly the rows one `seedFilterFixtures()` call wrote — never "everything in the org",
 * which would take the fixtures `inert.spec.ts` and `destructive.spec.ts` seed with it.
 *
 * An empty id list skips its table: a partial seed calls this too, and `in ()` is not valid SQL.
 */
export async function cleanFilterFixtures(f: FilterFixtures): Promise<void> {
	const sql = db();
	if (f.invoiceIds.length > 0) await sql`delete from invoice where id in ${sql(f.invoiceIds)}`;
	if (f.ssoProviderIds.length > 0) await sql`delete from sso_provider where id in ${sql(f.ssoProviderIds)}`;
	if (f.grantIds.length > 0) await sql`delete from grants where id in ${sql(f.grantIds)}`;
	if (f.teamIds.length > 0) await sql`delete from team where id in ${sql(f.teamIds)}`;
	if (f.supportCaseIds.length > 0) {
		await sql`delete from support_messages where case_id in ${sql(f.supportCaseIds)}`;
		await sql`delete from support_cases where id in ${sql(f.supportCaseIds)}`;
	}
	if (f.ruleIds.length > 0) await sql`delete from alert_rules where id in ${sql(f.ruleIds)}`;
	if (f.channelIds.length > 0) await sql`delete from alert_channels where id in ${sql(f.channelIds)}`;
	if (f.runnerIds.length > 0) await sql`delete from runners where id in ${sql(f.runnerIds)}`;
	if (f.jobIds.length > 0) await sql`delete from jobs where id in ${sql(f.jobIds)}`;
	await sql`delete from resource_hierarchy where child_type = 'project' and child_id = ${f.project.projectId}`;
	await sql`delete from projects where id = ${f.project.projectId}`;
	// After the project: it references the identity, and so do its network and cluster rows.
	if (f.cloudIdentityIds.length > 0) await sql`delete from cloud_identities where id in ${sql(f.cloudIdentityIds)}`;
}
