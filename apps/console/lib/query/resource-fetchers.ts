// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Plain (non-client) query functions for the runner + fleet resources. Shared by the
// client query hooks (use-runners-query / use-fleet-query) and the server-side prefetch
// in the runners route, so the fetch + shape logic lives in exactly one place.

import {
	getFleetEconomics,
	getFleetPoolViews,
	listFleetPoolConfigs,
	type FleetEconomics,
	type FleetPoolView,
} from "@/app/server/actions/fleet";
import { getOrgEvidence } from "@/app/server/actions/evidence";
import {
	getLatestRunnerRelease,
	getManagedRunnerUsage,
	getManagedRunnersWithReleases,
	getRunnersWithReleases,
} from "@/app/server/actions/runners";
import type { OrgEvidence } from "@/lib/queries/evidence";
import type { FleetPool, Runner } from "@/lib/db/schema";

export interface RunnerReleaseInfo {
	version: string;
	release_notes: string;
	released_at: string;
	github_release_url: string | null;
	commit_sha: string | null;
	is_breaking: boolean;
}

export type RunnerWithRelease = Runner & {
	runner_releases: RunnerReleaseInfo | null;
	/** Provisioned hours this calendar month for managed runners; null otherwise. */
	provisioned_hours: number | null;
};

export interface RunnersData {
	runners: RunnerWithRelease[];
	latestRelease: RunnerReleaseInfo | null;
}

export interface FleetData {
	pools: FleetPoolView[];
	/** Raw stored rows — the edit form needs the knobs the view doesn't render. */
	configs: FleetPool[];
	/** Month-to-date COGS/utilization — manager-only (null for viewers/operators). */
	economics: FleetEconomics | null;
	fleetProviderActive: boolean;
	canManageFleet: boolean;
}

/** Loads own (self/BYO) + managed runners, the latest release, and managed usage in one shot. */
export async function fetchRunnersData(): Promise<RunnersData> {
	// Own runners come through the RLS path; managed fleet runners via the service path
	// (returned only on self-managed deployments, [] on hosted), so the sets are disjoint.
	const [own, managed, latestRelease, usage] = await Promise.all([
		getRunnersWithReleases(),
		getManagedRunnersWithReleases(),
		getLatestRunnerRelease(),
		getManagedRunnerUsage(),
	]);
	const runners = [...own, ...managed].map((r) => ({
		...r,
		provisioned_hours: r.operator === "managed" ? (usage[r.id] ?? 0) : null,
	}));
	return { runners, latestRelease };
}

/** Loads the active org's evidence roll-up (verify verdicts + drift posture + waivers). */
export async function fetchEvidenceData(): Promise<OrgEvidence> {
	return getOrgEvidence();
}

/** Loads pool views, plus the raw configs + economics when the actor can manage the fleet. */
export async function fetchFleetData(): Promise<FleetData> {
	const { pools, fleetProviderActive, canManageFleet } =
		await getFleetPoolViews();
	// Raw configs + economics are manager-only (owner/admin), so only fetch when allowed.
	const [configs, economics] = canManageFleet
		? await Promise.all([listFleetPoolConfigs(), getFleetEconomics()])
		: [[] as FleetPool[], null];
	return { pools, configs, economics, fleetProviderActive, canManageFleet };
}
