// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The default dependencies of the declared reads (lib/ai/mcp/reads.ts): the in-app tools each read's
// contract entry names in `replaces`, run in-process, plus the design and plan-fact reads that have
// no in-app counterpart. Each in-app tool resolves the caller and checks its own verb.

import "server-only";
import { getJobs } from "@/app/server/actions/jobs";
import { getProjectAsFormData } from "@/app/server/actions/projects";
import { catalogTools, offeredProvisioningClouds } from "@/lib/ai/tools/compose";
import { docsTools } from "@/lib/ai/tools/docs";
import { readTools } from "@/lib/ai/tools/read";
import { scannerTools } from "@/lib/ai/tools/scanner";
import { currentActor } from "@/lib/authz/guard";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import { stripDesignCredentials } from "@/lib/cloud-providers/credential-knobs";
import { readDesignRevision } from "./design-store";
import { runInAppTool } from "./in-app";
import { readPlanFacts } from "./plan-facts";
import { isoOrNull, type ReadDeps } from "./reads";
import { McpToolRefusal } from "./served";

/**
 * `cloud` as a cloud this deployment offers, or an `invalid_input` refusal that lists the ones it
 * does. The in-app catalog tools take only an offered cloud, so the check is made here, where the
 * caller can be told what to pass instead.
 */
export function offeredCloud(cloud: string): CloudProviderSlug {
	const offered = offeredProvisioningClouds();
	const match = offered.find((slug) => slug === cloud);
	if (!match) {
		throw new McpToolRefusal("invalid_input", `Unknown cloud ${cloud}. Pass one of: ${offered.join(", ")}.`);
	}
	return match;
}

/**
 * The design of one environment as `get_resource` answers it: without any credential a component's
 * `provider_config` still stores from before #5565. The write guard lets such a value ride along
 * unchanged, so a design can hold one, but no tool result carries a credential. `apply_design_patch`
 * patches the stored design server-side (lib/ai/mcp/design-deps.ts), so the value is kept on save
 * without ever being shown.
 */
async function readDesignWithoutCredentials(projectId: string, environmentId: string | undefined) {
	const { formData } = await getProjectAsFormData(projectId, environmentId);
	const copy = structuredClone(formData);
	stripDesignCredentials(copy);
	return copy;
}

/** The default read dependencies. */
export const defaultReadDeps: ReadDeps = {
	listProjects: () => runInAppTool("list_projects", readTools().list_projects, {}),
	listJobs: async () =>
		(await getJobs()).map((j) => ({
			id: j.id,
			type: j.job_type,
			status: j.status,
			project: j.project_name,
			project_id: j.project_id,
			environment_id: j.environment_id,
			provider: j.cloud_provider,
			created_at: isoOrNull(j.created_at),
			completed_at: isoOrNull(j.completed_at),
		})),
	listRunners: () => runInAppTool("list_runners", readTools().list_runners, {}),
	listClusters: () => runInAppTool("list_clusters", readTools().list_clusters, {}),
	listConnectors: () => runInAppTool("list_connectors", readTools().list_connectors, {}),
	listCloudIdentities: () => runInAppTool("list_cloud_identities", readTools().list_cloud_identities, {}),
	getProject: (projectId) => runInAppTool("get_project", readTools().get_project, { projectId }),
	getJob: (jobId) => runInAppTool("get_job", readTools().get_job, { jobId }),
	getDrift: (projectId, environmentId) =>
		runInAppTool("get_drift_posture", readTools().get_drift_posture, { projectId, environmentId }),
	getCloudInventory: (cloudIdentityId) =>
		runInAppTool("get_cached_resources", readTools().get_cached_resources, { cloudIdentityId }),
	getScan: (jobId) => runInAppTool("get_scan_result", scannerTools().get_scan_result, { jobId }),
	readDesign: async (projectId, environmentId) => readDesignWithoutCredentials(projectId, environmentId),
	designRevision: async (projectId) => readDesignRevision(await currentActor(), projectId),
	getPlanResult: (jobId) => runInAppTool("get_plan_result", readTools().get_plan_result, { jobId }),
	planFacts: readPlanFacts,
	listServices: () => runInAppTool("list_services", catalogTools().list_services, {}),
	listServiceOptions: async (provider) =>
		runInAppTool("list_service_options", catalogTools().list_service_options, { provider: offeredCloud(provider) }),
	cidrForHosts: async ({ hosts, base, cloud }) =>
		runInAppTool("cidr_for_hosts", catalogTools().cidr_for_hosts, {
			hosts,
			base,
			cloud: cloud === undefined ? undefined : offeredCloud(cloud),
		}),
	compareProviders: (scanJobId) =>
		runInAppTool("compare_providers", scannerTools().compare_providers, { jobId: scanJobId }),
	orgUsage: () => runInAppTool("get_org_usage", readTools().get_org_usage, {}),
	aiUsage: () => runInAppTool("get_ai_usage", readTools().get_ai_usage, {}),
	billingSummary: () => runInAppTool("get_billing_summary", readTools().get_billing_summary, {}),
	searchDocs: ({ query, topK }) => runInAppTool("search_docs", docsTools().search_docs, { query, topK }),
};
