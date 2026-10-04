// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"text/template"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
)

// karpenterNodeClassName is the fixed name shared by the EC2NodeClass and the NodePool's
// nodeClassRef. A single default node class/pool is all the platform provisions today.
const karpenterNodeClassName = "default"

// kvPair is a sorted key/value tag entry — a map ranged in text/template iterates in
// non-deterministic order, so tags are pre-sorted into a slice for a stable render (golden tests).
type kvPair struct {
	Key   string
	Value string
}

// karpenterNodeClassData is the render context for the EC2NodeClass + NodePool manifest.
type karpenterNodeClassData struct {
	Name            string
	Role            string   // node_iam_role_name — the instance profile role Karpenter nodes assume
	SubnetIDs       []string // subnet1/2/3 selected by ID (the karpenter.sh/discovery tag is NOT on subnets)
	SecurityGroupID string   // node_security_group selected by ID
	Tags            []kvPair // karpenter_node_tags — classification + sweep-handle tags stamped on launched EC2/EBS
	NodePool        karpenterNodePool
}

// CPULimit is the NodePool's limits.cpu as the decimal string the manifest quotes.
func (d karpenterNodeClassData) CPULimit() string {
	return strconv.Itoa(d.NodePool.CPULimit)
}

// karpenterNodeClassTemplate renders a Karpenter v1 EC2NodeClass + NodePool. Both CRs use the
// 1.x GA apiVersions (karpenter.k8s.aws/v1 and karpenter.sh/v1). spec.tags on the EC2NodeClass is
// THE POINT of this renderer: Karpenter launches instances via its own ec2:CreateFleet/RunInstances
// calls, so the OpenTofu provider default_tags never reach them — only these tags do (gap G2, the
// CSI-PVC / orphan-instance sweep-handle leak class).
const karpenterNodeClassTemplate = `apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: {{ .Name }}
spec:
  role: {{ .Role }}
  amiSelectorTerms:
    - alias: al2023@latest
  subnetSelectorTerms:
{{- range .SubnetIDs }}
    - id: {{ . }}
{{- end }}
  securityGroupSelectorTerms:
    - id: {{ .SecurityGroupID }}
  tags:
{{- range .Tags }}
    {{ printf "%q" .Key }}: {{ printf "%q" .Value }}
{{- end }}
---
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: {{ .Name }}
spec:
  template:
{{- if .NodePool.Labels }}
    metadata:
      labels:
{{- range .NodePool.Labels }}
        {{ printf "%q" .Key }}: {{ printf "%q" .Value }}
{{- end }}
{{- end }}
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: {{ .Name }}
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: {{ quoteList .NodePool.CapacityTypes }}
        - key: kubernetes.io/arch
          operator: In
          values: {{ quoteList .NodePool.Architectures }}
{{- if .NodePool.InstanceCategories }}
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: {{ quoteList .NodePool.InstanceCategories }}
{{- end }}
{{- if .NodePool.InstanceFamilies }}
        - key: karpenter.k8s.aws/instance-family
          operator: In
          values: {{ quoteList .NodePool.InstanceFamilies }}
{{- end }}
        - key: karpenter.k8s.aws/instance-generation
          operator: Gt
          values: ["2"]
{{- if .NodePool.Taints }}
      taints:
{{- range .NodePool.Taints }}
        - key: {{ printf "%q" .Key }}
{{- if .HasValue }}
          value: {{ printf "%q" .Value }}
{{- end }}
          effect: {{ printf "%q" .Effect }}
{{- end }}
{{- end }}
  limits:
    cpu: {{ printf "%q" .CPULimit }}
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 1m
`

// quoteList renders a string list as a YAML flow sequence of double-quoted scalars — `["a", "b"]`,
// the exact shape the NodePool requirements were written in before they were configurable, so the
// default render stays byte-identical. Every element goes through %q: no user string is ever
// spliced into the manifest raw.
func quoteList(values []string) string {
	quoted := make([]string, len(values))
	for i, v := range values {
		quoted[i] = strconv.Quote(v)
	}
	return "[" + strings.Join(quoted, ", ") + "]"
}

