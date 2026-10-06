// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
)

// The arm64 (Graviton) Karpenter NodePool (#5534). The template's karpenter_arm64_nodepool output
// carries the user's settings; the runner renders a second NodePool, `arm64`, from them and ALWAYS
// adds the platform taint alethia.io/arch=arm64:NoSchedule after validating them.

// arm64NodePoolOutput is the karpenter_arm64_nodepool output the template emits for
// `karpenter_arm64_nodepool = {}` with every other knob at its default.
func arm64NodePoolOutput() map[string]interface{} {
	out := defaultNodePoolOutput()
	out["architectures"] = []interface{}{"arm64"}
	return out
}

// renderWithArm64 runs the runner's read-then-render path, arm64 pool included, over a tofu output
// map: the same calls applyKarpenterNodeClass makes before it hands the manifest to kubectl.
func renderWithArm64(t *testing.T, outputs map[string]interface{}) (string, error) {
	t.Helper()
	pool, err := extractKarpenterNodePool(outputs)
	if err != nil {
		return "", err
	}
	arm64, err := extractKarpenterArm64NodePool(outputs)
	if err != nil {
		return "", err
	}
	return renderKarpenterNodeClass(karpenterNodeClassData{
		Name:            karpenterNodeClassName,
		Role:            "alethia-eks-node-role",
		SubnetIDs:       []string{"subnet-aaa", "subnet-bbb", "subnet-ccc"},
		SecurityGroupID: "sg-0abc123",
		Tags:            sortedTagPairs(extractStringTagMap(outputs, "karpenter_node_tags")),
		NodePool:        pool,
		Arm64:           arm64,
	})
}

// wantArm64NodePool is the whole arm64 NodePool document for arm64NodePoolOutput().
const wantArm64NodePool = `apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: arm64
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
          values: ["arm64"]
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["t", "m"]
        - key: karpenter.k8s.aws/instance-generation
          operator: Gt
          values: ["2"]
      taints:
        - key: "alethia.io/arch"
          value: "arm64"
          effect: "NoSchedule"
  limits:
    cpu: "100"
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 1m
`

// TestKarpenterArm64_NotConfiguredRendersNoSuchPool: a project with no arm64 pool configured (the
// output absent, as in state from before #5534, or null, as the template emits by default) renders
// exactly the manifest it rendered before, with no arm64 NodePool.
func TestKarpenterArm64_NotConfiguredRendersNoSuchPool(t *testing.T) {
	absent := nodePoolOutputs(defaultNodePoolOutput())
	null := nodePoolOutputs(defaultNodePoolOutput())
	null["karpenter_arm64_nodepool"] = nil
	wrappedNull := nodePoolOutputs(defaultNodePoolOutput())
	wrappedNull["karpenter_arm64_nodepool"] = map[string]interface{}{"value": nil}
	for name, outputs := range map[string]map[string]interface{}{"absent": absent, "null": null, "wrapped null": wrappedNull} {
		t.Run(name, func(t *testing.T) {
			got, err := renderWithArm64(t, outputs)
			if err != nil {
				t.Fatal(err)
			}
			if got != preConfigurableKarpenterManifest {
				t.Errorf("render drifted from the pre-#5527 manifest:\n--- got ---\n%s\n--- want ---\n%s", got, preConfigurableKarpenterManifest)
			}
			if strings.Contains(got, "arm64") {
				t.Errorf("a project with no arm64 pool rendered one:\n%s", got)
			}
		})
	}
}

// TestKarpenterArm64_PoolAlwaysCarriesThePlatformTaint: the arm64 NodePool is a third document after
// the unchanged default pool, it launches arm64 only, and it carries alethia.io/arch=arm64:NoSchedule.
func TestKarpenterArm64_PoolAlwaysCarriesThePlatformTaint(t *testing.T) {
	outputs := nodePoolOutputs(defaultNodePoolOutput())
	outputs["karpenter_arm64_nodepool"] = arm64NodePoolOutput()
	got, err := renderWithArm64(t, outputs)
	if err != nil {
		t.Fatal(err)
	}
	head, arm64Doc, found := strings.Cut(got, "consolidateAfter: 1m\n---\n")
	if !found {
		t.Fatalf("no second NodePool document:\n%s", got)
	}
	if head+"consolidateAfter: 1m\n" != preConfigurableKarpenterManifest {
		t.Errorf("the arm64 pool changed the default NodePool or the EC2NodeClass:\n%s", head)
	}
	if arm64Doc != wantArm64NodePool {
		t.Errorf("arm64 NodePool:\n--- got ---\n%s\n--- want ---\n%s", arm64Doc, wantArm64NodePool)
	}
	if n := len(decodeDocs(t, got)); n != 3 {
		t.Errorf("expected 3 YAML documents (EC2NodeClass, default, arm64), got %d", n)
	}
}

