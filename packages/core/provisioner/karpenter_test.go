// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"bytes"
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"gopkg.in/yaml.v3"
)

// awsOutputs builds a representative AWS tofu-output map (unwrapped values, as tofu.Output stores
// them) with the fields the Karpenter renderer consumes.
func awsOutputs() map[string]interface{} {
	return map[string]interface{}{
		"node_iam_role_name":  "alethia-eks-node-role",
		"node_security_group": "sg-0abc123",
		"subnet1":             "subnet-aaa",
		"subnet2":             "subnet-bbb",
		"subnet3":             "subnet-ccc",
		"eks_cluster_name":    "alethia-demo-prod",
		"karpenter_node_tags": map[string]interface{}{
			"alethia:project-id":     "proj-123",
			"alethia:environment-id": "env-456",
			"Name":                   "alethia-demo-prod",
		},
	}
}

// decodeDocs splits a multi-doc YAML string and decodes each document into a generic map.
func decodeDocs(t *testing.T, manifest string) []map[string]interface{} {
	t.Helper()
	dec := yaml.NewDecoder(strings.NewReader(manifest))
	var docs []map[string]interface{}
	for {
		var doc map[string]interface{}
		err := dec.Decode(&doc)
		if err != nil {
			break
		}
		if doc != nil {
			docs = append(docs, doc)
		}
	}
	return docs
}

// findDoc returns the first decoded doc whose `kind` matches.
func findDoc(docs []map[string]interface{}, kind string) map[string]interface{} {
	for _, d := range docs {
		if k, _ := d["kind"].(string); k == kind {
			return d
		}
	}
	return nil
}

