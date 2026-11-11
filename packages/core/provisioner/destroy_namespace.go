// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	coreaws "github.com/alethialabs-io/alethialabs/packages/core/cloud/aws"
	"github.com/alethialabs-io/alethialabs/packages/core/names"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// runNamespaceDestroy tears down a `namespace`-placement env (called from RunDestroy). A namespace env
// owns NO tofu — runNamespaceDeploy's own contract is "it runs NO tofu" — so its teardown is deleting
// what that deploy created on the SHARED Fabric, never `tofu destroy` against the full-cluster template.
//
// What the deploy created, and what this therefore reverses, in reverse order:
//  1. the tenant's ArgoCD Application  — deleted FIRST, so ArgoCD stops re-syncing resources back into
//     a namespace that is being removed underneath it;
//  2. the Namespace (which takes the guardrail bundle — quota, limits, NetworkPolicies, default-SA RBAC
//     — with it) and the hardened AppProject;
//  3. the per-namespace cloud identity (#957): the EKS IRSA role / GKE GSA / AKS UAMI / ACK RAM role.
//
// Step 3 is the one that made this a security bug rather than a tidiness bug: a decommissioned tenant
// that keeps a cloud IAM principal is a standing credential nobody is watching.
//
// Best-effort, like runVClusterDestroy: every step is attempted even when an earlier one fails, and the
// FIRST error is returned. A teardown that stopped at the first failure would strand exactly the
// resources this exists to reclaim. Each step is individually idempotent (`kubectl delete
// --ignore-not-found`, and a deprovisioner for which "already gone" is success), so a re-run converges.
func runNamespaceDestroy(ctx context.Context, provider cloud.CloudProvider, params DestroyParams) error {
	vc := params.ProjectConfig
	stdout := params.Stdout
	if stdout == nil {
		stdout = os.Stdout
	}
	stderr := params.Stderr
	if stderr == nil {
		stderr = os.Stderr
	}

	// Fail-open on an un-activated cloud: selectPlacementPath would never have deployed a namespace env
	// there, so there is nothing of ours on it to reclaim. Mirrors runVClusterDestroy.
	if !namespaceRemintWired(params.Provider) {
		fmt.Fprintf(stdout, "namespace teardown: provider %q is not activated for namespace placement — nothing was provisioned; skipping.\n", params.Provider)
		return nil
	}

	// Same trust-boundary validation the deploy path applies: ns and clusterName flow into `bash -c`
	// kubectl invocations. The runner is the boundary for a project-data-influenced snapshot, and a
	// teardown is not a reason to relax it — a hostile value here would run with the runner's ambient
	// cloud credentials exactly as it would at deploy.
	clusterName := strings.TrimSpace(vc.Cluster.ClusterName)
	ns := strings.TrimSpace(vc.Namespace)
	if clusterName == "" || !isValidClusterName(clusterName) {
		return fmt.Errorf("namespace teardown: no valid serving cluster on the config snapshot — cannot reach the Fabric to delete namespace %q", ns)
	}
	if ns == "" || !isDNS1123Label(ns) {
		return fmt.Errorf("namespace teardown: destination namespace %q is not a valid DNS-1123 label", ns)
	}
	// #6551: the teardown deletes the Namespace object itself. A reserved namespace is shared with the
	// platform or the host environment, so deleting it would take their workloads with it. Refused
	// before kube access is minted, so nothing is deleted.
	if err := placementNamespaceRefusal(vc, ns, "teardown"); err != nil {
		return err
	}

	fmt.Fprintf(stdout, "Namespace teardown: removing namespace %q from shared cluster %q (provider: %s) — no tofu; this env owns no infrastructure state.\n", ns, clusterName, provider.Name())

	if err := utils.CheckDependencies("kubectl"); err != nil {
		return fmt.Errorf("namespace teardown preflight failed: %w", err)
	}

	// Keyless kube access to the EXISTING named cluster, output-free — the same mint the deploy used.
	// Fail CLOSED: without a kubeconfig nothing below can run, and reporting a successful teardown we
	// could not perform is the precise defect this function exists to remove.
	if err := mintNamespaceKubeAccess(ctx, provider, params.KubeConn, params.TalosKubeconfig, vc, params.Provider, clusterName, stdout); err != nil {
		return fmt.Errorf("namespace teardown: kubeconfig mint failed for cluster %q — cannot delete namespace %q: %w", clusterName, ns, err)
	}

	// #6551: the teardown deletes the Namespace object, so it must be this environment's — refused,
	// before the first delete, when it exists without this environment's owner label.
	if err := namespaceOwnershipRefusal(vc, ns, "teardown"); err != nil {
		return err
	}
	// #6575: owning the Namespace is not the same as being alone in it. A host BYO chart kept in a
	// namespace this placement holds (#6562) runs there too, and deleting the Namespace would delete its
	// workloads and binding secrets with it. Refused, before the first delete, while any Application
	// other than this placement's own targets the namespace.
	if err := sharedNamespaceRefusal(vc, ns); err != nil {
		return err
	}

	// Render the SAME manifests the deploy applied, so the delete targets exactly the resources it
	// created. The ArgoCD Application/AppProject names are DERIVED (namespaceTenantName), never stored,
	// so re-rendering is the only way to name them without a second, driftable copy of that derivation.
	manifests, renderErr := argocd.RenderNamespaceTenant(namespaceTenantInput(vc, ns))
	if renderErr != nil {
		return fmt.Errorf("namespace teardown: failed to render the tenant manifests to delete: %w", renderErr)
	}

	var firstErr error
	fail := func(err error) {
		if firstErr == nil {
			firstErr = err
		}
	}

	// (1) The Application first — otherwise ArgoCD re-syncs the tenant's resources into the namespace
	// while we are deleting it, and the namespace hangs in Terminating behind them.
	if manifests.App != "" {
		if err := kubectlDeleteManifest(manifests.App, fmt.Sprintf("namespace app Application for %q", ns), stdout, stderr); err != nil {
			fmt.Fprintf(stderr, "Warning: namespace teardown: deleting the app Application for %q failed: %v\n", ns, err)
			fail(fmt.Errorf("delete namespace app Application: %w", err))
		}
	}

	// (2) The Namespace + the hardened AppProject. Deleting the Namespace reclaims the whole guardrail
	// bundle with it — those objects are namespaced, so they need no separate pass.
	if err := kubectlDeleteManifest(manifests.Isolation, fmt.Sprintf("namespace isolation (Namespace %q + hardened AppProject)", ns), stdout, stderr); err != nil {
		fmt.Fprintf(stderr, "Warning: namespace teardown: deleting the isolation for %q failed: %v\n", ns, err)
		fail(fmt.Errorf("delete namespace isolation: %w", err))
	}

	// (3) The tenant's cloud identity. Attempted even if the kube deletes failed: a leaked IAM principal
	// outlives a leaked namespace and is the more dangerous of the two.
	if err := deprovisionNamespaceIdentity(ctx, params.NamespaceIdentity, params.Provider, vc.Region, vc, clusterName, ns, stdout, stderr); err != nil {
		fmt.Fprintf(stderr, "Warning: namespace teardown: deprovisioning the per-namespace cloud identity for %q failed: %v\n", ns, err)
		fail(err)
	}

	if firstErr != nil {
		return fmt.Errorf("namespace teardown for %q completed with errors — re-run the destroy to converge: %w", ns, firstErr)
	}
	fmt.Fprintf(stdout, "Namespace teardown completed: namespace %q, its guardrails, its ArgoCD Application/AppProject and its per-namespace cloud identity removed from cluster %q.\n", ns, clusterName)
	return nil
}

