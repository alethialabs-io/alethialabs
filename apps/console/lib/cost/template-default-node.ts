// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	DEFAULT_INSTANCE_TYPE,
	type CloudProviderSlug,
} from "@/lib/cloud-providers/generated/catalog";

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
 * What an EMPTY `instance_types` actually provisions, per cloud (#5251, #5266).
 *
 * Since #5266 this IS the catalog default (`DEFAULT_INSTANCE_TYPE`): each template's own
 * `variables.tf` default is pinned equal to it by packages/core/catalog/template_defaults_test.go,
 * so the machine type is read from the catalog here rather than restated. A cluster that reaches the
 * snapshot with no instance types — created through the CLI/API without a node shape, or a console
 * blank project — gets the template default, which is now the same node the console stamps.
 *
 * tests/lib/cost/template-default-node.test.ts still reads each `source` and fails if a template
 * stops agreeing with the node priced here:
 *   aws      infra/templates/project/aws/variables.tf      `eks_instance_types`
 *   gcp      infra/templates/project/gcp/variables.tf      `gke_instance_types`
 *   azure    infra/templates/project/azure/variables.tf    `aks_instance_types`
 *   hetzner  infra/templates/project/hetzner/variables.tf  `worker_server_type`
 *            (packages/core/cloud/hetzner_provider.go reads the catalog for an empty list)
 *   alibaba  infra/templates/project/alibaba/variables.tf  `ack_instance_types`
 *
 * The AWS template defaults its node group to SPOT (`eks_ng_capacity_type`); the estimate prices
 * on-demand, the upper bound, as it does for every other node. The AWS hourly figure is the
 * on-demand t3.large rate the estimate's own fallback table carries; the non-AWS figures are the
 * catalog's monthly cost hints divided by 730 h (hetzner's is a euro figure taken at par).
 */
export const TEMPLATE_DEFAULT_NODE: Record<CloudProviderSlug, TemplateDefaultNode> = {
	aws: {
		instanceType: DEFAULT_INSTANCE_TYPE.aws,
		fallbackHourly: 0.0912,
		source: { file: "infra/templates/project/aws/variables.tf", variable: "eks_instance_types" },
	},
	gcp: {
		instanceType: DEFAULT_INSTANCE_TYPE.gcp,
		fallbackHourly: 49 / 730,
		source: { file: "infra/templates/project/gcp/variables.tf", variable: "gke_instance_types" },
	},
	azure: {
		instanceType: DEFAULT_INSTANCE_TYPE.azure,
		fallbackHourly: 70 / 730,
		source: { file: "infra/templates/project/azure/variables.tf", variable: "aks_instance_types" },
	},
	hetzner: {
		instanceType: DEFAULT_INSTANCE_TYPE.hetzner,
		fallbackHourly: 19 / 730,
		source: { file: "infra/templates/project/hetzner/variables.tf", variable: "worker_server_type" },
	},
	alibaba: {
		instanceType: DEFAULT_INSTANCE_TYPE.alibaba,
		fallbackHourly: 50 / 730,
		source: { file: "infra/templates/project/alibaba/variables.tf", variable: "ack_instance_types" },
	},
};
