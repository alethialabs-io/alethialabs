// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// How a user gets a kubeconfig for one of their clusters (#5250, #5322).
//
// The PRIMARY way, on every cloud the runner can mint on, is `alethia cluster kubeconfig <selector>`:
// a short-lived credential minted in the cluster's network and sealed to the caller's machine
// (#5283, #5284), which needs no cloud login of the caller's own. On aws, gcp and azure the cloud's
// own CLI command is ALSO given, as the alternative for people who have cloud-console access.
//
// ONE place builds this, and both surfaces read it from here: `GET /api/cli/clusters/:id` serves it
// to `alethia cluster get`, and the console's cluster card renders the same object. Before this, the
// card composed an `aws eks update-kubeconfig` string inline and the CLI printed nothing, so the two
// could not agree because only one of them said anything.
//
// WHAT THIS IS NOT: a credential path. This file only says which commands to run. The mint itself
// is lib/kubeconfig-mint/, behind its own authz check per tier; the cloud-CLI alternative runs under
// the caller's own cloud login, and the cloud's authorization decides whether it works.
//
// A SHARED CLUSTER GETS NEITHER. A namespace/vcluster environment's cluster row names the shared
// Fabric's host cluster: the mint refuses it (lib/kubeconfig-mint/request.ts, and the runner), and
// printing the cloud command for the host cluster would advertise exactly the access the refusal
// withholds. Those environments get the refusal's own sentence instead.
//
// EVERY VALUE IN A CLOUD-CLI COMMAND IS ONE THE PLATFORM RECORDED. Nothing is derived from a naming
// convention: the Azure resource group is `rg-<project>-<env>` in the template only until the name
// passes 90 characters, after which it is truncated and hashed, so re-deriving it here would be a
// second implementation of the template that is right most of the time. Instead each value is read
// from what the runner reported for the cluster's last successful deploy (the tofu outputs it
// persists, scrubbed of credentials, in `jobs.execution_metadata.outputs`) or from what that deploy
// was told (`jobs.config_snapshot.region`). When a value a cloud's command needs is not recorded,
// the answer is NO command and a note naming what is missing — never a command with a guess in it.

