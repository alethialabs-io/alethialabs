// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE READER OF `destructive-actions.yaml`'s `fixture:` COLUMN.
//
// Every entry in `apps/console/destructive-actions.yaml` declares a `fixture:` — "what must exist
// for this control to render". Until this file, **nothing read that column**: not
// `destructive.spec.ts`, not `e2e/audit/context.ts`, not `scripts/check-destructive-actions.mjs`.
// A column no instrument reads cannot be wrong, which is how 35 distinct fixtures came to be
// declared against the two `seedRouteFixtures` writes (#4458).
//
// ── WHAT THIS FILE IS, AND WHAT IT REFUSES TO BE ────────────────────────────────────────────────
//
// It is a MAP from a fixture name to the rows that make it true, plus the arithmetic that says
// which declared fixtures are covered. The arithmetic is pure — no page, no database, no clock —
// so it can be driven in both directions by self-tests that need none of them, which is the
// property `destructive.spec.ts`'s own floor self-tests established as the bar (#4646).
//
// It is NOT a place to park work. A fixture with no seeder must appear in {@link UNSEEDABLE} with
// the reason it cannot be written, and that ledger fails in BOTH directions:
//
//   · a declared fixture with neither a seeder nor a reason is an UNACCOUNTED fixture — loud;
//   · an `UNSEEDABLE` entry naming a fixture the registry no longer declares, or one that has since
//     acquired a seeder, is a line that OUTLIVED its subject — also loud, because an exception that
//     outlives its subject suppresses a real finding forever and nothing but this check says so.
//
// ── A SEEDER THAT THROWS MUST NOT TAKE THE RUN WITH IT ──────────────────────────────────────────
//
// {@link seedDestructiveFixtures} runs every seeder and CATCHES each one separately. A column the
// product renamed, a NOT NULL the schema added — these are real and they will happen, and the
// honest outcome is that the controls depending on that ONE fixture withhold with a reason naming
// the fixture and the error, while every other control is still measured. A seeder loop that threw
// would convert one broken insert into "the audit context could not be established" on all 47, and
// this repo has already paid for that shape once (`context.ts`'s worker-restart note).
//
// That is also why the failure is REPORTED rather than swallowed: `fixtureSeedFailureReason()` is
// what turns "the trigger is not rendered … for this persona" — true, and not the whole truth —
// into "its fixture `alert-channel` could not be seeded: <error>".
//
// ── THE ROWS ARE WRITTEN AS THE OWNER DB ROLE, IN SNAKE_CASE ────────────────────────────────────
//
// `e2e/helpers/db.ts` connects as the owner (RLS bypassed), so every row states its `org_id` (and
// `user_id` where the table has one) explicitly or the app's RLS-scoped reads will not see it.
// Column names are the POSTGRES ones: `lib/db/schema/*.ts` declares camelCase keys and the drizzle
// instance's `casing: "snake_case"` maps them, so raw SQL talks to the columns, never to the keys.
// Where a column name here was in any doubt it was read out of `lib/db/migrations/*.sql`, which is
// the only artefact that states the post-rename truth (`jobs.spec_id` became `jobs.project_id` in
// 0037, inside a `DO` block, and the schema file has said `projectId` ever since).

import { db } from "../helpers/db";
import { grantOrganizationsEntitlement } from "../helpers/personas";
import { seedCloudIdentity, type Owner } from "../helpers/seed";
import { seedChannel, seedRule } from "../helpers/seed-alerts";
import { seedOrgMember } from "../helpers/seed-rbac";
import { seedDeployedRunner, seedFleetPool, seedRunner } from "../helpers/seed-runners";
import type { AuditContext } from "./context";

// ── the scope a seeder writes into ──────────────────────────────────────────────────────────────

/** The audit's project row, looked up from its slug. */
export interface FixtureProject {
	projectId: string;
	envId: string;
	slug: string;
}

/**
 * Everything a seeder is allowed to know.
 *
 * `project` is OPTIONAL because `seedRouteFixtures` may not have run — a seeder that needs it says
 * so by throwing, and its fixture is then withheld with that reason rather than silently writing an
 * orphan row. The ids are RE-READ from the database rather than passed down: `AuditContext` carries
 * only the project's SLUG (`context.ts`), and that file is not this unit's to change.
 */
export interface FixtureScope {
	owner: Owner;
	orgSlug: string;
	project?: FixtureProject;
}

