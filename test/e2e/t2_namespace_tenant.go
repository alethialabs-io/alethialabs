// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Namespace-placement T2 scenario (#959) — the PURE, reusable half. Deliberately UNTAGGED (like
// t2_soak.go / t2_b6_promotion.go) so `go mod tidy` sees its deps and the pure helpers are
// unit-testable WITHOUT Postgres, a cloud, or a build tag.
//
// # What #959 proves (the coupled #955 + #956 activation)
//
// The base T2 run (t2_provision_test.go) provisions a REAL cluster — the Fabric. This scenario then
// layers a SECOND DEPLOY job onto the SAME ephemeral cluster with `placement_mode=namespace`,
// `cluster.cluster_name` = that Fabric, and a derived `namespace`. The real runner claims it and runs
// runNamespaceDeploy: it mints keyless access to the EXISTING cluster (no tofu), applies the hardened
// isolation + guardrail bundle, and delivers the tenant app into `<ns>` — WITHOUT provisioning a new
// cluster or reinstalling the shared Fabric's ArgoCD. The run half (t2_namespace_tenant_run_test.go)
// asserts exactly that: the app landed in `<ns>` on the SAME cluster, and ArgoCD was not reinstalled.
//
// aws-first: #955 mints keyless EKS access by name; the other clouds are fail-closed follow-ups, so
// this scenario is aws-only (a clean skip elsewhere).
package e2e

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
)

// namespaceTenantParams carries what the scenario needs from the completed base provision.
type namespaceTenantParams struct {
	project     string
	env         string
	provider    string
	region      string
	fabricClust string // meta.ClusterName from the base deploy — the existing shared Fabric cluster
	owner       string // the SeedRunner owner (so the still-running runner claims the second job)
	appsRepo    string // apps-destination repo (reuse the A0.6 apps repo; empty ⇒ isolation-only)
}

// namespaceTenantEnabled reports whether the opt-in scenario should run (ALETHIA_E2E_NAMESPACE_TENANT
// truthy). Off by default: the base T2 proof is unchanged unless a maintainer opts in.
func namespaceTenantEnabled() bool { return t2Truthy(os.Getenv("ALETHIA_E2E_NAMESPACE_TENANT")) }

var namespaceSlugUnsafe = regexp.MustCompile(`[^a-z0-9-]+`)

// namespaceTenantSlug derives a deterministic RFC-1123 namespace for the placed env — the same shape
// the console's slugify produces, prefixed so it never collides with a system namespace. Bounded to
// 63 chars (the k8s namespace limit).
func namespaceTenantSlug(env string) string {
	s := strings.Trim(namespaceSlugUnsafe.ReplaceAllString(strings.ToLower(strings.TrimSpace(env)), "-"), "-")
	if s == "" {
		s = "env"
	}
	name := "e2e-ns-" + s
	if len(name) > 63 {
		name = strings.TrimRight(name[:63], "-")
	}
	return name
}

// buildNamespaceSnapshot returns the runner-facing config_snapshot for a namespace-placement DEPLOY
// job onto the existing Fabric cluster. It carries NO cluster shape (no tofu run) — only the
// placement, the destination namespace, the EXISTING cluster name to mint against, and the apps repo.
func buildNamespaceSnapshot(p namespaceTenantParams, ns string) map[string]any {
	snap := map[string]any{
		"id":                "e2e-" + p.env + "-ns",
		"project_name":      p.project,
		"environment_stage": p.env,
		"region":            p.region,
		"provider":          p.provider,
		"placement_mode":    "namespace",
		"namespace":         ns,
		// The serving cluster is the shared Fabric's — the runner mints keyless access to it by name.
		"cluster": map[string]any{"cluster_name": p.fabricClust},
	}
	if p.appsRepo != "" {
		snap["repositories"] = map[string]any{"apps_destination_repo": p.appsRepo}
	}
	return snap
}

// namespaceAppState is the minimal ArgoCD Application shape the assertions read.
type namespaceAppState struct {
	Metadata struct {
		Name string `json:"name"`
	} `json:"metadata"`
	Spec struct {
		Project     string `json:"project"`
		Destination struct {
			Server    string `json:"server"`
			Namespace string `json:"namespace"`
		} `json:"destination"`
	} `json:"spec"`
}

// findNamespaceApp parses a `kubectl get applications -o json` list and returns the Application whose
// destination namespace is the tenant namespace — the tenant app runNamespaceDeploy created. It fails
// closed: no match, or a match that is misrouted (wrong server, or pinned to the wide-open infra/apps
// project instead of the hardened per-namespace project) is an error.
func findNamespaceApp(listJSON []byte, ns string) (namespaceAppState, error) {
	var list struct {
		Items []namespaceAppState `json:"items"`
	}
	if err := json.Unmarshal(listJSON, &list); err != nil {
		return namespaceAppState{}, fmt.Errorf("decode applications list: %w", err)
	}
	for _, a := range list.Items {
		if a.Spec.Destination.Namespace != ns {
			continue
		}
		if a.Spec.Destination.Server != "https://kubernetes.default.svc" {
			return a, fmt.Errorf("app %q destination server = %q, want in-cluster https://kubernetes.default.svc", a.Metadata.Name, a.Spec.Destination.Server)
		}
		switch a.Spec.Project {
		case "", "infra", "apps":
			return a, fmt.Errorf("app %q is pinned to project %q — a namespace tenant MUST use the hardened per-namespace AppProject, never the wide-open infra/apps", a.Metadata.Name, a.Spec.Project)
		}
		return a, nil
	}
	return namespaceAppState{}, fmt.Errorf("no ArgoCD Application found targeting namespace %q — the tenant app was not delivered", ns)
}

// namespaceClusterUnchanged asserts the namespace deploy reported the SAME cluster as the base Fabric
// provision — i.e. it did NOT provision a new cluster.
func namespaceClusterUnchanged(fabricCluster, namespaceJobCluster string) error {
	if strings.TrimSpace(namespaceJobCluster) == "" {
		return fmt.Errorf("namespace job reported no cluster_name")
	}
	if namespaceJobCluster != fabricCluster {
		return fmt.Errorf("namespace job cluster_name = %q, want the existing Fabric cluster %q (a namespace placement must NOT provision a new cluster)", namespaceJobCluster, fabricCluster)
	}
	return nil
}

// argocdNotReinstalled asserts the argocd control plane was not reinstalled by the namespace deploy —
// the argocd-server Deployment's creationTimestamp is unchanged across the base + namespace jobs.
func argocdNotReinstalled(before, after string) error {
	before, after = strings.TrimSpace(before), strings.TrimSpace(after)
	if before == "" || after == "" {
		return fmt.Errorf("could not read argocd-server creationTimestamp (before=%q after=%q)", before, after)
	}
	if before != after {
		return fmt.Errorf("argocd-server creationTimestamp changed (%q → %q) — the namespace deploy reinstalled the shared Fabric's ArgoCD", before, after)
	}
	return nil
}