// TestKarpenterArm64_TaintFollowsTheUsersAndCannotBeDropped: with the user's labels and taints (the
// default pool's, shared), the platform taint comes last; a caller that hands the renderer an arm64
// pool with PlatformTaints cleared, or a default pool with them set, still gets the taint on the arm64
// pool and only there.
func TestKarpenterArm64_TaintFollowsTheUsersAndCannotBeDropped(t *testing.T) {
	settings := defaultNodePoolOutput()
	settings["labels"] = map[string]interface{}{"workload": "batch"}
	settings["taints"] = []interface{}{map[string]interface{}{"key": "dedicated", "value": "batch", "effect": "NoSchedule"}}
	arm64 := arm64NodePoolOutput()
	arm64["labels"] = settings["labels"]
	arm64["taints"] = settings["taints"]
	arm64["instance_families"] = []interface{}{"m7g", "t4g"}
	arm64["cpu_limit"] = float64(32)
	outputs := nodePoolOutputs(settings)
	outputs["karpenter_arm64_nodepool"] = arm64

	got, err := renderWithArm64(t, outputs)
	if err != nil {
		t.Fatal(err)
	}
	_, arm64Doc, _ := strings.Cut(got, "consolidateAfter: 1m\n---\n")
	wantTaints := "      taints:\n        - key: \"dedicated\"\n          value: \"batch\"\n          effect: \"NoSchedule\"\n        - key: \"alethia.io/arch\"\n          value: \"arm64\"\n          effect: \"NoSchedule\"\n  limits:\n    cpu: \"32\"\n"
	if !strings.Contains(arm64Doc, wantTaints) {
		t.Errorf("the arm64 pool must carry the user's taint, then the platform taint:\n%s", arm64Doc)
	}
	if !strings.Contains(arm64Doc, "values: [\"m7g\", \"t4g\"]") || !strings.Contains(arm64Doc, "\"workload\": \"batch\"") {
		t.Errorf("the arm64 pool lost its families or the shared labels:\n%s", arm64Doc)
	}
	if strings.Count(got, "alethia.io/arch") != 1 {
		t.Errorf("alethia.io/arch must appear once, on the arm64 pool:\n%s", got)
	}

	pool, _ := extractKarpenterNodePool(outputs)
	pool.PlatformTaints = []karpenterTaint{karpenterArm64Taint}
	arm64Pool, _ := extractKarpenterArm64NodePool(outputs)
	arm64Pool.PlatformTaints = nil
	forced, err := renderKarpenterNodeClass(karpenterNodeClassData{
		Name: karpenterNodeClassName, Role: "r", SubnetIDs: []string{"subnet-aaa"}, SecurityGroupID: "sg",
		Tags: []kvPair{{Key: "k", Value: "v"}}, NodePool: pool, Arm64: arm64Pool,
	})
	if err != nil {
		t.Fatal(err)
	}
	defaultDoc, arm64Forced, _ := strings.Cut(forced, "consolidateAfter: 1m\n---\n")
	if strings.Contains(defaultDoc, "alethia.io/arch") || !strings.Contains(arm64Forced, "alethia.io/arch") {
		t.Errorf("a caller's PlatformTaints must not move the arm64 taint:\n%s", forced)
	}
}

