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
	// Source selects how the add-on is delivered. "" / "helm" = a chart from a Helm registry
	// (ChartRepo is the registry URL, Chart is the chart name, Version is the chart version).
	// "git" = a chart directory inside a git repo — a bring-your-own (BYO) chart: ChartRepo is
	// the git URL, Path is the chart directory, Version is the git ref. BYO charts render into a
	// hardened per-project AppProject (Project) with manual sync.
	//
	// "manifest" = a plain YAML manifest the RUNNER kubectl-applies (NOT an ArgoCD Application):
	// ChartRepo is the pinned manifest URL and Version is the release tag it is pinned to. This is
	// the OPERATOR rail — Kubernetes operators (e.g. RabbitMQ's cluster-operator) ship as a
	// `kubectl apply` release manifest, not a Helm chart, and an ArgoCD Application source cannot
	// be a bare https://…yaml (only a git repo, a Helm chart, or a plugin). It reuses the same
	// server-side-apply path the CNI/CSI bootstrap manifests already take. Manifest add-ons are
	// applied BEFORE the Helm/git Applications render, so the CRDs they own exist by the time a
	// CR that depends on them (a RabbitmqCluster, a CNPG Cluster) is synced.
	Source string `json:"source,omitempty"`
	// Path is the chart directory within a git-source repo (Source=="git"). Empty for Helm charts.
	Path string `json:"path,omitempty"`
	// CRDs are the CustomResourceDefinition names a manifest-source add-on establishes (e.g.
	// "rabbitmqclusters.rabbitmq.com"). After applying the manifest the runner waits for each to
	// reach condition=Established, so a CR wave can never race the operator that owns its schema
	// (ArgoCD sync-waves do NOT order across separate top-level Applications). Empty otherwise.
	CRDs []string `json:"crds,omitempty"`
	// Project is the ArgoCD AppProject the Application is placed in. Empty = "infra" (the
	// marketplace default). BYO charts are pinned to a hardened "byo-<slug>" project the runner
	// sets at deploy time.
	Project string `json:"project,omitempty"`
	// Namespace the chart installs into (CreateNamespace on sync).
	Namespace string `json:"namespace"`
	// Fully-merged Helm values (catalog defaults + user knobs). NEVER contains a
	// secret-typed knob's value (W4.5 #640) — only SecretKeyRef wiring; see SecretRef.
	Values map[string]interface{} `json:"values"`
	// ArgoCD sync-wave ordering (lower installs first).
	SyncWave int `json:"syncWave"`
	// SecretRef names the per-add-on k8s Secret this chart's secret knobs read from
	// (W4.5 #640). It carries NO values — the runner fetches the plaintext at execution
	// time over the authenticated job channel (FetchAddonSecrets, the git-token pattern)
	// and seeds the Secret in-cluster BEFORE the Application syncs. Nil when the add-on
	// has no stored secret knobs. Mirrors the TS `AddOnSecretRef`.
	SecretRef *AddOnSecretRef `json:"secretRef,omitempty"`
}

// AddOnSecretRef is the runner-facing description of one add-on's in-cluster Secret:
// where it lives and which data keys the chart expects — never the values themselves.
type AddOnSecretRef struct {
	// SecretName is the Secret's metadata.name (deterministic: "alethia-addon-<id>").
	SecretName string `json:"secretName"`
	// Namespace the Secret lives in — the add-on's install namespace.
	Namespace string `json:"namespace"`
	// Keys the runner must populate (= the secret-typed field keys with stored values).
	Keys []string `json:"keys"`
	// StaticData are NON-secret constants that must live in the SAME Secret because the
	// chart reads a paired key from it (grafana's userKey, minio's rootUser — the admin
	// USERNAME is an ordinary knob, but the chart resolves it from the admin Secret
	// alongside the password). Snapshot-safe by declaration; a fetched value wins on a
	// key collision. Mirrors the TS `AddOnSecretRef.staticData`.
	StaticData map[string]string `json:"staticData,omitempty"`
}

// IsGitSource reports whether this install pulls a chart from a git repo (a BYO chart) rather
// than a Helm registry.
func (a AddOnInstall) IsGitSource() bool { return a.Source == "git" }

// IsManifestSource reports whether this install is a plain YAML manifest the runner
// kubectl-applies (the operator rail) rather than anything ArgoCD renders as an Application.
// Such add-ons get NO ArgoCD Application — the renderer skips them and the health read must not
// expect one.
func (a AddOnInstall) IsManifestSource() bool { return a.Source == "manifest" }
