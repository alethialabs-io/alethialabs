// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"strings"
	"testing"
)

// preConfigurableKarpenterManifest is the manifest renderKarpenterNodeClass produced for
// awsOutputs() on origin/dev @ 7de07b4e8, before the NodePool was configurable (#5527) — captured by
// rendering that commit's template, not by rendering this one. A cluster that sets no knob must keep
// getting exactly this, byte for byte, or every existing Karpenter cluster sees a NodePool diff.
const preConfigurableKarpenterManifest = `apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: default
spec:
  role: alethia-eks-node-role
  amiSelectorTerms:
    - alias: al2023@latest
  subnetSelectorTerms:
    - id: subnet-aaa
    - id: subnet-bbb
    - id: subnet-ccc
  securityGroupSelectorTerms:
    - id: sg-0abc123
  tags:
    "Name": "alethia-demo-prod"
    "alethia:environment-id": "env-456"
    "alethia:project-id": "proj-123"
---
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: default
spec:
  template:
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: default
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["on-demand"]
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64"]
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["t", "m"]
        - key: karpenter.k8s.aws/instance-generation
          operator: Gt
          values: ["2"]
  limits:
    cpu: "100"
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 1m
`

// nodePoolOutputs returns awsOutputs() plus a karpenter_nodepool output, shaped as tofu.Output
// decodes it (JSON: lists are []interface{}, numbers float64, a null value is nil).
func nodePoolOutputs(nodePool map[string]interface{}) map[string]interface{} {
	out := awsOutputs()
	out["karpenter_nodepool"] = nodePool
	return out
}

// defaultNodePoolOutput is the karpenter_nodepool output the template emits when no knob is set.
func defaultNodePoolOutput() map[string]interface{} {
	return map[string]interface{}{
		"capacity_types":      []interface{}{"on-demand"},
		"architectures":       []interface{}{"amd64"},
		"instance_categories": []interface{}{"t", "m"},
		"instance_families":   []interface{}{},
		"cpu_limit":           float64(100),
		"labels":              map[string]interface{}{},
		"taints":              []interface{}{},
	}
}

// renderFromOutputs runs the runner's own read-then-render path over a tofu output map — the same two
// calls applyKarpenterNodeClass makes before it hands the manifest to kubectl.
func renderFromOutputs(t *testing.T, outputs map[string]interface{}) string {
	t.Helper()
	pool, err := extractKarpenterNodePool(outputs)
	if err != nil {
		t.Fatalf("extractKarpenterNodePool: %v", err)
	}
	manifest, err := renderKarpenterNodeClass(karpenterNodeClassData{
		Name:            karpenterNodeClassName,
		Role:            "alethia-eks-node-role",
		SubnetIDs:       []string{"subnet-aaa", "subnet-bbb", "subnet-ccc"},
		SecurityGroupID: "sg-0abc123",
		Tags:            sortedTagPairs(extractStringTagMap(outputs, "karpenter_node_tags")),
		NodePool:        pool,
	})
	if err != nil {
		t.Fatalf("renderKarpenterNodeClass: %v", err)
	}
	return manifest
}

// TestKarpenterNodePool_DefaultsRenderTodaysManifest pins the byte-identical promise twice: once for
// state from an older template (no karpenter_nodepool output at all) and once for the new template
// with every knob at its default.
func TestKarpenterNodePool_DefaultsRenderTodaysManifest(t *testing.T) {
	cases := map[string]map[string]interface{}{
		"no output (older template state)": awsOutputs(),
		"null output (Karpenter guard)":    nodePoolOutputs(nil),
		"output at every default":          nodePoolOutputs(defaultNodePoolOutput()),
		"wrapped output at every default":  nodePoolOutputs(map[string]interface{}{"value": defaultNodePoolOutput()}),
	}
	for name, outputs := range cases {
		t.Run(name, func(t *testing.T) {
			if got := renderFromOutputs(t, outputs); got != preConfigurableKarpenterManifest {
				t.Errorf("default render drifted from the pre-#5527 manifest:\n--- got ---\n%s\n--- want ---\n%s", got, preConfigurableKarpenterManifest)
			}
		})
	}
}

