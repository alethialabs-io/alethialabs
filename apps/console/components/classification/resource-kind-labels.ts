// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ResourceKind } from "@/lib/db/schema/enums";

/** Human labels for the classifiable resource kinds (drill-down + coverage panels). */
export const RESOURCE_KIND_LABELS: Record<ResourceKind, string> = {
	cloud_identity: "Cloud identity",
	connector_credential: "Connector",
	alert_rule: "Alert rule",
	alert_channel: "Alert channel",
	alert_delivery: "Alert delivery",
	member: "Member",
	project: "Project",
	project_environment: "Environment",
	project_cluster: "Project cluster",
	cloud_kubernetes_cluster: "K8s cluster",
	role: "Role",
	runner: "Runner",
	runner_usage_session: "Runner session",
	support_case: "Support case",
};

/** The label for a resource kind, falling back to the raw slug. */
export function kindLabel(kind: string): string {
	return RESOURCE_KIND_LABELS[kind as ResourceKind] ?? kind;
}
