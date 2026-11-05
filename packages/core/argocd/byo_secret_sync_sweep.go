// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"reflect"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
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
// applies a binding with client-side `kubectl apply`, which merges into whatever is there, so a field
// its manifest does not write survives every apply. The sweep therefore compares each kept binding's
// live spec with the spec the runner rendered for it on this deploy (byoBindingSpecMatches). When they
// differ — an extra dataFrom, a templateFrom, another store, anything — it REPLACES the object with
// the rendered one, pinned to the live uid and resourceVersion. The object, and the Secret it owns,
// stay where they are; only the foreign fields go. Nothing at a kept name is ever deleted, and a
// binding whose live spec already matches is not written at all. A replace that loses a race
// (another write in between) is reported, not retried: the next deploy compares again.
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
	resourceVersion string
	spec            json.RawMessage
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
//
// rendered maps a declared binding to the ExternalSecret document the runner rendered for it on this
// deploy; a kept binding whose live spec differs from that document's is replaced with it. A declared
// binding with no rendered document is kept as it is.
func SweepByoSecretSyncObjects(owner string, declared []BindingSecretRef, rendered map[BindingSecretRef]string, stdout, stderr io.Writer) []string {
	if !validOwner(owner) {
		fmt.Fprintf(stderr, "Warning: not sweeping BYO chart namespaces for secret-sync objects: no usable environment owner label (%q)\n", owner)
		return nil
	}
	keep := make(map[bindingKey]bool, len(declared))
	for _, d := range declared {
		keep[bindingKey{d.Namespace, d.Name}] = true
	}

	namespaces, err := byoSweepNamespaces(owner)
	if err != nil {
		fmt.Fprintf(stderr, "Warning: not sweeping BYO chart namespaces for secret-sync objects: %v\n", err)
		return nil
	}
	if len(namespaces) == 0 {
		return nil
	}
	resources, err := byoSweepResources()
	if err != nil {
		fmt.Fprintf(stderr, "Warning: not sweeping BYO chart namespaces for secret-sync objects: %v\n", err)
		return nil
	}

	var stale, kept []byoSweepObject
	for _, ns := range namespaces {
		for _, r := range resources {
			objs, err := byoSweepList(r, ns)
			if err != nil {
				fmt.Fprintf(stderr, "Warning: not sweeping BYO chart namespaces for secret-sync objects: %v\n", err)
				return nil
			}
			for _, o := range objs {
				if r.group == "external-secrets.io" && r.kind == "ExternalSecret" && keep[bindingKey{o.namespace, o.name}] {
					kept = append(kept, o)
					continue
				}
				stale = append(stale, o)
			}
		}
	}

	var warnings []string
	for _, o := range kept {
		doc, ok := rendered[BindingSecretRef{Namespace: o.namespace, Name: o.name}]
		if !ok {
			continue
		}
		if w := byoRestoreBinding(o, doc, stdout, stderr); w != "" {
			warnings = append(warnings, w)
		}
	}
	for _, o := range stale {
		opts := fmt.Sprintf(`{"kind":"DeleteOptions","apiVersion":"v1","propagationPolicy":"Foreground","preconditions":{"uid":%q}}`, o.uid)
		path := fmt.Sprintf("/apis/%s/%s/namespaces/%s/%s/%s", o.res.group, o.res.version, o.namespace, o.res.resource, o.name)
		// The deleted object's JSON comes back on stdout and is discarded, so none of it reaches the log.
		if _, err := byoKubectl(opts, "delete", "--raw", path, "-f", "-"); err != nil {
			fmt.Fprintf(stderr, "Warning: failed to delete %s %s/%s from a BYO chart namespace: %v\n", o.res.kind, o.namespace, o.name, err)
			continue
		}
		fmt.Fprintf(stdout, "BYO chart namespace secret-sync sweep: deletion requested for %s %s/%s\n", o.res.kind, o.namespace, o.name)
		warnings = append(warnings, fmt.Sprintf(
			"The runner deleted %s %q from BYO chart namespace %q. Bring-your-own charts can't create %s objects; "+
				"declare a binding on the chart's workload instead, and the runner creates the secret for it.",
			o.res.kind, o.name, o.namespace, o.res.group))
	}
	return warnings
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
		Items []struct {
			Metadata struct {
				Name            string `json:"name"`
				Namespace       string `json:"namespace"`
				UID             string `json:"uid"`
				ResourceVersion string `json:"resourceVersion"`
			} `json:"metadata"`
			Spec json.RawMessage `json:"spec"`
		} `json:"items"`
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
		out = append(out, byoSweepObject{res: r, namespace: ns, name: m.Name, uid: m.UID, resourceVersion: item.Metadata.ResourceVersion, spec: item.Spec})
	}
	return out, nil
}

