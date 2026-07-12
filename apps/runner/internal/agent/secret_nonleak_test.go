// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/provisioner"
)

// Security regression (SOC 2 CC6.7 — secrets are not exposed): the execution_metadata the
// runner persists to the console (Postgres, readable from DB backups/replicas and by
// cross-tenant support staff) must carry NO cluster-credential material. A deploy's
// `PlanResult.Outputs` legitimately holds full kubeconfigs and raw client keys — the
// in-process pipeline consumes them — but only a SCRUBBED copy may cross into the metadata.
//
// This drives the REAL persisted-surface assembly (`buildDeployMetadata`, the exact function
// executeDeploy calls), plants a unique SENTINEL inside every credential-bearing output, and
// asserts the SENTINEL never appears anywhere in the serialized metadata. It is NON-VACUOUS:
// bypassing the scrub (persisting `result.Outputs` verbatim) makes the SENTINEL surface and
// the test go red — see docs/compliance/security-e2e-matrix.md.

// A value unlikely to occur by accident, embedded in the credential VALUES so a value-level
// leak (not just a key-level one) is caught by the substring scan.
const credSentinel = "SENTINEL-CRED-9f1c3b2a-DO-NOT-PERSIST"

func TestDeployMetadata_ScrubsClusterCredentials(t *testing.T) {
	result := &provisioner.PlanResult{
		ClusterName:     "prod-eks",
		ClusterEndpoint: "https://abc.eks.amazonaws.com", // public, kept
		ClusterReady:    true,
		Outputs: map[string]interface{}{
			// Credential-bearing outputs — every value carries the SENTINEL.
			"kubeconfig":       "apiVersion: v1\nkind: Config\nclient-key-data: " + credSentinel,
			"gke_kubeconfig":   "apiVersion: v1\n# " + credSentinel,
			"kube_config_raw":  "apiVersion: v1\n# " + credSentinel,
			"talosconfig":      "context: default\nkey: " + credSentinel,
			"admin_client_key": "-----BEGIN PRIVATE KEY-----\n" + credSentinel,
			// Generated credential VALUES re-exported from the tofu root (the P1 leak):
			// AWS awssm-passgen promotes plaintext generated secrets as `custom_secret_values`,
			// and any `*_values` map carries raw secret material — must be scrubbed.
			"custom_secret_values": map[string]any{"db-pass": credSentinel, "api-key": credSentinel},
			"generated_secret_values": map[string]any{"token": credSentinel},
			// Non-secret outputs — must survive so the console still shows real status.
			"eks_cluster_endpoint":       "https://abc.eks.amazonaws.com",
			"gke_cluster_ca_certificate": "LS0tLS1CRUdJTi==", // CA is public
			"cluster_name":               "prod-eks",
			// Non-secret handles to the AWS Secrets Manager entries — must survive
			// (they carry no plaintext; the console shows them so operators can find secrets).
			"custom_secret_arns":     map[string]any{"db-pass": "arn:aws:secretsmanager:...:db-pass"},
			"custom_secret_names":    map[string]any{"db-pass": "prod/db-pass"},
			"custom_secret_versions": map[string]any{"db-pass": "AWSCURRENT"},
		},
	}

	// Sanity: the SENTINEL really IS in the source outputs — otherwise the scan below would
	// pass vacuously (nothing to leak). This proves the test plants a real secret.
	rawOutputs, err := json.Marshal(result.Outputs)
	if err != nil {
		t.Fatalf("marshal source outputs: %v", err)
	}
	if !strings.Contains(string(rawOutputs), credSentinel) {
		t.Fatal("test bug: SENTINEL not present in the source outputs — the assertion would be vacuous")
	}

	metadata := buildDeployMetadata(result)

	// The full, unscrubbed metadata as it is serialized for the console (UpdateJobStatus).
	persisted, err := json.Marshal(metadata)
	if err != nil {
		t.Fatalf("marshal persisted metadata: %v", err)
	}
	if strings.Contains(string(persisted), credSentinel) {
		t.Fatalf("SECRET LEAK: cluster-credential SENTINEL crossed into console execution_metadata:\n%s", persisted)
	}

	// Non-vacuity anchor: the assembly actually ran and produced the non-secret surface —
	// public cluster metadata survives, and the scrubbed `outputs` map keeps the safe keys.
	outputs, ok := metadata["outputs"].(map[string]any)
	if !ok {
		t.Fatalf("expected a scrubbed outputs map in metadata, got %T", metadata["outputs"])
	}
	for _, keep := range []string{
		"eks_cluster_endpoint", "gke_cluster_ca_certificate", "cluster_name",
		"custom_secret_arns", "custom_secret_names", "custom_secret_versions",
	} {
		if _, present := outputs[keep]; !present {
			t.Errorf("non-secret output %q was dropped — scrub is over-broad", keep)
		}
	}
	for _, gone := range []string{"kubeconfig", "gke_kubeconfig", "kube_config_raw", "talosconfig", "admin_client_key", "custom_secret_values", "generated_secret_values"} {
		if _, present := outputs[gone]; present {
			t.Errorf("credential-bearing output %q survived into console metadata", gone)
		}
	}
	if metadata["cluster_name"] != "prod-eks" {
		t.Errorf("expected public cluster_name to survive, got %v", metadata["cluster_name"])
	}
}
