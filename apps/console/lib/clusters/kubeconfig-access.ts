// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// How a user gets a kubeconfig for one of their clusters — with THEIR OWN cloud CLI (#5250).
//
// ONE place builds this, and both surfaces read it from here: `GET /api/cli/clusters/:id` serves it
// to `alethia cluster get`, and the console's cluster card renders the same object. Before this, the
// card composed an `aws eks update-kubeconfig` string inline and the CLI printed nothing, so the two
// could not agree because only one of them said anything.
//
// WHAT THIS IS NOT: a credential path. Every command below runs under the caller's own cloud login
// and the cloud's own authorization decides whether it works. Alethia hands out no token, no
// certificate and no kubeconfig here — that is stage 2 of #5250, and it is a design, not this file.
//
// EVERY VALUE IN A COMMAND IS ONE THE PLATFORM RECORDED. Nothing is derived from a naming
// convention: the Azure resource group is `rg-<project>-<env>` in the template only until the name
// passes 90 characters, after which it is truncated and hashed, so re-deriving it here would be a
// second implementation of the template that is right most of the time. Instead each value is read
// from what the runner reported for the cluster's last successful deploy (the tofu outputs it
// persists, scrubbed of credentials, in `jobs.execution_metadata.outputs`) or from what that deploy
// was told (`jobs.config_snapshot.region`). When a value a cloud's command needs is not recorded,
// the answer is NO command and a note naming what is missing — never a command with a guess in it.

import { and, desc, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "@/lib/db";
import { jobs } from "@/lib/db/schema";

/** The tracking issue the "not yet" notes point at. */
export const KUBECONFIG_ISSUE_URL =
	"https://github.com/alethialabs-io/alethialabs/issues/5250";

/** What the builder needs. Every field is nullable because every one can be unrecorded. */
export interface KubeconfigFacts {
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
 *   - `command` set, `note` null — copy and run it;
 *   - `command` null, `note` set — there is no command, and the note says why;
 *   - both null — the cluster has no name yet (still provisioning), so there is nothing to say.
 */
export interface KubeconfigAccess {
	command: string | null;
	note: string | null;
}

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
 * Builds the kubeconfig command for a cluster from recorded facts, or says why there is none.
 *
 * Pure: no I/O, so every cloud's arm and every missing-value arm is a unit test.
 */
export function buildKubeconfigAccess(facts: KubeconfigFacts): KubeconfigAccess {
	const name = present(facts.clusterName);
	if (!name) return { command: null, note: null };

	const provider = present(facts.provider);
	if (provider === "hetzner") {
		return {
			command: null,
			note: `Alethia does not hand out a kubeconfig for Hetzner clusters yet — the Talos admin config stays encrypted on the platform. See ${KUBECONFIG_ISSUE_URL}.`,
		};
	}

	const region = present(facts.region);
	const values: Record<string, string | null> = { "cluster name": name, region };

	/** The first named value that is missing, or that is unsafe to paste into a shell. */
	const problem = (needed: string[]): string | null => {
		for (const label of needed) {
			const v = values[label];
			if (!v) {
				return `Alethia has no recorded ${label} for this cluster, so it cannot build the command. Redeploy the environment to record it.`;
			}
			if (!SHELL_SAFE.test(v)) {
				return `The recorded ${label} contains characters that are unsafe to paste into a shell, so Alethia does not print a command for it.`;
			}
		}
		return null;
	};

	switch (provider) {
		case "aws": {
			const why = problem(["cluster name", "region"]);
			if (why) return { command: null, note: why };
			return {
				command: `aws eks update-kubeconfig --name ${name} --region ${region}`,
				note: null,
			};
		}
		case "gcp": {
			values["GCP project ID"] = present(facts.gcpProjectId);
			const why = problem(["cluster name", "region", "GCP project ID"]);
			if (why || !region) return { command: null, note: why };
			// The template passes var.region to GKE's `location` verbatim, so a zone value makes a
			// ZONAL cluster and gcloud must be told which kind of location it is.
			const where = GCP_ZONE.test(region) ? `--zone ${region}` : `--region ${region}`;
			return {
				command: `gcloud container clusters get-credentials ${name} ${where} --project ${values["GCP project ID"]}`,
				note: null,
			};
		}
		case "azure": {
			values["resource group"] = present(facts.azureResourceGroup);
			const why = problem(["cluster name", "resource group"]);
			if (why) return { command: null, note: why };
			return {
				command: `az aks get-credentials --resource-group ${values["resource group"]} --name ${name}`,
				note: null,
			};
		}
		case "alibaba": {
			// ACK's kubeconfig API (DescribeClusterUserKubeconfig, GET /k8s/{ClusterId}/user_config)
			// takes the cluster ID, and no template output or column records it — only the name.
			// ACK does not guarantee names are unique, so resolving the ID by name here would be a
			// guess. Name the cluster and the call instead.
			const where = region ? ` in ${region}` : "";
			return {
				command: null,
				note: `Alethia does not record ACK cluster IDs yet. Find the ID of cluster ${name}${where} in the ACK console, then run: aliyun cs GET /k8s/<cluster-id>/user_config — its "config" field is the kubeconfig. See ${KUBECONFIG_ISSUE_URL}.`,
			};
		}
		default:
			return {
				command: null,
				note: provider
					? `Alethia has no kubeconfig command for ${provider} clusters.`
					: "Alethia does not know which cloud this cluster runs on, so it cannot build the command.",
			};
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
 * Gathers the facts for one cluster: the provider and region its last successful DEPLOY ran with,
 * and the two tofu outputs the GCP and Azure commands need — then builds the command.
 *
 * Reads only the four scalar paths it needs out of the job's JSONB, never the whole snapshot: the
 * snapshot is a signed build input, not a display record, and nothing here needs the rest of it.
 * The caller is responsible for tenancy (a service-DB caller must already have proved the cluster
 * is in the actor's org; an RLS-scoped transaction proves it itself).
 */
export async function readKubeconfigAccess(
	db: Db | Tx,
	cluster: ClusterLocator,
): Promise<KubeconfigAccess> {
	if (!present(cluster.clusterName)) return { command: null, note: null };

	let deploy:
		| {
				provider: string | null;
				region: unknown;
				gcpProjectId: unknown;
				azureResourceGroup: unknown;
		  }
		| undefined;
	if (cluster.environmentId) {
		[deploy] = await db
			.select({
				provider: jobs.provider,
				region: sql<unknown>`${jobs.config_snapshot}->'region'`,
				gcpProjectId: sql<unknown>`${jobs.execution_metadata}->'outputs'->'gcp_project_id'`,
				azureResourceGroup: sql<unknown>`${jobs.execution_metadata}->'outputs'->'resource_group_name'`,
			})
			.from(jobs)
			.where(
				and(
					eq(jobs.project_id, cluster.projectId),
					eq(jobs.environment_id, cluster.environmentId),
					eq(jobs.job_type, "DEPLOY"),
					eq(jobs.status, "SUCCESS"),
				),
			)
			.orderBy(desc(jobs.created_at))
			.limit(1);
	}

	return buildKubeconfigAccess({
		provider: deploy?.provider ?? cluster.provider,
		clusterName: cluster.clusterName,
		region: outputString(deploy?.region) ?? cluster.region,
		gcpProjectId: outputString(deploy?.gcpProjectId),
		azureResourceGroup: outputString(deploy?.azureResourceGroup),
	});
}
