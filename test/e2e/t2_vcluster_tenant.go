// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// vcluster-placement T2 scenario (#1308) — the PURE, reusable half. Deliberately UNTAGGED (like
// t2_namespace_tenant.go / t2_soak.go) so `go mod tidy` sees its deps and the pure helpers are
// unit-testable WITHOUT Postgres, a cloud, or a build tag.
//
// # What #1308 proves (the fast-follow of #1231, which activated the vcluster deploy path)
//
// The base T2 run (t2_provision_test.go) provisions a REAL cluster — the Fabric. This scenario then
// layers a SECOND DEPLOY job onto the SAME ephemeral cluster with `placement_mode=vcluster`,
// `cluster.cluster_name` = that Fabric, and a derived `namespace`. The real runner claims it and runs
// runVClusterDeploy: it mints keyless HOST access to the EXISTING Fabric (no tofu), helm-installs a
// virtual cluster on the host, registers it with the host ArgoCD as a `cluster` Secret, and delivers
// the tenant app onto it via `destination.name = <vcName>` — WITHOUT provisioning a new cloud cluster
// or reinstalling the shared Fabric's ArgoCD. Teardown (a second, DESTROY job) runs runVClusterDestroy,
// which removes the helm release + the exported kubeconfig Secret + the ArgoCD cluster Secret (no
// orphaned registration).
//
// vcluster sits ABOVE `namespace` (soft) and BELOW `dedicated` (hard) on the isolation ladder: a
// dedicated tenant control plane (own API server / RBAC / CRDs) running as one StatefulSet on the
// shared Fabric host. This scenario is the middle-tier analogue of the namespace scenario (#959).
//
// aws-first: #1231 mints keyless EKS host access by name; the other clouds are fail-closed follow-ups
// (#1127 gcp / #1128 azure / #1129 alibaba), so this scenario is aws-only (a clean skip elsewhere).
package e2e

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
)

// vclusterTenantParams carries what the scenario needs from the completed base provision.
type vclusterTenantParams struct {
	project     string
	env         string
	provider    string
	region      string
	fabricClust string // meta.ClusterName from the base deploy — the existing shared Fabric cluster
	owner       string // the SeedRunner owner (so the still-running runner claims the seeded jobs)
	appsRepo    string // apps-destination repo (reuse the A0.6 apps repo; empty ⇒ vcluster+registration only)

	// ── Optional overrides. Every one defaults to the #1308 behaviour, so that scenario is
	//    byte-for-byte unchanged; they exist so #845 can drive this same body as its vcluster tier
	//    instead of forking a near-duplicate copy of it. ──

	// appsPath is the subpath within appsRepo to sync ("" ⇒ the product default ".", the repo root).
	appsPath string
	// vcName overrides the vcluster name ("" ⇒ vclusterTenantSlug(env)). #845 places its OWN vcluster
	// inside the same Fabric lifetime as #1308's, so the two names MUST differ.
	vcName string
	// label prefixes the logs ("" ⇒ the #1308 label), so a shared body reads honestly about which
	// scenario is driving it.
	label string
	// requireAppResources turns on the >0 `.status.resources` floor and the source-path assertion.
	// OFF for #1308, which predates them; ON for #845, where a Healthy+Synced app over an empty
	// directory would make the whole acceptance gate vacuous.
	requireAppResources bool
}

// vclusterTenantResult records what the shared body proved, for a caller that must fold it into an
// acceptance verdict. It is an OUT-PARAM rather than a return value because every failure in the
// body is a t.Fatalf: runtime.Goexit runs the caller's deferred summary write, and a returned value
// would be lost exactly when the partial result matters most.
type vclusterTenantResult struct {
	Name          string
	Placed        bool
	App           string
	SourcePath    string
	ResourceCount int
	Deregistered  bool
}

