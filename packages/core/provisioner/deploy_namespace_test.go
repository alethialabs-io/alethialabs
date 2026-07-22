// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"io"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func TestSelectPlacementPath(t *testing.T) {
	cases := []struct {
		name     string
		pm       types.PlacementMode
		provider string
		want     placementPath
	}{
		{"empty is dedicated (legacy env=cluster)", "", "aws", placementDedicated},
		{"dedicated aws", types.PlacementModeDedicated, "aws", placementDedicated},
		{"dedicated gcp", types.PlacementModeDedicated, "gcp", placementDedicated},
		{"namespace aws → activated", types.PlacementModeNamespace, "aws", placementNamespaceAWS},
		// Only clouds in namespaceRemintProviders activate; the rest fail closed with a documented,
		// cloud-named reason. Each flips to placementNamespaceAWS as its lane lands (#1127/#1128/#1129).
		{"namespace gcp → fail closed", types.PlacementModeNamespace, "gcp", placementUnactivated},
		{"namespace azure → fail closed", types.PlacementModeNamespace, "azure", placementUnactivated},
		{"namespace alibaba → fail closed", types.PlacementModeNamespace, "alibaba", placementUnactivated},
		{"namespace hetzner → fail closed (permanent exclusion)", types.PlacementModeNamespace, "hetzner", placementUnactivated},
		{"vcluster aws → fail closed", types.PlacementModeVcluster, "aws", placementUnactivated},
		{"unknown mode → fail closed", types.PlacementMode("bogus"), "aws", placementUnactivated},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := selectPlacementPath(tc.pm, tc.provider); got != tc.want {
				t.Errorf("selectPlacementPath(%q, %q) = %d, want %d", tc.pm, tc.provider, got, tc.want)
			}
		})
	}
}

func TestUnactivatedPlacementError(t *testing.T) {
	// namespace on a non-aws cloud names the cloud and the per-cloud reason (parity is documented, not
	// silent) and points at aws as the working cloud.
	nsErr := unactivatedPlacementError(types.PlacementModeNamespace, "gcp")
	if nsErr == nil {
		t.Fatal("expected error")
	}
	msg := nsErr.Error()
	for _, want := range []string{"namespace", "gcp", "aws"} {
		if !strings.Contains(msg, want) {
			t.Errorf("namespace error %q missing %q", msg, want)
		}
	}

	// vcluster explains the mode isn't activated at all (tracked follow-up), never mentions a specific
	// cloud being the fix.
	vcErr := unactivatedPlacementError(types.PlacementModeVcluster, "aws")
	if vcErr == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(vcErr.Error(), "vcluster") {
		t.Errorf("vcluster error %q missing 'vcluster'", vcErr.Error())
	}
}

func TestNamespaceRemintSeam(t *testing.T) {
	// The allowlist is the single activation control: aws is wired today; the parity clouds and the
	// permanent hetzner exclusion are not (they flip on as #1127/#1128/#1129 land).
	if !namespaceRemintWired("aws") {
		t.Error("namespaceRemintWired(aws) = false, want true (aws-first activation)")
	}
	for _, p := range []string{"gcp", "azure", "alibaba", "hetzner", "digitalocean", ""} {
		if namespaceRemintWired(p) {
			t.Errorf("namespaceRemintWired(%q) = true, want false (not yet wired)", p)
		}
	}

	// The fail-closed error is cloud-named and points at the follow-ups (parity is documented, never
	// silent).
	err := namespaceRemintNotWired("gcp")
	if err == nil {
		t.Fatal("expected error")
	}
	for _, want := range []string{"gcp", "aws", "#1127", "hetzner"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("namespaceRemintNotWired error %q missing %q", err.Error(), want)
		}
	}

	// The mint seam fails closed for an unwired cloud BEFORE touching the CloudProvider — a nil provider
	// is safe precisely because the guard returns first (defence-in-depth behind selectPlacementPath).
	if err := mintNamespaceKubeAccess(context.Background(), nil, nil, "gcp", "some-cluster", io.Discard); err == nil {
		t.Error("mintNamespaceKubeAccess(gcp) = nil, want fail-closed error (re-mint not wired)")
	}

	// The identity seam fails closed for an unwired cloud (default case) — no AWS calls, no silent no-op.
	if err := provisionAndBindNamespaceIdentity(context.Background(), "azure", "eu-west-1", "some-cluster", "ns", io.Discard, io.Discard); err == nil {
		t.Error("provisionAndBindNamespaceIdentity(azure) = nil, want fail-closed error (identity not wired)")
	}
}

func TestNamespaceInputValidation(t *testing.T) {
	// Valid DNS-1123 labels pass; shell/YAML-hostile or malformed values fail closed — the guard
	// stops a hostile snapshot value from injecting a shell command (kubectl apply -n <ns>) that would
	// run with the runner's ambient cloud creds.
	validNS := []string{"production", "e2e-ns-prod", "a", "team-1-web"}
	badNS := []string{"", "Production", "foo bar", "foo;rm -rf /", "foo$(whoami)", "foo`id`", "-lead", "trail-", "a/b", strings.Repeat("x", 64)}
	for _, s := range validNS {
		if !isDNS1123Label(s) {
			t.Errorf("isDNS1123Label(%q) = false, want true", s)
		}
	}
	for _, s := range badNS {
		if isDNS1123Label(s) {
			t.Errorf("isDNS1123Label(%q) = true, want false (must fail closed)", s)
		}
	}

	validCluster := []string{"eks-fabric", "prod_cluster-1", "A1"}
	badCluster := []string{"", "cluster name", "clus;ter", "clus$(x)", "-lead"}
	for _, s := range validCluster {
		if !isValidClusterName(s) {
			t.Errorf("isValidClusterName(%q) = false, want true", s)
		}
	}
	for _, s := range badCluster {
		if isValidClusterName(s) {
			t.Errorf("isValidClusterName(%q) = true, want false (must fail closed)", s)
		}
	}
}
