// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"sort"
	"strings"
)

// The sweep that makes byoSecretSyncDenied hold for objects that exist already (#6479).
//
// The AppProject deny stops ArgoCD from syncing a secret-sync object out of a BYO chart. It does not
// remove one an earlier sync created: ArgoCD drops a live object its project no longer permits from
// the Application's view, BYO sync does not prune, and a detach deletes only permitted objects. So
// an object of that kind stays on the cluster, and ESO keeps reconciling it. This sweep removes them.
//
// WHAT IT KEEPS is the runner's own declared binding set, identified by (namespace, name, kind) — an
// ExternalSecret whose namespace and name the deploy's configuration declares as a binding. It is
// NOT identified by labels: a chart sets its own objects' labels, so a chart-authored object can
// carry the binding marker and this environment's owner label exactly as the runner's do. Every
// other namespaced object of the external-secrets.io group or any of its subgroups in a swept
// namespace is deleted.
//
// A KEPT BINDING MUST BE EXACTLY THE RUNNER'S OWN OBJECT, not merely carry its name. The runner
// applies a binding with client-side `kubectl apply`, which merges into whatever is there: a field its
// manifest does not write survives every apply. So a declared name is kept only when the live object
// was written by the runner alone (byoBindingIsRunnersOwn). Anything else at that name is deleted
// like any other object here, and returned to the caller to re-apply in the same stage, once the
// delete has completed, so the binding is not missing until the next deploy.
//
// WHERE IT LOOKS is decided by NAMESPACE labels, which a chart cannot set (Namespace is
// cluster-scoped and the BYO AppProject's clusterResourceWhitelist is empty): the namespaces the
// runner stamped as BYO chart namespaces (RenderByoNamespaces) whose owner label names this
// environment, minus any reserved platform namespace. Another environment's namespace is never
// listed. A namespace two environments' charts share carries the owner label of whichever deployed
// last.
//
// That last case cannot arise today: BYO charts are configured only by a dedicated deploy, on the
// environment's own cluster (namespace and vcluster placements never apply BYO charts), so one
// cluster carries one environment's BYO namespaces. If BYO charts ever run where two environments
// share a cluster, this sweep must not stay as it is: it would delete the other environment's
// bindings there. It would then need the namespace itself to be per-environment (refused when another
// environment's owner label is on it), or a keep set covering every environment on the cluster.
//
// It reads everything before it deletes anything, and an error in any read deletes nothing: an
// unknown set is never treated as an empty one. The caller skips the sweep outright when any
// binding failed to render or apply, because the keep set is then incomplete.

// byoSecretSyncGroup reports whether an API group is one byoSecretSyncDenied refuses.
func byoSecretSyncGroup(group string) bool {
	return group == "external-secrets.io" || strings.HasSuffix(group, ".external-secrets.io")
}

// byoSweepPathSafe reports whether s is a DNS-1123 subdomain: dot-separated segments, each the same
// DNS label grammar a namespace uses (dns1123Label, from packages/core/names), at most 253 characters
// in all. That is the shape Kubernetes allows for a custom resource's name, and every API group,
// version and resource name discovery returns fits it too. Each of them interpolates into an API path,
// so anything else is refused.
func byoSweepPathSafe(s string) bool {
	if s == "" || len(s) > 253 {
		return false
	}
	for _, seg := range strings.Split(s, ".") {
		if len(seg) > dns1123LabelMaxLen || !dns1123Label.MatchString(seg) {
			return false
		}
	}
	return true
}

// byoSweepResource is one namespaced, listable and deletable resource of a swept group.
type byoSweepResource struct {
	group, version, resource, kind string
}

// byoSweepObject is one listed object the sweep will delete.
type byoSweepObject struct {
	res             byoSweepResource
	namespace, name string
	uid             string
	// runnersOwn is set on an ExternalSecret that byoBindingIsRunnersOwn accepts.
	runnersOwn bool
}

