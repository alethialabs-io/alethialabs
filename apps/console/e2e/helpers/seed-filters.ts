// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Rows for the live filter-standard pass (F8–F10, `e2e/audit/filters.spec.ts`, #4278).
//
// A filter over ONE row cannot narrow anything, so F8 ("the narrowed list survives a reload") and
// F9 ("facet counts do not move") are only askable over a list of at least two rows whose facet
// values DIFFER. This file writes that minimum for the lists it can reach with a plain insert, and
// nothing else: every extra row is a page some other audit can no longer read the empty state of.
//
// WHAT IT DOES NOT SEED, AND WHY THAT IS NOT SILENT. Members, teams, roles, SSO connections, access
// grants, evidence, connectors, the activity log and invoices each need either a second person, a
// provider round-trip or a Stripe object. The spec does not guess: a list that still renders fewer
// than two rows is recorded NOT MEASURED naming the count, so the gap is a column in the scoreboard
// rather than a PASS over nothing. Extending coverage is adding a row here, not editing a verdict.
//
// EVERY ROW IS REMOVED AGAIN. The spec shares an organisation with `inert.spec.ts` (R8), which runs
// after it in the same `audit-interaction` project and counts the controls each list renders; rows
// left behind here would move that count. `cleanFilterFixtures()` deletes exactly the ids it wrote.

import { db } from "./db";
import { seedJob, seedProject, type Owner, type SeededProject } from "./seed";
import { seedChannel, seedRule } from "./seed-alerts";

/** What one seeding pass wrote — the ids `cleanFilterFixtures()` removes, and the project a `[project]` route needs. */
export interface FilterFixtures {
	project: SeededProject;
	jobIds: string[];
	runnerIds: string[];
	channelIds: string[];
	ruleIds: string[];
	supportCaseIds: string[];
}

/**
 * Write two rows with differing facet values into every list a plain insert reaches.
 *
 * The facet each pair differs on is named beside it, because "two rows" is not the requirement —
 * two rows that are identical on every facet give F9 nothing to compare and F8 nothing to narrow.
 */
export async function seedFilterFixtures(owner: Owner): Promise<FilterFixtures> {
	const sql = db();
	const stamp = Date.now();
	const project = await seedProject(owner, { name: `Filters ${stamp}` });

	// Jobs (`/[org]/~/jobs`, `/[org]/[project]/jobs`): differ on STATUS and TYPE.
	const jobs = [
		await seedJob(owner, { projectId: project.projectId, envId: project.envId, status: "SUCCESS", jobType: "DEPLOY" }),
		await seedJob(owner, { projectId: project.projectId, envId: project.envId, status: "FAILED", jobType: "DESTROY", errorMessage: "e2e filter fixture" }),
	];

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
	const runnerIds = [await runner(`filters-a-${stamp}`, "ONLINE", "1.0.0"), await runner(`filters-b-${stamp}`, "OFFLINE", "1.1.0")];

	// Alerts (`/[org]/~/alerts`): channels differ on TYPE and ENABLED, policies on ENABLED.
	const channels = [
		await seedChannel(owner, { type: "email", name: `filters-mail-${stamp}`, enabled: true }),
		await seedChannel(owner, { type: "webhook", name: `filters-hook-${stamp}`, enabled: false }),
	];
	const rules = [
		await seedRule(owner, { name: `filters-on-${stamp}`, enabled: true, channelIds: [channels[0].id] }),
		await seedRule(owner, { name: `filters-off-${stamp}`, enabled: false }),
	];

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
	const supportCaseIds = [
		await supportCase(`Filters fixture A ${stamp}`, "normal", "technical"),
		await supportCase(`Filters fixture B ${stamp}`, "high", "billing"),
	];

	return {
		project,
		jobIds: jobs.map((j) => j.id),
		runnerIds,
		channelIds: channels.map((c) => c.id),
		ruleIds: rules.map((r) => r.id),
		supportCaseIds,
	};
}

/**
 * Delete exactly the rows one `seedFilterFixtures()` call wrote — never "everything in the org",
 * which would take the fixtures `inert.spec.ts` and `destructive.spec.ts` seed with it.
 */
export async function cleanFilterFixtures(f: FilterFixtures): Promise<void> {
	const sql = db();
	await sql`delete from support_messages where case_id in ${sql(f.supportCaseIds)}`;
	await sql`delete from support_cases where id in ${sql(f.supportCaseIds)}`;
	await sql`delete from alert_rules where id in ${sql(f.ruleIds)}`;
	await sql`delete from alert_channels where id in ${sql(f.channelIds)}`;
	await sql`delete from runners where id in ${sql(f.runnerIds)}`;
	await sql`delete from jobs where id in ${sql(f.jobIds)}`;
	await sql`delete from resource_hierarchy where child_type = 'project' and child_id = ${f.project.projectId}`;
	await sql`delete from projects where id = ${f.project.projectId}`;
}