// The bounded waits one vcluster placement can consume, named here (in the UNTAGGED half) so the
// parent context's budget term is computed from the SAME constants the run half waits on and the two
// can never drift apart. A ctx that expired mid-placement used to surface as "the placement never
// converged" — indistinguishable from a real failure.
const (
	vcDeployWait    = 20 * time.Minute
	vcAppHealthWait = 10 * time.Minute
	vcDestroyWait   = 15 * time.Minute
	// vclusterTenantBudget is the wall clock one full vcluster placement can consume.
	vclusterTenantBudget = vcDeployWait + vcAppHealthWait + vcDestroyWait
)

// vclusterTenantEnabled reports whether the opt-in scenario should run (ALETHIA_E2E_VCLUSTER truthy).
// Off by default: the base T2 proof is unchanged unless a maintainer opts in.
func vclusterTenantEnabled() bool { return t2Truthy(os.Getenv("ALETHIA_E2E_VCLUSTER")) }

// vclusterTenantSlug derives a deterministic RFC-1123 name for the vcluster-placement env — the same
// shape the console's slugify produces, prefixed so it never collides with a system namespace. This
// value is BOTH the env's namespace AND the vcluster's name (buildVClusterSpec derives the host
// namespace `vcluster-<name>`, the SA, and the exported Secret off it). Bounded to 54 chars so the
// host namespace `vcluster-<name>` (prefix adds 9) still fits the 63-char k8s namespace limit.
// vclusterTenantName resolves the vcluster name for a run: the explicit override when a caller set
// one (#845), else the #1308 slug.
func vclusterTenantName(p vclusterTenantParams) string {
	if n := strings.TrimSpace(p.vcName); n != "" {
		return n
	}
	return vclusterTenantSlug(p.env)
}

// vclusterTenantLabel is the log prefix for whichever scenario is driving the shared body.
func vclusterTenantLabel(p vclusterTenantParams) string {
	if l := strings.TrimSpace(p.label); l != "" {
		return l
	}
	return "vcluster-tenant (#1308)"
}

func vclusterTenantSlug(env string) string {
	s := strings.Trim(namespaceSlugUnsafe.ReplaceAllString(strings.ToLower(strings.TrimSpace(env)), "-"), "-")
	if s == "" {
		s = "env"
	}
	name := "e2e-vc-" + s
	if len(name) > 54 {
		name = strings.TrimRight(name[:54], "-")
	}
	return name
}

// buildVClusterSnapshot returns the runner-facing config_snapshot for a vcluster-placement DEPLOY (or
// DESTROY) job onto the existing Fabric cluster. It carries NO cluster shape (no tofu run) — only the
// placement, the destination namespace (== the vcluster name), the EXISTING cluster name to mint
// against, and the apps repo. Mirrors buildNamespaceSnapshot.
func buildVClusterSnapshot(p vclusterTenantParams, vcName string) map[string]any {
	snap := map[string]any{
		// Keyed on the VCLUSTER NAME, not the env: #845 places a second vcluster inside the same
		// Fabric lifetime as #1308's, and a shared snapshot id would collide.
		"id":                "e2e-" + vcName,
		"project_name":      p.project,
		"environment_stage": p.env,
		"region":            p.region,
		"provider":          p.provider,
		"placement_mode":    "vcluster",
		"namespace":         vcName,
		// The serving cluster is the shared Fabric's — the runner mints keyless HOST access to it by name.
		"cluster": map[string]any{"cluster_name": p.fabricClust},
	}
	if p.appsRepo != "" {
		repos := map[string]any{"apps_destination_repo": p.appsRepo}
		// Emitted only when set, so #1308's snapshot is unchanged and the runner keeps rendering the
		// repo root for it.
		if strings.TrimSpace(p.appsPath) != "" {
			repos["apps_path"] = p.appsPath
		}
		snap["repositories"] = repos
	}
	return snap
}