// ByoBindingFieldManager is the field manager client-side `kubectl apply` records — the one the
// runner's ApplyManifest writes every binding ExternalSecret with.
const ByoBindingFieldManager = "kubectl-client-side-apply"

// byoSweepItem is the slice of a listed object the sweep reads.
type byoSweepItem struct {
	Metadata struct {
		Name          string `json:"name"`
		Namespace     string `json:"namespace"`
		UID           string `json:"uid"`
		ManagedFields []struct {
			Manager     string `json:"manager"`
			Subresource string `json:"subresource"`
		} `json:"managedFields"`
	} `json:"metadata"`
	Spec struct {
		DataFrom []json.RawMessage `json:"dataFrom"`
		Target   struct {
			Template struct {
				TemplateFrom []json.RawMessage `json:"templateFrom"`
			} `json:"template"`
		} `json:"target"`
	} `json:"spec"`
}

// byoBindingIsRunnersOwn reports whether a live ExternalSecret is exactly the runner's own binding:
// every write to the object itself was the runner's (ByoBindingFieldManager), and its spec carries
// none of the fields the runner's renderers never write that pull more than the binding's own key
// (spec.dataFrom, spec.target.template.templateFrom). Status writes, which ESO makes through the
// status subresource, are not the object's content and are not read. An object with no
// managedFields at all proves nothing about who wrote it, so it is not accepted.
func byoBindingIsRunnersOwn(it byoSweepItem) bool {
	if len(it.Spec.DataFrom) > 0 || len(it.Spec.Target.Template.TemplateFrom) > 0 {
		return false
	}
	seen := false
	for _, f := range it.Metadata.ManagedFields {
		if f.Subresource != "" {
			continue
		}
		if f.Manager != ByoBindingFieldManager {
			return false
		}
		seen = true
	}
	return seen
}

// ByoSecretSyncSweep is what one sweep did.
type ByoSecretSyncSweep struct {
	// Warnings are the Deploy-tab warnings, one per deletion.
	Warnings []string
	// Reapply are the declared bindings whose live object was not the runner's own and was deleted;
	// the caller re-applies them. Each one's delete has completed, or a warning says it may not have.
	Reapply []BindingSecretRef
}

// byoKubectl runs kubectl from an argument vector (no shell) and returns its stdout. stdin, when
// non-empty, is written to the process.
func byoKubectl(stdin string, args ...string) (string, error) {
	cmd := exec.Command("kubectl", args...)
	var out, errBuf bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errBuf
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("kubectl %s: %w: %s", args[0], err, strings.TrimSpace(errBuf.String()))
	}
	return out.String(), nil
}

