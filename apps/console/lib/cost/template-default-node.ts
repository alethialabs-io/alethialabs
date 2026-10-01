// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CloudProviderSlug } from "@/lib/cloud-providers/generated/catalog";

/** The node a cloud's project template buys when the cluster carries NO instance type. */
export interface TemplateDefaultNode {
	/** The machine type the template defaults to. */
	instanceType: string;
	/** Approximate on-demand USD/hour, used only when the live price table has no entry for it. */
	fallbackHourly: number;
	/** Where the template states that default — the drift test reads it from exactly here. */
	source: { file: string; variable: string };
}

/**
 * What an EMPTY `instance_types` actually provisions, per cloud (#5251).
 *
 * This is NOT the catalog default (`DEFAULT_INSTANCE_TYPE`), and the difference is the point. The
 * catalog default is what the console STAMPS on a new cluster; a cluster that reaches the snapshot
 * with no instance types — created through the CLI/API, or before a default was stamped — gets the
 * template's own `variables.tf` default instead, which on AWS is 2× m5a.4xlarge. The estimate used
 * to price that case as a t3.medium and so understated AWS ~17×.
 *
 * No generated source carries these, so they are restated here, and
 * tests/lib/cost/template-default-node.test.ts reads each `source` and fails if a template moves:
 *   aws      infra/templates/project/aws/variables.tf      `eks_instance_types`  (default line 209)
 *   gcp      infra/templates/project/gcp/variables.tf      `gke_instance_types`  (default line 144)
 *   azure    infra/templates/project/azure/variables.tf    `aks_instance_types`  (default line 122)
 *   hetzner  infra/templates/project/hetzner/variables.tf  `worker_server_type`  (default line 122;
 *            packages/core/cloud/hetzner_provider.go also hard-codes cpx22 for an empty list)
 *   alibaba  infra/templates/project/alibaba/variables.tf  `ack_instance_types`  (default line 107)
 *
 * The AWS template defaults its node group to SPOT (`eks_ng_capacity_type`); the estimate prices
 * on-demand, the upper bound, as it does for every other node. The non-AWS hourly figures are the
 * catalog's own monthly cost hints divided by 730 h (hetzner's is a euro figure taken at par).
 */
export const TEMPLATE_DEFAULT_NODE: Record<CloudProviderSlug, TemplateDefaultNode> = {
	aws: {
		instanceType: "m5a.4xlarge",
		fallbackHourly: 0.768,
		source: { file: "infra/templates/project/aws/variables.tf", variable: "eks_instance_types" },
	},
	gcp: {
		instanceType: "e2-standard-4",
		fallbackHourly: 98 / 730,
		source: { file: "infra/templates/project/gcp/variables.tf", variable: "gke_instance_types" },
	},
	azure: {
		instanceType: "Standard_D4s_v5",
		fallbackHourly: 140 / 730,
		source: { file: "infra/templates/project/azure/variables.tf", variable: "aks_instance_types" },
	},
	hetzner: {
		instanceType: "cpx22",
		fallbackHourly: 19 / 730,
		source: { file: "infra/templates/project/hetzner/variables.tf", variable: "worker_server_type" },
	},
	alibaba: {
		instanceType: "ecs.g6.large",
		fallbackHourly: 50 / 730,
		source: { file: "infra/templates/project/alibaba/variables.tf", variable: "ack_instance_types" },
	},
};