// TestKarpenterArm64_RefusesWhatTheTemplateRefuses: the arm64 output is validated before it renders,
// with the template's rules, and a user cannot write the platform taint through the shared knobs.
func TestKarpenterArm64_RefusesWhatTheTemplateRefuses(t *testing.T) {
	cases := []struct {
		name string
		edit func(arm64, settings map[string]interface{})
		want string
	}{
		{"an x86 family", func(a, _ map[string]interface{}) { a["instance_families"] = []interface{}{"m7i"} }, `"m7i" is not a Graviton family`},
		{"the amd64 architecture", func(a, _ map[string]interface{}) { a["architectures"] = []interface{}{"amd64"} }, "exactly the arm64 architecture"},
		{"both architectures", func(a, _ map[string]interface{}) { a["architectures"] = []interface{}{"arm64", "amd64"} }, "exactly the arm64 architecture"},
		{"a zero cpu limit", func(a, _ map[string]interface{}) { a["cpu_limit"] = float64(0) }, "cpu limit 0 is out of range"},
		{"an unknown attribute", func(a, _ map[string]interface{}) { a["weight"] = float64(10) }, `karpenter_arm64_nodepool output carries "weight"`},
		{"a user's alethia.io/arch taint", func(a, _ map[string]interface{}) {
			a["taints"] = []interface{}{map[string]interface{}{"key": "alethia.io/arch", "value": "arm64", "effect": "NoSchedule"}}
		}, `uses the reserved domain "alethia.io"`},
		{"a family outside the categories", func(a, _ map[string]interface{}) { a["instance_families"] = []interface{}{"c7g"} }, `"c7g" belongs to none of the instance categories`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			settings := defaultNodePoolOutput()
			arm64 := arm64NodePoolOutput()
			tc.edit(arm64, settings)
			outputs := nodePoolOutputs(settings)
			outputs["karpenter_arm64_nodepool"] = arm64
			_, err := renderWithArm64(t, outputs)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Errorf("want an error containing %q, got %v", tc.want, err)
			}
		})
	}
}

// TestKarpenterArm64_ApplyDeletesAPoolNoLongerConfigured: kubectl apply never prunes, so when the
// project stops configuring an arm64 pool the runner deletes it after the apply; while it is
// configured, nothing is deleted.
func TestKarpenterArm64_ApplyDeletesAPoolNoLongerConfigured(t *testing.T) {
	applied := filepath.Join(t.TempDir(), "applied.yaml")
	provStubTool(t, "kubectl", "#!/bin/sh\nif [ \"$1\" = apply ]; then cat \"$3\" > "+applied+"; fi\nexit 0\n")
	var deleted []string
	orig := deleteKarpenterNodePool
	t.Cleanup(func() { deleteKarpenterNodePool = orig })
	deleteKarpenterNodePool = func(name string, _, _ io.Writer) error {
		deleted = append(deleted, name)
		return nil
	}
	facts := &argocd.InfraFacts{Provider: "aws", EnableKarpenter: true}

	if err := applyKarpenterNodeClass(context.Background(), nodePoolOutputs(defaultNodePoolOutput()), facts, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	if len(deleted) != 1 || deleted[0] != "arm64" {
		t.Errorf("with no arm64 pool configured, the runner must delete NodePool arm64; deleted %v", deleted)
	}

	deleted = nil
	outputs := nodePoolOutputs(defaultNodePoolOutput())
	outputs["karpenter_arm64_nodepool"] = arm64NodePoolOutput()
	if err := applyKarpenterNodeClass(context.Background(), outputs, facts, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	if len(deleted) != 0 {
		t.Errorf("a configured arm64 pool was deleted: %v", deleted)
	}
	body, err := os.ReadFile(applied)
	if err != nil || !strings.Contains(string(body), "name: arm64") || !strings.Contains(string(body), "alethia.io/arch") {
		t.Errorf("the applied manifest lacks the tainted arm64 NodePool (err=%v):\n%s", err, body)
	}
}

// TestKarpenterArm64_MalformedOutputIsAnError: a karpenter_arm64_nodepool output of the wrong shape is
// refused with the output's own name, never read as "no arm64 pool".
func TestKarpenterArm64_MalformedOutputIsAnError(t *testing.T) {
	cases := map[string]struct {
		val  interface{}
		want string
	}{
		"not an object":             {"arm64", "the karpenter_arm64_nodepool output is not an object"},
		"wrapped, not an object":    {map[string]interface{}{"value": "arm64"}, "the karpenter_arm64_nodepool output is not an object"},
		"a list that is not":        {map[string]interface{}{"instance_families": "m7g"}, "karpenter_arm64_nodepool.instance_families is not a list"},
		"a fractional cpu limit":    {map[string]interface{}{"cpu_limit": 1.5}, "karpenter_arm64_nodepool.cpu_limit 1.5 is not a whole number"},
		"labels that are not":       {map[string]interface{}{"labels": "x"}, "karpenter_arm64_nodepool.labels is not a map"},
		"a taint that is not":       {map[string]interface{}{"taints": []interface{}{"x"}}, "karpenter_arm64_nodepool.taints[0] is not an object"},
		"a taint key that is not":   {map[string]interface{}{"taints": []interface{}{map[string]interface{}{"key": 1}}}, "karpenter_arm64_nodepool.taints[0].key is not a string"},
		"a taint with an unknown":   {map[string]interface{}{"taints": []interface{}{map[string]interface{}{"key": "a", "effect": "NoSchedule", "x": "y"}}}, `karpenter_arm64_nodepool.taints[0] carries "x"`},
		"a label value that is not": {map[string]interface{}{"labels": map[string]interface{}{"a": 1}}, `karpenter_arm64_nodepool.labels["a"] is not a string`},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			outputs := nodePoolOutputs(defaultNodePoolOutput())
			outputs["karpenter_arm64_nodepool"] = tc.val
			_, err := extractKarpenterArm64NodePool(outputs)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Errorf("want an error containing %q, got %v", tc.want, err)
			}
		})
	}
}