import { and, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "@/lib/db";
import { jobs, projectEnvironments } from "@/lib/db/schema";
// mint-eligibility, never lib/kubeconfig-mint/: an AI tool reaches this file through the cluster read,
// and that directory is on the AI tool-scope denylist.
import {
	isMintableCloud,
	isSharedClusterPlacement,
	KUBECONFIG_MINT_SHARED_CLUSTER_REASON,
} from "@/lib/clusters/mint-eligibility";

/** What the builder needs. Every value field is nullable because every one can be unrecorded. */
export interface KubeconfigFacts {
	/** The `project_cluster` row id — the selector when the cluster name is not shell-safe. */
	clusterId: string | null;
	/** Whether the environment is placed on a SHARED cluster (namespace/vcluster): no command at all. */
	sharedCluster: boolean;
	/** The cloud the cluster runs on (`aws`, `gcp`, `azure`, `alibaba`, `hetzner`, …). */
	provider: string | null;
	/** The Kubernetes cluster's name in the cloud — `project_cluster.cluster_name`. */
	clusterName: string | null;
	/** The region (or, on GCP, possibly a zone) the cluster was deployed into. */
	region: string | null;
	/** GCP only: the project the cluster lives in (the `gcp_project_id` tofu output). */
	gcpProjectId: string | null;
	/** Azure only: the resource group holding the cluster (the `resource_group_name` tofu output). */
	azureResourceGroup: string | null;
}

/**
 * The answer both surfaces render. Exactly one of three shapes:
 *   - `command` set, `note` null — copy and run it. `alternative` is the cloud's own CLI command
 *     (aws/gcp/azure, when every value it needs is recorded and shell-safe), else null;
 *   - `command` null, `note` set — there is no command, and the note says why (`alternative` null);
 *   - all null — the cluster has no name yet (still provisioning), so there is nothing to say.
 */
export interface KubeconfigAccess {
	/** `alethia cluster kubeconfig <selector>` — the primary way, on every mintable cloud. */
	command: string | null;
	/** The cloud-CLI command, for people with cloud-console access; never without `command`. */
	alternative: string | null;
	/** Why there is no command; never alongside one. */
	note: string | null;
}

/** The answer for a cluster with nothing to say yet. */
const NOTHING: KubeconfigAccess = { command: null, alternative: null, note: null };

/**
 * The characters a value may contain and still be pasted into a shell verbatim.
 *
 * The command is COPIED INTO A TERMINAL, so a value is a shell injection vector if it can carry
 * `;`, `$(…)`, a quote or a space. Every managed template's names fit this set; a BYO-IaC module's
 * `cluster_name` output is the customer's own string, and it is the case this exists for. Quoting
 * the value instead would make the command work for a name no cloud accepts anyway.
 */
const SHELL_SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A GCP zone ends in `-<letter>` (europe-west3-a); a region does not. Mirrors gcp/locals.tf's `gcp_region_key`. */
const GCP_ZONE = /-[a-z]$/;

/** Returns the trimmed value when present, otherwise null. */
function present(value: string | null): string | null {
	const v = value?.trim();
	return v ? v : null;
}

/**
 * The selector `alethia cluster kubeconfig` is given: the cluster name — the value the CLI's own
 * error messages offer (clusterSelector in apps/cli/cmd/clusters_get.go) — or, when the name is not
 * safe to paste into a shell, the cluster's id. Null when neither is usable; the command then has
 * no selector and the CLI asks which cluster.
 */
function mintSelector(name: string, clusterId: string | null): string | null {
	if (SHELL_SAFE.test(name)) return name;
	const id = present(clusterId);
	return id && SHELL_SAFE.test(id) ? id : null;
}

/**
 * Builds the kubeconfig commands for a cluster from recorded facts, or says why there are none.
 *
 * Pure: no I/O, so every cloud's arm and every missing-value arm is a unit test.
 */
export function buildKubeconfigAccess(facts: KubeconfigFacts): KubeconfigAccess {
	const name = present(facts.clusterName);
	if (!name) return NOTHING;

	if (facts.sharedCluster) {
		return { command: null, alternative: null, note: KUBECONFIG_MINT_SHARED_CLUSTER_REASON };
	}

	const provider = present(facts.provider);
	if (!isMintableCloud(provider)) {
		return {
			command: null,
			alternative: null,
			note: provider
				? `Alethia has no kubeconfig command for ${provider} clusters.`
				: "Alethia does not know which cloud this cluster runs on, so it cannot build the command.",
		};
	}

	const selector = mintSelector(name, facts.clusterId);
	return {
		command: selector
			? `alethia cluster kubeconfig ${selector}`
			: "alethia cluster kubeconfig",
		alternative: cloudCliCommand(provider, name, facts),
		note: null,
	};
}

/**
 * The cloud's own CLI command for the cluster — the alternative for people with cloud-console
 * access — or null when the cloud has none (alibaba, hetzner) or a value it needs is unrecorded or
 * unsafe to paste. A missing value says nothing here: the primary command does not need it, so a
 * sentence about it beside a working command would read as a failure that is not one.
 */
function cloudCliCommand(
	provider: string | null,
	name: string,
	facts: KubeconfigFacts,
): string | null {
	const region = present(facts.region);
	const values: Record<string, string | null> = { "cluster name": name, region };

	/** Whether every named value is recorded and safe to paste into a shell. */
	const usable = (needed: string[]): boolean =>
		needed.every((label) => {
			const v = values[label];
			return Boolean(v) && SHELL_SAFE.test(v ?? "");
		});

	switch (provider) {
		case "aws":
			if (!usable(["cluster name", "region"])) return null;
			return `aws eks update-kubeconfig --name ${name} --region ${region}`;
		case "gcp": {
			values["GCP project ID"] = present(facts.gcpProjectId);
			if (!usable(["cluster name", "region", "GCP project ID"]) || !region) return null;
			// The template passes var.region to GKE's `location` verbatim, so a zone value makes a
			// ZONAL cluster and gcloud must be told which kind of location it is.
			const where = GCP_ZONE.test(region) ? `--zone ${region}` : `--region ${region}`;
			return `gcloud container clusters get-credentials ${name} ${where} --project ${values["GCP project ID"]}`;
		}
		case "azure":
			values["resource group"] = present(facts.azureResourceGroup);
			if (!usable(["cluster name", "resource group"])) return null;
			return `az aks get-credentials --resource-group ${values["resource group"]} --name ${name}`;
		default:
			// alibaba and hetzner: no cloud-CLI alternative. ACK's kubeconfig API takes a cluster ID
			// no template output records, and a Hetzner cluster's Talos admin config never leaves
			// the platform — the mint is the only way, and it is the command above.
			return null;
	}
}

/** Reads a tofu output's string value — outputs arrive either bare or as `{ value }`. */
export function outputString(raw: unknown): string | null {
	if (typeof raw === "string") return raw;
	if (raw && typeof raw === "object" && "value" in raw) {
		const v = raw.value;
		if (typeof v === "string") return v;
	}
	return null;
}

/** Where a cluster lives, as the caller already knows it; the fallbacks for an unrecorded deploy. */
export interface ClusterLocator {
	/** The `project_cluster` row id. */
	clusterId: string;
	projectId: string;
	/** The environment that OWNS the cluster row (`project_cluster.environment_id`). */
	environmentId: string | null;
	clusterName: string | null;
	/** The cloud the caller resolved for the cluster (its cloud identity's provider). */
	provider: string | null;
	/** The region the caller resolved for the cluster. */
	region: string | null;
}

/**
 * Gathers the facts for one cluster — the owning environment's placement, plus the provider, region
 * and placement its last successful DEPLOY ran with and the two tofu outputs the GCP and Azure
 * commands need — then builds the answer.
 *
 * ONE read: the owning environment, left-joined to its successful deploys, newest first. The left
 * join is what keeps the placement when the environment has never deployed. Reads only the five
 * scalar paths it needs out of the job's JSONB, never the whole snapshot: the snapshot is a signed
 * build input, not a display record, and nothing here needs the rest of it.
 *
 * The environment is SHARED when either its column or the deploy's snapshot says namespace/vcluster:
 * the request route refuses on either (lib/kubeconfig-mint/request.ts), so this never offers a
 * command that route would refuse.
 *
 * The caller is responsible for tenancy (a service-DB caller must already have proved the cluster
 * is in the actor's org; an RLS-scoped transaction proves it itself).
 */
export async function readKubeconfigAccess(
	db: Db | Tx,
	cluster: ClusterLocator,
): Promise<KubeconfigAccess> {
	if (!present(cluster.clusterName)) return NOTHING;

	let row:
		| {
				placementMode: string | null;
				provider: string | null;
				region: unknown;
				snapshotPlacement: unknown;
				gcpProjectId: unknown;
				azureResourceGroup: unknown;
		  }
		| undefined;
	if (cluster.environmentId) {
		[row] = await db
			.select({
				placementMode: projectEnvironments.placement_mode,
				provider: jobs.provider,
				region: sql<unknown>`${jobs.config_snapshot}->'region'`,
				snapshotPlacement: sql<unknown>`${jobs.config_snapshot}->'placement_mode'`,
				gcpProjectId: sql<unknown>`${jobs.execution_metadata}->'outputs'->'gcp_project_id'`,
				azureResourceGroup: sql<unknown>`${jobs.execution_metadata}->'outputs'->'resource_group_name'`,
			})
			.from(projectEnvironments)
			.leftJoin(
				jobs,
				and(
					eq(jobs.environment_id, projectEnvironments.id),
					eq(jobs.project_id, cluster.projectId),
					eq(jobs.job_type, "DEPLOY"),
					eq(jobs.status, "SUCCESS"),
				),
			)
			.where(eq(projectEnvironments.id, cluster.environmentId))
			// NULLS LAST: the no-deploy row (all job columns null) must never outrank a real deploy.
			.orderBy(sql`${jobs.created_at} desc nulls last`)
			.limit(1);
	}

	return buildKubeconfigAccess({
		clusterId: cluster.clusterId,
		sharedCluster:
			isSharedClusterPlacement(row?.placementMode) ||
			isSharedClusterPlacement(row?.snapshotPlacement),
		provider: row?.provider ?? cluster.provider,
		clusterName: cluster.clusterName,
		region: outputString(row?.region) ?? cluster.region,
		gcpProjectId: outputString(row?.gcpProjectId),
		azureResourceGroup: outputString(row?.azureResourceGroup),
	});
}