// sharedNamespaceRefusal refuses the teardown of namespace ns while an ArgoCD Application other than
// this placement's own targets it (#6575). The teardown deletes the Namespace object, which takes every
// workload and Secret in it along; a namespace this environment owns can still hold a host BYO chart,
// because #6562 keeps a chart that already ran there rather than withdraw its bindings. The refusal
// names each such Application, the chart when it is a BYO chart's, and what the operator does first.
// The placement's own Application is recognised by its owner label as well as its name, so a project
// rename does not make it read as someone else's.
//
// It FAILS CLOSED: a read that fails on every attempt (retryByoRead), and an answer that is not an
// Application list, both refuse, and nothing is deleted. It reads every Application in `argocd`, not
// only BYO charts': any other Application there that targets ns is someone's workload, and deleting it
// is the same harm. It matches on spec.destination.namespace only, so an Application in `argocd` that
// targets the same namespace name on ANOTHER cluster refuses too; that is the safe direction, and
// placement-host Applications are in-cluster. It only reads.
func sharedNamespaceRefusal(vc *types.ProjectConfig, ns string) error {
	own := ownApplication{
		name:  argocd.NamespaceTenantAppName(vc.ProjectName, ns),
		envID: strings.TrimSpace(vc.EnvironmentID),
	}
	var others []foreignApplication
	err := retryByoRead(func() error {
		var rerr error
		others, rerr = applicationsTargetingNamespace(ns, own)
		return rerr
	})
	if err != nil {
		return fmt.Errorf("namespace placement: refusing the teardown, because the runner %w, so it cannot tell whether anything else runs in namespace %q; nothing was deleted. Run the teardown again once the ArgoCD Applications can be read", err, ns)
	}
	if len(others) == 0 {
		return nil
	}
	described := make([]string, 0, len(others))
	for _, app := range others {
		described = append(described, app.describe())
	}
	return fmt.Errorf("namespace placement: namespace %q is also used by %s, which this environment does not own. The teardown deletes the namespace and everything in it, so it would delete those workloads and their binding secrets. Refusing the teardown; nothing was deleted. Re-attach each chart elsewhere first, with a namespace of its own (leave it blank for byo-<chart id>), and deploy its environment, so that its Application no longer targets %q; move any other Application out the same way; then run the teardown again", ns, strings.Join(described, ", "), ns)
}

