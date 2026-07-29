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
		{"namespace gcp → activated", types.PlacementModeNamespace, "gcp", placementNamespaceAWS},
		{"namespace azure → activated", types.PlacementModeNamespace, "azure", placementNamespaceAWS},
		// Only clouds in namespaceRemintProviders activate; the rest fail closed with a documented,
		// cloud-named reason. alibaba (in-core keyless RRSA: ACK resolve + per-namespace RAM role) and
		// hetzner (persisted-talosconfig Talos mint; no cloud IAM — k8s-native isolation) are activated
		// too, so with azure EVERY supported cloud is wired and only an unknown one fails closed.
		{"namespace alibaba → activated", types.PlacementModeNamespace, "alibaba", placementNamespaceAWS},
		{"namespace hetzner → activated", types.PlacementModeNamespace, "hetzner", placementNamespaceAWS},
		{"namespace unknown cloud → fail closed", types.PlacementModeNamespace, "digitalocean", placementUnactivated},
		// vcluster is activated per-cloud as its host re-mint lands: aws (in-core) + gcp/azure
		// (runner-injected KubeConnResolver) + alibaba (in-core keyless RRSA) + hetzner (Talos-API mint).
		{"vcluster aws → activated", types.PlacementModeVcluster, "aws", placementVcluster},
		{"vcluster gcp → activated", types.PlacementModeVcluster, "gcp", placementVcluster},
		{"vcluster azure → activated", types.PlacementModeVcluster, "azure", placementVcluster},
		{"vcluster alibaba → activated", types.PlacementModeVcluster, "alibaba", placementVcluster},
		{"vcluster hetzner → activated", types.PlacementModeVcluster, "hetzner", placementVcluster},
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