// TestKarpenterNodePool_EachKnobGolden sets one knob at a time and asserts the exact manifest: the
// pre-#5527 golden with only that knob's lines changed. A knob that leaks into another field, or one
// the render drops, shows as a diff.
func TestKarpenterNodePool_EachKnobGolden(t *testing.T) {
	cases := []struct {
		name string
		key  string
		val  interface{}
		from string // the pre-#5527 text this knob replaces
		to   string
	}{
		{
			name: "spot and on-demand in one In requirement",
			key:  "capacity_types", val: []interface{}{"spot", "on-demand"},
			from: `values: ["on-demand"]`, to: `values: ["spot", "on-demand"]`,
		},
		{
			name: "spot only",
			key:  "capacity_types", val: []interface{}{"spot"},
			from: `values: ["on-demand"]`, to: `values: ["spot"]`,
		},
		{
			name: "arm64",
			key:  "architectures", val: []interface{}{"arm64"},
			from: `values: ["amd64"]`, to: `values: ["arm64"]`,
		},
		{
			name: "instance categories",
			key:  "instance_categories", val: []interface{}{"c", "r"},
			from: `values: ["t", "m"]`, to: `values: ["c", "r"]`,
		},
		{
			name: "no instance categories drops the requirement",
			key:  "instance_categories", val: []interface{}{},
			from: "        - key: karpenter.k8s.aws/instance-category\n          operator: In\n          values: [\"t\", \"m\"]\n",
			to:   "",
		},
		{
			name: "instance families inside the default categories",
			key:  "instance_families", val: []interface{}{"m7g", "t4g"},
			from: "          values: [\"t\", \"m\"]\n",
			to:   "          values: [\"t\", \"m\"]\n        - key: karpenter.k8s.aws/instance-family\n          operator: In\n          values: [\"m7g\", \"t4g\"]\n",
		},
		{
			name: "cpu limit",
			key:  "cpu_limit", val: float64(400),
			from: `cpu: "100"`, to: `cpu: "400"`,
		},
		{
			name: "labels, key-sorted",
			key:  "labels", val: map[string]interface{}{"workload": "batch", "node-restriction.kubernetes.io/pool": "batch"},
			from: "  template:\n    spec:\n",
			to:   "  template:\n    metadata:\n      labels:\n        \"node-restriction.kubernetes.io/pool\": \"batch\"\n        \"workload\": \"batch\"\n    spec:\n",
		},
		{
			name: "taints, with and without a value",
			key:  "taints",
			val: []interface{}{
				map[string]interface{}{"key": "dedicated", "value": "batch", "effect": "NoSchedule"},
				map[string]interface{}{"key": "example.com/gpu", "value": nil, "effect": "NoExecute"},
			},
			from: "          values: [\"2\"]\n  limits:",
			to:   "          values: [\"2\"]\n      taints:\n        - key: \"dedicated\"\n          value: \"batch\"\n          effect: \"NoSchedule\"\n        - key: \"example.com/gpu\"\n          effect: \"NoExecute\"\n  limits:",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if strings.Count(preConfigurableKarpenterManifest, tc.from) != 1 {
				t.Fatalf("fixture error: %q must appear exactly once in the pre-#5527 manifest", tc.from)
			}
			want := strings.Replace(preConfigurableKarpenterManifest, tc.from, tc.to, 1)
			nodePool := defaultNodePoolOutput()
			nodePool[tc.key] = tc.val
			got := renderFromOutputs(t, nodePoolOutputs(nodePool))
			if got != want {
				t.Errorf("render with %s set:\n--- got ---\n%s\n--- want ---\n%s", tc.key, got, want)
			}
			nodes := decodeDocs(t, got)
			if len(nodes) != 2 {
				t.Fatalf("expected 2 YAML documents, got %d", len(nodes))
			}
		})
	}
}

// TestKarpenterNodePool_ArmSpotGolden is the documented example end to end: an arm64 Spot pool on
// Graviton c/m families with more headroom, labels and a taint — the whole NodePool, exactly.
func TestKarpenterNodePool_ArmSpotGolden(t *testing.T) {
	got := renderFromOutputs(t, nodePoolOutputs(map[string]interface{}{
		"capacity_types":      []interface{}{"spot", "on-demand"},
		"architectures":       []interface{}{"arm64"},
		"instance_categories": []interface{}{"c", "m"},
		"instance_families":   []interface{}{"c7g", "m7g"},
		"cpu_limit":           float64(400),
		"labels":              map[string]interface{}{"workload": "batch"},
		"taints":              []interface{}{map[string]interface{}{"key": "workload", "value": "batch", "effect": "NoSchedule"}},
	}))
	const wantNodePool = `apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: default
spec:
  template:
    metadata:
      labels:
        "workload": "batch"
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: default
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot", "on-demand"]
        - key: kubernetes.io/arch
          operator: In
          values: ["arm64"]
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["c", "m"]
        - key: karpenter.k8s.aws/instance-family
          operator: In
          values: ["c7g", "m7g"]
        - key: karpenter.k8s.aws/instance-generation
          operator: Gt
          values: ["2"]
      taints:
        - key: "workload"
          value: "batch"
          effect: "NoSchedule"
  limits:
    cpu: "400"
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 1m
`
	_, nodePool, found := strings.Cut(got, "---\n")
	if !found || nodePool != wantNodePool {
		t.Errorf("arm64 Spot NodePool:\n--- got ---\n%s\n--- want ---\n%s", nodePool, wantNodePool)
	}
	// And it is the YAML a Kubernetes API server would read: labels and taints at the right paths.
	np := findDoc(decodeDocs(t, got), "NodePool")
	tmpl, _ := np["spec"].(map[string]interface{})["template"].(map[string]interface{})
	labels, _ := tmpl["metadata"].(map[string]interface{})["labels"].(map[string]interface{})
	if labels["workload"] != "batch" {
		t.Errorf("spec.template.metadata.labels = %#v", labels)
	}
	taints, _ := tmpl["spec"].(map[string]interface{})["taints"].([]interface{})
	if len(taints) != 1 {
		t.Fatalf("spec.template.spec.taints = %#v", taints)
	}
}

