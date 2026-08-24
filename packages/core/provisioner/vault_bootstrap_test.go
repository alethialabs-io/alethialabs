// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"io"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func hetznerSecretProject(names ...string) *types.ProjectConfig {
	vc := &types.ProjectConfig{Provider: "hetzner"}
	for _, n := range names {
		vc.Secrets = append(vc.Secrets, types.ProjectSecretConfig{Name: n, Generate: true, Length: 32})
	}
	return vc
}

// Every cloud but Hetzner has a real secret store, so running this path there would apply a Job
// against a Vault that was never installed and a ClusterSecretStore pointing at a Service that does
// not exist — while the cloud's OWN store is the one ESO should read.
func TestBootstrapInClusterVaultIsAHetznerOnlyNoOp(t *testing.T) {
	for _, provider := range []string{"aws", "gcp", "azure", "alibaba"} {
		vc := hetznerSecretProject("api-key")
		vc.Provider = types.CloudProvider(provider)
		facts := &argocd.InfraFacts{Provider: provider, HetznerInClusterVault: true}
		var out, errOut strings.Builder
		bootstrapInClusterVault(context.Background(), vc, facts, &out, &errOut)
		if out.Len() != 0 || errOut.Len() != 0 {
			t.Errorf("%s attempted an in-cluster Vault bootstrap: out=%q err=%q", provider, out.String(), errOut.String())
		}
	}
}

// A Hetzner project that declares no secret gets no Vault: two 10 GiB volumes and an audit surface
// for a capability nobody asked for.
func TestBootstrapInClusterVaultIsANoOpWithNoSecret(t *testing.T) {
	var out, errOut strings.Builder
	bootstrapInClusterVault(context.Background(), hetznerSecretProject(),
		&argocd.InfraFacts{Provider: "hetzner"}, &out, &errOut)
	if out.Len() != 0 || errOut.Len() != 0 {
		t.Errorf("a project with no secret installed a Vault: out=%q err=%q", out.String(), errOut.String())
	}
}

// Non-fatal by design, like the add-on, Karpenter and registry paths: the Job waits for Vault on its
// own and the store re-reconciles, so a Vault still converging must not fail a healthy cluster. The
// function has no error return for exactly that reason — so this asserts it REPORTS rather than
// panics or silently swallows.
func TestBootstrapInClusterVaultIsNonFatalAndReportsBothHalves(t *testing.T) {
	// No kubectl on PATH → every call fails.
	t.Setenv("PATH", t.TempDir())
	var errOut strings.Builder
	bootstrapInClusterVault(context.Background(), hetznerSecretProject("api-key"),
		&argocd.InfraFacts{Provider: "hetzner", HetznerInClusterVault: true}, io.Discard, &errOut)

	got := errOut.String()
	// BOTH halves must be attempted and both failures reported. Returning after the first would
	// leave the store unapplied on every deploy where the Job apply happened to fail — and the store
	// is the half ESO reads, so the kind would be undelivered with only a Job warning to show for it.
	if !strings.Contains(got, "Vault bootstrap skipped") {
		t.Errorf("the Job failure was not reported: %q", got)
	}
	if !strings.Contains(got, "ClusterSecretStore not applied") {
		t.Errorf("the store failure was not reported — the second half was skipped after the first failed: %q", got)
	}
}
