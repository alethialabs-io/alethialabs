// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	tfjson "github.com/hashicorp/terraform-json"
	"gopkg.in/yaml.v3"
)

// ParseCustomerPlan parses a customer-provided OpenTofu/Terraform `show -json` plan so
// Evaluate can audit infrastructure ALETHIA DID NOT generate (the "bring your own IaC"
// flow). No control changes are needed — the same AWS/GCP/Azure controls run on any plan.
// Returns an error when the bytes are not a valid plan document.
func ParseCustomerPlan(planJSON []byte) (*tfjson.Plan, error) {
	if len(bytes.TrimSpace(planJSON)) == 0 {
		return nil, fmt.Errorf("empty plan JSON")
	}
	var plan tfjson.Plan
	if err := json.Unmarshal(planJSON, &plan); err != nil {
		return nil, fmt.Errorf("invalid plan JSON: %w", err)
	}
	if plan.FormatVersion == "" && len(plan.ResourceChanges) == 0 {
		return nil, fmt.Errorf("not an OpenTofu/Terraform plan (no format_version or resource_changes)")
	}
	return &plan, nil
}

// k8sResource is one decoded Kubernetes manifest reduced to what the controls read.
type k8sResource struct {
	kind      string
	name      string
	namespace string
	raw       map[string]any
}

// decodeManifests decodes a (possibly multi-document) YAML manifest stream into k8s
// resources, skipping empty/null documents.
func decodeManifests(manifests []byte) ([]k8sResource, error) {
	dec := yaml.NewDecoder(bytes.NewReader(manifests))
	var out []k8sResource
	for {
		var doc map[string]any
		err := dec.Decode(&doc)
		if err != nil {
			if err.Error() == "EOF" {
				break
			}
			return nil, fmt.Errorf("invalid k8s YAML: %w", err)
		}
		if doc == nil {
			continue
		}
		meta, _ := doc["metadata"].(map[string]any)
		out = append(out, k8sResource{
			kind:      asString(doc["kind"]),
			name:      asString(meta["name"]),
			namespace: asString(meta["namespace"]),
			raw:       doc,
		})
	}
	return out, nil
}

// EvaluateManifests audits rendered Kubernetes manifests with the k8s control set and
// returns the same Report shape as the terraform path (so the receipt + UI are uniform).
func EvaluateManifests(manifests []byte) (*Report, error) {
	rep := &Report{CatalogVersion: CatalogVersion, Provider: "k8s"}
	resources, err := decodeManifests(manifests)
	if err != nil {
		return nil, err
	}
	rep.Controls = []ControlResult{
		controlContainerSecurity(resources),
		controlResourceLimits(resources),
		controlHostAccess(resources),
		controlRBAC(resources),
	}
	rep.finalize()
	return rep, nil
}

// workloadKinds carry a pod template the container controls inspect.
var workloadKinds = map[string]bool{
	"Deployment": true, "StatefulSet": true, "DaemonSet": true,
	"ReplicaSet": true, "Job": true, "Pod": true, "ReplicationController": true,
}

// podSpec returns the PodSpec of a workload resource ("" kinds → not a workload).
func podSpec(r k8sResource) (map[string]any, bool) {
	if !workloadKinds[r.kind] {
		return nil, false
	}
	spec, ok := r.raw["spec"].(map[string]any)
	if !ok {
		return nil, false
	}
	if r.kind == "Pod" {
		return spec, true
	}
	tmpl, ok := spec["template"].(map[string]any)
	if !ok {
		return nil, false
	}
	ps, ok := tmpl["spec"].(map[string]any)
	return ps, ok
}

// containers returns the containers (+ initContainers) of a pod spec.
func containers(ps map[string]any) []map[string]any {
	var out []map[string]any
	for _, key := range []string{"containers", "initContainers"} {
		if list, ok := ps[key].([]any); ok {
			for _, c := range list {
				if cm, ok := c.(map[string]any); ok {
					out = append(out, cm)
				}
			}
		}
	}
	return out
}