// ownApplication identifies the placement's own Application: by its derived name, or by its owner
// label. The name is derived from the project's display name, so after a project rename the live
// Application still carries the OLD name; the owner label (namespaceOwnerLabel, stamped by the tenant
// render from cloud.ClassificationLabels) is this environment's id and survives a rename.
type ownApplication struct {
	name  string
	envID string
}

// is reports whether the Application named name, carrying labels, is the placement's own.
func (o ownApplication) is(name string, labels map[string]string) bool {
	return name == o.name || (o.envID != "" && labels[namespaceOwnerLabel] == o.envID)
}

// foreignApplication is one Application in `argocd` that targets the namespace and is not the
// placement's own.
type foreignApplication struct {
	Name    string
	Project string
}

// describe names the Application for the refusal. It says "BYO chart" only when the Application is
// an add-on Application (`addon-<id>`) pinned to a BYO charts' AppProject, the one placement
// RenderAddOnApplication allows a BYO chart; another add-on Application is a catalogue add-on, and
// anything else is named as an Application.
func (a foreignApplication) describe() string {
	if id, ok := strings.CutPrefix(a.Name, names.AddOnAppNamePrefix); ok && id != "" {
		if argocd.IsByoProjectName(a.Project) {
			return fmt.Sprintf("BYO chart %q (Application %s)", id, a.Name)
		}
		return fmt.Sprintf("add-on %q (Application %s)", id, a.Name)
	}
	return fmt.Sprintf("Application %q", a.Name)
}

// applicationsTargetingNamespace lists, sorted by name, the ArgoCD Applications in `argocd` whose
// spec.destination.namespace is ns, leaving out the placement's own. A failed read, an empty answer
// and an answer without an `items` list are errors worded "could not read/parse the ArgoCD
// Applications": `kubectl get -o json` of a list always prints one, so anything else is not evidence
// of "none".
func applicationsTargetingNamespace(ns string, own ownApplication) ([]foreignApplication, error) {
	out, err := executeCommandWithOutput("kubectl get applications.argoproj.io -n argocd -o json", "", nil)
	if err != nil {
		return nil, fmt.Errorf("could not read the ArgoCD Applications in argocd: %w", err)
	}
	var list struct {
		Items *[]struct {
			Metadata struct {
				Name   string            `json:"name"`
				Labels map[string]string `json:"labels"`
			} `json:"metadata"`
			Spec struct {
				Project     string `json:"project"`
				Destination struct {
					Namespace string `json:"namespace"`
				} `json:"destination"`
			} `json:"spec"`
		} `json:"items"`
	}
	if err := json.Unmarshal([]byte(out), &list); err != nil {
		return nil, fmt.Errorf("could not parse the ArgoCD Applications in argocd: %w", err)
	}
	if list.Items == nil {
		return nil, fmt.Errorf("could not parse the ArgoCD Applications in argocd: the answer carries no items list")
	}
	var found []foreignApplication
	for _, app := range *list.Items {
		name := strings.TrimSpace(app.Metadata.Name)
		if name == "" || own.is(name, app.Metadata.Labels) || strings.TrimSpace(app.Spec.Destination.Namespace) != ns {
			continue
		}
		found = append(found, foreignApplication{Name: name, Project: strings.TrimSpace(app.Spec.Project)})
	}
	sort.Slice(found, func(i, j int) bool { return found[i].Name < found[j].Name })
	return found, nil
}