// TestKarpenterArm64_ApplyFailsLoudly: a malformed arm64 output stops the apply before kubectl, and a
// failed delete of a no-longer-configured pool is reported rather than swallowed.
func TestKarpenterArm64_ApplyFailsLoudly(t *testing.T) {
	provStubTool(t, "kubectl", "#!/bin/sh\nexit 0\n")
	facts := &argocd.InfraFacts{Provider: "aws", EnableKarpenter: true}

	bad := nodePoolOutputs(defaultNodePoolOutput())
	bad["karpenter_arm64_nodepool"] = "arm64"
	if err := applyKarpenterNodeClass(context.Background(), bad, facts, io.Discard, io.Discard); err == nil || !strings.Contains(err.Error(), "karpenter_arm64_nodepool") {
		t.Errorf("a malformed arm64 output must fail the apply, got %v", err)
	}

	orig := deleteKarpenterNodePool
	t.Cleanup(func() { deleteKarpenterNodePool = orig })
	deleteKarpenterNodePool = func(string, io.Writer, io.Writer) error { return errors.New("forbidden") }
	err := applyKarpenterNodeClass(context.Background(), nodePoolOutputs(defaultNodePoolOutput()), facts, io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "deleting it failed: forbidden") {
		t.Errorf("a failed delete of the arm64 pool must be reported, got %v", err)
	}
}

// TestKarpenterArm64_GravitonRuleIsTheTemplates holds the runner's Graviton rule and the AWS
// template's to ONE literal: it must appear in both template validations that decide what is arm64
// (karpenter_arm64_nodepool's families and extra_node_pools' instance types), so Go and tofu cannot
// disagree about which instance is Graviton.
func TestKarpenterArm64_GravitonRuleIsTheTemplates(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("..", "..", "..", "infra", "templates", "project", "aws", "variables.tf"))
	if err != nil {
		t.Fatal(err)
	}
	literal := `regex("` + karpenterGravitonFamily.String() + `"`
	for _, v := range []string{"karpenter_arm64_nodepool", "extra_node_pools"} {
		start := strings.Index(string(src), "variable \""+v+"\" {")
		if start < 0 {
			t.Fatalf("variables.tf declares no %s", v)
		}
		end := strings.Index(string(src)[start:], "\n}\n")
		if end < 0 || !strings.Contains(string(src)[start:start+end], literal) {
			t.Errorf("variable %q does not apply the runner's Graviton rule %s", v, literal)
		}
	}
	for _, f := range []string{"m7g", "c7gn", "t4g", "r8gd", "g5g", "a1", "a1.large", "m7g.large"} {
		if !karpenterGravitonFamily.MatchString(f) {
			t.Errorf("%q is Graviton and must match", f)
		}
	}
	for _, f := range []string{"m7i", "c5n", "g5", "g4dn", "p4d", "inf2", "m7a", "a2", "mac2"} {
		if karpenterGravitonFamily.MatchString(f) {
			t.Errorf("%q is not Graviton and must not match", f)
		}
	}
}

// TestKarpenterArm64_RefusesA1: both NodePools require instance generation 3 or later, so a1 could
// never launch on the arm64 pool and is refused rather than accepted as a pool that never scales.
func TestKarpenterArm64_RefusesA1(t *testing.T) {
	arm64 := arm64NodePoolOutput()
	arm64["instance_categories"] = []interface{}{}
	arm64["instance_families"] = []interface{}{"a1"}
	outputs := nodePoolOutputs(defaultNodePoolOutput())
	outputs["karpenter_arm64_nodepool"] = arm64
	if _, err := extractKarpenterArm64NodePool(outputs); err == nil || !strings.Contains(err.Error(), `"a1" is refused`) {
		t.Errorf("want a1 refused, got %v", err)
	}
}

