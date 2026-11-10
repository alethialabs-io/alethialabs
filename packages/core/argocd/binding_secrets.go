// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

// W5 Path A Lane 2b — prune runner-applied BYO chart binding ExternalSecrets. These are applied by
// the runner OUTSIDE ArgoCD, because the hardened BYO AppProject admits only a closed list of
// namespaced workload kinds and denies every external-secrets.io kind (byoWorkloadKinds,
// byoSecretSyncDenied), so the chart's Application could not carry them. Nothing else sweeps them:
// when a binding is removed (or its chart detached), its ExternalSecret would orphan.
//
// The prune is scoped to ONE environment's objects, and scoped twice:
//   - by NAMESPACE: it lists only the namespaces the environment declares a BYO binding in, plus
//     the namespaces carrying the environment's own owner label (the runner stamps it on every BYO
//     namespace it creates, so a detached chart's namespace is still found). It never lists across
//     all namespaces, so a shared host — a Fabric owner whose cluster also carries namespace or
//     vcluster placements — is not walked end to end.
//   - by OWNER LABEL: an object is a candidate only when it carries the binding marker AND this
//     environment's owner label, checked both in the API server's selector and again on every
//     returned object. An object with no owner label, or another environment's, is never deleted.
//
// The desired set is the caller's: what the environment's configuration DECLARES, not what applied
// on this run (see provisioner.pruneByoChartBindings, which also skips the prune outright when any
// binding failed to render or apply).

import (
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"regexp"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// ByoBindingSecretLabel marks an ExternalSecret the runner applied for a BYO chart workload's
// credential binding. The renderer stamps it (ExternalSecretParams.Labels) so the prune below can
// list them.
const ByoBindingSecretLabel = "alethia.io/byo-binding"

// ByoBindingOwnerLabel names the environment that owns a binding ExternalSecret. It is the same key
// as the environment sweep handle cloud.ClassificationLabels emits (`alethia.io/environment-id`),
// so the owner value on the ExternalSecret and on the BYO namespace the runner creates are one
// rendering of one ID.
const ByoBindingOwnerLabel = "alethia.io/environment-id"

// ByoBindingSourceLabel names where a binding ExternalSecret reads its credential from. Only the
// per-binding-user path sets it (ByoBindingSourceDBUser); an object without it reads the
// administrative credential (docs/adr/byo-binding-db-users.md §4).
const ByoBindingSourceLabel = "alethia.io/byo-binding-source"

// ByoBindingSourceDBUser is ByoBindingSourceLabel's value on an ExternalSecret that reads the
// binding's own database user's key.
const ByoBindingSourceDBUser = "db-user"

// BindingSecretRef names one binding ExternalSecret by namespace and name. A name alone is not an
// identity: two charts in two namespaces may bind the same workload name to the same target.
type BindingSecretRef struct {
	Namespace string
	Name      string
	// Source, when set, is the ByoBindingSourceLabel value the live object must carry to be kept.
	// A declared binding whose live object reads another source (the administrative credential, from
	// a deploy before the per-binding-user mode) is not kept, so turning the mode on withdraws it.
	Source string
}

// bindingKey is a BindingSecretRef's identity, without the source it is kept for.
type bindingKey struct{ namespace, name string }

// labelledList is the slice of a `kubectl get … -o json` list this file reads.
type labelledList struct {
	Items []struct {
		APIVersion string `json:"apiVersion"`
		Metadata   struct {
			Name      string            `json:"name"`
			Namespace string            `json:"namespace"`
			UID       string            `json:"uid"`
			Labels    map[string]string `json:"labels"`
		} `json:"metadata"`
	} `json:"items"`
}

// bindingUIDRe is a Kubernetes object UID (a UUID). It interpolates into a delete precondition, so
// anything else is refused.
var bindingUIDRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// bindingAPIVersionRe is the ExternalSecret group/version the delete path is built from.
var bindingAPIVersionRe = regexp.MustCompile(`^external-secrets\.io/v1(beta1)?$`)

// staleBinding is one listed object the prune will delete, with what the delete is pinned to.
type staleBinding struct {
	ref        BindingSecretRef
	uid        string
	apiVersion string
	// wrongSource is set when the binding is still declared but its live object does not read the
	// source the declaration requires.
	wrongSource bool
}

// validOwner reports whether owner can be used as a label value in a selector. It interpolates into
// a shell command, so anything that is not a plain label value is refused.
func validOwner(owner string) bool {
	return owner != "" && len(owner) <= dns1123LabelMaxLen && k8sLabelValue.MatchString(owner)
}

// ownedNamespaces lists the namespaces that carry owner's label. An error means the set is unknown,
// which the caller must treat as "do not prune", never as "no namespaces".
func ownedNamespaces(owner string) ([]string, error) {
	raw, err := utils.ExecuteCommandWithOutput(
		fmt.Sprintf("kubectl get namespaces -l %s=%s -o json", ByoBindingOwnerLabel, owner), ".", nil)
	if err != nil {
		return nil, fmt.Errorf("list namespaces owned by %s: %w", owner, err)
	}
	var list labelledList
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		return nil, fmt.Errorf("parse namespaces owned by %s: %w", owner, err)
	}
	var out []string
	for _, item := range list.Items {
		if item.Metadata.Labels[ByoBindingOwnerLabel] == owner {
			out = append(out, item.Metadata.Name)
		}
	}
	return out, nil
}

