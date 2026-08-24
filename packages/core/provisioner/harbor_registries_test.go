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

// Every cloud but Hetzner provisions a REAL registry whose nodes authenticate with their own
// identity, so there is nothing to seed and nothing to mint. Running the Harbor path there would
// create Jobs against a registry that does not exist.
func TestCredentialInClusterRegistriesIsAHetznerOnlyNoOp(t *testing.T) {
	for _, provider := range []string{"aws", "gcp", "azure", "alibaba"} {
		vc := &types.ProjectConfig{
			Provider:            types.CloudProvider(provider),
			ContainerRegistries: []types.ProjectContainerRegistryConfig{{Name: "app-images"}},
		}
		var out, errOut strings.Builder
		credentialInClusterRegistries(context.Background(), vc, &out, &errOut)
		if out.Len() != 0 || errOut.Len() != 0 {
			t.Errorf("%s attempted in-cluster registry credentials: out=%q err=%q", provider, out.String(), errOut.String())
		}
	}
}

// A registry still converging must not fail an otherwise-healthy cluster: the Job retries, and the
// next deploy re-runs this — a no-op once the credential works.
func TestCredentialInClusterRegistriesIsNonFatal(t *testing.T) {
	vc := &types.ProjectConfig{
		Provider:            "hetzner",
		ContainerRegistries: []types.ProjectContainerRegistryConfig{{Name: "app-images"}},
	}
	// No kubectl on PATH → every call fails. The function must report and return, never panic or
	// propagate: it has no error return by design.
	t.Setenv("PATH", t.TempDir())
	var errOut strings.Builder
	credentialInClusterRegistries(context.Background(), vc, io.Discard, &errOut)
	if !strings.Contains(errOut.String(), "app-images") {
		t.Errorf("a failure was not reported: %q", errOut.String())
	}
}
