// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestHygCoreCategoriesPublicECRRegistryHostCheckFires pins that the oci-public-ecr registry-host
// validation is REACHABLE (#2087). The old guard routed through pcString, which substitutes its
// non-empty default for a missing, null or explicitly-empty value — so `== ""` could never be true
// and the error was unemittable. Each rejected case below returns nil on the unfixed code.
func TestHygCoreCategoriesPublicECRRegistryHostCheckFires(t *testing.T) {
	p, err := Get("helm_registry", "oci-public-ecr")
	if err != nil {
		t.Fatal(err)
	}

	for _, tt := range []struct {
		name    string
		pc      map[string]any
		wantErr bool
	}{
		{name: "unset provider_config", pc: nil},
		{name: "key absent", pc: map[string]any{"region": "us-east-1"}},
		{name: "explicit null is unset", pc: map[string]any{"registry_host": nil}},
		{name: "the fixed host is accepted", pc: map[string]any{"registry_host": "public.ecr.aws"}},
		{name: "surrounding whitespace is tolerated", pc: map[string]any{"registry_host": "  public.ecr.aws "}},
		{name: "explicitly empty is rejected", pc: map[string]any{"registry_host": ""}, wantErr: true},
		{name: "blank is rejected", pc: map[string]any{"registry_host": "   "}, wantErr: true},
		{name: "a foreign host is rejected", pc: map[string]any{"registry_host": "evil.example.test"}, wantErr: true},
		{name: "a non-string scalar is rejected", pc: map[string]any{"registry_host": 42}, wantErr: true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			err := p.Validate(ComponentContext{ProviderConfig: tt.pc})
			if tt.wantErr && err == nil {
				t.Fatalf("Validate(%v) = nil, want an error naming the fixed host", tt.pc)
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("Validate(%v) = %v, want nil", tt.pc, err)
			}
			if tt.wantErr && !strings.Contains(err.Error(), "public.ecr.aws") {
				t.Fatalf("error %q should name the fixed host", err)
			}
		})
	}
}

// TestHygCoreCategoriesPublicECRHostIsPinned pins the host-trust half of #2087: the keyless target
// takes the ECR Public host from a constant, never from provider_config. The refresher mints the
// token under the CLUSTER's own IRSA, so an operator-supplied host would seed that token as an
// ArgoCD repo credential for a registry the customer never connected.
func TestHygCoreCategoriesPublicECRHostIsPinned(t *testing.T) {
	p, err := Get("helm_registry", "oci-public-ecr")
	if err != nil {
		t.Fatal(err)
	}

	// Precondition: the attacker-supplied host is genuinely present in the context we pass.
	pc := map[string]any{"registry_host": "evil.example.test"}
	if pcString(pc, "registry_host", publicECRRegistryHost) != "evil.example.test" {
		t.Fatal("precondition: provider_config must actually carry the foreign host")
	}

	tgt, ok := p.KeylessRepoCred(ComponentContext{ProviderConfig: pc})
	if !ok {
		t.Fatal("oci-public-ecr must register a keylessRepoCred")
	}
	if tgt.RegistryHost != publicECRRegistryHost {
		t.Errorf("RegistryHost = %q, want the pinned %q", tgt.RegistryHost, publicECRRegistryHost)
	}
	if tgt.RepoURL() != "oci://"+publicECRRegistryHost {
		t.Errorf("RepoURL = %q, want oci://%s", tgt.RepoURL(), publicECRRegistryHost)
	}

	// End to end: KeylessHelmRepoTargets validates first, so the foreign host is skipped fail-closed
	// with an error rather than yielding a target at all.
	vc := &types.ProjectConfig{
		HelmRegistries: []types.ProjectHelmRegistryConfig{{Name: "charts", Provider: "oci-public-ecr", ProviderConfig: pc}},
	}
	targets, err := KeylessHelmRepoTargets(vc)
	if err == nil {
		t.Error("KeylessHelmRepoTargets should report the rejected host")
	}
	if len(targets) != 0 {
		t.Errorf("a rejected host must yield no target, got %+v", targets)
	}
}

// TestHygCoreCategoriesHelmRegistryPredicateEquivalence pins the invariant that made the removed
// HelmRepoCredSpecs diagnostic unemittable (#2088): IsHelmRegistry(slug) and the ok returned by
// CategoryProvider.RepoCred are the SAME `repoCred != nil` test on the same behavior value. The
// removed arm was dead because of it, so if a future change ever separates the two, this fails
// rather than the fail-closed skip silently becoming a real gap.
func TestHygCoreCategoriesHelmRegistryPredicateEquivalence(t *testing.T) {
	var checked int
	for key := range behaviors {
		slug, isHelm := strings.CutPrefix(key, "helm_registry/")
		if !isHelm {
			continue
		}
		checked++
		p, err := Get("helm_registry", slug)
		if err != nil {
			t.Fatalf("Get(helm_registry, %q): %v", slug, err)
		}
		_, ok := p.RepoCred(ComponentContext{})
		if ok != IsHelmRegistry(slug) {
			t.Errorf("%s: RepoCred ok = %v but IsHelmRegistry = %v — the predicates have diverged, so HelmRepoCredSpecs now needs a live !ok arm again", slug, ok, IsHelmRegistry(slug))
		}
	}
	if checked == 0 {
		t.Fatal("precondition: no helm_registry behaviors were enumerated")
	}
}