// renderKarpenterNodeClass renders the EC2NodeClass + NodePool manifest from the provisioned-infra
// facts. Kept separate from the apply so the golden tests can assert the exact YAML. It re-validates
// the NodePool settings itself, so no caller can render a value the template would have refused.
func renderKarpenterNodeClass(data karpenterNodeClassData) (string, error) {
	if err := data.NodePool.validate(); err != nil {
		return "", err
	}
	tmpl, err := template.New("karpenter-nodeclass").Funcs(template.FuncMap{"quoteList": quoteList}).Parse(karpenterNodeClassTemplate)
	if err != nil {
		return "", fmt.Errorf("failed to parse karpenter template: %w", err)
	}
	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, data); err != nil {
		return "", fmt.Errorf("failed to render karpenter manifest: %w", err)
	}
	return buf.String(), nil
}

// extractStringTagMap pulls a `map(string)` OpenTofu output (e.g. karpenter_node_tags) as a
// map[string]string. argocd.ExtractOutput is string-only (returns "" for a map), so map outputs
// need this. Handles both the unwrapped value (how tofu.Output stores it) and the defensive
// `{"value": {...}}` wrapped form. Returns nil when the output is absent/null/not-a-map.
func extractStringTagMap(outputs map[string]interface{}, key string) map[string]string {
	raw, ok := outputs[key]
	if !ok || raw == nil {
		return nil
	}
	m, ok := raw.(map[string]interface{})
	if !ok {
		return nil
	}
	if inner, ok := m["value"].(map[string]interface{}); ok {
		m = inner
	}
	out := make(map[string]string, len(m))
	for k, v := range m {
		if s, ok := v.(string); ok {
			out[k] = s
		}
	}
	return out
}

// sortedTagPairs turns a tag map into a key-sorted slice for a deterministic render.
func sortedTagPairs(tags map[string]string) []kvPair {
	keys := make([]string, 0, len(tags))
	for k := range tags {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	pairs := make([]kvPair, 0, len(keys))
	for _, k := range keys {
		pairs = append(pairs, kvPair{Key: k, Value: tags[k]})
	}
	return pairs
}

// applyKarpenterNodeClass renders and applies the Karpenter EC2NodeClass + NodePool after the
// ArgoCD infra Applications (karpenter installs on sync-wave 2). It is a no-op unless the cluster
// is AWS and Karpenter is enabled. The apply RETRIES: Karpenter's CRDs (ec2nodeclasses /
// nodepools) land ASYNCHRONOUSLY via ArgoCD sync, so the first apply typically races ahead of the
// CRDs — the loop (mirroring applyBootstrapManifests) waits for them to register.
func applyKarpenterNodeClass(ctx context.Context, outputs map[string]interface{}, facts *argocd.InfraFacts, stdout, stderr io.Writer) error {
	if facts == nil || facts.Provider != "aws" || !facts.EnableKarpenter {
		return nil // not an AWS+Karpenter cluster — nothing to stamp
	}

	role := argocd.ExtractOutput(outputs, "node_iam_role_name")
	sg := argocd.ExtractOutput(outputs, "node_security_group")
	subnets := make([]string, 0, 3)
	for _, key := range []string{"subnet1", "subnet2", "subnet3"} {
		if id := argocd.ExtractOutput(outputs, key); id != "" {
			subnets = append(subnets, id)
		}
	}
	tags := extractStringTagMap(outputs, "karpenter_node_tags")
	nodePool, err := extractKarpenterNodePool(outputs)
	if err != nil {
		return err
	}

	// Fail loudly if the selectors the node class needs are missing — an EC2NodeClass without a
	// role/subnets/SG can never launch a node, and silently applying it would look healthy while
	// the fleet never scales.
	var missing []string
	if role == "" {
		missing = append(missing, "node_iam_role_name")
	}
	if sg == "" {
		missing = append(missing, "node_security_group")
	}
	if len(subnets) == 0 {
		missing = append(missing, "subnet1/2/3")
	}
	if len(missing) > 0 {
		return fmt.Errorf("cannot render Karpenter EC2NodeClass — missing required outputs: %s", strings.Join(missing, ", "))
	}
	// The sweep-handle tags are the whole reason this renderer exists (gap G2). Their absence is a
	// template/plumbing defect (the checks.tf invariant guarantees the output carries them when
	// Karpenter is on), so refuse rather than launch untagged, sweeper-invisible EC2.
	if len(tags) == 0 {
		return fmt.Errorf("cannot render Karpenter EC2NodeClass — the karpenter_node_tags output is empty; Karpenter-launched EC2 would escape the environment-scoped sweeper")
	}

	manifest, err := renderKarpenterNodeClass(karpenterNodeClassData{
		Name:            karpenterNodeClassName,
		Role:            role,
		SubnetIDs:       subnets,
		SecurityGroupID: sg,
		Tags:            sortedTagPairs(tags),
		NodePool:        nodePool,
	})
	if err != nil {
		return err
	}

	fmt.Fprintln(stdout, "Applying Karpenter EC2NodeClass + NodePool (stamping classification/sweep-handle tags onto launched EC2)...")
	var lastErr error
	for attempt := 1; attempt <= 4; attempt++ {
		if lastErr = argocd.ApplyManifest(manifest, stdout, stderr); lastErr == nil {
			fmt.Fprintln(stdout, "Karpenter EC2NodeClass + NodePool applied.")
			return nil
		}
		fmt.Fprintf(stderr, "Karpenter node class apply attempt %d/4 failed (CRDs not synced yet): %v\n", attempt, lastErr)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(15 * time.Second):
		}
	}
	return fmt.Errorf("kubectl apply of Karpenter node class failed after retries: %w", lastErr)
}