// PruneChartBindingSecrets deletes this environment's labelled BYO binding ExternalSecrets that are
// no longer desired (a removed binding, or a detached chart, or a declared binding whose live object
// does not read the source the declaration requires — see BindingSecretRef.Source). owner is the environment's owner-label
// value; declaredNamespaces are the namespaces its configuration places a binding in; desired is
// every binding its configuration declares. Best-effort: any listing it cannot read stops the prune
// with a warning and deletes nothing — an unknown set is never treated as an empty one.
func PruneChartBindingSecrets(owner string, declaredNamespaces []string, desired []BindingSecretRef, stdout, stderr io.Writer) {
	if !validOwner(owner) {
		fmt.Fprintf(stderr, "Warning: not pruning BYO binding ExternalSecrets: no usable environment owner label (%q)\n", owner)
		return
	}
	keep := make(map[bindingKey]string, len(desired))
	for _, d := range desired {
		keep[bindingKey{d.Namespace, d.Name}] = d.Source
	}

	owned, err := ownedNamespaces(owner)
	if err != nil {
		fmt.Fprintf(stderr, "Warning: could not list BYO binding namespaces to prune: %v\n", err)
		return
	}
	nsSet := map[string]struct{}{}
	for _, ns := range append(append([]string(nil), declaredNamespaces...), owned...) {
		if ns == "" {
			continue
		}
		nsSet[ns] = struct{}{}
	}
	namespaces := make([]string, 0, len(nsSet))
	for ns := range nsSet {
		namespaces = append(namespaces, ns)
	}
	sort.Strings(namespaces)

	// Read EVERY namespace before deleting in any: a listing that fails part-way must not leave the
	// prune half-applied on the namespaces it happened to reach first.
	var stale []staleBinding
	for _, ns := range namespaces {
		if !k8sNameRe.MatchString(ns) {
			fmt.Fprintf(stderr, "Warning: skipping prune in oddly-named namespace %q\n", ns)
			continue
		}
		raw, err := utils.ExecuteCommandWithOutput(
			fmt.Sprintf("kubectl get externalsecrets -n %s -l %s=true,%s=%s -o json",
				ns, ByoBindingSecretLabel, ByoBindingOwnerLabel, owner),
			".", nil)
		if err != nil {
			fmt.Fprintf(stderr, "Warning: could not list BYO binding ExternalSecrets to prune in %s: %v\n", ns, err)
			return
		}
		var list labelledList
		if err := json.Unmarshal([]byte(raw), &list); err != nil {
			fmt.Fprintf(stderr, "Warning: could not parse BYO binding ExternalSecret list to prune in %s: %v\n", ns, err)
			return
		}
		for _, item := range list.Items {
			m := item.Metadata
			// The selector already asked for exactly this; re-check it on the object, so a listing
			// that ignored the selector (or a namespace mismatch) can never widen what is deleted.
			if m.Namespace != ns || m.Labels[ByoBindingSecretLabel] != "true" || m.Labels[ByoBindingOwnerLabel] != owner {
				continue
			}
			ref := BindingSecretRef{Namespace: m.Namespace, Name: m.Name}
			source, declared := keep[bindingKey{m.Namespace, m.Name}]
			if declared && (source == "" || m.Labels[ByoBindingSourceLabel] == source) {
				continue
			}
			// The name interpolates into a kubectl command; the API server already constrains it to a
			// DNS label, but fail closed on anything that isn't one (mirrors PruneAddOnSecrets).
			if !k8sNameRe.MatchString(m.Name) {
				fmt.Fprintf(stderr, "Warning: skipping prune of oddly-named ExternalSecret %q/%q\n", m.Namespace, m.Name)
				continue
			}
			// The delete is pinned to the uid that was listed, so an object recreated between the
			// list and the delete (by anyone) is never the one removed.
			if !bindingUIDRe.MatchString(m.UID) || !bindingAPIVersionRe.MatchString(item.APIVersion) {
				fmt.Fprintf(stderr, "Warning: skipping prune of ExternalSecret %s/%s: no usable uid or apiVersion in the listing\n", m.Namespace, m.Name)
				continue
			}
			stale = append(stale, staleBinding{ref: ref, uid: m.UID, apiVersion: item.APIVersion, wrongSource: declared})
		}
	}

	for _, s := range stale {
		if delErr := deleteBindingWithUID(s, stderr); delErr != nil {
			fmt.Fprintf(stderr, "Warning: failed to prune BYO binding ExternalSecret %s/%s: %v\n",
				s.ref.Namespace, s.ref.Name, delErr)
			continue
		}
		if s.wrongSource {
			fmt.Fprintf(stdout, "BYO binding ExternalSecret does not read its binding's own credential: deletion requested for %s/%s\n", s.ref.Namespace, s.ref.Name)
			continue
		}
		fmt.Fprintf(stdout, "BYO binding ExternalSecret no longer declared: deletion requested for %s/%s\n", s.ref.Namespace, s.ref.Name)
	}
}

// deleteBindingWithUID deletes one ExternalSecret through the raw API with a uid precondition and
// Foreground propagation (the pattern of provisioner's bootstrap reaper): the API server refuses the
// delete when the object at that name is no longer the one that was listed, and removes the Secret
// it owns before the ExternalSecret itself. kubectl runs from an argument vector — no shell — with
// the DeleteOptions on stdin. Its stdout (the deleted object's JSON) is discarded, so nothing of the
// object reaches the job log; stderr is kept for errors.
func deleteBindingWithUID(s staleBinding, stderr io.Writer) error {
	opts := fmt.Sprintf(`{"kind":"DeleteOptions","apiVersion":"v1","propagationPolicy":"Foreground","preconditions":{"uid":%q}}`, s.uid)
	path := fmt.Sprintf("/apis/%s/namespaces/%s/externalsecrets/%s", s.apiVersion, s.ref.Namespace, s.ref.Name)
	cmd := exec.Command("kubectl", "delete", "--raw", path, "-f", "-")
	cmd.Stdin = strings.NewReader(opts)
	cmd.Stdout = io.Discard
	cmd.Stderr = stderr
	return cmd.Run()
}
