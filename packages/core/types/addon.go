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
	// Namespace the chart installs into (CreateNamespace on sync).
	Namespace string `json:"namespace"`
	// Fully-merged Helm values (catalog defaults + user knobs).
	Values map[string]interface{} `json:"values"`
	// ArgoCD sync-wave ordering (lower installs first).
	SyncWave int `json:"syncWave"`
}