// TestMintClusterOutputs locks the runner-injected kube-conn seam: aws needs no resolver (name-only,
// resolved in-core), a cloud that reads endpoint/CA from outputs (gcp) gets them injected from the
// resolver under its output keys, and every fail-closed branch surfaces an error rather than an
// unusable kubeconfig.
func TestMintClusterOutputs(t *testing.T) {
	ctx := context.Background()
	cfg := &types.ProjectConfig{CloudAccountID: "proj-1", Region: "us-central1"}

	// aws: no conn keys → name-only map, resolver MUST NOT be consulted (in-core EKS DescribeCluster).
	t.Run("aws name-only, resolver untouched", func(t *testing.T) {
		called := false
		resolver := func(context.Context, string, *types.ProjectConfig, string) (string, string, error) {
			called = true
			return "", "", nil
		}
		out, err := mintClusterOutputs(ctx, resolver, nil, "aws", cfg, "my-eks", "eks_cluster_name")
		if err != nil {
			t.Fatalf("aws: unexpected error: %v", err)
		}
		if called {
			t.Error("aws must not invoke the kube-conn resolver (endpoint/CA come from EKS DescribeCluster)")
		}
		if out["eks_cluster_name"] != "my-eks" || len(out) != 1 {
			t.Errorf("aws outputs = %v, want just the cluster name", out)
		}
	})

	// gcp: resolver supplies endpoint+CA, stored under the GKE output keys ConfigureKubeconfig reads.
	t.Run("gcp injects endpoint+CA", func(t *testing.T) {
		resolver := func(_ context.Context, slug string, c *types.ProjectConfig, cluster string) (string, string, error) {
			if slug != "gcp" || c != cfg || cluster != "my-gke" {
				t.Errorf("resolver got (%q, %v, %q), want (gcp, cfg, my-gke)", slug, c, cluster)
			}
			return "https://1.2.3.4", "CA==", nil
		}
		out, err := mintClusterOutputs(ctx, resolver, nil, "gcp", cfg, "my-gke", "gke_cluster_name")
		if err != nil {
			t.Fatalf("gcp: unexpected error: %v", err)
		}
		if out["gke_cluster_name"] != "my-gke" ||
			out["gke_cluster_endpoint"] != "https://1.2.3.4" ||
			out["gke_cluster_ca_certificate"] != "CA==" {
			t.Errorf("gcp outputs = %v, want name+endpoint+CA under the GKE keys", out)
		}
	})

	// A cloud that needs a conn but was handed no resolver is a runner wiring bug — fail closed.
	t.Run("gcp nil resolver fails closed", func(t *testing.T) {
		if _, err := mintClusterOutputs(ctx, nil, nil, "gcp", cfg, "my-gke", "gke_cluster_name"); err == nil {
			t.Error("gcp with a nil resolver = nil error, want a wiring-bug error")
		}
	})

	// A resolver error propagates; an empty endpoint/CA is rejected (never a half-built kubeconfig).
	t.Run("gcp resolver error propagates", func(t *testing.T) {
		boom := func(context.Context, string, *types.ProjectConfig, string) (string, string, error) {
			return "", "", io.ErrUnexpectedEOF
		}
		if _, err := mintClusterOutputs(ctx, boom, nil, "gcp", cfg, "my-gke", "gke_cluster_name"); err == nil {
			t.Error("gcp resolver error = nil, want it propagated")
		}
		empty := func(context.Context, string, *types.ProjectConfig, string) (string, string, error) {
			return "", "CA==", nil
		}
		if _, err := mintClusterOutputs(ctx, empty, nil, "gcp", cfg, "my-gke", "gke_cluster_name"); err == nil {
			t.Error("gcp resolver empty endpoint = nil, want a fail-closed error")
		}
	})

	// hetzner: no cloud API — the injected Talos minter supplies a full kubeconfig, stored under the
	// `kubeconfig` key ConfigureKubeconfig reads. The KubeConnResolver is never consulted.
	t.Run("hetzner talos minter supplies kubeconfig", func(t *testing.T) {
		resolverCalled := false
		resolver := func(context.Context, string, *types.ProjectConfig, string) (string, string, error) {
			resolverCalled = true
			return "", "", nil
		}
		minter := func(_ context.Context, c *types.ProjectConfig, cluster string) (string, error) {
			if c != cfg || cluster != "talos-1" {
				t.Errorf("minter got (%v, %q), want (cfg, talos-1)", c, cluster)
			}
			return "apiVersion: v1\nkind: Config\n", nil
		}
		out, err := mintClusterOutputs(ctx, resolver, minter, "hetzner", cfg, "talos-1", "talos_cluster_name")
		if err != nil {
			t.Fatalf("hetzner: unexpected error: %v", err)
		}
		if resolverCalled {
			t.Error("hetzner must not invoke the cloud KubeConnResolver (Talos has no cloud API)")
		}
		if out["talos_cluster_name"] != "talos-1" || out["kubeconfig"] != "apiVersion: v1\nkind: Config\n" {
			t.Errorf("hetzner outputs = %v, want name + minted kubeconfig", out)
		}
	})

	// hetzner with no injected minter is a runner wiring bug — fail closed.
	t.Run("hetzner nil minter fails closed", func(t *testing.T) {
		if _, err := mintClusterOutputs(ctx, nil, nil, "hetzner", cfg, "talos-1", "talos_cluster_name"); err == nil {
			t.Error("hetzner with a nil Talos minter = nil error, want a wiring-bug error")
		}
	})

	// A minter error propagates; an empty kubeconfig is rejected (never an unusable config).
	t.Run("hetzner minter error / empty fails closed", func(t *testing.T) {
		boom := func(context.Context, *types.ProjectConfig, string) (string, error) { return "", io.ErrUnexpectedEOF }
		if _, err := mintClusterOutputs(ctx, nil, boom, "hetzner", cfg, "talos-1", "talos_cluster_name"); err == nil {
			t.Error("hetzner minter error = nil, want it propagated")
		}
		blank := func(context.Context, *types.ProjectConfig, string) (string, error) { return "  ", nil }
		if _, err := mintClusterOutputs(ctx, nil, blank, "hetzner", cfg, "talos-1", "talos_cluster_name"); err == nil {
			t.Error("hetzner empty kubeconfig = nil, want a fail-closed error")
		}
	})
}

// TestHetznerNamespaceIdentityIsDocumentedNoOp locks the explicit per-cloud exclusion: hetzner-talos has no
// cloud IAM, so provisionAndBindNamespaceIdentity returns nil (k8s-native isolation only) rather than
// fail-closing like an unwired cloud — a documented no-op, not a silent one.
func TestHetznerNamespaceIdentityIsDocumentedNoOp(t *testing.T) {
	// nil identity provisioner + nil config are safe: the hetzner case touches neither (no cloud call).
	if err := provisionAndBindNamespaceIdentity(context.Background(), nil, "hetzner", "fsn1", nil, "talos-1", "team-web", io.Discard, io.Discard); err != nil {
		t.Errorf("provisionAndBindNamespaceIdentity(hetzner) = %v, want nil (k8s-native isolation, no cloud IAM)", err)
	}
}

