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
	// RequiresCertManager marks an add-on whose admission webhook takes its serving certificate
	// from cert-manager (the chart annotates it `cert-manager.io/inject-ca-from`). The runner must
	// then install the cert-manager CONTROLLER even on a deploy that issues no public certificate,
	// because a `failurePolicy: Fail` webhook with no CA does not degrade the add-on — it rejects
	// every CR the operator owns, so the kind is simply unusable.
	//
	// It is declared HERE, on the spec, rather than inferred from the add-on id in Go, so exactly
	// one place knows which operators need it: the console mapper that adds the operator. The Go
	// side reads it back through InfraFacts.WebhookCAAddOns and gates on that, which is what stops
	// the install decision drifting from the thing that caused it (#3228).
	RequiresCertManager bool `json:"requiresCertManager,omitempty"`
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
	// PodSecurity is the Pod Security Standards level this add-on's namespace must allow
	// ("privileged" | "baseline" | "restricted"), rendered as
	// syncPolicy.managedNamespaceMetadata.labels so ArgoCD labels the namespace it creates (#2837).
	//
	// Talos enforces `baseline` on every namespace but kube-system, and baseline forbids privileged
	// containers, host namespaces and hostPath volumes — so a chart needing any of those has its
	// DaemonSet admitted and its PODS rejected: zero pods, Progressing forever, nothing saying why.
	//
	// Empty = do not label the namespace, leaving the cluster's own default in force. Mirrors the
	// TS `AddOnInstallSpec.podSecurity`.
	PodSecurity string `json:"podSecurity,omitempty"`
	// SecretRef names the per-add-on k8s Secret this chart's secret knobs read from
	// (W4.5 #640). It carries NO values — the runner fetches the plaintext at execution
	// time over the authenticated job channel (FetchAddonSecrets, the git-token pattern)
	// and seeds the Secret in-cluster BEFORE the Application syncs. Nil when the add-on
	// has no stored secret knobs. Mirrors the TS `AddOnSecretRef`.
	SecretRef *AddOnSecretRef `json:"secretRef,omitempty"`
	// Workloads carries a BYO chart's described workloads' user overlay (W5 Lane 2b): their W3
	// bindings + value_paths. The runner resolves the bindings against the provision's tofu outputs
	// at deploy — a non-secret facet becomes a literal value, a credential facet a keyless
	// existingSecret ref — and writes them into Values at the declared paths. Nil for non-BYO
	// add-ons or a BYO chart with no bound workloads. Mirrors the TS `AddOnInstallSpec.workloads`.
	Workloads []ChartWorkloadBinding `json:"workloads,omitempty"`
	// Bootstrap is a one-shot, in-cluster operation the runner performs AFTER this add-on's
	// Application has been applied. Nil for every add-on that needs none. Mirrors the TS
	// `AddOnInstallSpec.bootstrap`.
	Bootstrap *AddOnBootstrap `json:"bootstrap,omitempty"`
}

// AddOnBootstrapKind names a one-shot bootstrap the runner knows how to perform.
//
// A typed kind over a closed set, not a free string, because the runner DISPATCHES on it: an
// unrecognised kind is an ERROR rather than a skip. A skipped bootstrap is invisible — the deploy
// stays green, the add-on sits Progressing forever, and nothing says why.
type AddOnBootstrapKind string

const (
	// AddOnBootstrapVaultInit initialises and unseals a freshly installed HashiCorp Vault, and
	// enables its KV v2 mount.
	//
	// A fresh Vault is SEALED: its readiness probe fails (`vault status` exits 2), no pod is ever
	// Ready, and the Application sits Progressing at any budget. The chart ships no bootstrap of its
	// own — upstream's position is that initialising is an operator act — so without this the
	// marketplace offers a one-click install that cannot come up, on every cloud.
	AddOnBootstrapVaultInit AddOnBootstrapKind = "vault-init"
)

// AddOnBootstrap describes a one-shot bootstrap the runner runs from INSIDE the cluster.
//
// ── What may travel in this struct ──────────────────────────────────────────────────────────────
//
// Names, namespaces and addresses. Nothing else. It rides the DEPLOY job's config snapshot, which
// is persisted in Postgres, so it carries nothing a credential could be derived from — the same
// contract AddOnSecretRef holds. Key material the bootstrap needs is MINTED INSIDE the pod and
// written straight to a Secret in the cluster; it never enters the runner process, the job log, or
// execution_metadata.
type AddOnBootstrap struct {
	// Kind selects the bootstrap. Unknown kinds are refused.
	Kind AddOnBootstrapKind `json:"kind"`
	// APIBase is the in-cluster API root the Job talks to (scheme + host + port, no path).
	APIBase string `json:"apiBase"`
	// StateSecret is the Secret the Job writes its state into, in the add-on's own namespace.
	StateSecret string `json:"stateSecret"`
}

// ChartWorkloadBinding is one described BYO-chart workload's runtime-resolvable overlay: its W3
// bindings and the value_paths (logical knob → chart-values dot-path) they write to. The runner
// resolves it at deploy via manifests.ResolveChartWorkloadBindings.
type ChartWorkloadBinding struct {
	// Name is the workload's rendered metadata.name — used to name its keyless binding Secret.
	Name string `json:"name"`
	// Bindings are the workload's W3 edges to backing resources (the same ServiceBinding a
	// first-class service declares).
	Bindings []ServiceBinding `json:"bindings,omitempty"`
	// ValuePaths maps a binding-facet knob (`bind:{kind}:{name}:{facet}`) to the chart-values
	// dot-path the resolved value/ref is written to.
	ValuePaths map[string]string `json:"valuePaths,omitempty"`
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