// ── The NodePool settings (#5527) ────────────────────────────────────────────────────────────────
//
// The template's karpenter_* variables (infra/templates/project/aws/variables.tf) reach the runner as
// ONE object output, `karpenter_nodepool`. The template validates every value at plan; this file
// validates them AGAIN, with the same rules, because the manifest is applied with cluster-admin
// rights and a check that lives only in tofu is bypassed by a hand-edited state or output.

// karpenterTaint is one NodePool taint. HasValue separates an absent value (a key-only taint) from
// an empty one, so the render never invents a `value: ""` the user did not write.
type karpenterTaint struct {
	Key      string
	Value    string
	HasValue bool
	Effect   string
}

// karpenterNodePool is the user-configurable part of the NodePool.
type karpenterNodePool struct {
	CapacityTypes      []string
	Architectures      []string
	InstanceCategories []string // empty → no instance-category requirement
	InstanceFamilies   []string // empty → no instance-family requirement
	CPULimit           int
	Labels             []kvPair // key-sorted for a deterministic render
	Taints             []karpenterTaint
}

// defaultKarpenterNodePool returns the NodePool every Karpenter cluster got before #5527, and still
// gets when the template sets nothing: on-demand amd64 t/m instances, capped at 100 vCPU. The cap is
// the only bound on Karpenter's fleet — it launches EC2 out of band of OpenTofu, so no plan-time cost
// ceiling sees it.
func defaultKarpenterNodePool() karpenterNodePool {
	return karpenterNodePool{
		CapacityTypes:      []string{"on-demand"},
		Architectures:      []string{"amd64"},
		InstanceCategories: []string{"t", "m"},
		InstanceFamilies:   []string{},
		CPULimit:           100,
	}
}