func TestUnactivatedPlacementError(t *testing.T) {
	// namespace on a non-aws cloud names the cloud and the per-cloud reason (parity is documented, not
	// silent) and points at aws as the working cloud.
	nsErr := unactivatedPlacementError(types.PlacementModeNamespace, "alibaba")
	if nsErr == nil {
		t.Fatal("expected error")
	}
	msg := nsErr.Error()
	for _, want := range []string{"namespace", "alibaba", "aws"} {
		if !strings.Contains(msg, want) {
			t.Errorf("namespace error %q missing %q", msg, want)
		}
	}

	// vcluster on an un-activated cloud names the cloud and the per-cloud reason (parity is documented,
	// not silent) and points at a working cloud. hetzner-talos is the permanent exclusion (aws/gcp/azure
	// and now alibaba are activated).
	vcErr := unactivatedPlacementError(types.PlacementModeVcluster, "hetzner")
	if vcErr == nil {
		t.Fatal("expected error")
	}
	for _, want := range []string{"vcluster", "hetzner", "aws"} {
		if !strings.Contains(vcErr.Error(), want) {
			t.Errorf("vcluster error %q missing %q", vcErr.Error(), want)
		}
	}
}

func TestNamespaceRemintSeam(t *testing.T) {
	// The allowlist is the single activation control: aws + gcp + azure (managed output-free mint +
	// identity), alibaba (ACK resolve + RRSA per-namespace RAM role) and hetzner (persisted-talosconfig
	// Talos mint, k8s-native isolation) are ALL wired now that azure landed — every supported cloud.
	for _, p := range []string{"aws", "gcp", "azure", "alibaba", "hetzner"} {
		if !namespaceRemintWired(p) {
			t.Errorf("namespaceRemintWired(%q) = false, want true (activated)", p)
		}
	}
	// No supported cloud remains unwired, so only an unrecognized provider fails closed.
	for _, p := range []string{"digitalocean", ""} {
		if namespaceRemintWired(p) {
			t.Errorf("namespaceRemintWired(%q) = true, want false (not yet wired)", p)
		}
	}

	// The fail-closed error names the offending provider AND enumerates what IS activated (parity is
	// documented, never silent). With every supported cloud wired, the only caller left is an
	// unrecognized provider — so that is what this asserts on.
	err := namespaceRemintNotWired("digitalocean")
	if err == nil {
		t.Fatal("expected error")
	}
	for _, want := range []string{"digitalocean", "aws", "gcp", "azure", "alibaba", "hetzner"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("namespaceRemintNotWired error %q missing %q", err.Error(), want)
		}
	}

	// The mint seam fails closed for an unwired cloud BEFORE touching the CloudProvider — a nil provider
	// is safe precisely because the guard returns first (defence-in-depth behind selectPlacementPath).
	// Uses an UNRECOGNIZED cloud deliberately: every supported one is wired now, so naming a real cloud
	// here would pass on whatever error it happened to hit rather than on the not-wired guard.
	if err := mintNamespaceKubeAccess(context.Background(), nil, nil, nil, nil, "digitalocean", "some-cluster", io.Discard); err == nil {
		t.Error("mintNamespaceKubeAccess(digitalocean) = nil, want fail-closed error (re-mint not wired)")
	}

	// Same for the identity seam's default case — no cloud calls, no silent no-op.
	if err := provisionAndBindNamespaceIdentity(context.Background(), nil, "digitalocean", "eu-west-1", nil, "some-cluster", "ns", io.Discard, io.Discard); err == nil {
		t.Error("provisionAndBindNamespaceIdentity(digitalocean) = nil, want fail-closed error (identity not wired)")
	}

	// gcp and azure namespace identity both need an injected provisioner — a nil one is a runner wiring
	// bug, fail closed (never a silent skip that would leave the tenant SA with the cluster node role).
	for _, p := range []struct{ cloud, region string }{{"gcp", "us-central1"}, {"azure", "eu-west-1"}} {
		if err := provisionAndBindNamespaceIdentity(context.Background(), nil, p.cloud, p.region, nil, "some-cluster", "ns", io.Discard, io.Discard); err == nil {
			t.Errorf("provisionAndBindNamespaceIdentity(%s, nil provisioner) = nil, want a wiring-bug error", p.cloud)
		}
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