// vclusterAppState is the minimal ArgoCD Application shape the assertions read. Unlike a namespace
// placement, a vcluster app routes by `destination.name` (the registered virtual cluster) and sets NO
// `destination.server` (name-based routing to the registered cluster Secret).
type vclusterAppState struct {
	Metadata struct {
		Name string `json:"name"`
	} `json:"metadata"`
	Spec struct {
		Project string `json:"project"`
		// Source is what the app actually syncs. #1308 ignores it; #845 asserts on it, because the
		// per-tier overlay path is its whole Kustomize claim.
		Source struct {
			RepoURL string `json:"repoURL"`
			Path    string `json:"path"`
		} `json:"source"`
		Destination struct {
			Server    string `json:"server"`
			Name      string `json:"name"`
			Namespace string `json:"namespace"`
		} `json:"destination"`
	} `json:"spec"`
}

// findVClusterApp parses a `kubectl get applications -o json` list and returns the Application whose
// destination NAME is the vcluster — the tenant app runVClusterDeploy delivered. It fails closed: no
// match, or a match that is misrouted (a host `destination.server` set instead of name-based routing,
// or pinned to the wide-open infra/apps project instead of the hardened per-vcluster project) is an
// error.
func findVClusterApp(listJSON []byte, vcName string) (vclusterAppState, error) {
	var list struct {
		Items []vclusterAppState `json:"items"`
	}
	if err := json.Unmarshal(listJSON, &list); err != nil {
		return vclusterAppState{}, fmt.Errorf("decode applications list: %w", err)
	}
	for _, a := range list.Items {
		if a.Spec.Destination.Name != vcName {
			continue
		}
		if strings.TrimSpace(a.Spec.Destination.Server) != "" {
			return a, fmt.Errorf("app %q sets destination.server = %q — a vcluster placement MUST route by destination.name (the registered vcluster), never a host server", a.Metadata.Name, a.Spec.Destination.Server)
		}
		switch a.Spec.Project {
		case "", "infra", "apps":
			return a, fmt.Errorf("app %q is pinned to project %q — a vcluster tenant MUST use the hardened per-vcluster AppProject, never the wide-open infra/apps", a.Metadata.Name, a.Spec.Project)
		}
		return a, nil
	}
	return vclusterAppState{}, fmt.Errorf("no ArgoCD Application found targeting vcluster %q — the tenant app was not delivered", vcName)
}

// clusterSecretItem is the minimal shape read from a `kubectl get secrets -o json` list to assert the
// ArgoCD cluster-registration Secret for a vcluster.
type clusterSecretItem struct {
	Metadata struct {
		Name   string            `json:"name"`
		Labels map[string]string `json:"labels"`
	} `json:"metadata"`
}

// findVClusterClusterSecret asserts the host ArgoCD carries a `cluster` Secret named vcName (labelled
// argocd.argoproj.io/secret-type: cluster) — the registration EnsureVClusterClusterSecret wrote, so an
// Application whose `destination.name = vcName` resolves against it. Fails closed: a missing Secret, or
// one present but missing the secret-type=cluster label, is an error.
func findVClusterClusterSecret(listJSON []byte, vcName string) error {
	var list struct {
		Items []clusterSecretItem `json:"items"`
	}
	if err := json.Unmarshal(listJSON, &list); err != nil {
		return fmt.Errorf("decode secrets list: %w", err)
	}
	for _, s := range list.Items {
		if s.Metadata.Name != vcName {
			continue
		}
		if s.Metadata.Labels["argocd.argoproj.io/secret-type"] != "cluster" {
			return fmt.Errorf("Secret %q exists but is not labelled argocd.argoproj.io/secret-type: cluster (labels: %v) — it is not an ArgoCD cluster registration", vcName, s.Metadata.Labels)
		}
		return nil
	}
	return fmt.Errorf("no ArgoCD cluster Secret named %q found — the vcluster was not registered with the host ArgoCD", vcName)
}