// TestKarpenterNodePool_RendererRefusesWhatTheTemplateRefuses is the renderer's OWN guard: the
// manifest is applied with cluster-admin rights, so a value the template's validations would refuse
// must not render even when it reaches the runner some other way (a hand-edited state or output).
func TestKarpenterNodePool_RendererRefusesWhatTheTemplateRefuses(t *testing.T) {
	cases := []struct {
		name    string
		key     string
		val     interface{}
		wantErr string
	}{
		{"unknown capacity type", "capacity_types", []interface{}{"reserved"}, `capacity type "reserved" is not allowed`},
		{"empty capacity types", "capacity_types", []interface{}{}, "capacity type is empty"},
		{"duplicate capacity type", "capacity_types", []interface{}{"spot", "spot"}, `lists "spot" twice`},
		{"unknown architecture", "architectures", []interface{}{"x86_64"}, `architecture "x86_64" is not allowed`},
		{"malformed category", "instance_categories", []interface{}{"C"}, `instance category "C" is not valid`},
		{"malformed family", "instance_families", []interface{}{"c7g.large"}, `instance family "c7g.large" is not valid`},
		{"family outside every category", "instance_families", []interface{}{"c7g"}, `belongs to none of the instance categories`},
		{"cpu limit zero", "cpu_limit", float64(0), "out of range"},
		{"cpu limit above the ceiling", "cpu_limit", float64(10001), "out of range"},
		{"fractional cpu limit", "cpu_limit", float64(1.5), "not a whole number"},
		{"label in kubernetes.io", "labels", map[string]interface{}{"kubernetes.io/arch": "arm64"}, "reserved domain"},
		{"label in a kubernetes.io subdomain", "labels", map[string]interface{}{"topology.kubernetes.io/zone": "a"}, "reserved domain"},
		{"label in node-role.kubernetes.io", "labels", map[string]interface{}{"node-role.kubernetes.io/batch": ""}, "reserved domain"},
		{"label in k8s.io", "labels", map[string]interface{}{"kops.k8s.io/instancegroup": "x"}, "reserved domain"},
		{"label in karpenter.sh", "labels", map[string]interface{}{"karpenter.sh/nodepool": "other"}, "reserved domain"},
		{"label in karpenter.k8s.aws", "labels", map[string]interface{}{"karpenter.k8s.aws/instance-family": "c7g"}, "reserved domain"},
		{"label in a domain merely ending in kubernetes.io", "labels", map[string]interface{}{"examplekubernetes.io/x": "y"}, "reserved domain"},
		{"label prefix over 253 characters", "labels", map[string]interface{}{strings.Repeat("a.", 127) + "io/x": "y"}, "is not a Kubernetes key"},
		{"label prefix with a DNS label over 63", "labels", map[string]interface{}{strings.Repeat("a", 64) + ".com/x": "y"}, "is not a Kubernetes key"},
		{"label name over 63", "labels", map[string]interface{}{"example.com/" + strings.Repeat("a", 64): "y"}, "is not a Kubernetes key"},
		{"taint in a domain merely ending in k8s.io", "taints", []interface{}{map[string]interface{}{"key": "examplek8s.io/x", "effect": "NoSchedule"}}, "reserved domain"},
		{"label value with YAML in it", "labels", map[string]interface{}{"workload": "batch\"\n  injected: \"yes"}, "has value"},
		{"label key with YAML in it", "labels", map[string]interface{}{"a\": \"b": "c"}, "is not a Kubernetes key"},
		{"label value not a string", "labels", map[string]interface{}{"workload": float64(1)}, "is not a string"},
		{"taint in a reserved domain", "taints", []interface{}{map[string]interface{}{"key": "node.kubernetes.io/unschedulable", "effect": "NoSchedule"}}, "reserved domain"},
		{"taint in karpenter.sh", "taints", []interface{}{map[string]interface{}{"key": "karpenter.sh/disrupted", "effect": "NoSchedule"}}, "reserved domain"},
		{"unknown taint effect", "taints", []interface{}{map[string]interface{}{"key": "dedicated", "effect": "NoScheduleEver"}}, `has effect "NoScheduleEver"`},
		{"duplicate taint", "taints", []interface{}{
			map[string]interface{}{"key": "dedicated", "effect": "NoSchedule"},
			map[string]interface{}{"key": "dedicated", "value": "x", "effect": "NoSchedule"},
		}, "listed twice"},
		{"unknown taint attribute", "taints", []interface{}{map[string]interface{}{"key": "dedicated", "effect": "NoSchedule", "operator": "Exists"}}, `carries "operator"`},
		{"capacity types not a list", "capacity_types", "spot", "is not a list"},
		{"unknown attribute", "max_pods", float64(10), `carries "max_pods"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			nodePool := defaultNodePoolOutput()
			nodePool[tc.key] = tc.val
			_, err := extractKarpenterNodePool(nodePoolOutputs(nodePool))
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("extractKarpenterNodePool err = %v, want one containing %q", err, tc.wantErr)
			}
		})
	}

	// The render validates on its own too — a caller that builds the struct directly, skipping the
	// extraction, still cannot render a reserved label or an unknown capacity type.
	direct := []karpenterNodePool{
		func() karpenterNodePool {
			p := defaultKarpenterNodePool()
			p.Labels = []kvPair{{Key: "karpenter.sh/nodepool", Value: "other"}}
			return p
		}(),
		func() karpenterNodePool {
			p := defaultKarpenterNodePool()
			p.CapacityTypes = []string{"on-demand\"]\n  injected: [\""}
			return p
		}(),
		func() karpenterNodePool {
			p := defaultKarpenterNodePool()
			p.Taints = []karpenterTaint{{Key: "dedicated", Value: "a b", HasValue: true, Effect: "NoSchedule"}}
			return p
		}(),
	}
	for i, p := range direct {
		if _, err := renderKarpenterNodeClass(karpenterNodeClassData{Name: "default", NodePool: p}); err == nil {
			t.Errorf("direct render %d: rendered an invalid NodePool, want a refusal", i)
		}
	}
}

// TestKarpenterNodePool_AllowedEdges pins the other side of every refusal above, so the guard cannot
// pass by refusing everything.
func TestKarpenterNodePool_AllowedEdges(t *testing.T) {
	nodePool := defaultNodePoolOutput()
	nodePool["capacity_types"] = []interface{}{"on-demand", "spot"}
	nodePool["architectures"] = []interface{}{"amd64", "arm64"}
	nodePool["instance_categories"] = []interface{}{}
	nodePool["instance_families"] = []interface{}{"c7g", "m7i-flex"}
	nodePool["cpu_limit"] = float64(10000)
	nodePool["labels"] = map[string]interface{}{
		"node-restriction.kubernetes.io/pool":                       "batch",
		"example.com/team":                                          "",
		"kubernetes.io.example.com/x":                               "y", // a domain that merely CONTAINS kubernetes.io
		strings.Repeat("a", 63) + ".com/" + strings.Repeat("b", 63): "y", // 63-character DNS label and name
	}
	nodePool["taints"] = []interface{}{
		map[string]interface{}{"key": "dedicated", "effect": "NoSchedule"},
		map[string]interface{}{"key": "dedicated", "effect": "NoExecute"},
	}
	pool, err := extractKarpenterNodePool(nodePoolOutputs(nodePool))
	if err != nil {
		t.Fatalf("extractKarpenterNodePool refused an allowed NodePool: %v", err)
	}
	if pool.CPULimit != 10000 || len(pool.Labels) != 4 || len(pool.Taints) != 2 || pool.Taints[0].HasValue {
		t.Errorf("extracted NodePool = %#v", pool)
	}
	// One attribute omitted keeps its default (a template that predates a knob).
	partial := defaultNodePoolOutput()
	delete(partial, "cpu_limit")
	if pool, err := extractKarpenterNodePool(nodePoolOutputs(partial)); err != nil || pool.CPULimit != 100 {
		t.Errorf("omitted cpu_limit: pool.CPULimit = %d, err = %v; want the default 100", pool.CPULimit, err)
	}
}
