// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Provider-aware hints for the add-on catalog's `requires` capabilities. This is a
// capability map keyed by requirement (storage/ingress/domain) with a per-provider
// resolver — deliberately NOT a per-addon × per-cloud matrix. Ground truth mirrors the
// OpenTofu templates: aws gp3 (infra/templates/argocd/storage-class-gp3.yaml), hetzner
// hcloud-volumes (infra/templates/project/hetzner/csi.tf), gcp/azure managed-K8s
// built-ins; Alibaba's ACK template manages no StorageClass, so its hint is "verify".

import { PROVIDERS } from "@/lib/cloud-providers/registry";
import type { CloudProviderSlug } from "@/lib/cloud-providers/registry";
import type { AddOnRequirement } from "./types";

/** How a requirement is met on the target cloud: provisioned by the platform template
 * ("built-in"), installable from the marketplace ("addon"), or up to the user ("manual"). */
export type RequirementSatisfaction = "built-in" | "addon" | "manual";

/** A resolved requirement hint: a short badge label + a one-line, provider-specific
 * explanation of how (or whether) the capability is satisfied. */
export interface RequirementHint {
	label: string;
	hint: string;
	satisfied: RequirementSatisfaction;
}

/** Default-StorageClass hint per provisioning cloud (null = provider not yet chosen). */
function storageHint(provider: CloudProviderSlug | null): RequirementHint {
	const label = "Storage";
	switch (provider) {
		case "aws":
			return {
				label,
				hint: 'Persistent volumes via the default "gp3" StorageClass, created by the platform (EBS CSI).',
				satisfied: "built-in",
			};
		case "gcp":
			return {
				label,
				hint: 'Persistent volumes via GKE\'s built-in default "standard-rwo" StorageClass.',
				satisfied: "built-in",
			};
		case "azure":
			return {
				label,
				hint: 'Persistent volumes via AKS\'s built-in default "managed-csi" StorageClass.',
				satisfied: "built-in",
			};
		case "alibaba":
			return {
				label,
				hint: "ACK ships alicloud-disk-* StorageClasses; verify a default class is annotated.",
				satisfied: "manual",
			};
		case "hetzner":
			return {
				label,
				hint: 'Persistent volumes via the default "hcloud-volumes" StorageClass, created by the platform (hcloud CSI).',
				satisfied: "built-in",
			};
		default:
			return {
				label,
				hint: "Needs persistent volumes — a default StorageClass must exist on the cluster.",
				satisfied: "manual",
			};
	}
}

/** Ingress-controller hint per provisioning cloud (null = provider not yet chosen). */
function ingressHint(provider: CloudProviderSlug | null): RequirementHint {
	const label = "Ingress";
	switch (provider) {
		case "aws":
			return {
				label,
				hint: 'ALB controller installed by the platform (ingress class "alb").',
				satisfied: "built-in",
			};
		case "gcp":
		case "azure":
		case "alibaba":
			return {
				label,
				hint: "Cloud LoadBalancer available — install the ingress-nginx add-on for Ingress resources.",
				satisfied: "addon",
			};
		case "hetzner":
			return {
				label,
				hint: "hcloud load balancers via the in-cluster CCM — install the ingress-nginx add-on.",
				satisfied: "addon",
			};
		default:
			return {
				label,
				hint: "Needs an ingress controller — install the ingress-nginx add-on for Ingress resources.",
				satisfied: "addon",
			};
	}
}

/** Domain/DNS hint — points at the project's DNS node (the provider's DNS service). */
function domainHint(provider: CloudProviderSlug | null): RequirementHint {
	const label = "Domain";
	if (provider) {
		return {
			label,
			hint: `Requires a domain — add the DNS node (${PROVIDERS[provider].dnsService}) to the project.`,
			satisfied: "manual",
		};
	}
	return {
		label,
		hint: "Requires a domain with DNS records pointing at the cluster — add the project's DNS node.",
		satisfied: "manual",
	};
}

/**
 * Resolver per requirement: given the project's effective cloud provider (or null when
 * none is chosen yet), returns the badge label + provider-specific hint the add-on
 * config sheet renders under its description.
 */
export const REQUIREMENT_HINTS: Record<
	AddOnRequirement,
	(provider: CloudProviderSlug | null) => RequirementHint
> = {
	storage: storageHint,
	ingress: ingressHint,
	domain: domainHint,
};