func TestRenderKarpenterNodeClass_ValidYAMLAndFields(t *testing.T) {
	tags := extractStringTagMap(awsOutputs(), "karpenter_node_tags")
	manifest, err := renderKarpenterNodeClass(karpenterNodeClassData{
		Name:            karpenterNodeClassName,
		Role:            "alethia-eks-node-role",
		SubnetIDs:       []string{"subnet-aaa", "subnet-bbb", "subnet-ccc"},
		SecurityGroupID: "sg-0abc123",
		Tags:            sortedTagPairs(tags),
		CPULimit:        karpenterCPULimit,
	})
	if err != nil {
		t.Fatalf("render failed: %v", err)
	}

	docs := decodeDocs(t, manifest)
	if len(docs) != 2 {
		t.Fatalf("expected 2 YAML documents, got %d:\n%s", len(docs), manifest)
	}

	// ── EC2NodeClass ─────────────────────────────────────────────
	nc := findDoc(docs, "EC2NodeClass")
	if nc == nil {
		t.Fatal("no EC2NodeClass document rendered")
	}
	if got := nc["apiVersion"]; got != "karpenter.k8s.aws/v1" {
		t.Errorf("EC2NodeClass apiVersion = %v, want karpenter.k8s.aws/v1 (v1 GA)", got)
	}
	ncSpec, _ := nc["spec"].(map[string]interface{})
	if ncSpec == nil {
		t.Fatal("EC2NodeClass has no spec")
	}
	if got := ncSpec["role"]; got != "alethia-eks-node-role" {
		t.Errorf("spec.role = %v, want alethia-eks-node-role", got)
	}

	// spec.tags deep-equals the input tag map (THE POINT — sweep-handle stamped verbatim).
	wantTags := map[string]interface{}{
		"alethia:project-id":     "proj-123",
		"alethia:environment-id": "env-456",
		"Name":                   "alethia-demo-prod",
	}
	if got, _ := ncSpec["tags"].(map[string]interface{}); !reflect.DeepEqual(got, wantTags) {
		t.Errorf("spec.tags = %#v, want %#v", got, wantTags)
	}

	// subnetSelectorTerms select the three subnets BY ID (no discovery tag on subnets).
	wantSubnets := map[string]bool{"subnet-aaa": true, "subnet-bbb": true, "subnet-ccc": true}
	subnetTerms, _ := ncSpec["subnetSelectorTerms"].([]interface{})
	if len(subnetTerms) != 3 {
		t.Fatalf("expected 3 subnetSelectorTerms, got %d", len(subnetTerms))
	}
	for _, term := range subnetTerms {
		m, _ := term.(map[string]interface{})
		id, _ := m["id"].(string)
		if !wantSubnets[id] {
			t.Errorf("unexpected subnet id in selector: %q", id)
		}
		delete(wantSubnets, id)
	}
	if len(wantSubnets) != 0 {
		t.Errorf("missing subnets in selector: %v", wantSubnets)
	}

	// securityGroupSelectorTerms select the node SG by ID.
	sgTerms, _ := ncSpec["securityGroupSelectorTerms"].([]interface{})
	if len(sgTerms) != 1 {
		t.Fatalf("expected 1 securityGroupSelectorTerm, got %d", len(sgTerms))
	}
	if m, _ := sgTerms[0].(map[string]interface{}); m["id"] != "sg-0abc123" {
		t.Errorf("securityGroupSelectorTerms[0].id = %v, want sg-0abc123", m["id"])
	}

	// amiSelectorTerms use the al2023 alias.
	amiTerms, _ := ncSpec["amiSelectorTerms"].([]interface{})
	if len(amiTerms) != 1 {
		t.Fatalf("expected 1 amiSelectorTerm, got %d", len(amiTerms))
	}
	if m, _ := amiTerms[0].(map[string]interface{}); m["alias"] != "al2023@latest" {
		t.Errorf("amiSelectorTerms[0].alias = %v, want al2023@latest", m["alias"])
	}

	// ── NodePool ─────────────────────────────────────────────────
	np := findDoc(docs, "NodePool")
	if np == nil {
		t.Fatal("no NodePool document rendered")
	}
	if got := np["apiVersion"]; got != "karpenter.sh/v1" {
		t.Errorf("NodePool apiVersion = %v, want karpenter.sh/v1 (v1 GA)", got)
	}
	npSpec, _ := np["spec"].(map[string]interface{})
	if npSpec == nil {
		t.Fatal("NodePool has no spec")
	}

	// nodeClassRef points at the EC2NodeClass by group/kind/name.
	tmplSpec, _ := npSpec["template"].(map[string]interface{})
	innerSpec, _ := tmplSpec["spec"].(map[string]interface{})
	ref, _ := innerSpec["nodeClassRef"].(map[string]interface{})
	if ref["group"] != "karpenter.k8s.aws" || ref["kind"] != "EC2NodeClass" || ref["name"] != karpenterNodeClassName {
		t.Errorf("nodeClassRef = %#v, want group=karpenter.k8s.aws kind=EC2NodeClass name=%s", ref, karpenterNodeClassName)
	}

	// requirements: capacity-type on-demand, arch amd64, instance-category t/m, generation Gt 2.
	reqs, _ := innerSpec["requirements"].([]interface{})
	byKey := map[string]map[string]interface{}{}
	for _, r := range reqs {
		m, _ := r.(map[string]interface{})
		byKey[m["key"].(string)] = m
	}
	assertReq(t, byKey, "karpenter.sh/capacity-type", "In", []string{"on-demand"})
	assertReq(t, byKey, "kubernetes.io/arch", "In", []string{"amd64"})
	assertReq(t, byKey, "karpenter.k8s.aws/instance-category", "In", []string{"t", "m"})
	assertReq(t, byKey, "karpenter.k8s.aws/instance-generation", "Gt", []string{"2"})

	// limits.cpu present; disruption consolidation policy set.
	limits, _ := npSpec["limits"].(map[string]interface{})
	if limits["cpu"] != karpenterCPULimit {
		t.Errorf("limits.cpu = %v, want %q", limits["cpu"], karpenterCPULimit)
	}
	disruption, _ := npSpec["disruption"].(map[string]interface{})
	if disruption["consolidationPolicy"] != "WhenEmptyOrUnderutilized" {
		t.Errorf("disruption.consolidationPolicy = %v, want WhenEmptyOrUnderutilized", disruption["consolidationPolicy"])
	}
}