// deprovisionNamespaceIdentity deletes the per-namespace tenant cloud identity provisioned by
// provisionAndBindNamespaceIdentity (#957) — the teardown mirror of that function, case for case.
//
// The mirror must stay total: a cloud that provisions an identity and does not delete it leaves a
// standing cloud principal for a tenant that no longer exists. So the default arm FAILS rather than
// returning nil — a cloud activated in namespaceRemintProviders whose teardown case someone forgot is
// reported, never silently skipped (cloud parity is a hard rule; the gap is named or it is a bug).
//
// No handle is needed anywhere: every per-cloud name is derived from (clusterName, namespace) by the
// same function the provision side used, so a destroy job whose snapshot never carried the handle can
// still reconstruct it.
func deprovisionNamespaceIdentity(ctx context.Context, deprovision NamespaceIdentityDeprovisioner, providerSlug, region string, config *types.ProjectConfig, clusterName, ns string, stdout, stderr io.Writer) error {
	needsInjected := func() error {
		if deprovision == nil {
			return fmt.Errorf("namespace teardown: provider %q needs an injected NamespaceIdentity deprovisioner but none was provided — this is a runner wiring bug, and the tenant's cloud identity is still live", providerSlug)
		}
		return nil
	}

	switch providerSlug {
	case "aws":
		// In-core via the AWS IAM SDK, matching the in-core provision path (coreaws.ProvisionNamespaceIdentity).
		fmt.Fprintf(stdout, "Deprovisioning namespace %q per-namespace IRSA role...\n", ns)
		if err := coreaws.DeprovisionNamespaceIdentity(ctx, region, clusterName, ns); err != nil {
			return fmt.Errorf("failed to deprovision the per-namespace identity for %q: %w", ns, err)
		}
		return nil
	case "gcp":
		// GKE Workload Identity: deleting the GSA removes its IAM policy (the WI binding) with it.
		if err := needsInjected(); err != nil {
			return err
		}
		fmt.Fprintf(stdout, "Deprovisioning namespace %q per-namespace GCP service account...\n", ns)
		if err := deprovision(ctx, providerSlug, config, clusterName, ns); err != nil {
			return fmt.Errorf("failed to deprovision the per-namespace identity for %q: %w", ns, err)
		}
		return nil
	case "azure":
		// Azure Workload Identity: deleting the UAMI removes its federated credential with it.
		if err := needsInjected(); err != nil {
			return err
		}
		fmt.Fprintf(stdout, "Deprovisioning namespace %q per-namespace managed identity...\n", ns)
		if err := deprovision(ctx, providerSlug, config, clusterName, ns); err != nil {
			return fmt.Errorf("failed to deprovision the per-namespace identity for %q: %w", ns, err)
		}
		return nil
	case "alibaba":
		// ACK RRSA: in-core via the keyless ACS3-signing client, mirroring the in-core provision path.
		fmt.Fprintf(stdout, "Deprovisioning namespace %q per-namespace RAM role...\n", ns)
		if err := cloud.DeprovisionACKNamespaceIdentity(ctx, region, clusterName, ns); err != nil {
			return fmt.Errorf("failed to deprovision the per-namespace identity for %q: %w", ns, err)
		}
		return nil
	case "hetzner":
		// hetzner-talos has NO cloud IAM, so the deploy minted no cloud identity and there is nothing to
		// reclaim. The EXPLICIT counterpart of the documented exclusion in provisionAndBindNamespaceIdentity
		// — stated here too, so this arm reads as a decision rather than an omission.
		fmt.Fprintf(stdout, "Namespace %q on hetzner-talos: no cloud IAM identity was minted, so none is reclaimed.\n", ns)
		return nil
	default:
		return namespaceRemintNotWired(providerSlug)
	}
}
