"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { listArtifacts } from "@/app/server/actions/artifacts";
import { getVerifiedCloudIdentities } from "@/app/server/actions/aws/identities";
import { getClusters } from "@/app/server/actions/clusters";
import { getConnectorsWithStatus } from "@/app/server/actions/connectors";
import { getJobs } from "@/app/server/actions/jobs";
import { getProjects } from "@/app/server/actions/projects";
import { getRunnersWithReleases } from "@/app/server/actions/runners";
import type { MentionResult, MentionType } from "@/lib/ai/mentions";

// Generous cap: the popover is scrollable, so surface the owner's full set of taggable
// resources (all types) rather than clipping to a handful.
const MAX_RESULTS = 40;
/** Type ordering when results are otherwise equal (most-actionable first). */
const TYPE_RANK: Record<MentionType, number> = {
	project: 0,
	cluster: 1,
	job: 2,
	connector: 3,
	runner: 4,
	identity: 5,
	artifact: 6,
};

/** Resolve one source to mention rows; a failing source contributes nothing. */
async function safe(fn: () => Promise<MentionResult[]>): Promise<MentionResult[]> {
	try {
		return await fn();
	} catch {
		return [];
	}
}

/**
 * Search the owner's real resources for the composer @-mention autocomplete — across
 * projects, clusters, jobs, connectors, runners, and cloud identities. Each source is
 * a PDP-gated, owner-scoped action (so results never cross tenants), fetched in
 * parallel and merged; a failing source is skipped rather than failing the whole
 * search. Matches `query` (case-insensitive) against the label + sublabel; caps the
 * merged list so the popover stays tight.
 */
export async function searchMentions(query = ""): Promise<MentionResult[]> {
	const [projects, clusters, jobs, connectors, runners, identities, artifacts] =
		await Promise.all([
			safe(async () =>
				(await getProjects()).map((p) => ({
					id: p.id,
					type: "project" as const,
					label: p.project_name,
					sublabel: [p.cloud_provider, p.region, p.status]
						.filter(Boolean)
						.join(" · "),
				})),
			),
			safe(async () =>
				(await getClusters()).map((c) => ({
					id: c.id,
					type: "cluster" as const,
					label: c.project_name,
					sublabel: [c.cloud_identities?.provider, c.status]
						.filter(Boolean)
						.join(" · "),
				})),
			),
			safe(async () =>
				(await getJobs()).slice(0, 40).map((j) => ({
					id: j.id,
					type: "job" as const,
					label: `${j.job_type} · ${j.project_name ?? "—"}`,
					sublabel: [j.status, j.cloud_provider].filter(Boolean).join(" · "),
				})),
			),
			safe(async () =>
				// Only connected connectors are taggable — an unconnected connector has no
				// account/data behind it, so tagging it tells the agent nothing.
				(await getConnectorsWithStatus())
					.filter((c) => c.connected)
					.map((c) => ({
						id: c.name,
						type: "connector" as const,
						label: c.name,
						sublabel: [c.group, "connected"].filter(Boolean).join(" · "),
					})),
			),
			safe(async () =>
				(await getRunnersWithReleases()).map((r) => ({
					id: r.id,
					type: "runner" as const,
					label: r.name,
					sublabel: r.status ?? "",
				})),
			),
			safe(async () =>
				(await getVerifiedCloudIdentities()).map((i) => ({
					id: i.id,
					type: "identity" as const,
					label: i.name,
					sublabel: i.provider,
				})),
			),
			safe(async () =>
				(await listArtifacts()).map((a) => ({
					id: a.id,
					type: "artifact" as const,
					label: a.name,
					sublabel: `${a.kind} · ${a.spec.widgets.length} widgets`,
				})),
			),
		]);

	const all: MentionResult[] = [
		...projects,
		...clusters,
		...jobs,
		...connectors,
		...runners,
		...identities,
		...artifacts,
	];

	const needle = query.trim().toLowerCase();
	const matched = needle
		? all.filter(
				(m) =>
					m.label.toLowerCase().includes(needle) ||
					m.sublabel.toLowerCase().includes(needle),
			)
		: all;

	// Prefer label-prefix matches, then type rank, then alphabetical.
	matched.sort((a, b) => {
		if (needle) {
			const ap = a.label.toLowerCase().startsWith(needle) ? 0 : 1;
			const bp = b.label.toLowerCase().startsWith(needle) ? 0 : 1;
			if (ap !== bp) return ap - bp;
		}
		if (TYPE_RANK[a.type] !== TYPE_RANK[b.type])
			return TYPE_RANK[a.type] - TYPE_RANK[b.type];
		return a.label.localeCompare(b.label);
	});

	return matched.slice(0, MAX_RESULTS);
}