// controlContainerSecurity — CONTAINERSECURITY-001. No privileged containers, no
// root (runAsUser 0 / privileged), and no mutable `:latest` image tags.
func controlContainerSecurity(resources []k8sResource) ControlResult {
	c := ControlResult{
		ID:         "CONTAINERSECURITY-001",
		Title:      "Containers run non-root, unprivileged, on pinned images",
		Severity:   SeverityHigh,
		Provider:   "k8s",
		Frameworks: []string{"CIS-K8S-5.2", "NSA-Kubernetes"},
	}
	failed, warned, relevant := 0, 0, 0
	for _, r := range resources {
		ps, ok := podSpec(r)
		if !ok {
			continue
		}
		podSC, _ := ps["securityContext"].(map[string]any)
		for _, ct := range containers(ps) {
			relevant++
			addr := r.kind + "/" + r.name + ":" + asString(ct["name"])
			sc, _ := ct["securityContext"].(map[string]any)
			if b, ok := boolField(sc, "privileged"); ok && b {
				c.Findings = append(c.Findings, Finding{Address: addr, Message: "runs a privileged container"})
				failed++
			}
			if runsAsRoot(sc, podSC) {
				c.Findings = append(c.Findings, Finding{Address: addr, Message: "runs as root (runAsUser 0)"})
				failed++
			} else if !runAsNonRootSet(sc, podSC) {
				c.Findings = append(c.Findings, Finding{Address: addr, Message: "does not set runAsNonRoot — may run as root"})
				warned++
			}
			img := asString(ct["image"])
			if img != "" && (strings.HasSuffix(img, ":latest") || !strings.Contains(lastSegment(img), ":")) {
				c.Findings = append(c.Findings, Finding{Address: addr, Message: "uses a mutable image tag (:latest or untagged): " + img})
				failed++
			}
		}
	}
	resolveStatus(&c, failed, warned, relevant, relevant, 0, nil)
	return c
}

// controlResourceLimits — RESOURCES-001. Every container should set CPU + memory limits.
func controlResourceLimits(resources []k8sResource) ControlResult {
	c := ControlResult{
		ID:         "RESOURCES-001",
		Title:      "Containers declare CPU + memory limits",
		Severity:   SeverityMedium,
		Provider:   "k8s",
		Frameworks: []string{"CIS-K8S-5.7"},
	}
	warned, relevant := 0, 0
	for _, r := range resources {
		ps, ok := podSpec(r)
		if !ok {
			continue
		}
		for _, ct := range containers(ps) {
			relevant++
			addr := r.kind + "/" + r.name + ":" + asString(ct["name"])
			res, _ := ct["resources"].(map[string]any)
			limits, _ := res["limits"].(map[string]any)
			if asString(limits["cpu"]) == "" || asString(limits["memory"]) == "" {
				c.Findings = append(c.Findings, Finding{Address: addr, Message: "missing CPU and/or memory limits"})
				warned++
			}
		}
	}
	resolveStatus(&c, 0, warned, relevant, relevant, 0, nil)
	return c
}

// controlHostAccess — HOSTACCESS-001. No hostNetwork/hostPID/hostIPC and no hostPath volumes.
func controlHostAccess(resources []k8sResource) ControlResult {
	c := ControlResult{
		ID:         "HOSTACCESS-001",
		Title:      "Pods do not access the host namespace or filesystem",
		Severity:   SeverityHigh,
		Provider:   "k8s",
		Frameworks: []string{"CIS-K8S-5.2", "NSA-Kubernetes"},
	}
	failed, relevant := 0, 0
	for _, r := range resources {
		ps, ok := podSpec(r)
		if !ok {
			continue
		}
		relevant++
		addr := r.kind + "/" + r.name
		for _, hk := range []string{"hostNetwork", "hostPID", "hostIPC"} {
			if b, ok := boolField(ps, hk); ok && b {
				c.Findings = append(c.Findings, Finding{Address: addr, Message: "sets " + hk + ": true"})
				failed++
			}
		}
		if vols, ok := ps["volumes"].([]any); ok {
			for _, v := range vols {
				if vm, ok := v.(map[string]any); ok {
					if _, has := vm["hostPath"]; has {
						c.Findings = append(c.Findings, Finding{Address: addr, Message: "mounts a hostPath volume " + asString(vm["name"])})
						failed++
					}
				}
			}
		}
	}
	resolveStatus(&c, failed, 0, relevant, relevant, 0, nil)
	return c
}