// byoRestoreBinding makes a kept binding's live object exactly the rendered one, and returns a
// Deploy-tab warning when it had to, or when it could not. A live spec that already matches is not
// written.
//
// The replace carries the live uid and resourceVersion in its metadata. The API server refuses an
// update whose resourceVersion is not the current one (another write came in between) and one whose
// uid is not the object's (the name now holds a different object), so neither a concurrent edit nor
// a recreated object is ever overwritten blind. Either refusal is reported, not retried.
func byoRestoreBinding(o byoSweepObject, doc string, stdout, stderr io.Writer) string {
	var obj map[string]any
	if err := yaml.Unmarshal([]byte(doc), &obj); err != nil {
		fmt.Fprintf(stderr, "Warning: could not read the rendered binding ExternalSecret %s/%s: %v\n", o.namespace, o.name, err)
		return ""
	}
	want, _ := obj["spec"].(map[string]any)
	var live map[string]any
	if err := json.Unmarshal(o.spec, &live); err != nil {
		fmt.Fprintf(stderr, "Warning: could not read the live binding ExternalSecret %s/%s: %v\n", o.namespace, o.name, err)
		return ""
	}
	if byoBindingSpecMatches(live, want) {
		return ""
	}
	if !bindingUIDRe.MatchString(o.uid) || o.resourceVersion == "" {
		fmt.Fprintf(stderr, "Warning: not restoring binding ExternalSecret %s/%s: no usable uid or resourceVersion in the listing\n", o.namespace, o.name)
		return fmt.Sprintf(byoBindingRestoreFailed, o.name, o.namespace)
	}
	meta, _ := obj["metadata"].(map[string]any)
	if meta == nil || meta["name"] != o.name || meta["namespace"] != o.namespace {
		fmt.Fprintf(stderr, "Warning: not restoring binding ExternalSecret %s/%s: the rendered document names another object\n", o.namespace, o.name)
		return fmt.Sprintf(byoBindingRestoreFailed, o.name, o.namespace)
	}
	meta["uid"] = o.uid
	meta["resourceVersion"] = o.resourceVersion
	body, err := json.Marshal(obj)
	if err != nil {
		fmt.Fprintf(stderr, "Warning: could not encode the binding ExternalSecret %s/%s: %v\n", o.namespace, o.name, err)
		return fmt.Sprintf(byoBindingRestoreFailed, o.name, o.namespace)
	}
	if _, err := byoKubectl(string(body), "replace", "-f", "-"); err != nil {
		fmt.Fprintf(stderr, "Warning: did not restore binding ExternalSecret %s/%s (it changed since it was read, or the write failed): %v\n", o.namespace, o.name, err)
		return fmt.Sprintf(byoBindingRestoreFailed, o.name, o.namespace)
	}
	fmt.Fprintf(stdout, "BYO chart namespace secret-sync sweep: restored binding ExternalSecret %s/%s to the runner's rendered spec\n", o.namespace, o.name)
	return fmt.Sprintf("The runner restored binding ExternalSecret %q in BYO chart namespace %q to the spec it renders, "+
		"removing fields it does not write. A kept binding must be exactly the runner's own object.", o.name, o.namespace)
}

// byoBindingRestoreFailed is the Deploy-tab warning for a binding the sweep found altered and could
// not restore on this deploy.
const byoBindingRestoreFailed = "Binding ExternalSecret %q in BYO chart namespace %q holds fields the runner does not write, and the " +
	"runner could not restore it on this deploy (see the deploy log). It compares and restores it again on the next deploy."

// byoBindingSpecMatches reports whether a live ExternalSecret spec is the rendered one. Both are first
// given the defaults ESO 0.9.20's CRD fills in (esoSpecDefaults), so a field the API server defaulted
// does not count as a difference; after that the two must be equal in full, so any field the
// renderer does not write — dataFrom, a templateFrom, a template metadata block, another store —
// is a difference. Scalars compare as their text, and refreshInterval as a duration, because a
// rendered YAML scalar and the stored JSON value need not share a type or a spelling.
func byoBindingSpecMatches(live, want map[string]any) bool {
	if want == nil {
		return false
	}
	return reflect.DeepEqual(esoNormalizeSpec(live), esoNormalizeSpec(want))
}

// esoNormalizeSpec returns spec with ESO's v1beta1 ExternalSecret defaults filled in and every scalar
// as text. It never mutates its argument.
func esoNormalizeSpec(spec map[string]any) any {
	m, _ := esoTextScalars(spec).(map[string]any) // a map in, a map out
	esoSpecDefaults(m)
	if ri, ok := m["refreshInterval"].(string); ok {
		if d, err := time.ParseDuration(ri); err == nil {
			m["refreshInterval"] = d.String()
		}
	}
	return m
}

// esoSpecDefaults fills, in place, the defaults external-secrets.io_externalsecrets.yaml (v1beta1,
// chart 0.9.20) declares for the fields this renderer's documents reach: spec.refreshInterval;
// target.creationPolicy and target.deletionPolicy; template.engineVersion and template.mergePolicy;
// and each data entry's remoteRef.conversionStrategy, decodingStrategy and metadataPolicy. Defaults
// under kinds the renderer never writes (dataFrom, templateFrom, sourceRef) are deliberately not
// filled: their presence alone is already a difference.
func esoSpecDefaults(spec map[string]any) {
	setDefault(spec, "refreshInterval", "1h")
	target, _ := spec["target"].(map[string]any)
	if target == nil {
		target = map[string]any{}
		spec["target"] = target
	}
	setDefault(target, "creationPolicy", "Owner")
	setDefault(target, "deletionPolicy", "Retain")
	if tmpl, ok := target["template"].(map[string]any); ok {
		setDefault(tmpl, "engineVersion", "v2")
		setDefault(tmpl, "mergePolicy", "Replace")
	}
	if data, ok := spec["data"].([]any); ok {
		for _, d := range data {
			entry, _ := d.(map[string]any)
			if entry == nil {
				continue
			}
			if ref, ok := entry["remoteRef"].(map[string]any); ok {
				setDefault(ref, "conversionStrategy", "Default")
				setDefault(ref, "decodingStrategy", "None")
				setDefault(ref, "metadataPolicy", "None")
			}
		}
	}
}

// setDefault sets m[k] to v when m has no value for k.
func setDefault(m map[string]any, k, v string) {
	if _, ok := m[k]; !ok {
		m[k] = v
	}
}

// esoTextScalars deep-copies v with every scalar rendered as text and nil kept as nil.
func esoTextScalars(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, x := range t {
			out[k] = esoTextScalars(x)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, x := range t {
			out[i] = esoTextScalars(x)
		}
		return out
	case nil:
		return nil
	default:
		return fmt.Sprint(t)
	}
}