// SweepByoSecretSyncObjects deletes every namespaced external-secrets.io-family object in this
// environment's BYO chart namespaces that is not one of the runner's declared binding ExternalSecrets.
// owner is the environment's owner-label value; declared is every binding ExternalSecret the
// configuration declares. It returns one Deploy-tab warning per object whose deletion it requested.
func SweepByoSecretSyncObjects(owner string, declared []BindingSecretRef, stdout, stderr io.Writer) ByoSecretSyncSweep {
	var out ByoSecretSyncSweep
	if !validOwner(owner) {
		fmt.Fprintf(stderr, "Warning: not sweeping BYO chart namespaces for secret-sync objects: no usable environment owner label (%q)\n", owner)
		return out
	}
	keep := make(map[bindingKey]bool, len(declared))
	for _, d := range declared {
		keep[bindingKey{d.Namespace, d.Name}] = true
	}

	namespaces, err := byoSweepNamespaces(owner)
	if err != nil {
		fmt.Fprintf(stderr, "Warning: not sweeping BYO chart namespaces for secret-sync objects: %v\n", err)
		return out
	}
	if len(namespaces) == 0 {
		return out
	}
	resources, err := byoSweepResources()
	if err != nil {
		fmt.Fprintf(stderr, "Warning: not sweeping BYO chart namespaces for secret-sync objects: %v\n", err)
		return out
	}

	var stale []byoSweepObject
	for _, ns := range namespaces {
		for _, r := range resources {
			objs, err := byoSweepList(r, ns)
			if err != nil {
				fmt.Fprintf(stderr, "Warning: not sweeping BYO chart namespaces for secret-sync objects: %v\n", err)
				return out
			}
			for _, o := range objs {
				if r.group == "external-secrets.io" && r.kind == "ExternalSecret" && keep[bindingKey{o.namespace, o.name}] && o.runnersOwn {
					continue
				}
				stale = append(stale, o)
			}
		}
	}

	for _, o := range stale {
		declaredBinding := o.res.group == "external-secrets.io" && o.res.kind == "ExternalSecret" && keep[bindingKey{o.namespace, o.name}]
		opts := fmt.Sprintf(`{"kind":"DeleteOptions","apiVersion":"v1","propagationPolicy":"Foreground","preconditions":{"uid":%q}}`, o.uid)
		path := fmt.Sprintf("/apis/%s/%s/namespaces/%s/%s/%s", o.res.group, o.res.version, o.namespace, o.res.resource, o.name)
		// The deleted object's JSON comes back on stdout and is discarded, so none of it reaches the log.
		if _, err := byoKubectl(opts, "delete", "--raw", path, "-f", "-"); err != nil {
			fmt.Fprintf(stderr, "Warning: failed to delete %s %s/%s from a BYO chart namespace: %v\n", o.res.kind, o.namespace, o.name, err)
			continue
		}
		fmt.Fprintf(stdout, "BYO chart namespace secret-sync sweep: deletion requested for %s %s/%s\n", o.res.kind, o.namespace, o.name)
		if !declaredBinding {
			out.Warnings = append(out.Warnings, fmt.Sprintf(
				"The runner deleted %s %q from BYO chart namespace %q. Bring-your-own charts can't create %s objects; "+
					"declare a binding on the chart's workload instead, and the runner creates the secret for it.",
				o.res.kind, o.name, o.namespace, o.res.group))
			continue
		}
		// A declared binding's name held an object that was not the runner's own. It is re-applied by
		// the caller, which must not happen while the Foreground delete is still in progress: an apply
		// onto an object being deleted is lost with it.
		if _, err := byoKubectl("", "wait", "--for=delete", "externalsecrets."+o.res.group+"/"+o.name, "-n", o.namespace, "--timeout=60s"); err != nil {
			fmt.Fprintf(stderr, "Warning: the replaced binding ExternalSecret %s/%s may still be deleting: %v\n", o.namespace, o.name, err)
		}
		out.Reapply = append(out.Reapply, BindingSecretRef{Namespace: o.namespace, Name: o.name})
		out.Warnings = append(out.Warnings, fmt.Sprintf(
			"The runner replaced binding ExternalSecret %q in BYO chart namespace %q, because the live object was not "+
				"exactly the one the runner writes. A kept binding must be exactly the runner's own object.",
			o.name, o.namespace))
	}
	return out
}

// byoSweepNamespaces lists the namespaces the runner stamped as this environment's BYO chart
// namespaces, re-checking the labels on every returned object and dropping reserved names.
func byoSweepNamespaces(owner string) ([]string, error) {
	sel := fmt.Sprintf("%s=%s,%s=%s", byoNamespaceManagedByLabel, byoNamespaceManagedByValue, ByoBindingOwnerLabel, owner)
	raw, err := byoKubectl("", "get", "namespaces", "-l", sel, "-o", "json")
	if err != nil {
		return nil, fmt.Errorf("list BYO chart namespaces: %w", err)
	}
	var list labelledList
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		return nil, fmt.Errorf("parse BYO chart namespaces: %w", err)
	}
	var out []string
	for _, item := range list.Items {
		m := item.Metadata
		if m.Labels[byoNamespaceManagedByLabel] != byoNamespaceManagedByValue || m.Labels[ByoBindingOwnerLabel] != owner {
			continue
		}
		if validateByoNamespace(m.Name) != nil {
			continue // malformed, or reserved for the platform: never swept
		}
		out = append(out, m.Name)
	}
	sort.Strings(out)
	return out, nil
}

