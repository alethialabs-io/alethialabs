// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package types

// ChartWorkload is a workload DESCRIBED from a bring-your-own Helm chart's rendered manifests
// (W5 Path A — Option B). The chart addon (project_addons source='byo') stays the single DEPLOY
// UNIT; this is a read-mostly description Alethia never re-renders. It mirrors the runner → console
// extraction wire (execution_metadata.chart_workloads) and the immutable columns of the TS
// project_chart_workloads row (apps/console/types/jsonb.types.ts). The user overlay
// (bindings/config/value_paths) is console-side in PR1 and joins this Go type when the provisioner
// consumes it (Lane 2). Contract-locked by test/e2e/fixtures/chart_workloads.json.
type ChartWorkload struct {
	Name         string                `json:"name"`
	WorkloadKind ChartWorkloadKind     `json:"workload_kind"` // deployment|statefulset|daemonset|cronjob|job
	Rendered     ChartWorkloadRendered `json:"rendered"`
}

// ChartWorkloadRendered is the immutable description extracted from `helm template` output. EnvKeys
// is key NAMES only (values/valueFrom dropped) so a description never carries a rendered secret.
// Replicas is a pointer so DaemonSet/Job/CronJob (which have no replica count) omit it rather than
// reporting a misleading 0.
type ChartWorkloadRendered struct {
	Image     string            `json:"image"`
	Ports     []ServicePort     `json:"ports"`
	EnvKeys   []string          `json:"env_keys"`
	Resources *ServiceResources `json:"resources,omitempty"`
	Replicas  *int              `json:"replicas,omitempty"`
}
