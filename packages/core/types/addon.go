// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package types

// AddOnInstall is a fully-resolved marketplace add-on install spec, produced by the console
// (lib/addons/catalog.ts `resolveAddOnInstall`) and carried in the DEPLOY job's config
// snapshot under `addons`. The runner renders one ArgoCD Helm Application per entry — it needs
// no catalog of its own. JSON keys match the TS `AddOnInstallSpec` exactly (camelCase).
type AddOnInstall struct {
	// Catalog id, e.g. "kube-prometheus-stack".
	ID string `json:"id"`
	// Delivery mode: "managed" (Alethia applies the Application) or "gitops" (written into
	// the customer's apps repo). Phase 1 renders managed; gitops is Phase 2.
	Mode string `json:"mode"`
	// Helm chart coordinates.
	ChartRepo string `json:"chartRepo"`
	Chart     string `json:"chart"`
	Version   string `json:"version"`
	// Source selects how ArgoCD pulls the chart. "" / "helm" = a chart from a Helm registry
	// (ChartRepo is the registry URL, Chart is the chart name, Version is the chart version).
	// "git" = a chart directory inside a git repo — a bring-your-own (BYO) chart: ChartRepo is
	// the git URL, Path is the chart directory, Version is the git ref. BYO charts render into a
	// hardened per-project AppProject (Project) with manual sync.
	Source string `json:"source,omitempty"`
	// Path is the chart directory within a git-source repo (Source=="git"). Empty for Helm charts.
	Path string `json:"path,omitempty"`
	// Project is the ArgoCD AppProject the Application is placed in. Empty = "infra" (the
	// marketplace default). BYO charts are pinned to a hardened "byo-<slug>" project the runner
	// sets at deploy time.
	Project string `json:"project,omitempty"`
	// Namespace the chart installs into (CreateNamespace on sync).
	Namespace string `json:"namespace"`
	// Fully-merged Helm values (catalog defaults + user knobs).
	Values map[string]interface{} `json:"values"`
	// ArgoCD sync-wave ordering (lower installs first).
	SyncWave int `json:"syncWave"`
}

// IsGitSource reports whether this install pulls a chart from a git repo (a BYO chart) rather
// than a Helm registry.
func (a AddOnInstall) IsGitSource() bool { return a.Source == "git" }