var (
	// karpenterCategoryPattern is an EC2 instance category: the letters before the generation.
	karpenterCategoryPattern = regexp.MustCompile(`^[a-z]{1,8}$`)
	// karpenterFamilyPattern is an EC2 instance family such as c7g or m7i-flex.
	karpenterFamilyPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,15}$`)
	// k8sQualifiedKeyPattern is a Kubernetes label/taint key: an optional DNS-subdomain prefix and a
	// name of at most 63 characters.
	k8sQualifiedKeyPattern = regexp.MustCompile(`^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$`)
	// k8sLabelValuePattern is a Kubernetes label (and taint) value; length is checked separately.
	k8sLabelValuePattern = regexp.MustCompile(`^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$`)
	// reservedKeyDomainPattern matches a key prefix in a domain Kubernetes or Karpenter owns. There is
	// deliberately NO dot boundary: Karpenter's NodePool CRD tests `endsWith("kubernetes.io")` on the
	// prefix, so `examplekubernetes.io/x` is refused at apply, and this guard must refuse it at plan.
	reservedKeyDomainPattern = regexp.MustCompile(`(kubernetes\.io|k8s\.io|karpenter\.sh|karpenter\.k8s\.aws)$`)
	// labelDomainExceptionPattern is the one reserved subdomain a user label may use. Kubernetes
	// documents node-restriction.kubernetes.io/ for exactly this (labels a kubelet cannot set on its
	// own node), and Karpenter's NodePool CRD admits it. node-role.kubernetes.io is NOT admitted.
	labelDomainExceptionPattern = regexp.MustCompile(`(^|\.)node-restriction\.kubernetes\.io$`)
)

// karpenterTaintEffects are the taint effects Kubernetes defines.
var karpenterTaintEffects = map[string]bool{"NoSchedule": true, "PreferNoSchedule": true, "NoExecute": true}

// karpenterNodePoolKeys are the attributes the template's karpenter_nodepool output carries. Any
// other attribute is refused rather than ignored: a setting the runner does not understand must not
// look applied.
var karpenterNodePoolKeys = map[string]bool{
	"capacity_types": true, "architectures": true, "instance_categories": true, "instance_families": true,
	"cpu_limit": true, "labels": true, "taints": true,
}

// keyDomain returns the prefix of a qualified key ("example.com" for "example.com/gpu"), or "" when
// the key has none.
func keyDomain(key string) string {
	if i := strings.Index(key, "/"); i >= 0 {
		return key[:i]
	}
	return ""
}

// validateQualifiedKey checks a label or taint key's syntax and lengths: a prefix of at most 253
// characters whose dot-separated DNS labels are at most 63 each, and a name of at most 63 (the
// pattern bounds the name).
func validateQualifiedKey(what, key string) error {
	bad := !k8sQualifiedKeyPattern.MatchString(key)
	if prefix := keyDomain(key); !bad && prefix != "" {
		bad = len(prefix) > 253
		for _, label := range strings.Split(prefix, ".") {
			bad = bad || len(label) > 63
		}
	}
	if bad {
		return fmt.Errorf("%s key %q is not a Kubernetes key: use [prefix/]name, with a DNS prefix of up to 253 characters (63 per label) and a name of up to 63 letters, digits, '-', '_' or '.'", what, key)
	}
	return nil
}

// validateLabelValue checks a label or taint value's syntax and length.
func validateLabelValue(what, key, value string) error {
	if len(value) > 63 || !k8sLabelValuePattern.MatchString(value) {
		return fmt.Errorf("%s %q has value %q: use up to 63 letters, digits, '-', '_' or '.', starting and ending with a letter or digit", what, key, value)
	}
	return nil
}

// validateEnumList checks that a list is non-empty, has no duplicates and holds only allowed values.
func validateEnumList(name string, values []string, allowed ...string) error {
	if len(values) == 0 {
		return fmt.Errorf("karpenter %s is empty: list at least one of %s", name, strings.Join(allowed, ", "))
	}
	seen := map[string]bool{}
	for _, v := range values {
		ok := false
		for _, a := range allowed {
			ok = ok || v == a
		}
		if !ok {
			return fmt.Errorf("karpenter %s %q is not allowed: use %s", name, v, strings.Join(allowed, ", "))
		}
		if seen[v] {
			return fmt.Errorf("karpenter %s lists %q twice", name, v)
		}
		seen[v] = true
	}
	return nil
}

// validatePatternList checks that a list has no duplicates and that every entry matches pattern.
func validatePatternList(name string, values []string, pattern *regexp.Regexp, example string) error {
	seen := map[string]bool{}
	for _, v := range values {
		if !pattern.MatchString(v) {
			return fmt.Errorf("karpenter %s %q is not valid: use lowercase EC2 names such as %s", name, v, example)
		}
		if seen[v] {
			return fmt.Errorf("karpenter %s lists %q twice", name, v)
		}
		seen[v] = true
	}
	return nil
}

// validate applies the template's rules to the NodePool settings. It is the renderer's own guard:
// every value it accepts is one the template's variable validations accept too.
func (p karpenterNodePool) validate() error {
	if err := validateEnumList("capacity type", p.CapacityTypes, "spot", "on-demand"); err != nil {
		return err
	}
	if err := validateEnumList("architecture", p.Architectures, "amd64", "arm64"); err != nil {
		return err
	}
	if err := validatePatternList("instance category", p.InstanceCategories, karpenterCategoryPattern, `"c", "m" or "r"`); err != nil {
		return err
	}
	if err := validatePatternList("instance family", p.InstanceFamilies, karpenterFamilyPattern, `"c7g" or "m7i-flex"`); err != nil {
		return err
	}
	if len(p.InstanceCategories) > 0 {
		for _, f := range p.InstanceFamilies {
			inCategory := false
			for _, c := range p.InstanceCategories {
				inCategory = inCategory || strings.HasPrefix(f, c)
			}
			if !inCategory {
				return fmt.Errorf("karpenter instance family %q belongs to none of the instance categories %s, so Karpenter could launch no instance: add its category or clear the categories", f, quoteList(p.InstanceCategories))
			}
		}
	}
	if p.CPULimit < 1 || p.CPULimit > 10000 {
		return fmt.Errorf("karpenter cpu limit %d is out of range: use a whole number of vCPU from 1 to 10000", p.CPULimit)
	}
	for _, l := range p.Labels {
		if err := validateQualifiedKey("karpenter node label", l.Key); err != nil {
			return err
		}
		if d := keyDomain(l.Key); reservedKeyDomainPattern.MatchString(d) && !labelDomainExceptionPattern.MatchString(d) {
			return fmt.Errorf("karpenter node label %q uses the reserved domain %q: Kubernetes and Karpenter own kubernetes.io, k8s.io, karpenter.sh and karpenter.k8s.aws labels (node-restriction.kubernetes.io/ is allowed)", l.Key, d)
		}
		if err := validateLabelValue("karpenter node label", l.Key, l.Value); err != nil {
			return err
		}
	}
	seenTaints := map[string]bool{}
	for _, t := range p.Taints {
		if err := validateQualifiedKey("karpenter node taint", t.Key); err != nil {
			return err
		}
		if d := keyDomain(t.Key); reservedKeyDomainPattern.MatchString(d) {
			return fmt.Errorf("karpenter node taint %q uses the reserved domain %q: Kubernetes and Karpenter set kubernetes.io, k8s.io, karpenter.sh and karpenter.k8s.aws taints themselves", t.Key, d)
		}
		if t.HasValue {
			if err := validateLabelValue("karpenter node taint", t.Key, t.Value); err != nil {
				return err
			}
		}
		if !karpenterTaintEffects[t.Effect] {
			return fmt.Errorf("karpenter node taint %q has effect %q: use NoSchedule, PreferNoSchedule or NoExecute", t.Key, t.Effect)
		}
		pair := t.Key + ":" + t.Effect
		if seenTaints[pair] {
			return fmt.Errorf("karpenter node taint %q with effect %s is listed twice", t.Key, t.Effect)
		}
		seenTaints[pair] = true
	}
	return nil
}

// stringList decodes a JSON list of strings from a tofu output attribute.
func stringList(name string, raw interface{}) ([]string, error) {
	items, ok := raw.([]interface{})
	if !ok {
		return nil, fmt.Errorf("karpenter_nodepool.%s is not a list", name)
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		s, ok := item.(string)
		if !ok {
			return nil, fmt.Errorf("karpenter_nodepool.%s holds a non-string entry", name)
		}
		out = append(out, s)
	}
	return out, nil
}

// extractKarpenterNodePool reads the template's `karpenter_nodepool` output. When the output is
// absent or null — state written by a template from before #5527 — it returns the defaults, so an
// existing cluster keeps the NodePool it has. An attribute the object omits keeps its default too.
// A malformed or unknown attribute is an ERROR, never a silent default: a setting that does not take
// effect must not look as if it did. The values are validated before they are returned.
func extractKarpenterNodePool(outputs map[string]interface{}) (karpenterNodePool, error) {
	pool := defaultKarpenterNodePool()
	raw, ok := outputs["karpenter_nodepool"]
	if !ok || raw == nil {
		return pool, nil
	}
	m, ok := raw.(map[string]interface{})
	if !ok {
		return pool, fmt.Errorf("the karpenter_nodepool output is not an object")
	}
	if inner, wrapped := m["value"]; wrapped && len(m) == 1 {
		// The defensive `{"value": …}` wrapped form extractStringTagMap also accepts.
		if inner == nil {
			return pool, nil
		}
		if m, ok = inner.(map[string]interface{}); !ok {
			return pool, fmt.Errorf("the karpenter_nodepool output is not an object")
		}
	}

	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if !karpenterNodePoolKeys[k] {
			return pool, fmt.Errorf("the karpenter_nodepool output carries %q, which this runner does not know how to apply", k)
		}
	}

	var err error
	lists := []struct {
		key string
		dst *[]string
	}{
		{"capacity_types", &pool.CapacityTypes},
		{"architectures", &pool.Architectures},
		{"instance_categories", &pool.InstanceCategories},
		{"instance_families", &pool.InstanceFamilies},
	}
	for _, l := range lists {
		if v, ok := m[l.key]; ok && v != nil {
			if *l.dst, err = stringList(l.key, v); err != nil {
				return pool, err
			}
		}
	}

	if v, ok := m["cpu_limit"]; ok && v != nil {
		n, isNum := v.(float64)
		if !isNum || n != float64(int(n)) {
			return pool, fmt.Errorf("karpenter_nodepool.cpu_limit %v is not a whole number", v)
		}
		pool.CPULimit = int(n)
	}

	if v, ok := m["labels"]; ok && v != nil {
		lm, isMap := v.(map[string]interface{})
		if !isMap {
			return pool, fmt.Errorf("karpenter_nodepool.labels is not a map")
		}
		labels := make(map[string]string, len(lm))
		for k, lv := range lm {
			s, isStr := lv.(string)
			if !isStr {
				return pool, fmt.Errorf("karpenter_nodepool.labels[%q] is not a string", k)
			}
			labels[k] = s
		}
		pool.Labels = sortedTagPairs(labels)
	}

	if v, ok := m["taints"]; ok && v != nil {
		items, isList := v.([]interface{})
		if !isList {
			return pool, fmt.Errorf("karpenter_nodepool.taints is not a list")
		}
		for i, item := range items {
			tm, isMap := item.(map[string]interface{})
			if !isMap {
				return pool, fmt.Errorf("karpenter_nodepool.taints[%d] is not an object", i)
			}
			var taint karpenterTaint
			for k, tv := range tm {
				switch k {
				case "key", "effect":
					s, isStr := tv.(string)
					if !isStr {
						return pool, fmt.Errorf("karpenter_nodepool.taints[%d].%s is not a string", i, k)
					}
					if k == "key" {
						taint.Key = s
					} else {
						taint.Effect = s
					}
				case "value":
					if tv == nil {
						continue
					}
					s, isStr := tv.(string)
					if !isStr {
						return pool, fmt.Errorf("karpenter_nodepool.taints[%d].value is not a string", i)
					}
					taint.Value, taint.HasValue = s, true
				default:
					return pool, fmt.Errorf("karpenter_nodepool.taints[%d] carries %q, which this runner does not know how to apply", i, k)
				}
			}
			pool.Taints = append(pool.Taints, taint)
		}
	}

	if err := pool.validate(); err != nil {
		return pool, fmt.Errorf("the karpenter_nodepool output is invalid: %w", err)
	}
	return pool, nil
}
