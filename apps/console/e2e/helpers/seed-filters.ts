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
// `inert.spec.ts` reads. The spec does not guess: a list that still renders fewer than two rows —
// or a bar with no counted option — is recorded NOT MEASURED naming why, so the gap is a column in
// the scoreboard rather than a PASS over nothing. Extending coverage is adding a row here, not
// editing a verdict — and adding the route to `SEEDED_ROUTES` below. The spec fails a seeded
// route only when it reads NOT MEASURED while showing the list ANSWERED (a counted list under
// MIN_ROWS, or options that narrowed nothing); one where no list size was read at all is still a
// column, not a failure (see `pairMissing` in `filters.spec.ts`).
//
// THE ACTIVITY ROWS ARE THE ONE EXCEPTION TO "EVERY ROW IS REMOVED AGAIN". `authz_activity_log` is
// append-only: its WORM trigger (`lib/db/programmables.sql`) raises on any DELETE outside the
// retention GC, so the two rows written for the activity feeds outlive the spec. They are written
// anyway (#5471) because without them neither feed had a pair: the project feed rendered 0 rows and
// the org feed's every row belonged to the owner, and whether anything else landed there depended
// on what earlier specs happened to do. What they leave behind is bounded: two rows in the run's own
// org, whose project id stops resolving once `cleanFilterFixtures()` deletes the project.
//
// NO ROW HERE MAY FEED A BACKGROUND LOOP. The console runs in-process schedulers
// (`lib/reconcile/loop.ts`) that write rows into the very lists measured here. A successful DEPLOY
// is the source the drift scheduler (`lib/drift/dispatch.ts`) enqueues a DETECT_DRIFT job from, on
// a 5-minute tick: a seeded one added a job to `/[org]/~/jobs` mid-measurement whenever that tick
// fell inside the route's ~10 s window, and the known-PASS jobs surface reported F8 FAIL with
// `afterReset` one higher than `full` (runs 37124096053 and 37158731650, #5471).

// Invoices are NOT a Stripe object here: the billing UI reads `invoice`, the local mirror the Stripe
// webhook writes (`lib/db/schema/invoices.ts`), so a plain insert reaches the page. This header said
// otherwise until #5045, and the page stayed unmeasured on the strength of the sentence.
//
// EVERY ROW IS REMOVED AGAIN. The spec shares an organisation with `inert.spec.ts` (R8), which runs
// after it in the same `audit-interaction` project and counts the controls each list renders; rows
// left behind here would move that count. `cleanFilterFixtures()` deletes exactly the ids it wrote.

import { createHash, randomBytes, randomUUID } from "node:crypto";

import { db } from "./db";
import { seedCloudIdentity, seedJob, seedProject, type Owner, type SeededProject } from "./seed";
import { seedChannel, seedRule } from "./seed-alerts";
import { seedSupportContact } from "./support-contact";

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
	serviceTokenIds: string[];
	approvalIds: string[];
}

/**
 * The manifest routes this file seeds a narrowing pair for. `filters.spec.ts` fails one of them
 * when it reads NOT MEASURED while the list visibly ANSWERED without a narrowing pair (an answered
 * count under MIN_ROWS, or options that narrowed nothing) — that means the pair stopped reaching
 * the page, a defect in this file. A NOT MEASURED where no list size was read (no `[data-list-item]`,
 * no table, still busy) is let through as a column, not a failure; listing a route here does not by
 * itself hold it to a measured verdict.
 */