/** Resolve the scope a seeder writes into, from the audit context the spec already established. */
export async function resolveFixtureScope(ctx: AuditContext): Promise<FixtureScope> {
	const scope: FixtureScope = { owner: ctx.owner, orgSlug: ctx.orgSlug };
	if (!ctx.projectSlug) return scope;
	const sql = db();
	const rows = await sql<{ id: string; env_id: string | null }[]>`
		select p.id,
		       (select e.id from project_environments e
		         where e.project_id = p.id
		         order by e.is_default desc, e.created_at asc
		         limit 1) as env_id
		from projects p
		where p.org_id = ${ctx.owner.orgId} and p.slug = ${ctx.projectSlug}
		limit 1`;
	const row = rows[0];
	if (row?.env_id) scope.project = { projectId: row.id, envId: row.env_id, slug: ctx.projectSlug };
	return scope;
}

/** The project a seeder needs, or a raise naming what is missing. */
function requireProject(scope: FixtureScope): FixtureProject {
	if (!scope.project) {
		throw new Error(
			"the audit's project has not been seeded (e2e/audit/context.ts → seedRouteFixtures), so there is nothing to hang this fixture off",
		);
	}
	return scope.project;
}

// ── the map ─────────────────────────────────────────────────────────────────────────────────────

/** One fixture name and the rows that make it true. */
export interface FixtureSeeder {
	/** What it writes, in one line. Read back to the reader when the seed fails. */
	readonly writes: string;
	/** Write it. Raises with a legible reason; the caller records, it never crashes the run. */
	readonly seed: (scope: FixtureScope) => Promise<void>;
}

