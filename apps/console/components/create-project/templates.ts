// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CreateProjectInput } from "@/app/server/actions/projects";
import type { EnvironmentSpec } from "@/lib/queries/projects";
import {
	AUTOSCALER,
	DEFAULT_INSTANCE_TYPE,
	DEFAULT_K8S_VERSION,
	DEFAULT_REGION,
	type CloudProviderSlug,
} from "@/lib/cloud-providers";
import type { EnvironmentStage } from "@/lib/db/schema";
import { webhookCaConsumersForTemplate } from "@/lib/addons/webhook-ca-consumers";

/** The quick-create template ids. UI-only — there is no template column in the schema. */
export type TemplateId = "standard" | "ai" | "custom";

/** The template the Configure screen starts on. */
export const DEFAULT_TEMPLATE: TemplateId = "standard";

/** A public starter repository (epic #2766, created by #4112) a template hands the user. */
export interface StarterRepository {
	/** The repository's name under `alethialabs-io`, as the docs page names it. */
	name: string;
	/** The repository's GitHub URL. */
	url: string;
}

/** One card of the template picker: what it says, and which starter repository it hands over. */
export interface TemplateOption {
	id: TemplateId;
	title: string;
	description: string;
	features: string[];
	/** The starter to copy, or `null` when the template deliberately ships none (Custom). */
	starter: StarterRepository | null;
	/** What to do with the starter once the project exists — one sentence, shown under the picker. */
	nextStep: string;
}

/**
 * The picker's catalogue, keyed on {@link TemplateId}. STATIC ON PURPOSE: the three starter
 * repositories are public and fixed (`apps/docs/content/docs/console/design-project/starter-templates.mdx`),
 * so the screen never asks GitHub anything at render time.
 *
 * WHAT A TEMPLATE DOES NOT CHANGE: the cluster. All three create the same CPU node pool —
 * `alethia-starter-ai` is CPU-only by the explicit decision in #4112 ("a GPU node pool is the most
 * expensive thing a curious user could provision by accident") and states that its default stack
 * fits in an ordinary node pool. The `"ai"` id used to mean a GPU instance type here; it was
 * unreachable from the UI, and wiring the picker to it would have made "AI Workloads" provision the
 * one thing its own starter refuses to.
 */
export const TEMPLATE_OPTIONS: readonly TemplateOption[] = [
	{
		id: "standard",
		title: "Standard",
		description:
			"A general-purpose cluster, and an apps repository for ArgoCD to deploy your manifests from.",
		features: ["Default node type for your cloud", "Auto-scaling node pool", "Apps repository starter"],
		starter: {
			name: "alethia-starter-apps",
			url: "https://github.com/alethialabs-io/alethia-starter-apps",
		},
		nextStep:
			"Copy it, then set your copy as the environment's ArgoCD apps repository under Repositories.",
	},
	{
		id: "ai",
		title: "AI Workloads",
		description:
			"The same cluster, with a retrieval-augmented generation stack: a vector database, embeddings and CPU inference.",
		features: ["CPU-only — provisions no GPU", "KServe and Kueue add-ons", "Qdrant and a RAG app"],
		starter: {
			name: "alethia-starter-ai",
			url: "https://github.com/alethialabs-io/alethia-starter-ai",
		},
		nextStep:
			"KServe needs cert-manager, which Alethia installs only when the DNS component has a domain and Managed TLS certificate switched on. Set that first; its add-ons go in the apps repository and its workloads in a bring-your-own chart.",
	},
	{
		id: "custom",
		title: "Custom",
		description:
			"The same cluster and no starter repository. You attach your own repositories on the canvas.",
		features: ["No starter repository", "Your own apps repository or chart", "Full control"],
		starter: null,
		nextStep: "Attach your own apps repository or Helm chart from the canvas after you create the project.",
	},
];

/** The catalogue entry for `id`. Every {@link TemplateId} has exactly one; the fallback is unreachable. */
export function templateOption(id: TemplateId): TemplateOption {
	return TEMPLATE_OPTIONS.find((o) => o.id === id) ?? TEMPLATE_OPTIONS[0];
}

/** GitHub's "Use this template" URL for a starter — it opens the create-a-copy form. */
export function starterCopyUrl(starter: StarterRepository): string {
	return `${starter.url}/generate`;
}

