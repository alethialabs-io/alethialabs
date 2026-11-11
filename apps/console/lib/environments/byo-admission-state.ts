// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What the Environments page shows about an environment's BYO admission setting (#6541): whether
// the environment has a bring-your-own chart at all (the setting means nothing without one), and
// whether the setting has changed since the latest deploy was made — "redeploy to apply".
//
// "Since the latest deploy" is read from what that deploy CARRIED, not from when it ran: its frozen
// config_snapshot's `byo_admission.enforce`. A re-run, or a deploy from a plan made before the change
// (an approval-gated or promoted one), carries the old value, so only a deploy built after the change
// applies it, and the note stays until one has been made.

import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { jobs, projectAddons } from "@/lib/db/schema";

/** One environment's BYO admission facts for its card. */
export interface ByoAdmissionCardState {
	/** The environment has at least one enabled BYO chart. */
	hasByoCharts: boolean;
	/** The setting differs from what the latest deploy carried: the next new deploy applies it. */
	pending: boolean;
}

/**
 * Whether the setting `enforce` still has to be applied, given what the latest deploy carried:
 * `carried` is its snapshot's `byo_admission.enforce`, `undefined` when that deploy carried no such key
 * (it predates the key, or the environment had no BYO chart then), `null` when there is no deploy.
 * No deploy yet means nothing to re-apply: the first deploy carries the setting.
 */
export function byoAdmissionPending(enforce: boolean, carried: boolean | undefined | null): boolean {
	if (carried === null) return false;
	return (carried ?? false) !== enforce;
}

/**
 * The card state of each of `envIds` in project `projectId`, given each one's current setting. The
 * caller has authorized `view` on the project; these reads are scoped by its id.
 */
export async function readByoAdmissionCardStates(
	projectId: string,
	settings: ReadonlyMap<string, boolean>,
): Promise<Map<string, ByoAdmissionCardState>> {
	const envIds = [...settings.keys()];
	const out = new Map<string, ByoAdmissionCardState>();
	if (envIds.length === 0) return out;
	const db = getServiceDb();
	const [byoRows, deployRows] = await Promise.all([
		db
			.selectDistinct({ environment_id: projectAddons.environment_id })
			.from(projectAddons)
			.where(
				and(
					eq(projectAddons.project_id, projectId),
					inArray(projectAddons.environment_id, envIds),
					eq(projectAddons.source, "byo"),
					eq(projectAddons.enabled, true),
				),
			),
		db
			.selectDistinctOn([jobs.environment_id], {
				environment_id: jobs.environment_id,
				carried: sql<string | null>`${jobs.config_snapshot} -> 'byo_admission' ->> 'enforce'`,
			})
			.from(jobs)
			.where(
				and(
					eq(jobs.project_id, projectId),
					inArray(jobs.environment_id, envIds),
					eq(jobs.job_type, "DEPLOY"),
				),
			)
			.orderBy(jobs.environment_id, desc(jobs.created_at)),
	]);
	const withByo = new Set(byoRows.map((r) => r.environment_id));
	const carriedByEnv = new Map(
		deployRows.map((r) => [r.environment_id, r.carried === null ? undefined : r.carried === "true"]),
	);
	for (const id of envIds) {
		const hasByoCharts = withByo.has(id);
		const carried = carriedByEnv.has(id) ? carriedByEnv.get(id) : null;
		out.set(id, {
			hasByoCharts,
			pending: hasByoCharts && byoAdmissionPending(settings.get(id) ?? false, carried),
		});
	}
	return out;
}
