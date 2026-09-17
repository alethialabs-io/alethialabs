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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { db } from "../helpers/db";
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
	/** The job `/[org]/~/jobs/[id]` will be materialised with — the ONLY job that route ever visits. */
	jobId?: string;
}

/** Resolve the scope a seeder writes into, from the audit context the spec already established. */
export async function resolveFixtureScope(ctx: AuditContext): Promise<FixtureScope> {
	const scope: FixtureScope = { owner: ctx.owner, orgSlug: ctx.orgSlug, jobId: ctx.jobId };
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
			writes: "connected `cloud_identities` rows for aws, gcp, azure and hetzner — provider-shaped credentials, so identityWasConfigured() holds",
			seed: async (scope) => {
				// ONE ROW PER PROVIDER, NOT ONE ROW. `connectors.ts` filters the account list by the
				// card's slug (`rows.filter((ci) => ci.provider === slug)`), so an AWS identity puts
				// a Disconnect on the AWS card and on nothing else — and the four
				// `connectors.disconnect.{aws,gcp,azure,extra}` entries each name their own card.
				//
				// `hetzner` covers `.extra`, whose mutation fires for `EXTRA_CLOUDS`
				// (`use-cloud-connect.tsx` — digitalocean, hetzner, civo, alibaba). It is `active`
				// in the catalog where digitalocean and civo are `coming_soon`, and self-managed, so
				// `identityWasConfigured()` holds on `self_managed` without a ciphertext being
				// invented.
				//
				// The credential shape is NOT restated here: `seedCredentials` already decides it
				// per provider, and it does so because a one-shape-fits-all credential made every
				// seeded GCP and Azure identity invisible to this exact filter (#4708) — the row
				// inserted, the read succeeded, the predicate answered false, and a click did
				// nothing for 120 seconds.
				for (const provider of ["aws", "gcp", "azure", "hetzner"] as const) {
					await seedCloudIdentity(scope.owner, { provider, name: `Audit ${provider.toUpperCase()} account` });
				}
			},
		},
	],
	[
		"connected-api-key-connector",
		{
			writes: "one org-scoped `connector_credentials` row against the `cloudflare` catalog connector",
			seed: async (scope) => {
				const sql = db();
				// The catalog row is NOT written here. `connector_credentials.connector_id` is a FK
				// into `connectors`, and that table is populated by `scripts/migrate.mjs` from
				// `lib/db/seed/connectors.generated.sql` as part of `db:migrate` — so the id is
				// LOOKED UP. Writing a catalog row would be this file inventing a product surface.
				const rows = await sql<{ id: string }[]>`select id from connectors where slug = 'cloudflare' limit 1`;
				const connectorId = rows[0]?.id;
				if (!connectorId) {
					throw new Error(
						"no `cloudflare` row in the `connectors` catalog — it is seeded by scripts/migrate.mjs from lib/db/seed/connectors.generated.sql, so this database has not been migrated",
					);
				}
				// `scope: "org"` and an explicit `org_id`: `programmables.sql`'s `scoped_all` policy
				// on this table admits an org row only by `app.current_org`, and the owner-role
				// seeder sets no such setting, so a `personal` row or an absent `org_id` inserts
				// cleanly and is invisible to the page.
				//
				// The credential is written in the REAL `EncryptedSecret` shape with obviously-e2e
				// values, not a made-up envelope. Nothing on this page decrypts it — `connectors.ts`
				// selects four columns and `credentials` is not among them ("Secrets stay encrypted
				// here — only `is_verified` is needed") — but a fixture whose shape lies about the
				// wire format is the next reader's wrong answer.
				await sql`
					insert into connector_credentials ${sql({
						user_id: scope.owner.userId,
						org_id: scope.owner.orgId,
						scope: "org",
						connector_id: connectorId,
						credentials: sql.json({
							fields: {},
							secret: { v: 1, kid: "e2e", iv: "e2e", tag: "e2e", data: "e2e" },
						}),
						is_verified: true,
					})}
					on conflict do nothing`;
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

	// ── project, environments and promotions ───────────────────────────────────────────────────
	[
		"project-with-a-node",
		{
			// ⚠ ALREADY SATISFIED, and that is a finding rather than a convenience. #4458 counts
			// this among the 33 fixtures nobody wrote; the tree disagrees. `seedProject` writes a
			// `project_network` AND a `project_cluster` row (`e2e/helpers/seed.ts`); `formToGraph`
			// makes a node for each; `makeNode` sets `deletable: kind !== "project"`; and
			// `DangerZone` renders "Delete resource" for any node that is deletable and not in
			// `OUT_OF_BAND` (chart, chart_workload, addon, external). Neither `network` nor
			// `cluster` is in that set.
			//
			// So the seeder writes nothing and ASSERTS the project is there. A second component row
			// would add a second "Delete" with the same accessible name, which `resolveTrigger`
			// correctly refuses to attribute a verdict to — the fixture would make the control LESS
			// measurable, not more.
			writes: "nothing — seedProject's project_network and project_cluster rows already render deletable canvas nodes",
			seed: async (scope) => {
				requireProject(scope);
			},
		},
	],
	[
		"project-with-two-environments",
		{
			writes: "a second, NON-DEFAULT `project_environments` row — Delete renders on exactly `!env.is_default`",
			seed: async (scope) => {
				await ensureSecondEnvironment(scope);
			},
		},
	],
	[
		"pending-promotion",
		{
			writes: "an `environment_promotions` row in PENDING_APPROVAL plus one PENDING `promotion_approvals` row",
			seed: async (scope) => {
				const project = requireProject(scope);
				const sourceEnvId = await ensureSecondEnvironment(scope);
				const sql = db();
				// BOTH controls, or neither. `Cancel` renders for PENDING_PLAN/PENDING_APPROVAL/
				// DEPLOYING; `Reject` renders only for `PENDING_APPROVAL && approved < required`,
				// and `required` is the COUNT OF APPROVAL ROWS — so with no `promotion_approvals`
				// row `required` is 0, `0 < 0` is false, and Reject can never appear. One status
				// satisfies both, and it needs the approval row to do it.
				const active = await sql<{ id: string }[]>`
					select id from environment_promotions
					where target_environment_id = ${project.envId}
					  and status in ('PENDING_PLAN', 'PENDING_APPROVAL', 'APPROVED', 'DEPLOYING')
					limit 1`;
				// `env_promotions_one_active_per_target` is a partial UNIQUE index over exactly that
				// status set, so a second in-flight promotion for this target is a 23505, not a row.
				if (active.length > 0) return;
				const [promotion] = await sql<{ id: string }[]>`
					insert into environment_promotions ${sql({
						project_id: project.projectId,
						user_id: scope.owner.userId,
						org_id: scope.owner.orgId,
						source_environment_id: sourceEnvId,
						target_environment_id: project.envId,
						status: "PENDING_APPROVAL",
						candidate_hash: "audit-candidate-hash",
					})}
					returning id`;
				if (!promotion) throw new Error("insert into environment_promotions returned no row");
				await sql`
					insert into promotion_approvals ${sql({
						promotion_id: promotion.id,
						project_id: project.projectId,
						org_id: scope.owner.orgId,
						status: "pending",
					})}`;
			},
		},
	],
	[
		"installed-addon (kube-prometheus-stack / Prometheus + Grafana)",
		{
			writes: "one `project_addons` row for `kube-prometheus-stack` against the project's DEFAULT environment",
			seed: async (scope) => {
				const project = requireProject(scope);
				const sql = db();
				// `environment_id` must be NON-NULL and the DEFAULT env: `listProjectAddons` filters
				// on the id `resolveActiveEnvironmentId` returns, and a null there matches nothing.
				//
				// `addon_id` must be a catalog id — `kube-prometheus-stack`, whose catalog `name` is
				// "Prometheus + Grafana", which is what the entry's second reach step opens. An id
				// the catalog does not know produces no market item at all and is silently invisible.
				//
				// `"values"` is quoted because it is a reserved word; the other columns are not.
				await sql`
					insert into project_addons ${sql({
						project_id: project.projectId,
						environment_id: project.envId,
						addon_id: "kube-prometheus-stack",
						enabled: true,
						mode: "managed",
						version: "61.9.0",
						values: sql.json({}),
						namespace: "monitoring",
						status: "PENDING",
					})}
					on conflict do nothing`;
			},
		},
	],
	[
		"active-job",
		{
			// IT UPDATES THE AUDIT'S JOB RATHER THAN INSERTING A SECOND ONE, and that is forced.
			// `/[org]/~/jobs/[id]` is materialised with `ctx.jobId` and nothing else
			// (`e2e/audit/context.ts` → `valueFor`), so a freshly-inserted QUEUED job would sit in a
			// database no route this suite visits can reach — a fixture written and a control still
			// withheld, which is the shape this whole unit exists to end.
			//
			// `seedRouteFixtures` calls `seedJob` with no status, and `seedJob` defaults to
			// `SUCCESS` — a finished deploy, which renders Re-run, not Cancel. The three statuses
			// that render Cancel are QUEUED, CLAIMED and PROCESSING (`isActive` on the job page, and
			// `cancellable` in `cancelJob` — the two agree). QUEUED is the cheapest: its `runner_id`
			// is null, so `cancelJob` skips `notifyRunnerCancel` and no runner is needed.
			//
			// `completed_at` is cleared with it. A row that is QUEUED and completed is a state the
			// product cannot produce, and a fixture that invents one teaches the next reader a lie.
			writes: "flips the audit's own `jobs` row to QUEUED (completed_at cleared) — the only job id this suite's route resolves",
			seed: async (scope) => {
				if (!scope.jobId) {
					throw new Error("the audit has no seeded job (e2e/audit/context.ts → seedRouteFixtures), so /[org]/~/jobs/[id] has nothing to visit");
				}
				const sql = db();
				await sql`
					update jobs set status = 'QUEUED', completed_at = null, updated_at = now()
					where id = ${scope.jobId}`;
			},
		},
	],

	// ── roles, access and SSO ──────────────────────────────────────────────────────────────────
	[
		"custom-role",
		{
			writes: "one non-builtin `role` row — the roles rail lists `is_builtin = false` and nothing else",
			seed: async (scope) => {
				const sql = db();
				// `role_permission` rows are NOT required: `listRoles` left-joins them separately and
				// the rail renders `permissionKeys.length`, so a role with none is a role with a
				// zero. Writing permission rows would be inventing a policy nobody chose.
				const existing = await sql<{ id: string }[]>`
					select id from role where organization_id = ${scope.owner.orgId} and is_builtin = false limit 1`;
				if (existing.length > 0) return;
				await sql`
					insert into role ${sql({
						organization_id: scope.owner.orgId,
						name: "Audit role",
						description: "Seeded by the destructive-action audit so its Delete control has a row to act on.",
						is_builtin: false,
					})}`;
			},
		},
	],
	[
		"access-grant",
		{
			// ⚠ The org very likely HAS grants already: `lib/authz/grants.ts` → `ensureMemberGrant`
			// writes exactly this row shape for every member, so this fixture may be redundant in
			// practice. It is written anyway rather than assumed: a fixture that depends on another
			// subsystem's side effect is a fixture that disappears the day that subsystem changes,
			// and the failure would read as a missing control.
			writes: "one org-scoped `grants` row binding the owner to the built-in viewer role",
			seed: async (scope) => {
				const sql = db();
				const VIEWER_ROLE_ID = "00000000-0000-4000-8000-000000000004";
				await sql`
					insert into grants ${sql({
						org_id: scope.owner.orgId,
						principal_type: "user",
						principal_id: scope.owner.userId,
						effect: "allow",
						role_id: VIEWER_ROLE_ID,
						resource_type: "org",
					})}
					on conflict do nothing`;
			},
		},
	],
	[
		"sso-provider",
		{
			writes: "one `sso_provider` row scoped to the org",
			seed: async (scope) => {
				const sql = db();
				const existing = await sql<{ id: string }[]>`
					select id from sso_provider where organization_id = ${scope.owner.orgId} limit 1`;
				if (existing.length > 0) return;
				// `oidc_config` is `text`, and the read path parses it DEFENSIVELY — `parseJson`
				// returns null on a throw and the row then renders as "misconfigured" rather than
				// disappearing. Valid JSON is written anyway: a fixture that relies on the error
				// path is asserting the error path.
				await sql`
					insert into sso_provider ${sql({
						issuer: "https://idp.audit.test",
						domain: "audit.test",
						provider_id: `audit-idp-${unique()}`,
						oidc_config: JSON.stringify({ clientId: "audit-client" }),
						saml_config: null,
						user_id: scope.owner.userId,
						organization_id: scope.owner.orgId,
						domain_verified: true,
					})}`;
			},
		},
	],

	// ── the agent surfaces ─────────────────────────────────────────────────────────────────────
	//
	// ⚠ THESE FIVE TABLES ARE SCOPED TO THE USER, NOT THE ORG, and getting it backwards writes a
	// row nothing can read. They are read through `withOwnerScope`, which pins BOTH
	// `app.current_owner` AND `app.current_org` to the USER id (`lib/db/index.ts` says so in its own
	// ⚠), against an `owner_all` policy that admits `user_id = current_owner OR org_id =
	// current_org`. So every row below carries `org_id = userId` — which is exactly what the product
	// writes for itself. `agent_artifact_shares` is the one exception and takes the REAL org id: it
	// is read with `getServiceDb()`, RLS bypassed, filtered on `actor.orgId`.
	[
		"chat-thread",
		{
			writes: "one `agent_threads` row: kind `agent`, project_id NULL, and a NON-EMPTY `messages` array",
			seed: async (scope) => {
				await ensureAuditThread(scope);
			},
		},
	],
	[
		"artifact",
		{
			writes: "one `agent_artifacts` row whose `spec` carries a `widgets` ARRAY",
			seed: async (scope) => {
				await ensureAuditArtifact(scope);
			},
		},
	],
	[
		"shared-artifact",
		{
			writes: "an `agent_artifact_shares` row over the audit artifact, scoped `org` — plus the two members and the billing row the share popover demands",
			seed: async (scope) => {
				const artifactId = await ensureAuditArtifact(scope);
				const sql = db();
				// THE SHARE ROW ALONE RENDERS NOTHING. `artifact-share-popover.tsx` returns null
				// unless `canShareArtifacts`, which is three separate facts: the actor's org is a
				// REAL org (not the personal `orgId === userId` fallback), its billing status is
				// active or trialing, and the org has MORE THAN ONE member row. The entitlement
				// grant and the `member-row` seeders above supply the second and third; the first is
				// a property of the audit persona's org.
				//
				// `org_id` here is the REAL org id, unlike every other row in this block:
				// `listArtifactShares` reads through `getServiceDb()` with RLS bypassed and filters
				// on `actor.orgId`.
				await sql`
					insert into agent_artifact_shares ${sql({
						artifact_id: artifactId,
						org_id: scope.owner.orgId,
						scope_type: "org",
						scope_id: null,
						created_by: scope.owner.userId,
					})}
					on conflict do nothing`;
			},
		},
	],
	[
		"knowledge-doc",
		{
			writes: "one `KnowledgeDoc` entry in `agent_context.documents` — a JSONB entry, NOT a row of its own",
			seed: async (scope) => {
				const sql = db();
				// The shape is `types/jsonb.types.ts` → `KnowledgeDoc`, and the write path's zod
				// (`app/server/actions/agent-context.ts`) enforces exactly these four keys with a
				// non-empty id and title. `updated_at` is an ISO STRING, deliberately — the
				// interface says so, "stored as a string so the JSONB round-trips without a Date
				// revival step" — so a Date here would round-trip into something the reader does not
				// expect.
				//
				// `project_id` must be NULL: the org-level Knowledge panel calls
				// `getAgentContext(undefined)`. The unique index is (org_id, project_id) NULLS NOT
				// DISTINCT, which is what makes the upsert below reach the right row.
				const doc = {
					id: `audit-doc-${unique()}`,
					title: "Audit document",
					content: "Seeded by the destructive-action audit so its Delete control has a document to act on.",
					updated_at: new Date().toISOString(),
				};
				await sql`
					insert into agent_context ${sql({
						user_id: scope.owner.userId,
						org_id: scope.owner.userId,
						project_id: null,
						instructions: "",
						notes: "",
						documents: sql.json([doc]),
					})}
					on conflict (org_id, project_id) do update set documents = excluded.documents, updated_at = now()`;
			},
		},
	],
	[
		"pinned-widget",
		{
			writes: "one `thread_widgets` row hanging off the audit thread",
			seed: async (scope) => {
				const threadId = await ensureAuditThread(scope);
				const sql = db();
				const existing = await sql<{ id: string }[]>`
					select id from thread_widgets where thread_id = ${threadId} limit 1`;
				if (existing.length > 0) return;
				// `data.block` is what `WidgetCard` renders when there is no `source` — a
				// `DashboardBlock`, and the `stat` shape is the smallest one the tool schema admits.
				// The Remove control renders either way; a widget whose body reads "No renderer for
				// this widget" would still be measurable, and would still be a fixture that lies.
				await sql`
					insert into thread_widgets ${sql({
						thread_id: threadId,
						user_id: scope.owner.userId,
						org_id: scope.owner.userId,
						kind: "stat",
						title: "Audit widget",
						source: null,
						data: sql.json({ block: { kind: "stat", title: "Audit widget", value: 42 } }),
						pos_x: 0,
						pos_y: 0,
						colspan: 1,
						rowspan: 1,
						mode: "frozen",
					})}`;
			},
		},
	],

	// ── billing ────────────────────────────────────────────────────────────────────────────────
	[
		"active-subscription",
		{
			// ⚠ THIS WAS DECLARED UNSEEDABLE IN THIS FILE'S FIRST DRAFT, ON A REASON THAT WAS HALF
			// WRONG — and the wrong half is the one a reader acts on. The line said a seeded row
			// "would render a control whose mutation targets nothing". The mutation half is right:
			// `cancelSubscription` calls `requireSubscriptionId` and throws without a live Stripe
			// subscription. The RENDER half was false. `getBillingSummary` enters Stripe ONLY when
			// `stripe_subscription_id` is non-null; with it NULL the panel's state comes purely from
			// `organization_billing.status`, and `hasSub` is true for `active`, so "Cancel plan"
			// renders.
			//
			// And the render half is the only half this suite needs: it opens the control, asserts
			// the confirmation and presses **Cancel**. It never activates the mutation — that is
			// enforced by `assertNeverPressed`, not promised. So the fixture is seedable, and
			// leaving `stripe_subscription_id` NULL is what keeps the seeding offline.
			writes: "`organization_billing` at plan enterprise / status active with a period end and NO stripe_subscription_id",
			seed: async (scope) => {
				const sql = db();
				await sql`
					update organization_billing
					   set current_period_end = now() + interval '30 days'
					 where organization_id = ${scope.owner.orgId}`;
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
/**
 * The project's SECOND environment, written once however many fixtures ask for it.
 *
 * `project-with-two-environments` needs it to have something deletable; `pending-promotion` needs it
 * as a promotion SOURCE, because a promotion's source and target are different environments. Two
 * seeders writing one each would give the environments page two identical Delete buttons, which
 * `resolveTrigger` refuses to attribute a verdict to — so this is idempotent on the name.
 *
 * `is_default: false` is not a style choice. `spec_environments_one_default` is a partial UNIQUE
 * index on `project_id WHERE is_default`, and `project_environments_one_default_check` is a deferred
 * constraint trigger demanding EXACTLY ONE default per project — a second default fails both.
 * The name must also differ from the first: `UNIQUE(project_id, name)`.
 */
async function ensureSecondEnvironment(scope: FixtureScope): Promise<string> {
	const project = requireProject(scope);
	const sql = db();
	const NAME = "audit-staging";
	const existing = await sql<{ id: string }[]>`
		select id from project_environments where project_id = ${project.projectId} and name = ${NAME} limit 1`;
	if (existing[0]) return existing[0].id;
	const [row] = await sql<{ id: string }[]>`
		insert into project_environments ${sql({
			project_id: project.projectId,
			user_id: scope.owner.userId,
			org_id: scope.owner.orgId,
			name: NAME,
			// One of the three stages `STAGE_ORDER` groups by — an environment outside them falls
			// into no rendered group and its card is never drawn.
			stage: "staging",
			status: "DRAFT",
			is_default: false,
			region: "eu-central-1",
		})}
		returning id`;
	if (!row) throw new Error("insert into project_environments returned no row");
	return row.id;
}

/**
 * The audit's agent thread, written once however many fixtures hang off it.
 *
 * `chat-thread` needs it for `agent.thread.delete`; `pinned-widget` needs it because a
 * `thread_widgets` row is a child of a thread. Two seeders writing one each would put two rows in a
 * rail whose Delete buttons are named `Delete chat <title>` — distinguishable only if the titles
 * differ, and identical if they do not.
 *
 * ⚠ `messages` MUST BE NON-EMPTY, and this is not a display nicety. `listThreads` runs a DELETE
 * first — every `kind='agent'` thread with `jsonb_array_length(messages) = 0` older than an hour is
 * removed — and then filters the SELECT on `jsonb_array_length(messages) > 0`. An empty thread is
 * therefore invisible immediately and gone within the hour, which would read as a fixture that
 * stopped working rather than one that was never valid.
 */
async function ensureAuditThread(scope: FixtureScope): Promise<string> {
	const sql = db();
	const TITLE = "Audit chat";
	const existing = await sql<{ id: string }[]>`
		select id from agent_threads
		where user_id = ${scope.owner.userId} and title = ${TITLE} and project_id is null
		limit 1`;
	if (existing[0]) return existing[0].id;
	const [row] = await sql<{ id: string }[]>`
		insert into agent_threads ${sql({
			user_id: scope.owner.userId,
			// The USER id, not the org id — see the ⚠ on the agent block above.
			org_id: scope.owner.userId,
			// NULL: the org rail lists `project_id IS NULL` only.
			project_id: null,
			title: TITLE,
			status: "active",
			kind: "agent",
			messages: sql.json([
				{ id: "audit-m1", role: "user", parts: [{ type: "text", text: "seeded by the destructive-action audit" }] },
				{ id: "audit-m2", role: "assistant", parts: [{ type: "text", text: "acknowledged" }] },
			]),
		})}
		returning id`;
	if (!row) throw new Error("insert into agent_threads returned no row");
	return row.id;
}

/**
 * The audit's artifact, written once however many fixtures hang off it.
 *
 * `artifact` needs it for `agent.artifact.delete`; `shared-artifact` needs something to share. Two
 * would also collide on `uq_agent_artifacts_org_name`.
 *
 * ⚠ `spec.widgets` must be an ARRAY. The gallery card renders `a.spec.widgets.length` unguarded, so
 * a spec without it does not render an empty card — it throws in render, and the control is then
 * withheld for a reason that names the trigger rather than the fixture.
 */
async function ensureAuditArtifact(scope: FixtureScope): Promise<string> {
	const sql = db();
	const NAME = "Audit artifact";
	const existing = await sql<{ id: string }[]>`
		select id from agent_artifacts where org_id = ${scope.owner.userId} and name = ${NAME} limit 1`;
	if (existing[0]) return existing[0].id;
	const [row] = await sql<{ id: string }[]>`
		insert into agent_artifacts ${sql({
			user_id: scope.owner.userId,
			org_id: scope.owner.userId,
			name: NAME,
			kind: "dashboard",
			spec: sql.json({
				widgets: [
					{
						kind: "stat",
						title: "Audit stat",
						source: null,
						data: { block: { kind: "stat", title: "Audit stat", value: 1 } },
						mode: "frozen",
						position: { x: 0, y: 0 },
						size: { colspan: 1, rowspan: 1 },
					},
				],
			}),
		})}
		returning id`;
	if (!row) throw new Error("insert into agent_artifacts returned no row");
	return row.id;
}

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
		"byo-iac-source",
		"the BYO-IaC surface is behind a PROCESS FLAG, not a row. `lib/addons/byo-iac-flag.ts` reads " +
			"`ALETHIA_BYO_IAC_ENABLED === \"true\"`, the architecture page passes that down, and " +
			"`design-project-canvas.tsx` short-circuits the fetch on it — so with the flag unset the IaC card " +
			"never loads however many `project_iac_sources` rows exist. NOTHING in `.github/workflows/` or " +
			"`scripts/` sets that variable, so no gate leg can render this control. ⚠ The registry records " +
			"`byo.iac.detach` as `confirmed`; that claim rests on no run this gate can perform.",
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
 * 17 of the 47 entries record `persona: team`, and the pages they live on are gated on plan
 * entitlements. The audit persona is a plain signup (`e2e/fixtures/auth.setup.ts` → `signUpWithOtp`),
 * so its org resolves COMMUNITY and those pages refuse before any seeded row is read. Seeding the
 * rows without the grant would leave every one of those controls withheld for a reason that has
 * nothing to do with the fixture — precisely the mis-attribution this whole wave exists to end.
 *
 * See {@link grantEntitlements} for which plan, and why it is not `team`.
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
		await grantEntitlements(ctx.owner.orgId);
	} catch (err) {
		report.entitlement = err instanceof Error ? err.message : String(err);
	}
	const scope = await resolveFixtureScope(ctx);
	const already = readSeededMarker(ctx.orgSlug);
	for (const [fixture, seeder] of seeders) {
		if (already.has(fixture)) {
			report.seeded.push(fixture);
			continue;
		}
		try {
			await seeder.seed(scope);
			report.seeded.push(fixture);
			already.add(fixture);
		} catch (err) {
			report.failed.set(fixture, err instanceof Error ? err.message : String(err));
		}
	}
	writeSeededMarker(ctx.orgSlug, already);
	return report;
}

/**
 * Put the audit's org on the ENTERPRISE plan, active.
 *
 * ⚠ NOT `team`, and the difference decides four fixtures. `lib/billing/plan.ts`'s ladder gives
 * `team` the `organizations`, `alerting` and `byoRunners` entitlements — enough for members,
 * invitations and alerts — but `teams`, `customRoles` and `sso` are ENTERPRISE-ONLY. On a `team`
 * plan the Teams page disables the `Manage team` menu that BOTH team controls reach through, the
 * Access page replaces its table with an upsell, and the SSO page replaces its whole surface with
 * one. Four seeded fixtures would then sit in a database behind a paywall, and four controls would
 * withhold saying their trigger is not rendered — which is the exact sentence this unit exists to
 * stop being the only thing a reader is told.
 *
 * `personas.ts` → `grantOrganizationsEntitlement` writes `team`, and is left alone: it is the
 * fixture for the INVITE flow, several specs depend on that value, and it is not this unit's to
 * change. This writes the same row one rung up for the audit's org only.
 *
 * It is a fixture, not a bypass, on the same argument that one makes: the gate itself stays
 * exercised, because `ownerHobby`'s org is untouched and `rbac.spec.ts` still reads the real
 * refusal there. And `stripe_subscription_id` is deliberately NOT written — `getBillingSummary`
 * calls Stripe only when it is non-null, so leaving it NULL is what keeps the seeding offline while
 * still rendering the billing panel's Cancel control (see the `active-subscription` seeder).
 */
async function grantEntitlements(orgId: string): Promise<void> {
	const sql = db();
	await sql`
		insert into organization_billing (organization_id, plan, status)
		values (${orgId}, 'enterprise', 'active')
		on conflict (organization_id) do update set plan = 'enterprise', status = 'active'`;
	const rows = await sql<{ plan: string; status: string }[]>`
		select plan, status from organization_billing where organization_id = ${orgId}`;
	const row = rows[0];
	// READ IT BACK. A grant that inserted nothing and a grant that worked are the same colour
	// otherwise, and the 17 controls downstream would each blame their own fixture.
	if (!row || row.plan !== "enterprise" || row.status !== "active") {
		throw new Error(`organization_billing for ${orgId} reads ${JSON.stringify(row)} after the grant, not enterprise/active`);
	}
}

/**
 * Which fixtures this org has already had written, so a WORKER RESTART does not write them twice.
 *
 * The same hazard `context.ts` records and for the same reason: a single test timing out makes
 * Playwright discard the worker and start the next test in a fresh one, where this module is a new
 * instance with an empty map. Re-running the seeders there would put a SECOND member row and a
 * SECOND alert channel in the org — and a second identically-named row is exactly the ambiguity
 * `resolveTrigger` refuses to guess past, so the restart would silently withhold the controls it
 * re-seeded for.
 *
 * Keyed on the ORG SLUG, again following `context.ts`: a leftover file from a previous run against
 * a different org must never be read as this run's state. It records what SUCCEEDED, per fixture, so
 * a seeder that threw is retried by the next worker rather than being written off.
 */
const SEEDED_MARKER = path.resolve(process.cwd(), "e2e/.auth/audit-fixtures.json");

/** The fixtures already written for this org, or an empty set when the marker is absent or another org's. */
function readSeededMarker(orgSlug: string): Set<string> {
	if (!existsSync(SEEDED_MARKER)) return new Set();
	try {
		const saved: unknown = JSON.parse(readFileSync(SEEDED_MARKER, "utf8"));
		if (typeof saved !== "object" || saved === null) return new Set();
		if (!("orgSlug" in saved) || saved.orgSlug !== orgSlug) return new Set();
		if (!("seeded" in saved) || !Array.isArray(saved.seeded)) return new Set();
		return new Set(saved.seeded.filter((f): f is string => typeof f === "string"));
	} catch {
		// An unreadable marker is not a reason to fail a run: the worst it costs is a re-seed, and
		// the ambiguity that produces is REPORTED by `resolveTrigger` rather than silent.
		return new Set();
	}
}

/** Record which fixtures this org now has, for whichever worker runs next. */
function writeSeededMarker(orgSlug: string, seeded: ReadonlySet<string>): void {
	mkdirSync(path.dirname(SEEDED_MARKER), { recursive: true });
	writeFileSync(SEEDED_MARKER, `${JSON.stringify({ orgSlug, seeded: [...seeded] }, null, 2)}\n`);
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
