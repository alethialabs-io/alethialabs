// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"sort"
	"strings"
	"text/template"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
)

// karpenterNodeClassName is the fixed name shared by the EC2NodeClass and the NodePool's
// nodeClassRef. A single default node class/pool is all the platform provisions today.
const karpenterNodeClassName = "default"

// karpenterCPULimit caps total NodePool CPU so a runaway workload can't scale the account into
// the ground. It mirrors the pre-apply cost ceiling spirit (BYOC A1.4) — Karpenter provisions
// EC2 out-of-band of OpenTofu, so this is the only knob that bounds its fleet size.
const karpenterCPULimit = "100"

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
	CPULimit        string
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
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: {{ .Name }}
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
    cpu: {{ printf "%q" .CPULimit }}
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 1m
`

// renderKarpenterNodeClass renders the EC2NodeClass + NodePool manifest from the provisioned-infra
// facts. Kept separate from the apply so the golden tests can assert the exact YAML.
func renderKarpenterNodeClass(data karpenterNodeClassData) (string, error) {
	tmpl, err := template.New("karpenter-nodeclass").Parse(karpenterNodeClassTemplate)
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
		CPULimit:        karpenterCPULimit,
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