// byoSweepResources discovers every namespaced resource of the swept groups that can be listed and
// deleted, at each group's preferred version.
func byoSweepResources() ([]byoSweepResource, error) {
	raw, err := byoKubectl("", "get", "--raw", "/apis")
	if err != nil {
		return nil, fmt.Errorf("discover API groups: %w", err)
	}
	var groups struct {
		Groups []struct {
			Name             string `json:"name"`
			PreferredVersion struct {
				Version string `json:"version"`
			} `json:"preferredVersion"`
		} `json:"groups"`
	}
	if err := json.Unmarshal([]byte(raw), &groups); err != nil {
		return nil, fmt.Errorf("parse API groups: %w", err)
	}
	var out []byoSweepResource
	for _, g := range groups.Groups {
		if !byoSecretSyncGroup(g.Name) {
			continue
		}
		v := g.PreferredVersion.Version
		if !byoSweepPathSafe(g.Name) || !byoSweepPathSafe(v) {
			return nil, fmt.Errorf("API group %q version %q is not a usable path", g.Name, v)
		}
		rraw, err := byoKubectl("", "get", "--raw", "/apis/"+g.Name+"/"+v)
		if err != nil {
			return nil, fmt.Errorf("discover %s/%s resources: %w", g.Name, v, err)
		}
		var rl struct {
			Resources []struct {
				Name       string   `json:"name"`
				Kind       string   `json:"kind"`
				Namespaced bool     `json:"namespaced"`
				Verbs      []string `json:"verbs"`
			} `json:"resources"`
		}
		if err := json.Unmarshal([]byte(rraw), &rl); err != nil {
			return nil, fmt.Errorf("parse %s/%s resources: %w", g.Name, v, err)
		}
		for _, r := range rl.Resources {
			if !r.Namespaced || strings.Contains(r.Name, "/") || !hasVerbs(r.Verbs, "list", "delete") {
				continue // cluster-scoped (the AppProject denies those outright), or a subresource
			}
			if !byoSweepPathSafe(r.Name) {
				return nil, fmt.Errorf("resource %q in %s is not a usable path", r.Name, g.Name)
			}
			out = append(out, byoSweepResource{group: g.Name, version: v, resource: r.Name, kind: r.Kind})
		}
	}
	return out, nil
}

// hasVerbs reports whether verbs carries every one of want.
func hasVerbs(verbs []string, want ...string) bool {
	set := map[string]bool{}
	for _, v := range verbs {
		set[v] = true
	}
	for _, w := range want {
		if !set[w] {
			return false
		}
	}
	return true
}

// byoSweepList lists one resource in one namespace. An object whose name or uid cannot be used in
// a pinned delete is an error, not a skip: leaving it would leave exactly the object the sweep
// exists to remove, and say nothing.
func byoSweepList(r byoSweepResource, ns string) ([]byoSweepObject, error) {
	raw, err := byoKubectl("", "get", "--raw", fmt.Sprintf("/apis/%s/%s/namespaces/%s/%s", r.group, r.version, ns, r.resource))
	if err != nil {
		return nil, fmt.Errorf("list %s in %s: %w", r.resource, ns, err)
	}
	var list struct {
		Items []byoSweepItem `json:"items"`
	}
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		return nil, fmt.Errorf("parse %s in %s: %w", r.resource, ns, err)
	}
	var out []byoSweepObject
	for _, item := range list.Items {
		m := item.Metadata
		if m.Namespace != ns {
			continue // a listing that ignored its namespace can never widen what is deleted
		}
		if !byoSweepPathSafe(m.Name) || !bindingUIDRe.MatchString(m.UID) {
			return nil, fmt.Errorf("%s %q in %s has no usable name or uid in the listing", r.kind, m.Name, ns)
		}
		out = append(out, byoSweepObject{res: r, namespace: ns, name: m.Name, uid: m.UID, runnersOwn: byoBindingIsRunnersOwn(item)})
	}
	return out, nil
}
