// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/hashicorp/hcl/v2/hclsyntax"
)

// GCP's lane of the node-pool contract (#5537). Registered from this file, as the harness asks
// (nodepool_contract_test.go), so no two cloud lanes edit the same line.
func init() { nodePoolProviders["gcp"] = nodePoolTarget{provider: &gcpProvider{}} }

// TestNodePoolContract_GCP holds the real GCP template to the cross-cloud node-pool contract: the
// three variables declared verbatim, every contract case carried in its tofu test, each value
// reaching its tfvar from the Cluster component's provider_config, and each knob settable on the
// GCP cluster card.
func TestNodePoolContract_GCP(t *testing.T) { assertNodePoolContract(t, "gcp") }

// gkePoolIsolationMayDiffer are the node_config entries an extra pool may set differently from the
// default pool: its own shape (machine type, Spot, labels, taints) and the boot disk, which reads the
// same root variables under the root's names (var.gke_disk_size_gb at the root is var.disk_size_gb in
// modules/gke) and which nodepools.tftest.hcl asserts on the plan. Everything else in either
// node_config is an isolation control and must be token-equal.
var gkePoolIsolationMayDiffer = map[string]bool{
	"machine_type":      true,
	"disk_size_gb":      true,
	"disk_type":         true,
	"spot":              true,
	"preemptible":       true, // the default pool's gke_preemptible; an extra pool's tier is capacity_type
	"labels":            true,
	"dynamic boot_disk": true,
	"dynamic taint":     true,
}

// gkeNodePoolEntries returns a google_container_node_pool's node_config and management entries as
// "node_config.<attr>" / "node_config.<block>.<attr>" → token sequence. A nested block is keyed by
// its type ("dynamic <label>" for a dynamic block, whose whole body is one entry).
func gkeNodePoolEntries(path, name string) (map[string]string, error) {
	body, src, err := parseHCLFile(path)
	if err != nil {
		return nil, err
	}
	for _, b := range body.Blocks {
		if b.Type != "resource" || len(b.Labels) != 2 || b.Labels[0] != "google_container_node_pool" || b.Labels[1] != name {
			continue
		}
		out := map[string]string{}
		for _, nb := range b.Body.Blocks {
			if nb.Type != "node_config" && nb.Type != "management" {
				continue
			}
			for k, a := range nb.Body.Attributes {
				out[nb.Type+"."+k] = exprTokens(src, a.Expr)
			}
			for _, inner := range nb.Body.Blocks {
				key := inner.Type
				if inner.Type == "dynamic" && len(inner.Labels) == 1 {
					key = "dynamic " + inner.Labels[0]
					out[nb.Type+"."+key] = string(inner.Range().SliceBytes(src))
					continue
				}
				out[nb.Type+"."+key] = blockTokens(src, inner.Body)
			}
		}
		return out, nil
	}
	return nil, fmt.Errorf("%s: no resource google_container_node_pool %q", path, name)
}

// blockTokens renders a block body's attributes as sorted "name=tokens" pairs, so two blocks compare
// equal exactly when they set the same attributes to the same expressions.
func blockTokens(src []byte, body *hclsyntax.Body) string {
	var parts []string
	for k, a := range body.Attributes {
		parts = append(parts, k+"="+exprTokens(src, a.Expr))
	}
	for _, b := range body.Blocks {
		parts = append(parts, b.Type+"{"+blockTokens(src, b.Body)+"}")
	}
	sort.Strings(parts)
	return strings.Join(parts, "; ")
}

// gkeIsolationDrift compares two pools' entries and returns one line per isolation control that is
// missing from either pool or set differently, skipping only gkePoolIsolationMayDiffer.
func gkeIsolationDrift(def, extra map[string]string) []string {
	keys := map[string]bool{}
	for k := range def {
		keys[k] = true
	}
	for k := range extra {
		keys[k] = true
	}
	var drift []string
	for k := range keys {
		short := strings.TrimPrefix(k, "node_config.")
		if strings.HasPrefix(k, "node_config.") && gkePoolIsolationMayDiffer[short] {
			continue
		}
		d, inDef := def[k]
		e, inExtra := extra[k]
		switch {
		case !inExtra:
			drift = append(drift, fmt.Sprintf("%s: set on the default pool (%s), missing on the extra pools", k, d))
		case !inDef:
			drift = append(drift, fmt.Sprintf("%s: set on the extra pools (%s), missing on the default pool", k, e))
		case d != e:
			drift = append(drift, fmt.Sprintf("%s: default pool %s, extra pools %s", k, d, e))
		}
	}
	sort.Strings(drift)
	return drift
}

// TestGKEExtraPoolsKeepTheDefaultPoolsIsolation fails when the extra pools (root nodepools.tf) and
// the default pool (modules/gke/main.tf) drift apart on an isolation control: the metadata server
// mode, shielded nodes, the metadata, the OAuth scopes, the node service account, disk encryption or
// node management. It reads the SOURCE because modules/gke cannot be planned under mocks, so no
// tofu test can see the default pool; nodepools.tftest.hcl asserts the same controls on the planned
// extra pools. Any entry not in gkePoolIsolationMayDiffer must be token-equal in both, so a control
// added to one pool and not the other fails here.
func TestGKEExtraPoolsKeepTheDefaultPoolsIsolation(t *testing.T) {
	root, err := repoRootFromSource()
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "infra/templates/project/gcp")
	def, err := gkeNodePoolEntries(filepath.Join(dir, "modules/gke/main.tf"), "default")
	if err != nil {
		t.Fatal(err)
	}
	extra, err := gkeNodePoolEntries(filepath.Join(dir, "nodepools.tf"), "extra")
	if err != nil {
		t.Fatal(err)
	}
	for _, must := range []string{"node_config.workload_metadata_config", "node_config.shielded_instance_config", "node_config.metadata", "node_config.oauth_scopes"} {
		if _, ok := def[must]; !ok {
			t.Errorf("the default pool no longer sets %s; this test would compare nothing for it", must)
		}
	}
	for _, d := range gkeIsolationDrift(def, extra) {
		t.Error(d)
	}
}

// TestGKEIsolationDriftIsDetected proves the comparison can fail: an extra pool without the GKE
// metadata server, and one with a node service account the default pool does not have, are reported.
func TestGKEIsolationDriftIsDetected(t *testing.T) {
	def := map[string]string{
		"node_config.workload_metadata_config": `mode="GKE_METADATA"`,
		"node_config.machine_type":             "var . machine_types [ 0 ]",
	}
	extra := map[string]string{
		"node_config.machine_type":    "each . value . machine_type",
		"node_config.service_account": `"sa@x.iam.gserviceaccount.com"`,
	}
	got := gkeIsolationDrift(def, extra)
	if len(got) != 2 || !strings.Contains(got[0], "service_account") || !strings.Contains(got[1], "workload_metadata_config") {
		t.Fatalf("want the missing metadata mode and the extra service account reported, got %q", got)
	}
}