// controlRBAC — RBAC-001. No wildcard ClusterRole rules and no bindings to
// system:anonymous / system:unauthenticated.
func controlRBAC(resources []k8sResource) ControlResult {
	c := ControlResult{
		ID:         "RBAC-001",
		Title:      "No wildcard RBAC or anonymous bindings",
		Severity:   SeverityHigh,
		Provider:   "k8s",
		Frameworks: []string{"CIS-K8S-5.1", "SOC2-CC6.3"},
	}
	failed, relevant := 0, 0
	for _, r := range resources {
		switch r.kind {
		case "ClusterRole", "Role":
			relevant++
			if rules, ok := r.raw["rules"].([]any); ok {
				for _, rule := range rules {
					rm, ok := rule.(map[string]any)
					if !ok {
						continue
					}
					if hasStar(rm["verbs"]) && hasStar(rm["resources"]) && hasStar(rm["apiGroups"]) {
						c.Findings = append(c.Findings, Finding{Address: r.kind + "/" + r.name, Message: `grants "*" verbs on "*" resources in "*" apiGroups (cluster-admin-equivalent)`})
						failed++
					}
				}
			}
		case "ClusterRoleBinding", "RoleBinding":
			relevant++
			if subs, ok := r.raw["subjects"].([]any); ok {
				for _, s := range subs {
					sm, ok := s.(map[string]any)
					if !ok {
						continue
					}
					n := asString(sm["name"])
					if n == "system:anonymous" || n == "system:unauthenticated" {
						c.Findings = append(c.Findings, Finding{Address: r.kind + "/" + r.name, Message: "binds a role to " + n})
						failed++
					}
				}
			}
		}
	}
	resolveStatus(&c, failed, 0, relevant, relevant, 0, nil)
	return c
}

// ── small helpers ───────────────────────────────────────────────────

func boolField(m map[string]any, key string) (bool, bool) {
	if m == nil {
		return false, false
	}
	b, ok := m[key].(bool)
	return b, ok
}

// runsAsRoot reports whether the container/pod pins runAsUser to 0.
func runsAsRoot(containerSC, podSC map[string]any) bool {
	for _, sc := range []map[string]any{containerSC, podSC} {
		if sc == nil {
			continue
		}
		if u, ok := sc["runAsUser"]; ok {
			if asInt(u) == 0 {
				return true
			}
		}
	}
	return false
}

// runAsNonRootSet reports whether runAsNonRoot:true is set at container or pod level.
func runAsNonRootSet(containerSC, podSC map[string]any) bool {
	for _, sc := range []map[string]any{containerSC, podSC} {
		if b, ok := boolField(sc, "runAsNonRoot"); ok && b {
			return true
		}
	}
	return false
}

func hasStar(v any) bool {
	list, ok := v.([]any)
	if !ok {
		return false
	}
	for _, e := range list {
		if asString(e) == "*" {
			return true
		}
	}
	return false
}

func asInt(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case int64:
		return int(n)
	case float64:
		return int(n)
	}
	return -1
}

// lastSegment returns the part after the final "/" (to test the image ref's tag).
func lastSegment(image string) string {
	if i := strings.LastIndex(image, "/"); i >= 0 {
		return image[i+1:]
	}
	return image
}
