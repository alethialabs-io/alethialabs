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
	"github.com/alethialabs-io/alethialabs/packages/core/nodekeys"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// karpenterNodeClassName is the fixed name shared by the EC2NodeClass, the default NodePool and
// every NodePool's nodeClassRef. One EC2NodeClass serves both pools: its `al2023@latest` alias
// resolves to the AMI of whichever architecture a NodePool launches.
const karpenterNodeClassName = "default"

// karpenterArm64NodePoolName names the arm64 (Graviton) NodePool beside the default one (#5534).
const karpenterArm64NodePoolName = "arm64"

// karpenterArm64Taint is the platform taint every arm64 NodePool carries (#5534). The images Alethia
// builds (kaniko) and the Deployments it generates are single-arch and pin no arch, so arm64 capacity
// must never take a pod that did not tolerate this taint. A user may not write an alethia.io key, so
// validate() would refuse it: the renderer adds it AFTER validation, and only to the arm64 pool.
var karpenterArm64Taint = karpenterTaint{Key: "alethia.io/arch", Value: "arm64", HasValue: true, Effect: "NoSchedule"}

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
	// Arm64 is the arm64 (Graviton) NodePool (#5534), or nil for none. Its platform taint is the
	// renderer's to add, so a caller cannot leave it out.
	Arm64 *karpenterNodePool
}

// karpenterManifestTemplate is the parsed manifest: the EC2NodeClass and one NodePool document per
// pool. Parsed once, at init, so a template that does not parse fails every test rather than one
// apply.
var karpenterManifestTemplate = template.Must(template.New("karpenter-nodeclass").
	Funcs(template.FuncMap{"quoteList": quoteList}).
	Parse(karpenterNodeClassTemplate + karpenterNodePoolTemplate))

// karpenterManifestData is what the manifest template executes over: the node class's facts and the
// NodePool documents, default first.
type karpenterManifestData struct {
	karpenterNodeClassData
	Docs []karpenterNodePoolDoc
}

// karpenterNodePoolDoc is the render context of one NodePool document.
type karpenterNodePoolDoc struct {
	Name      string
	NodeClass string
	Pool      karpenterNodePool
}