export const SEEDED_ROUTES: readonly string[] = [
	"/[org]/~/jobs",
	"/[org]/[project]/jobs",
	"/[org]/[project]/environments",
	"/[org]/~/clusters",
	"/[org]/[project]/clusters",
	"/[org]/~/runners",
	"/[org]/~/alerts",
	"/[org]/~/support/my-cases",
	"/[org]/~/evidence",
	"/[org]/~/settings/teams",
	"/[org]/[project]/settings/access",
	"/[org]/~/settings/sso",
	"/[org]/~/settings/billing/invoices",
	"/[org]/~/settings/activity",
	"/[org]/[project]/settings/activity",
	"/[org]/~/settings/tokens",
	"/[org]/~/approvals",
];

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
		serviceTokenIds: [],
		approvalIds: [],
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

	// Jobs (`/[org]/~/jobs`, `/[org]/[project]/jobs`): differ on STATUS and TYPE. The successful one
	// is a PLAN, never a DEPLOY: each background loop that inserts a job (`lib/reconcile/loop.ts` —
	// the drift and probe schedulers and the ephemeral reaper) selects its environments by a
	// successful DEPLOY, and a job it inserted here would land in the list while F8 is counting it —
	// see the header.
	written.jobIds.push((await seedJob(owner, { projectId: project.projectId, envId: project.envId, status: "SUCCESS", jobType: "PLAN" })).id);
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
	/**
	 * Insert one open support case with the given severity and type, and its opening message. The
	 * product never writes a case without one (`submitCase` → `openCase` inserts the description as the
	 * first customer message in the same transaction), and a case with none renders its thread's
	 * empty state — which made the route-behaviour audit score `~/support/cases/[id]` against an
	 * answered render that is an empty state, a shape no real case has (#6336).
	 */
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
				contact: sql.json(seedSupportContact()),
			})}
			returning id`;
		await sql`
			insert into support_messages ${sql({
				case_id: row.id,
				author_type: "customer",
				author_id: owner.userId,
				body: `Opening message of ${subject}.`,
			})}`;
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

	// Environments (`/[org]/[project]/environments`) and clusters (`/[org]/~/clusters`,
	// `/[org]/[project]/clusters`), #7673. `seedProject` writes ONE environment, so the environments
	// list read a single row, and its cluster row is not "under management" until its environment has
	// deployed (`managedClusterPredicate`, lib/queries/usage-counts.ts), so both clusters lists read
	// empty. A second environment differs on STAGE (production vs staging), and its cluster on REGION
	// (the project's eu-central-1 vs us-east-1); stamping `last_deployed_at` on both puts both
	// clusters under management.
	//
	// The stamp feeds NO background loop, which the header requires: the drift and probe schedulers
	// and the ephemeral reaper all select environments by a successful DEPLOY JOB
	// (`lib/drift/dispatch.ts`, `lib/probes/dispatch.ts`, `lib/reconcile/reap.ts`), and this file
	// writes none — only the column the list reads. Both environments stay DRAFT, which is not in
	// flight, so the converger has nothing to settle either. Both rows, and the second cluster row,
	// go with the project in `cleanFilterFixtures()`: `project_environments` and `project_cluster`
	// cascade from `projects`, exactly as the rows `seedProject` writes already do.
	const [staging] = await sql<{ id: string }[]>`
		insert into project_environments ${sql({
			project_id: project.projectId,
			user_id: owner.userId,
			org_id: owner.orgId,
			name: "staging",
			stage: "staging",
			status: "DRAFT",
			is_default: false,
			region: "us-east-1",
		})}
		returning id`;
	await sql`
		insert into project_cluster ${sql({
			project_id: project.projectId,
			environment_id: staging.id,
			region: "us-east-1",
			status: "PENDING",
		})}`;
	await sql`update project_environments set last_deployed_at = now() where id in ${sql([project.envId, staging.id])}`;

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

	// Activity (`/[org]/~/settings/activity`, `/[org]/[project]/settings/activity`): differ on ACTOR,
	// the bar's first facet, and on DECISION. Both rows name this project as their resource, so the
	// project feed — scoped to `resource_id` — holds exactly this pair, and the org feed holds it on
	// top of whatever earlier specs did. One actor is the owner; the other is an id with no user row
	// and no membership, which the feed renders as a "Former member" option counting one event
	// (`components/settings/activity/activity-log.tsx`) — narrower than either list. A real second
	// member would be an account other specs can see and sign in as; an id nobody holds is not.
	// These two rows are NOT removed: see the header.
	/** Insert one activity event on this project by the given actor. */
	const activity = async (actorId: string, action: string, decision: boolean) => {
		await sql`
			insert into authz_activity_log ${sql({
				org_id: owner.orgId,
				actor_id: actorId,
				action,
				resource_type: "project",
				resource_id: project.projectId,
				decision,
				reason: decision ? null : "e2e filter fixture",
			})}`;
	};
	await activity(owner.userId, "update", true);
	await activity(randomUUID(), "delete", false);

	// Service tokens (`/[org]/~/settings/tokens`, #7628): differ on STATUS, the bar's one facet —
	// one active, one revoked (the list keeps revoked rows for their audit trail). Without them the
	// family-B org rendered the first-run empty state where the route's skeleton draws a table (B2).
	// The hash is of random bytes nobody keeps, so no client can ever present either token; the
	// prefix has the real `alethia_sat_` + 8 shape so the row reads as a real one. The active token
	// is scoped to THIS project and has no auto-approve environments, so it could not queue a deploy
	// on anything even if it could be presented.
	/** Insert one service token limited to this project, recording its id; revoked when `revoked` is set. */
	const serviceToken = async (name: string, revoked: boolean) => {
		const secret = randomBytes(24).toString("hex");
		const [row] = await sql<{ id: string }[]>`
			insert into cli_service_tokens ${sql({
				organization_id: owner.orgId,
				name,
				token_hash: createHash("sha256").update(secret).digest("hex"),
				token_prefix: `alethia_sat_${secret.slice(0, 8)}`,
				created_by: owner.userId,
				revoked_at: revoked ? new Date() : null,
			})}
			returning id`;
		// A separate statement so the array carries an explicit `uuid[]` cast; recorded first, so a
		// failure here still leaves an id `cleanFilterFixtures` removes.
		written.serviceTokenIds.push(row.id);
		await sql`update cli_service_tokens set project_ids = array[${project.projectId}::uuid] where id = ${row.id}`;
		return row.id;
	};
	const ciToken = await serviceToken(`filters-ci-${stamp}`, false);
	await serviceToken(`filters-old-${stamp}`, true);

	// Approvals (`/[org]/~/approvals`, #7629): differ on STATUS and on the CREDENTIAL that asked —
	// the shape the product writes: a pipeline's request through the service token above, still
	// pending, and a person's own console request that was rejected, with its decider and time (the
	// `apply_approvals_decision_shape` check). Both name the SUCCESS PLAN job above in this project's
	// default environment, which `apply_approvals_bind_target` requires. Both are DEPLOYS: a destroy
	// approval needs a destroy-mode plan, which this file does not write. The pending one expires in
	// 24 hours, the longest TTL an org can set, so a restored family-B run still reads it live. No
	// background loop reads `apply_approvals` (`lib/reconcile/` consumes none), and a pending approval
	// is consumed only by a request that presents it. `cleanFilterFixtures()` deletes both by id
	// before the jobs they name (the FK would cascade anyway).
	/** Insert one deploy approval on the seeded plan job. */
	const approval = async (row: { status: "pending" | "rejected"; credential: "service_token" | "session"; ref: string | null; reason: string }) => {
		const decided = row.status === "rejected";
		const [inserted] = await sql<{ id: string }[]>`
			insert into apply_approvals ${sql({
				org_id: owner.orgId,
				project_id: project.projectId,
				environment_id: project.envId,
				operation: "deploy",
				plan_job_id: written.jobIds[0],
				plan_sha256: createHash("sha256").update(`filters-plan-${stamp}`).digest("hex"),
				requester_user_id: owner.userId,
				requester_credential: row.credential,
				requester_credential_ref: row.ref,
				reason: row.reason,
				status: row.status,
				approver_user_id: decided ? owner.userId : null,
				decided_at: decided ? new Date() : null,
				decision_reason: decided ? "e2e filter fixture" : null,
				expires_at: new Date(Date.now() + 24 * 60 * 60_000),
			})}
			returning id`;
		return inserted.id;
	};
	written.approvalIds.push(await approval({ status: "pending", credential: "service_token", ref: ciToken, reason: "Deploy from CI (e2e filter fixture)" }));
	written.approvalIds.push(await approval({ status: "rejected", credential: "session", ref: null, reason: "Manual deploy (e2e filter fixture)" }));
}

/**
 * Delete exactly the rows one `seedFilterFixtures()` call wrote — never "everything in the org",
 * which would take the fixtures `inert.spec.ts` and `destructive.spec.ts` seed with it.
 *
 * An empty id list skips its table: a partial seed calls this too, and `in ()` is not valid SQL.
 */
export async function cleanFilterFixtures(f: FilterFixtures): Promise<void> {
	const sql = db();
	if (f.approvalIds.length > 0) await sql`delete from apply_approvals where id in ${sql(f.approvalIds)}`;
	if (f.serviceTokenIds.length > 0) await sql`delete from cli_service_tokens where id in ${sql(f.serviceTokenIds)}`;
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
