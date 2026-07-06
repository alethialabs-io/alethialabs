"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getVerifiedCloudIdentities } from "@/app/server/actions/aws/identities";
import { getClusters } from "@/app/server/actions/clusters";
import { getConnectorsWithStatus } from "@/app/server/actions/connectors";
import { getJobs } from "@/app/server/actions/jobs";
import { getProjects } from "@/app/server/actions/projects";
import { getRunnersWithReleases } from "@/app/server/actions/runners";
import type { MentionResult, MentionType } from "@/lib/ai/mentions";

const MAX_RESULTS = 10;
/** Type ordering when results are otherwise equal (most-actionable first). */
const TYPE_RANK: Record<MentionType, number> = {
	project: 0,
	cluster: 1,
	job: 2,
	connector: 3,
	runner: 4,
	identity: 5,
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
	const [projects, clusters, jobs, connectors, runners, identities] =
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
				(await getConnectorsWithStatus()).map((c) => ({
					id: c.name,
					type: "connector" as const,
					label: c.name,
					sublabel: [c.group, c.connected ? "connected" : "not connected"]
						.filter(Boolean)
						.join(" · "),
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
		]);

	const all: MentionResult[] = [
		...projects,
		...clusters,
		...jobs,
		...connectors,
		...runners,
		...identities,
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