// CPULimit is the NodePool's limits.cpu as the decimal string the manifest quotes.
func (d karpenterNodePoolDoc) CPULimit() string {
	return strconv.Itoa(d.Pool.CPULimit)
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
{{ range .Docs }}---
{{ template "nodepool" . }}{{ end }}`

// karpenterNodePoolTemplate renders one NodePool. The default pool's document is byte-identical to
// the one the manifest carried before the arm64 pool existed (#5534): the golden in
// karpenter_nodepool_test.go pins it. PlatformTaints follow the user's taints and are never theirs.
const karpenterNodePoolTemplate = `{{ define "nodepool" }}apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: {{ .Name }}
spec:
  template:
{{- if .Pool.Labels }}
    metadata:
      labels:
{{- range .Pool.Labels }}
        {{ printf "%q" .Key }}: {{ printf "%q" .Value }}
{{- end }}
{{- end }}
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: {{ .NodeClass }}
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: {{ quoteList .Pool.CapacityTypes }}
        - key: kubernetes.io/arch
          operator: In
          values: {{ quoteList .Pool.Architectures }}
{{- if .Pool.InstanceCategories }}
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: {{ quoteList .Pool.InstanceCategories }}
{{- end }}
{{- if .Pool.InstanceFamilies }}
        - key: karpenter.k8s.aws/instance-family
          operator: In
          values: {{ quoteList .Pool.InstanceFamilies }}
{{- end }}
        - key: karpenter.k8s.aws/instance-generation
          operator: Gt
          values: ["2"]
{{- if or .Pool.Taints .Pool.PlatformTaints }}
      taints:
{{- range .Pool.Taints }}
        - key: {{ printf "%q" .Key }}
{{- if .HasValue }}
          value: {{ printf "%q" .Value }}
{{- end }}
          effect: {{ printf "%q" .Effect }}
{{- end }}
{{- range .Pool.PlatformTaints }}
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
{{ end }}`

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
//
// The arm64 NodePool (#5534), when data.Arm64 is set, is validated as the user's values and THEN given
// the platform taint alethia.io/arch=arm64:NoSchedule. No caller sets PlatformTaints: the renderer
// overwrites them on both pools, so the default pool never carries the arm64 taint and the arm64
// pool always does.
func renderKarpenterNodeClass(data karpenterNodeClassData) (string, error) {
	if err := data.NodePool.validate(); err != nil {
		return "", err
	}
	defaultPool := data.NodePool
	defaultPool.PlatformTaints = nil
	render := karpenterManifestData{
		karpenterNodeClassData: data,
		Docs:                   []karpenterNodePoolDoc{{Name: data.Name, NodeClass: data.Name, Pool: defaultPool}},
	}
	if data.Arm64 != nil {
		if err := data.Arm64.validateArm64(); err != nil {
			return "", err
		}
		arm64 := *data.Arm64
		arm64.PlatformTaints = []karpenterTaint{karpenterArm64Taint}
		render.Docs = append(render.Docs, karpenterNodePoolDoc{Name: karpenterArm64NodePoolName, NodeClass: data.Name, Pool: arm64})
	}
	var buf bytes.Buffer
	if err := karpenterManifestTemplate.Execute(&buf, render); err != nil {
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
	arm64, err := extractKarpenterArm64NodePool(outputs)
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
		Arm64:           arm64,
	})
	if err != nil {
		return err
	}

	fmt.Fprintln(stdout, "Applying Karpenter EC2NodeClass + NodePool (stamping classification/sweep-handle tags onto launched EC2)...")
	var lastErr error
	for attempt := 1; attempt <= 4; attempt++ {
		if lastErr = argocd.ApplyManifest(manifest, stdout, stderr); lastErr == nil {
			fmt.Fprintln(stdout, "Karpenter EC2NodeClass + NodePool applied.")
			if arm64 == nil {
				return removeKarpenterArm64NodePool(stdout, stderr)
			}
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

// deleteKarpenterNodePool deletes one Karpenter NodePool by name, if it exists, and waits for it to
// go. Karpenter's finalizer holds the NodePool until its nodes are drained and terminated, and a drain
// waits on PodDisruptionBudgets and termination grace periods, so the wait is 15 minutes, not the
// seconds an ordinary delete takes. A variable so the tests can see the call without a cluster.
var deleteKarpenterNodePool = func(name string, stdout, stderr io.Writer) error {
	cmd := fmt.Sprintf("kubectl delete nodepools.karpenter.sh %s --ignore-not-found --timeout=15m", name)
	return utils.ExecuteCommand(cmd, ".", nil, stdout, stderr)
}

// removeKarpenterArm64NodePool deletes the arm64 NodePool when the project no longer configures one
// (#5534). `kubectl apply` never prunes, so without this a pool the user switched off would keep
// launching Graviton nodes. Karpenter drains and terminates the pool's nodes when the NodePool goes;
// a cluster that never had one is unaffected (--ignore-not-found).
func removeKarpenterArm64NodePool(stdout, stderr io.Writer) error {
	if err := deleteKarpenterNodePool(karpenterArm64NodePoolName, stdout, stderr); err != nil {
		return fmt.Errorf("the arm64 Karpenter NodePool is no longer configured, and deleting it failed: %w", err)
	}
	return nil
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
	// PlatformTaints are the platform's, rendered after Taints and never validated as a user's: only
	// renderKarpenterNodeClass sets them (the arm64 taint, #5534).
	PlatformTaints []karpenterTaint
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
)

// The label and taint KEY and VALUE rules, and the reserved domains (kubernetes.io, k8s.io,
// karpenter.sh, karpenter.k8s.aws, each cloud's, and alethia.io), are packages/core/nodekeys: one
// definition shared with the template validations and the cross-cloud node-pool contract (#5533).

// karpenterMaxCPULimit is the highest limits.cpu a user may set. Karpenter launches EC2 outside
// OpenTofu, so no plan-time cost guard sees its fleet; this cap is the bound that remains.
const karpenterMaxCPULimit = 1000

// karpenterArm64Refusal says why the DEFAULT NodePool takes amd64 only. The managed node group is
// x86_64 and the images Alethia builds (kaniko) are single-arch amd64, so an arm64 node in the
// default pool would take any of them and crash it with `exec format error`. A taint would not help
// either: on the default pool it would strand every untolerated pod on the fixed-size managed group.
// arm64 belongs on the additional, tainted pool karpenter_arm64_nodepool creates (#5534).
const karpenterArm64Refusal = "the default Karpenter NodePool accepts amd64 only, because the managed node group is x86_64 and the images Alethia builds are amd64-only, so they would crash on an arm64 node with exec format error. arm64 needs a separate, tainted NodePool: set karpenter_arm64_nodepool instead"

// karpenterTaintEffects are the taint effects Kubernetes defines.
var karpenterTaintEffects = map[string]bool{"NoSchedule": true, "PreferNoSchedule": true, "NoExecute": true}

// karpenterNodePoolKeys are the attributes the template's karpenter_nodepool output carries. Any
// other attribute is refused rather than ignored: a setting the runner does not understand must not
// look applied.
var karpenterNodePoolKeys = map[string]bool{
	"capacity_types": true, "architectures": true, "instance_categories": true, "instance_families": true,
	"cpu_limit": true, "labels": true, "taints": true,
}

// validateQualifiedKey checks a label or taint key's syntax and lengths (nodekeys.ValidKey): a
// prefix of at most 253 characters whose dot-separated DNS labels are at most 63 each, and a name of
// at most 63.
func validateQualifiedKey(what, key string) error {
	if !nodekeys.ValidKey(key) {
		return fmt.Errorf("%s key %q is not a Kubernetes key: use [prefix/]name, with a DNS prefix of up to 253 characters (63 per label) and a name of up to 63 letters, digits, '-', '_' or '.'", what, key)
	}
	return nil
}

// validateLabelValue checks a label or taint value's syntax and length (nodekeys.ValidValue).
func validateLabelValue(what, key, value string) error {
	if !nodekeys.ValidValue(value) {
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
// every value it accepts is one the template's variable validations accept too. It refuses every
// alethia.io key, because a user may not write one, so a platform-owned label or taint (#5534's
// alethia.io/arch=arm64:NoSchedule on an arm64 NodePool) is added AFTER validate() has passed on the
// user's values, never fed through it.
func (p karpenterNodePool) validate() error {
	for _, a := range p.Architectures {
		if a == "arm64" {
			return fmt.Errorf("karpenter architecture \"arm64\" is refused: %s", karpenterArm64Refusal)
		}
	}
	if err := validateEnumList("architecture", p.Architectures, "amd64"); err != nil {
		return err
	}
	return p.validateShared()
}

// karpenterGravitonFamily is a Graviton (arm64) EC2 instance family or type: a1 (Graviton 1), or a
// "g" right after the generation digit (m7g, c7gn, t4g, r8gd). The template applies the same literal
// to karpenter_arm64_nodepool and extra_node_pools; TestKarpenterArm64_GravitonRuleIsTheTemplates
// holds the three equal.
var karpenterGravitonFamily = regexp.MustCompile(`^(a1([.]|$)|[a-z]+[0-9]+g)`)

// validateArm64 applies the template's rules to the arm64 NodePool's settings (#5534): exactly the
// arm64 architecture, Graviton families only, and every rule the default pool has. Like validate(),
// it refuses an alethia.io key, so the platform taint is added after it, never fed through it.
func (p karpenterNodePool) validateArm64() error {
	if len(p.Architectures) != 1 || p.Architectures[0] != "arm64" {
		return fmt.Errorf("the arm64 Karpenter NodePool must launch exactly the arm64 architecture, not %s", quoteList(p.Architectures))
	}
	for _, f := range p.InstanceFamilies {
		if f == "a1" {
			return fmt.Errorf("karpenter arm64 instance family \"a1\" is refused: the NodePool requires instance generation 3 or later, so a1 (Graviton 1) could never launch")
		}
		if !karpenterGravitonFamily.MatchString(f) {
			return fmt.Errorf("karpenter arm64 instance family %q is not a Graviton family: use one such as \"m7g\", \"c7gn\", \"t4g\" or \"a1\"", f)
		}
	}
	return p.validateShared()
}

// validateShared applies the rules both NodePools share: capacity types, categories, families, the
// CPU limit, and the label and taint keys and values.
func (p karpenterNodePool) validateShared() error {
	if err := validateEnumList("capacity type", p.CapacityTypes, "spot", "on-demand"); err != nil {
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
	if p.CPULimit < 1 || p.CPULimit > karpenterMaxCPULimit {
		return fmt.Errorf("karpenter cpu limit %d is out of range: use a whole number of vCPU from 1 to %d", p.CPULimit, karpenterMaxCPULimit)
	}
	for _, l := range p.Labels {
		if err := validateQualifiedKey("karpenter node label", l.Key); err != nil {
			return err
		}
		if d, reserved := nodekeys.ReservedDomain(l.Key); reserved && !nodekeys.IsNodeRestrictionDomain(d) {
			return fmt.Errorf("karpenter node label %q uses the reserved domain %q: Kubernetes, Karpenter, the clouds and Alethia own labels whose prefix ends in %s (node-restriction.kubernetes.io/ is allowed)", l.Key, d, nodekeys.ReservedDomainsText())
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
		if d, reserved := nodekeys.ReservedDomain(t.Key); reserved {
			return fmt.Errorf("karpenter node taint %q uses the reserved domain %q: Kubernetes, Karpenter, the clouds and Alethia set taints whose prefix ends in %s themselves (alethia.io/arch marks arm64 capacity)", t.Key, d, nodekeys.ReservedDomainsText())
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

// stringList decodes a JSON list of strings from a tofu output attribute; name is the attribute's
// full path ("karpenter_nodepool.capacity_types").
func stringList(name string, raw interface{}) ([]string, error) {
	items, ok := raw.([]interface{})
	if !ok {
		return nil, fmt.Errorf("%s is not a list", name)
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		s, ok := item.(string)
		if !ok {
			return nil, fmt.Errorf("%s holds a non-string entry", name)
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
	pool, _, err := parseKarpenterNodePoolOutput(outputs, "karpenter_nodepool", defaultKarpenterNodePool())
	if err != nil {
		return pool, err
	}
	if err := pool.validate(); err != nil {
		return pool, fmt.Errorf("the karpenter_nodepool output is invalid: %w", err)
	}
	return pool, nil
}

// extractKarpenterArm64NodePool reads the template's `karpenter_arm64_nodepool` output (#5534). It
// returns nil when the output is absent or null: the project configured no arm64 pool, or its state
// predates one. Like extractKarpenterNodePool it refuses a malformed or unknown attribute, and it
// validates the values (validateArm64) before returning them. The platform taint is not among them:
// renderKarpenterNodeClass adds it.
func extractKarpenterArm64NodePool(outputs map[string]interface{}) (*karpenterNodePool, error) {
	defaults := defaultKarpenterNodePool()
	defaults.Architectures = []string{"arm64"}
	pool, present, err := parseKarpenterNodePoolOutput(outputs, "karpenter_arm64_nodepool", defaults)
	if err != nil || !present {
		return nil, err
	}
	if err := pool.validateArm64(); err != nil {
		return nil, fmt.Errorf("the karpenter_arm64_nodepool output is invalid: %w", err)
	}
	return &pool, nil
}

// parseKarpenterNodePoolOutput decodes the NodePool settings object in outputs[key] over pool, the
// defaults for every attribute it omits. present is false when the output is absent or null. It
// checks shapes only; the caller validates the values.
func parseKarpenterNodePoolOutput(outputs map[string]interface{}, key string, pool karpenterNodePool) (karpenterNodePool, bool, error) {
	raw, ok := outputs[key]
	if !ok || raw == nil {
		return pool, false, nil
	}
	m, ok := raw.(map[string]interface{})
	if !ok {
		return pool, false, fmt.Errorf("the %s output is not an object", key)
	}
	if inner, wrapped := m["value"]; wrapped && len(m) == 1 {
		// The defensive `{"value": …}` wrapped form extractStringTagMap also accepts.
		if inner == nil {
			return pool, false, nil
		}
		if m, ok = inner.(map[string]interface{}); !ok {
			return pool, false, fmt.Errorf("the %s output is not an object", key)
		}
	}

	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if !karpenterNodePoolKeys[k] {
			return pool, true, fmt.Errorf("the %s output carries %q, which this runner does not know how to apply", key, k)
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
			if *l.dst, err = stringList(key+"."+l.key, v); err != nil {
				return pool, true, err
			}
		}
	}

	if v, ok := m["cpu_limit"]; ok && v != nil {
		n, isNum := v.(float64)
		if !isNum || n != float64(int(n)) {
			return pool, true, fmt.Errorf("%s.cpu_limit %v is not a whole number", key, v)
		}
		pool.CPULimit = int(n)
	}

	if v, ok := m["labels"]; ok && v != nil {
		lm, isMap := v.(map[string]interface{})
		if !isMap {
			return pool, true, fmt.Errorf("%s.labels is not a map", key)
		}
		labels := make(map[string]string, len(lm))
		for k, lv := range lm {
			s, isStr := lv.(string)
			if !isStr {
				return pool, true, fmt.Errorf("%s.labels[%q] is not a string", key, k)
			}
			labels[k] = s
		}
		pool.Labels = sortedTagPairs(labels)
	}

	if v, ok := m["taints"]; ok && v != nil {
		items, isList := v.([]interface{})
		if !isList {
			return pool, true, fmt.Errorf("%s.taints is not a list", key)
		}
		for i, item := range items {
			tm, isMap := item.(map[string]interface{})
			if !isMap {
				return pool, true, fmt.Errorf("%s.taints[%d] is not an object", key, i)
			}
			var taint karpenterTaint
			for k, tv := range tm {
				switch k {
				case "key", "effect":
					s, isStr := tv.(string)
					if !isStr {
						return pool, true, fmt.Errorf("%s.taints[%d].%s is not a string", key, i, k)
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
						return pool, true, fmt.Errorf("%s.taints[%d].value is not a string", key, i)
					}
					taint.Value, taint.HasValue = s, true
				default:
					return pool, true, fmt.Errorf("%s.taints[%d] carries %q, which this runner does not know how to apply", key, i, k)
				}
			}
			pool.Taints = append(pool.Taints, taint)
		}
	}

	return pool, true, nil
}