// assertReq checks a NodePool requirement's operator + value set.
func assertReq(t *testing.T, byKey map[string]map[string]interface{}, key, op string, want []string) {
	t.Helper()
	m, ok := byKey[key]
	if !ok {
		t.Errorf("missing requirement %q", key)
		return
	}
	if m["operator"] != op {
		t.Errorf("requirement %q operator = %v, want %v", key, m["operator"], op)
	}
	rawVals, _ := m["values"].([]interface{})
	got := make([]string, 0, len(rawVals))
	for _, v := range rawVals {
		got = append(got, v.(string))
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("requirement %q values = %v, want %v", key, got, want)
	}
}

func TestExtractStringTagMap(t *testing.T) {
	tests := []struct {
		name    string
		outputs map[string]interface{}
		want    map[string]string
	}{
		{
			name:    "unwrapped map",
			outputs: awsOutputs(),
			want: map[string]string{
				"alethia:project-id":     "proj-123",
				"alethia:environment-id": "env-456",
				"Name":                   "alethia-demo-prod",
			},
		},
		{
			name: "wrapped {value:...} form",
			outputs: map[string]interface{}{
				"karpenter_node_tags": map[string]interface{}{
					"value": map[string]interface{}{"k": "v"},
				},
			},
			want: map[string]string{"k": "v"},
		},
		{
			name:    "absent output",
			outputs: map[string]interface{}{},
			want:    nil,
		},
		{
			name:    "null output",
			outputs: map[string]interface{}{"karpenter_node_tags": nil},
			want:    nil,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := extractStringTagMap(tc.outputs, "karpenter_node_tags")
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("extractStringTagMap = %#v, want %#v", got, tc.want)
			}
		})
	}
}

func TestApplyKarpenterNodeClass_NoOpWhenDisabled(t *testing.T) {
	cases := []struct {
		name  string
		facts *argocd.InfraFacts
	}{
		{"karpenter disabled", &argocd.InfraFacts{Provider: "aws", EnableKarpenter: false}},
		{"non-aws provider", &argocd.InfraFacts{Provider: "gcp", EnableKarpenter: true}},
		{"nil facts", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			// awsOutputs() is fully populated — a no-op MUST short-circuit before any apply
			// (which would fail: no kubectl/cluster in a unit test).
			if err := applyKarpenterNodeClass(context.Background(), awsOutputs(), tc.facts, &stdout, &stderr); err != nil {
				t.Errorf("expected nil (no-op), got error: %v", err)
			}
			if stdout.Len() != 0 || stderr.Len() != 0 {
				t.Errorf("expected no output on no-op, got stdout=%q stderr=%q", stdout.String(), stderr.String())
			}
		})
	}
}

func TestApplyKarpenterNodeClass_MissingOutputsFailFast(t *testing.T) {
	facts := &argocd.InfraFacts{Provider: "aws", EnableKarpenter: true}
	// Empty outputs → required selectors missing → error BEFORE any kubectl apply.
	var stdout, stderr bytes.Buffer
	err := applyKarpenterNodeClass(context.Background(), map[string]interface{}{}, facts, &stdout, &stderr)
	if err == nil {
		t.Fatal("expected an error for missing outputs, got nil")
	}
	if !strings.Contains(err.Error(), "missing required outputs") {
		t.Errorf("error = %v, want it to mention missing required outputs", err)
	}
}

func TestApplyKarpenterNodeClass_EmptyTagsFailFast(t *testing.T) {
	facts := &argocd.InfraFacts{Provider: "aws", EnableKarpenter: true}
	out := awsOutputs()
	delete(out, "karpenter_node_tags")
	var stdout, stderr bytes.Buffer
	err := applyKarpenterNodeClass(context.Background(), out, facts, &stdout, &stderr)
	if err == nil {
		t.Fatal("expected an error for empty tags, got nil")
	}
	if !strings.Contains(err.Error(), "karpenter_node_tags") {
		t.Errorf("error = %v, want it to mention karpenter_node_tags", err)
	}
}
