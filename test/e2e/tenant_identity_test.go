// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestTenantIdentityForProvider(t *testing.T) {
	cases := map[string]struct {
		annotation string
		excluded   bool
	}{
		"aws":     {annotation: "eks.amazonaws.com/role-arn"},
		"gcp":     {annotation: "iam.gke.io/gcp-service-account"},
		"azure":   {annotation: "azure.workload.identity/client-id"},
		"alibaba": {annotation: "pod-identity.alibabacloud.com/role-name"},
		"hetzner": {excluded: true},
	}
	for provider, want := range cases {
		t.Run(provider, func(t *testing.T) {
			got, err := tenantIdentityForProvider(provider)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got.Excluded != want.excluded {
				t.Fatalf("excluded = %t, want %t", got.Excluded, want.excluded)
			}
			if got.SAAnnotation != want.annotation {
				t.Fatalf("SAAnnotation = %q, want %q", got.SAAnnotation, want.annotation)
			}
			if want.excluded && strings.TrimSpace(got.Reason) == "" {
				t.Fatal("an excluded cloud must carry a REASON — an exclusion without one is indistinguishable from an oversight")
			}
		})
	}

	// Case and whitespace must not change the contract.
	if got, _ := tenantIdentityForProvider(" AWS "); got.SAAnnotation != "eks.amazonaws.com/role-arn" {
		t.Errorf("provider resolution must be case/space insensitive, got %+v", got)
	}

	// An unrecognised cloud must fail LOUD. A silent skip is how a cloud ends up shipping with no
	// tenant isolation while the board reads green.
	if _, err := tenantIdentityForProvider("newcloud"); err == nil {
		t.Fatal("an unrecognised provider must be a hard error, never a quiet skip")
	}
}

// TestTenantIdentityMirrorsTheProduct is the drift guard.
//
// The annotation keys above are a SECOND source of truth for something the product already states in
// deploy_namespace.go. That is exactly the shape that silently rots: the product renames an
// annotation, this harness keeps asserting the old key, and the assertion either fails for the wrong
// reason or — worse — is loosened until it passes. So read the product source and require every key
// this file asserts to appear in it verbatim.
func TestTenantIdentityMirrorsTheProduct(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	src, err := os.ReadFile(filepath.Join(filepath.Dir(thisFile), "..", "..",
		"packages", "core", "provisioner", "deploy_namespace.go"))
	if err != nil {
		t.Fatalf("read deploy_namespace.go: %v", err)
	}
	body := string(src)

	for _, provider := range []string{"aws", "gcp", "azure", "alibaba", "hetzner"} {
		b, err := tenantIdentityForProvider(provider)
		if err != nil {
			t.Fatalf("%s: %v", provider, err)
		}
		for _, key := range []string{b.SAAnnotation, b.SALabel, b.NamespaceLabel} {
			if key == "" {
				continue
			}
			if !strings.Contains(body, key) {
				t.Errorf("%s: this harness asserts %q, which deploy_namespace.go never mentions — the product's binding contract has moved and the assertion is now checking a key nothing writes", provider, key)
			}
		}
	}
}

func TestTenantIdentityVerdictPass(t *testing.T) {
	bound := TenantIdentitySummary{
		Provider: "aws", Namespace: "tenant-a", Mechanism: "IRSA",
		Bound: true, IdentityRef: "arn:aws:iam::1234:role/alethia-ns-tenant-a-abcd1234",
		AutomountDisabled: true,
	}
	if !tenantIdentityVerdictPass(bound) {
		t.Fatal("a genuinely bound identity must pass")
	}

	refuters := map[string]func(*TenantIdentitySummary){
		"not bound at all":                func(s *TenantIdentitySummary) { s.Bound = false },
		"bound but names no identity":     func(s *TenantIdentitySummary) { s.IdentityRef = "" },
		"bound but the ref is whitespace": func(s *TenantIdentitySummary) { s.IdentityRef = "   " },
	}
	for name, breakOne := range refuters {
		t.Run("refutes/"+name, func(t *testing.T) {
			s := bound
			breakOne(&s)
			if tenantIdentityVerdictPass(s) {
				t.Fatalf("%q still read green", name)
			}
		})
	}

	// An excluded cloud passes by binding NOTHING.
	excluded := TenantIdentitySummary{Provider: "hetzner", Excluded: true, Reason: "no cloud IAM"}
	if !tenantIdentityVerdictPass(excluded) {
		t.Fatal("a documented exclusion that bound nothing must pass")
	}

	// …and FAILS if an identity turns up anyway. That would mean the documented exclusion is wrong,
	// which is a finding, not a pass.
	surprise := excluded
	surprise.Bound = true
	surprise.IdentityRef = "arn:aws:iam::1234:role/whoops"
	if tenantIdentityVerdictPass(surprise) {
		t.Fatal("an identity appearing on a cloud documented as having none must FAIL — the exclusion is then wrong, and silently accepting it would keep the wrong documentation forever")
	}
}

func TestTenantIdentityVerdictRendering(t *testing.T) {
	bound := TenantIdentitySummary{
		Provider: "gcp", Namespace: "tenant-a", Mechanism: "GKE Workload Identity",
		Bound: true, IdentityRef: "nsid-abc@proj.iam.gserviceaccount.com", AutomountDisabled: true,
	}
	got := tenantIdentityVerdict(bound)
	for _, want := range []string{"✅", "gcp", "tenant-a", "GKE Workload Identity", "automount disabled=true"} {
		if !strings.Contains(got, want) {
			t.Errorf("verdict %q is missing %q", got, want)
		}
	}

	excl := tenantIdentityVerdict(TenantIdentitySummary{Provider: "hetzner", Excluded: true, Reason: "no cloud IAM"})
	if !strings.Contains(excl, "NO cloud identity by design") || !strings.Contains(excl, "no cloud IAM") {
		t.Errorf("an exclusion must read as a deliberate design limit with its reason, got %q", excl)
	}

	if !strings.Contains(tenantIdentityVerdict(TenantIdentitySummary{Provider: "aws"}), "❌") {
		t.Error("an unbound identity must render ❌")
	}
}