/** A unique-enough suffix, so two workers (or two runs against one database) cannot collide. */
function unique(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The fixture→rows map, keyed EXACTLY as `destructive-actions.yaml` spells the `fixture:` value.
 *
 * The key is compared verbatim, including the one entry that carries a parenthetical
 * (`installed-addon (kube-prometheus-stack / Prometheus + Grafana)`). Normalising it here would be
 * a second spelling of the registry's value maintained by hand, which is the disagreement the
 * registry exists to prevent — the coverage check below reports an unmatched key by name, so a
 * renamed fixture is a named finding rather than a silent miss.
 */
export const FIXTURE_SEEDERS: ReadonlyMap<string, FixtureSeeder> = new Map<string, FixtureSeeder>([
	// ── `none` needs nothing. It is in the map rather than in UNSEEDABLE on purpose: "this fixture
	// is satisfied" and "this fixture cannot be written" are different answers, and `org.delete` /
	// `account.delete` are satisfied.
	[
		"none",
		{
			writes: "nothing — the control needs no row",
			seed: async () => {},
		},
	],

	// ── `project` is written by `seedRouteFixtures` before this file runs. Declared here so the
	// coverage arithmetic can see it; the seeder asserts the row is THERE rather than writing a
	// second one, because two projects make `project.delete`'s danger row ambiguous by name.
	[
		"project",
		{
			writes: "nothing — e2e/audit/context.ts → seedRouteFixtures already wrote the project and its environment",
			seed: async (scope) => {
				requireProject(scope);
			},
		},
	],

	// ── members ────────────────────────────────────────────────────────────────────────────────
	//
	// `seed-rbac.ts` → `seedOrgMember` writes a real `user` + `member` pair directly. That is not a
	// shortcut past `personas.ts`'s rule that a member is built through the REAL invite→accept flow:
	// that rule is about an ACTOR — an account that signs in and whose access must be provisioned —
	// and `seed-rbac.ts`'s own header states the distinction ("the specs drive it as a ROW, never as
	// an actor"). These fixtures need a ROW in the members table and nothing else. `seedOrgMember`'s
	// doc comment already anticipated this unit: "pass `status: \"suspended\"` for the Reactivate
	// control's fixture".
	[
		"member-row",
		{
			writes: "one active `member` row (+ its `user`) — the row whose Manage menu carries Remove and Suspend",
			seed: async (scope) => {
				await seedOrgMember(scope.owner, { label: `audit-active-${unique()}`, name: "Audit Active Colleague" });
			},
		},
	],
	[
		"suspended-member-row",
		{
			writes: "one SUSPENDED `member` row — the only row kind whose menu offers Reactivate instead of Suspend",
			seed: async (scope) => {
				await seedOrgMember(scope.owner, {
					label: `audit-suspended-${unique()}`,
					name: "Audit Suspended Colleague",
					status: "suspended",
				});
			},
		},
	],
	[
		"two-member-rows",
		{
			// ⚠ The registry's own comment on `members.bulk-remove` says this entry "does NOT depend
			// on a fixture: the checkbox column renders for every row including the owner's, so an
			// org holding nothing but its owner still raises the bar". Both statements cannot be
			// true, and the `fixture:` value is the one that overstates. It is seeded anyway — two
			// rows are cheap and they make the bulk bar's count unambiguous — but the disagreement
			// is a finding against the REGISTRY, reported rather than silently resolved here.
			writes: "two active `member` rows — enough for the bulk bar to act on a selection",
			seed: async (scope) => {
				await seedOrgMember(scope.owner, { label: `audit-bulk-a-${unique()}`, name: "Audit Bulk Colleague A" });
				await seedOrgMember(scope.owner, { label: `audit-bulk-b-${unique()}`, name: "Audit Bulk Colleague B" });
			},
		},
	],
	[
		"pending-invitation",
		{
			writes: "one pending `invitation` row — the only row kind whose menu is labelled \"Manage invitation\"",
			seed: async (scope) => {
				const sql = db();
				const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
				await sql`
					insert into invitation ${sql({
						organization_id: scope.owner.orgId,
						email: `audit-invitee-${unique()}@alethia.test`,
						role: "member",
						status: "pending",
						expires_at: expires,
						inviter_id: scope.owner.userId,
					})}`;
			},
		},
	],

	// ── teams ──────────────────────────────────────────────────────────────────────────────────
	[
		"team",
		{
			writes: "one `team` row",
			seed: async (scope) => {
				const sql = db();
				await sql`
					insert into team ${sql({
						organization_id: scope.owner.orgId,
						name: `Audit Team ${unique()}`,
					})}`;
			},
		},
	],
	[
		"team-with-a-member",
		{
			writes: "one `team` row plus a `team_member` row — the Manage members dialog needs a row to offer Remove on",
			seed: async (scope) => {
				const sql = db();
				const [team] = await sql<{ id: string }[]>`
					insert into team ${sql({
						organization_id: scope.owner.orgId,
						name: `Audit Staffed Team ${unique()}`,
					})}
					returning id`;
				if (!team) throw new Error("insert into team returned no row");
				const colleague = await seedOrgMember(scope.owner, {
					label: `audit-team-member-${unique()}`,
					name: "Audit Team Colleague",
				});
				await sql`
					insert into team_member ${sql({ team_id: team.id, user_id: colleague.userId })}`;
				// `team.member_count` is a denormalised counter the list renders; a team seeded
				// straight into the table would otherwise read 0 members while holding one.
				await sql`update team set member_count = 1 where id = ${team.id}`;
			},
		},
	],

	// ── alerts ─────────────────────────────────────────────────────────────────────────────────
	[
		"alert-channel",
		{
			writes: "one verified email `alert_channels` row — the rail row both Delete channel and the Enabled switch hang off",
			seed: async (scope) => {
				await seedChannel(scope.owner, { name: `audit-channel-${unique()}` });
			},
		},
	],
	[
		"alert-policy",
		{
			writes: "one enabled `alert_rules` row — the rail row both Delete policy and the Enabled switch hang off",
			seed: async (scope) => {
				await seedRule(scope.owner, { name: `audit-policy-${unique()}` });
			},
		},
	],

	// ── runners and fleet ──────────────────────────────────────────────────────────────────────
	[
		"registered-runner",
		{
			writes: "one self-operated runner in the `registered` provisioning mode — the shape that renders Remove",
			seed: async (scope) => {
				await seedRunner(scope.owner, { name: `audit-registered-${unique()}`, provisioning: "registered" });
			},
		},
	],
	[
		"deployed-runner-with-cloud-resources",
		{
			writes:
				"one `deployed` runner attached to a connected cloud identity and carrying a deploy_config — the exact conjunction RunnerActions.hasCloudResources tests",
			seed: async (scope) => {
				await seedDeployedRunner(scope.owner, { name: `audit-deployed-${unique()}` });
			},
		},
	],
	[
		"fleet-pool",
		{
			// `fleet_pools` is GLOBAL platform config with no `org_id` (schema/fleet.ts), and
			// `seedFleetPool` is a read-then-insert singleton for that reason. It is never torn
			// down by a spec, which is also why `runners.pool.delete` is only ever OPENED and
			// CANCELLED — exactly what this suite does to every control.
			writes: "the singleton warm `fleet_pools` row (read-then-insert; platform config, not an org row)",
			seed: async () => {
				await seedFleetPool();
			},
		},
	],

	// ── connectors ─────────────────────────────────────────────────────────────────────────────
	[
		"connected-cloud-identity",
		{
			writes: "connected `cloud_identities` rows for aws, gcp and azure — provider-shaped credentials, so identityWasConfigured() holds",
			seed: async (scope) => {
				// One row per provider, NOT one row. `identityWasConfigured()`
				// (`lib/cloud-providers/identity-configured.ts`) is provider-aware, and the four
				// `connectors.disconnect.*` entries each name their own tile. `seedCredentials`
				// already shapes the credential per provider (#4708) — this passes the provider and
				// lets that decide, rather than restating the shapes here.
				for (const provider of ["aws", "gcp", "azure"] as const) {
					await seedCloudIdentity(scope.owner, { provider, name: `Audit ${provider.toUpperCase()} account` });
				}
			},
		},
	],

	// ── classification ─────────────────────────────────────────────────────────────────────────
	[
		"classification-dimension",
		{
			writes: "one `classification_dimension` row",
			seed: async (scope) => {
				await seedClassification(scope.owner);
			},
		},
	],
	[
		"classification-value",
		{
			writes: "one `classification_dimension` row plus a `classification_value` under it",
			seed: async (scope) => {
				await seedClassification(scope.owner);
			},
		},
	],

	// ── org ────────────────────────────────────────────────────────────────────────────────────
	[
		"org-with-a-logo",
		{
			writes: "`organization.logo` set to a data URI — the column the Remove logo control clears",
			seed: async (scope) => {
				const sql = db();
				// A 1×1 transparent GIF as a data URI: no object store, no network, and a value the
				// `<img>` in the settings header can actually render.
				const LOGO =
					"data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
				await sql`update organization set logo = ${LOGO} where id = ${scope.owner.orgId}`;
			},
		},
	],
]);

/**
 * One dimension + one value, written once however many fixtures ask for it.
 *
 * `classification-dimension` and `classification-value` are two registry fixtures over one pair of
 * rows — a value cannot exist without its dimension, and two dimensions would make
 * `{select: "a dimension"}` ambiguous, which `resolveTrigger` correctly refuses to guess past. So
 * this is idempotent on the dimension's `key`.
 */
async function seedClassification(owner: Owner): Promise<void> {
	const sql = db();
	const KEY = "audit-sensitivity";
	const existing = await sql<{ id: string }[]>`
		select id from classification_dimension where org_id = ${owner.orgId} and key = ${KEY} limit 1`;
	const dimensionId =
		existing[0]?.id ??
		(
			await sql<{ id: string }[]>`
				insert into classification_dimension ${sql({
					org_id: owner.orgId,
					created_by: owner.userId,
					key: KEY,
					label: "Audit sensitivity",
					description: "Seeded by the destructive-action audit so its Delete controls have a row to act on.",
				})}
				returning id`
		)[0]?.id;
	if (!dimensionId) throw new Error("insert into classification_dimension returned no row");
	const value = await sql<{ id: string }[]>`
		select id from classification_value where dimension_id = ${dimensionId} limit 1`;
	if (value.length > 0) return;
	await sql`
		insert into classification_value ${sql({
			org_id: owner.orgId,
			dimension_id: dimensionId,
			value: "audit-confidential",
			label: "Audit confidential",
		})}`;
}

// ── the declared exceptions ─────────────────────────────────────────────────────────────────────

/**
 * Fixtures this spec DELIBERATELY does not seed, each with the thing that prevents it.
 *
 * A line here is a DECISION, not a queue. It must name what blocks the write — a capability the
 * gate cannot promise, a row only a third-party system can create, a control the registry already
 * records as absent — never "no seeder yet". {@link fixtureCoverage} fails when a line outlives its
 * subject, so the list can only shrink.
 */
export const UNSEEDABLE: ReadonlyMap<string, string> = new Map([
	[
		"byo-chart",
		"the registry records `byo.chart.detach` as `missing` — there is no confirmation to measure, so seeding the chart would " +
			"establish nothing. The fixture becomes worth writing when the control gains a confirmation, and not before.",
	],
	[
		"active-subscription",
		"a subscription is a STRIPE object, not a row. `organization_billing` records the plan the console resolved; the billing " +
			"page's Cancel control acts on the Stripe subscription itself, so a seeded row would render a control whose mutation " +
			"targets nothing — a measurement of a fixture nobody could have created.",
	],
	[
		"backup-payment-method",
		"a payment method is a STRIPE object attached to a Stripe customer. There is no table to write, and the `stripe` capability " +
			"the `audit-interaction` leg promises is an API key, not a seeded card.",
	],
]);

// ── the arithmetic ──────────────────────────────────────────────────────────────────────────────

/** The registry shape this module reads. Only the two fields it needs, so a spec's fuller type fits. */
export interface FixtureBearingControl {
	id: string;
	fixture?: string;
}

/**
 * Every distinct `fixture:` the registry declares, in first-appearance order.
 *
 * An entry with NO `fixture:` contributes nothing — it is a registry defect for
 * `check-destructive-actions.mjs` to hold, not a fixture named "undefined".
 */
export function declaredFixtures(controls: readonly FixtureBearingControl[]): string[] {
	const seen: string[] = [];
	for (const c of controls) {
		const f = c.fixture;
		if (typeof f !== "string" || f.trim() === "") continue;
		if (!seen.includes(f)) seen.push(f);
	}
	return seen;
}

/** What the fixture map covers, and what it does not. */
export interface FixtureCoverage {
	/** Declared fixtures a seeder writes. */
	seedable: string[];
	/** Declared fixtures deliberately not written, with the reason. */
	declaredUnseedable: string[];
	/** Declared fixtures with neither — the defect this module exists to make loud. */
	unaccounted: string[];
	/** Everything wrong with the two ledgers themselves. Empty means they describe today's registry. */
	problems: string[];
}

/**
 * Reconcile the registry's declared fixtures against the seeder map and the exception ledger.
 *
 * PURE — it reads no module-level state, which is why every argument is a parameter. A version that
 * read `FIXTURE_SEEDERS` and `UNSEEDABLE` directly could only be driven against whatever they
 * happen to hold, and those are the things under test.
 *
 * It reports in BOTH directions. Under-coverage (`unaccounted`) is loud on its own. Over-coverage —
 * a ledger line or a seeder for a fixture the registry no longer declares, or a fixture claimed by
 * both lists — is silent by nature and is therefore reported as a `problem`: an exception that
 * outlives its subject suppresses a real finding forever.
 */
export function fixtureCoverage(
	controls: readonly FixtureBearingControl[],
	seeders: ReadonlyMap<string, FixtureSeeder>,
	unseedable: ReadonlyMap<string, string>,
): FixtureCoverage {
	const declared = declaredFixtures(controls);
	const seedable: string[] = [];
	const declaredUnseedable: string[] = [];
	const unaccounted: string[] = [];
	const problems: string[] = [];

	for (const fixture of declared) {
		const hasSeeder = seeders.has(fixture);
		const hasReason = unseedable.has(fixture);
		if (hasSeeder && hasReason) {
			problems.push(
				`"${fixture}" is BOTH seeded and declared unseedable — the two ledgers disagree about the same fixture. ` +
					"Delete the UNSEEDABLE line if the seeder works; delete the seeder if it does not.",
			);
			seedable.push(fixture);
			continue;
		}
		if (hasSeeder) seedable.push(fixture);
		else if (hasReason) declaredUnseedable.push(fixture);
		else {
			unaccounted.push(fixture);
		}
	}

	const declaredSet = new Set(declared);
	for (const fixture of seeders.keys()) {
		if (!declaredSet.has(fixture)) {
			problems.push(
				`FIXTURE_SEEDERS writes "${fixture}", which no registry entry declares — the seeder outlived its subject. ` +
					"Delete it, or fix the spelling it was meant to match.",
			);
		}
	}
	for (const fixture of unseedable.keys()) {
		if (!declaredSet.has(fixture)) {
			problems.push(
				`UNSEEDABLE names "${fixture}", which no registry entry declares — the exception outlived its subject and now ` +
					"suppresses nothing. Delete the line.",
			);
		}
	}
	return { seedable, declaredUnseedable, unaccounted, problems };
}

/**
 * How many CONTROLS each coverage class accounts for.
 *
 * The fixture count is the wrong denominator for the reader's question. `connected-cloud-identity`
 * is one fixture and five controls; `none` is one fixture and two. "33 of 35 fixtures unseeded" and
 * "40 of 47 controls unmeasurable" are the same fact said two ways, and the second is the one the
 * gate reports.
 */
export function controlsByCoverage(
	controls: readonly FixtureBearingControl[],
	coverage: FixtureCoverage,
): { seedable: number; declaredUnseedable: number; unaccounted: number } {
	const seedable = new Set(coverage.seedable);
	const unseedable = new Set(coverage.declaredUnseedable);
	let a = 0;
	let b = 0;
	let c = 0;
	for (const control of controls) {
		const f = control.fixture;
		if (typeof f !== "string" || f.trim() === "") continue;
		if (seedable.has(f)) a += 1;
		else if (unseedable.has(f)) b += 1;
		else c += 1;
	}
	return { seedable: a, declaredUnseedable: b, unaccounted: c };
}

// ── running them ────────────────────────────────────────────────────────────────────────────────

/** What one run of {@link seedDestructiveFixtures} achieved. */
export interface FixtureSeedReport {
	/** Fixtures whose rows are now in the database. */
	seeded: string[];
	/** Fixtures whose seeder RAISED, keyed by fixture, valued by the error's message. */
	failed: Map<string, string>;
	/** Whether the `organizations` entitlement grant succeeded, and why not when it did not. */
	entitlement: "granted" | string;
}

/**
 * Write every fixture the registry declares and this module knows how to write.
 *
 * ── THE ENTITLEMENT IS PART OF THE FIXTURE, NOT A BYPASS ────────────────────────────────────────
 *
 * 17 of the 47 entries record `persona: team`, and the pages they live on — members, teams, roles,
 * SSO, access, alerts — are gated on the `organizations` entitlement. The audit persona is a plain
 * signup (`e2e/fixtures/auth.setup.ts` → `signUpWithOtp`), so its org resolves COMMUNITY and those
 * pages refuse before any seeded row is read. Seeding the rows without the grant would leave every
 * one of those controls withheld for a reason that has nothing to do with the fixture — which is
 * precisely the mis-attribution this whole wave exists to end.
 *
 * `grantOrganizationsEntitlement` is the fixture `personas.ts` already provides for this, and its
 * own doc states the bound: the gate itself stays exercised, because `ownerHobby`'s org is left
 * untouched and `rbac.spec.ts` still reads the real refusal there. This grants it to the AUDIT's
 * org only.
 *
 * It is reported rather than asserted: if the grant fails, the run says so and the `persona: team`
 * controls withhold naming it, instead of 17 controls each blaming a fixture that was written.
 */
export async function seedDestructiveFixtures(
	ctx: AuditContext,
	seeders: ReadonlyMap<string, FixtureSeeder> = FIXTURE_SEEDERS,
): Promise<FixtureSeedReport> {
	const report: FixtureSeedReport = { seeded: [], failed: new Map(), entitlement: "granted" };
	try {
		await grantOrganizationsEntitlement(ctx.owner.orgId);
	} catch (err) {
		report.entitlement = err instanceof Error ? err.message : String(err);
	}
	const scope = await resolveFixtureScope(ctx);
	for (const [fixture, seeder] of seeders) {
		try {
			await seeder.seed(scope);
			report.seeded.push(fixture);
		} catch (err) {
			report.failed.set(fixture, err instanceof Error ? err.message : String(err));
		}
	}
	return report;
}

/**
 * The reason a control's fixture is not there, or null when the fixture is fine.
 *
 * This is what turns a withheld verdict's "the trigger is not rendered … for this persona" — true,
 * and not the whole truth — into a sentence naming the thing that has to change. The three cases
 * are DIFFERENT findings and get different words: nobody wrote a seeder, a seeder ran and threw, or
 * the fixture is a declared exception.
 */
export function fixtureSeedFailureReason(
	control: FixtureBearingControl,
	report: FixtureSeedReport | null,
	seeders: ReadonlyMap<string, FixtureSeeder> = FIXTURE_SEEDERS,
	unseedable: ReadonlyMap<string, string> = UNSEEDABLE,
): string | null {
	const fixture = control.fixture;
	if (typeof fixture !== "string" || fixture.trim() === "") return null;
	const declined = unseedable.get(fixture);
	if (declined) return `its fixture \`${fixture}\` is not seeded, by decision: ${declined}`;
	if (!seeders.has(fixture)) {
		return `its fixture \`${fixture}\` has no seeder in e2e/audit/fixtures-destructive.ts and no declared reason — nothing wrote the row this control acts on`;
	}
	if (!report) return `its fixture \`${fixture}\` was never seeded — the fixture pass did not run`;
	const failure = report.failed.get(fixture);
	if (failure) return `its fixture \`${fixture}\` could not be seeded: ${failure}`;
	return null;
}