// TestKarpenterArm64_EdgeRefusals covers the remaining refusal branches the arm64 pool shares with the
// default one: a malformed list entry, a duplicate family, a bad taint key or value, and a renderer
// handed an arm64 pool that skipped extraction.
func TestKarpenterArm64_EdgeRefusals(t *testing.T) {
	cases := map[string]struct {
		edit func(map[string]interface{})
		want string
	}{
		"a non-string family": {func(a map[string]interface{}) { a["instance_families"] = []interface{}{1} }, "karpenter_arm64_nodepool.instance_families holds a non-string entry"},
		"a duplicate family":  {func(a map[string]interface{}) { a["instance_families"] = []interface{}{"m7g", "m7g"} }, `lists "m7g" twice`},
		"taints not a list":   {func(a map[string]interface{}) { a["taints"] = "x" }, "karpenter_arm64_nodepool.taints is not a list"},
		"a taint value not str": {func(a map[string]interface{}) {
			a["taints"] = []interface{}{map[string]interface{}{"key": "a", "value": 1, "effect": "NoSchedule"}}
		}, "karpenter_arm64_nodepool.taints[0].value is not a string"},
		"a bad taint key": {func(a map[string]interface{}) {
			a["taints"] = []interface{}{map[string]interface{}{"key": "-bad", "effect": "NoSchedule"}}
		}, "is not a Kubernetes key"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			arm64 := arm64NodePoolOutput()
			tc.edit(arm64)
			outputs := nodePoolOutputs(defaultNodePoolOutput())
			outputs["karpenter_arm64_nodepool"] = arm64
			_, err := extractKarpenterArm64NodePool(outputs)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Errorf("want an error containing %q, got %v", tc.want, err)
			}
		})
	}

	pool, err := extractKarpenterNodePool(nodePoolOutputs(defaultNodePoolOutput()))
	if err != nil {
		t.Fatal(err)
	}
	unvalidated := pool // amd64: a caller that skipped extractKarpenterArm64NodePool
	if _, err := renderKarpenterNodeClass(karpenterNodeClassData{Name: "default", NodePool: pool, Arm64: &unvalidated}); err == nil || !strings.Contains(err.Error(), "exactly the arm64 architecture") {
		t.Errorf("the renderer must validate the arm64 pool itself, got %v", err)
	}

	provStubTool(t, "kubectl", "#!/bin/sh\nexit 0\n")
	bad := defaultNodePoolOutput()
	bad["architectures"] = []interface{}{"x86_64"}
	if err := applyKarpenterNodeClass(context.Background(), nodePoolOutputs(bad), &argocd.InfraFacts{Provider: "aws", EnableKarpenter: true}, io.Discard, io.Discard); err == nil {
		t.Error("a malformed default pool output must fail the apply")
	}
}

// TestExtractStringTagMap_ShapesTheTagsOutputCanTake covers the tag map's non-map and wrapped forms.
func TestExtractStringTagMap_ShapesTheTagsOutputCanTake(t *testing.T) {
	if got := extractStringTagMap(map[string]interface{}{"t": "x"}, "t"); got != nil {
		t.Errorf("a non-map output must read as no tags, got %v", got)
	}
	got := extractStringTagMap(map[string]interface{}{"t": map[string]interface{}{"value": map[string]interface{}{"a": "b"}}}, "t")
	if got["a"] != "b" {
		t.Errorf("the wrapped form must unwrap, got %v", got)
	}
}

// TestKarpenterArm64_ApplyStopsRetryingWhenCancelled: a failing apply reports the attempt and stops
// at once when the deploy is cancelled, rather than waiting out its retries.
func TestKarpenterArm64_ApplyStopsRetryingWhenCancelled(t *testing.T) {
	provStubTool(t, "kubectl", "#!/bin/sh\nexit 1\n")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var stderr strings.Builder
	err := applyKarpenterNodeClass(ctx, nodePoolOutputs(defaultNodePoolOutput()), &argocd.InfraFacts{Provider: "aws", EnableKarpenter: true}, io.Discard, &stderr)
	if !errors.Is(err, context.Canceled) {
		t.Errorf("want context.Canceled, got %v", err)
	}
	if !strings.Contains(stderr.String(), "attempt 1/4 failed") {
		t.Errorf("the failed attempt must be reported, got %q", stderr.String())
	}
}