/** A quick-create environment row (the rail's Production / Preview entries). */
export interface QuickEnvironment {
	/** Slug-safe environment name (also the tofu state-path segment), e.g. "production". */
	name: string;
	stage: EnvironmentStage;
	region: string;
}

/**
 * Builds the full {@link CreateProjectInput} for a quick-create submission. The form only
 * captures a name and cloud; everything else comes from per-provider presets so the project is
 * valid and immediately designable. Every template creates the same cluster (see
 * {@link TEMPLATE_OPTIONS}); the template is an input only for the in-cluster webhook-CA marker
 * (#4990) — the AI template declares KServe — and otherwise differs only in the starter it hands
 * over. The first environment seeds the project's default env (createProject), the rest are added
 * afterwards.
 */
export function buildCreateInput(args: {
	projectName: string;
	template: TemplateId;
	provider: CloudProviderSlug;
	cloudIdentityId: string;
	defaultEnvironment: QuickEnvironment;
	/** The placement matrix from the selector (#844). Omitted → createProject keeps the legacy
	 *  Prod(dedicated)+Preview(namespace) shape. */
	environments?: EnvironmentSpec[];
}): CreateProjectInput {
	const { projectName, template, provider, cloudIdentityId, defaultEnvironment, environments } =
		args;
	const autoscalerKey = AUTOSCALER[provider].providerConfigKey;
	// The template's in-cluster webhook-CA needs (#4990): the AI template's KServe needs
	// cert-manager, which the deploy installs issuer-free when the project declares it. Omitted
	// when empty so every other template's input is unchanged.
	const webhookCaConsumers = webhookCaConsumersForTemplate(template);

	return {
		project: {
			project_name: projectName,
			environment_stage: defaultEnvironment.stage,
			region: defaultEnvironment.region,
			cloud_identity_id: cloudIdentityId,
			iac_version: "1.11.4",
			...(environments?.length ? { environments } : {}),
			...(webhookCaConsumers.length ? { webhook_ca_consumers: webhookCaConsumers } : {}),
		},
		network: {
			provision_network: true,
			cidr_block: "10.0.0.0/16",
			single_nat_gateway: true,
		},
		cluster: {
			cluster_version: DEFAULT_K8S_VERSION[provider],
			instance_types: [DEFAULT_INSTANCE_TYPE[provider]],
			node_min_size: 2,
			node_max_size: 5,
			node_desired_size: 2,
			cluster_admins: [],
			provider_config: { [autoscalerKey]: true },
		},
		dns: {
			enabled: false,
			managed_certificate: false,
			waf_enabled: false,
			provider_config: {},
		},
		repositories: {},
		databases: [],
		caches: [],
		queues: [],
		topics: [],
		nosql_tables: [],
		secrets: [],
	};
}

/**
 * Builds a minimal {@link CreateProjectInput} for an EMPTY project — name only, no cloud, no
 * template. `region` is `notNull` so we default it (the cloud + real region are chosen later on
 * the design page). The cluster/network rows exist but carry blank defaults to design from scratch.
 */
export function buildEmptyCreateInput(args: {
	projectName: string;
	defaultEnvironment: QuickEnvironment;
	/** The placement matrix from the selector (#844). Omitted → the legacy Prod+Preview shape. */
	environments?: EnvironmentSpec[];
}): CreateProjectInput {
	const { projectName, defaultEnvironment, environments } = args;

	return {
		project: {
			project_name: projectName,
			environment_stage: defaultEnvironment.stage,
			region: defaultEnvironment.region || DEFAULT_REGION.aws,
			cloud_identity_id: null,
			iac_version: "1.11.4",
			...(environments?.length ? { environments } : {}),
		},
		network: {
			provision_network: true,
			cidr_block: "10.0.0.0/16",
			single_nat_gateway: true,
		},
		cluster: {
			cluster_version: "1.31",
			instance_types: [],
			node_min_size: 2,
			node_max_size: 5,
			node_desired_size: 2,
			cluster_admins: [],
			provider_config: {},
		},
		dns: {
			enabled: false,
			managed_certificate: false,
			waf_enabled: false,
			provider_config: {},
		},
		repositories: {},
		databases: [],
		caches: [],
		queues: [],
		topics: [],
		nosql_tables: [],
		secrets: [],
	};
}
