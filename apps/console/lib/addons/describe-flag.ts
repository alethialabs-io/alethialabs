// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// W5 Path A dark-launch flag. When on, a BYO chart's CHART_SCAN also DESCRIBES its rendered
// workloads: the runner extracts one workload per Deployment/StatefulSet/DaemonSet/CronJob/Job and
// the console persists them to project_chart_workloads. Off by default so seam #0 (schema +
// introspect) can land and accrue data with no canvas surface until the bind/canvas lanes ship.
// Independent of ALETHIA_BYO_HELM_ENABLED (the BYO-Helm feature gate) so describe can be enabled
// without exposing chart attach, or vice-versa. A plain module (not "use server") so both server
// actions and server components can import the synchronous check.

/** Whether BYO chart workload DESCRIBE (extract → persist project_chart_workloads) is enabled. */
export function isByoDescribeEnabled(): boolean {
	return process.env.ALETHIA_BYO_DESCRIBE_ENABLED === "true";
}
