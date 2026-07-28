// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestHelmRegistryModulePath asserts every helm_registry provider is runner-seeded (an ArgoCD
// repository credential applied post-apply), so it carries NO tofu module → empty module_path, and
// that the Get() meta+behavior tripwire is satisfied for all 8 slugs (incl. the coming_soon ones).
func TestHelmRegistryModulePath(t *testing.T) {
	for _, slug := range []string{
		"helm-https", "oci-docker-hub", "oci-github-cr", "oci-gitlab-cr",
		"oci-generic-cr", "oci-scaleway-cr", "oci-ecr", "oci-public-ecr",
	} {
		t.Run(slug, func(t *testing.T) {
			p, err := Get("helm_registry", slug)
			if err != nil {
				t.Fatalf("Get(helm_registry, %q) unexpected error: %v", slug, err)
			}
			if got := p.ModulePath(); got != "" {
				t.Errorf("ModulePath() = %q, want empty (runner-seeded)", got)
			}
		})
	}
}

// TestHelmRegistryRepoCred asserts each active provider's repoCred mapping — the chart-repo URL
// (oci:// vs https://), the EnableOCI flag, and the username/password wiring.
func TestHelmRegistryRepoCred(t *testing.T) {
	tests := []struct {
		slug     string
		creds    map[string]string
		pc       map[string]any
		wantURL  string
		wantUser string
		wantPass string
		wantOCI  bool
	}{
		{
			slug:    "helm-https",
			creds:   map[string]string{"username": "alice", "password": "pw"},
			pc:      map[string]any{"repo_url": "https://charts.example.com"},
			wantURL: "https://charts.example.com", wantUser: "alice", wantPass: "pw", wantOCI: false,
		},
		{
			slug:    "oci-docker-hub",
			creds:   map[string]string{"username": "bob", "access_token": "tok"},
			wantURL: "oci://registry-1.docker.io", wantUser: "bob", wantPass: "tok", wantOCI: true,
		},
		{
			slug:    "oci-github-cr",
			creds:   map[string]string{"username": "carol", "password": "pat"},
			wantURL: "oci://ghcr.io", wantUser: "carol", wantPass: "pat", wantOCI: true,
		},
		{
			slug:    "oci-gitlab-cr",
			creds:   map[string]string{"username": "dan", "password": "dt"},
			wantURL: "oci://registry.gitlab.com", wantUser: "dan", wantPass: "dt", wantOCI: true,
		},
		{
			slug:    "oci-gitlab-cr (self-managed host)",
			creds:   map[string]string{"username": "dan", "password": "dt"},
			pc:      map[string]any{"registry_host": "registry.gitlab.acme.io"},
			wantURL: "oci://registry.gitlab.acme.io", wantUser: "dan", wantPass: "dt", wantOCI: true,
		},
		{
			slug:    "oci-generic-cr",
			creds:   map[string]string{"username": "eve", "password": "pw"},
			pc:      map[string]any{"registry_host": "registry.acme.io"},
			wantURL: "oci://registry.acme.io", wantUser: "eve", wantPass: "pw", wantOCI: true,
		},
		{
			slug:    "oci-scaleway-cr",
			creds:   map[string]string{"secret_key": "sk"},
			pc:      map[string]any{"registry_host": "rg.fr-par.scw.cloud"},
			wantURL: "oci://rg.fr-par.scw.cloud", wantUser: "nologin", wantPass: "sk", wantOCI: true,
		},
	}
	for _, tt := range tests {
		slug := strings.Fields(tt.slug)[0] // allow a descriptive suffix in the subtest name
		t.Run(tt.slug, func(t *testing.T) {
			p, err := Get("helm_registry", slug)
			if err != nil {
				t.Fatal(err)
			}
			cred, ok := p.RepoCred(ComponentContext{Credentials: tt.creds, ProviderConfig: tt.pc})
			if !ok {
				t.Fatalf("%s should register a repoCred", slug)
			}
			if cred.URL != tt.wantURL || cred.Username != tt.wantUser || cred.Password != tt.wantPass || cred.EnableOCI != tt.wantOCI {
				t.Errorf("RepoCred = %+v, want {URL:%q User:%q Pass:%q OCI:%v}",
					cred, tt.wantURL, tt.wantUser, tt.wantPass, tt.wantOCI)
			}
		})
	}
}

// TestHelmRegistryKeylessECR asserts the ECR slugs route to the KEYLESS path (#1185), not the static
// one: no seedable repoCred (IsHelmRegistry false → HelmRepoCredSpecs skips them), a keylessRepoCred
// present (IsKeylessHelmRegistry true), and a Validate that enforces the cross-account provider_config.
func TestHelmRegistryKeylessECR(t *testing.T) {
	for _, slug := range []string{"oci-ecr", "oci-public-ecr"} {
		t.Run(slug, func(t *testing.T) {
			if IsHelmRegistry(slug) {
				t.Errorf("%s must NOT be a static/seedable helm_registry (it is keyless)", slug)
			}
			if !IsKeylessHelmRegistry(slug) {
				t.Errorf("%s must be a keyless helm_registry", slug)
			}
			p, err := Get("helm_registry", slug)
			if err != nil {
				t.Fatalf("Get should resolve %q (meta+behavior present): %v", slug, err)
			}
			if _, ok := p.RepoCred(ComponentContext{}); ok {
				t.Errorf("%s must register no static repoCred", slug)
			}
			if _, ok := p.KeylessRepoCred(ComponentContext{}); !ok {
				t.Errorf("%s must register a keylessRepoCred", slug)
			}
		})
	}

	// oci-ecr (private): Validate requires the full cross-account provider_config; empty errors.
	pEcr, _ := Get("helm_registry", "oci-ecr")
	if err := pEcr.Validate(ComponentContext{}); err == nil {
		t.Error("oci-ecr Validate should error on empty provider_config")
	}
	fullEcr := map[string]any{
		"target_account_id": "111122223333",
		"region":            "us-east-1",
		"registry_host":     "111122223333.dkr.ecr.us-east-1.amazonaws.com",
		"target_role_arn":   "arn:aws:iam::111122223333:role/ecr-helm-pull",
	}
	if err := pEcr.Validate(ComponentContext{ProviderConfig: fullEcr}); err != nil {
		t.Errorf("oci-ecr Validate should pass with full config: %v", err)
	}
	tgt, ok := pEcr.KeylessRepoCred(ComponentContext{ProviderConfig: fullEcr})
	if !ok {
		t.Fatal("oci-ecr KeylessRepoCred missing")
	}
	if tgt.Provider != "aws" || tgt.Public || tgt.TargetRoleArn == "" || tgt.RegistryHost == "" || tgt.Region == "" || tgt.TargetAccountID == "" {
		t.Errorf("oci-ecr target = %+v, want a populated aws private target", tgt)
	}
	if want := "oci://" + fullEcr["registry_host"].(string); tgt.RepoURL() != want {
		t.Errorf("RepoURL = %q, want %q", tgt.RepoURL(), want)
	}

	// oci-public-ecr: no target role/account; fixed host + us-east-1; Public true; Validate passes on
	// defaults (nothing required).
	pPub, _ := Get("helm_registry", "oci-public-ecr")
	if err := pPub.Validate(ComponentContext{}); err != nil {
		t.Errorf("oci-public-ecr Validate should pass with defaults: %v", err)
	}
	pt, ok := pPub.KeylessRepoCred(ComponentContext{})
	if !ok {
		t.Fatal("oci-public-ecr KeylessRepoCred missing")
	}
	if !pt.Public || pt.RegistryHost != "public.ecr.aws" || pt.Region != "us-east-1" || pt.TargetRoleArn != "" {
		t.Errorf("oci-public-ecr target = %+v, want a public us-east-1 no-role target", pt)
	}
}

// helmProject wires a project selecting one helm_registry with the given provider_config + creds.
func helmProject(slug string, pc map[string]any, creds map[string]string) *types.ProjectConfig {
	vc := &types.ProjectConfig{
		HelmRegistries: []types.ProjectHelmRegistryConfig{{Name: "charts", Provider: slug, ProviderConfig: pc}},
	}
	if creds != nil {
		vc.ConnectorCredentials = []types.ConnectorCredential{
			{Category: "helm_registry", Slug: slug, Credentials: creds},
		}
	}
	return vc
}

func TestHelmRepoCredSpecs(t *testing.T) {
	// None / native → no specs, no error.
	for _, tt := range []struct {
		name string
		regs []types.ProjectHelmRegistryConfig
	}{
		{"no helm registries", nil},
		{"native/empty is skipped", []types.ProjectHelmRegistryConfig{{Name: "x", Provider: ""}}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			specs, err := HelmRepoCredSpecs(&types.ProjectConfig{HelmRegistries: tt.regs})
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(specs) != 0 {
				t.Fatalf("expected no specs, got %+v", specs)
			}
		})
	}

	// A selected provider missing its credential fails closed (skipped + error), not a half-built spec.
	specs, err := HelmRepoCredSpecs(helmProject("oci-github-cr", nil, nil))
	if err == nil {
		t.Fatal("expected a validation error for oci-github-cr with no credential")
	}
	if len(specs) != 0 {
		t.Fatalf("a failed-validation entry must not yield a spec, got %+v", specs)
	}

	// A keyless ECR slug is excluded from the STATIC path structurally (no repoCred) — even with a fully
	// valid provider_config, HelmRepoCredSpecs yields no spec and no error (it routes to the keyless
	// refresher instead, not the static seed).
	specs, err = HelmRepoCredSpecs(helmProject("oci-ecr", map[string]any{
		"target_account_id": "111122223333",
		"region":            "us-east-1",
		"registry_host":     "111122223333.dkr.ecr.us-east-1.amazonaws.com",
		"target_role_arn":   "arn:aws:iam::111122223333:role/ecr-helm-pull",
	}, nil))
	if err != nil {
		t.Fatalf("keyless slug should skip the static path silently, got error: %v", err)
	}
	if len(specs) != 0 {
		t.Fatalf("keyless slug must yield no static spec, got %+v", specs)
	}

	// Fully connected → one spec with a deterministic name derived from the URL.
	vc := helmProject("oci-github-cr", nil, map[string]string{"username": "carol", "password": "pat"})
	specs, err = HelmRepoCredSpecs(vc)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(specs) != 1 {
		t.Fatalf("expected exactly one spec, got %d", len(specs))
	}
	s := specs[0]
	if s.URL != "oci://ghcr.io" || s.Username != "carol" || s.Password != "pat" || !s.EnableOCI {
		t.Errorf("spec = %+v, want ghcr oci creds", s)
	}
	if want := HelmRepoCredSecretName("oci://ghcr.io"); s.Name != want {
		t.Errorf("Name = %q, want deterministic %q", s.Name, want)
	}
	if !strings.HasPrefix(s.Name, "repo-helm-") {
		t.Errorf("Name = %q, want repo-helm- prefix", s.Name)
	}
}

// helmProjectMulti builds a project with several connected chart repos, for the matcher tests.
func helmProjectMulti(entries ...types.ProjectHelmRegistryConfig) *types.ProjectConfig {
	vc := &types.ProjectConfig{HelmRegistries: entries}
	seen := map[string]bool{}
	for _, e := range entries {
		if e.Provider == "" || seen[e.Provider] {
			continue
		}
		seen[e.Provider] = true
		vc.ConnectorCredentials = append(vc.ConnectorCredentials, types.ConnectorCredential{
			Category: "helm_registry", Slug: e.Provider,
			Credentials: map[string]string{
				"username": "u-" + e.Provider, "password": "p-" + e.Provider,
				"access_token": "p-" + e.Provider, "secret_key": "p-" + e.Provider,
			},
		})
	}
	return vc
}

// TestRepoCredForChartRepo covers the credential the CHART_SCAN path authenticates an OCI chart
// pull with. It must resolve exactly the way ArgoCD resolves an Application's repository credential
// — longest URL prefix — or a chart could scan under one credential and deploy under another.
func TestRepoCredForChartRepo(t *testing.T) {
	ghcr := types.ProjectHelmRegistryConfig{Name: "ghcr", Provider: "oci-github-cr"}
	generic := func(host string) types.ProjectHelmRegistryConfig {
		return types.ProjectHelmRegistryConfig{
			Name: "generic-" + host, Provider: "oci-generic-cr",
			ProviderConfig: map[string]any{"registry_host": host},
		}
	}
	https := types.ProjectHelmRegistryConfig{
		Name: "https", Provider: "helm-https",
		ProviderConfig: map[string]any{"repo_url": "https://charts.example.com"},
	}

	tests := []struct {
		name     string
		vc       *types.ProjectConfig
		chart    string
		wantOK   bool
		wantURL  string
		wantUser string
	}{
		{
			name: "host match", vc: helmProjectMulti(ghcr),
			chart:  "oci://ghcr.io/acme/charts/redis",
			wantOK: true, wantURL: "oci://ghcr.io", wantUser: "u-oci-github-cr",
		},
		{
			name: "exact URL match", vc: helmProjectMulti(ghcr),
			chart:  "oci://ghcr.io",
			wantOK: true, wantURL: "oci://ghcr.io",
		},
		{
			name: "case-insensitive host", vc: helmProjectMulti(ghcr),
			chart:  "oci://GHCR.IO/acme/redis",
			wantOK: true, wantURL: "oci://ghcr.io",
		},
		{
			name: "no connected repo covers the host", vc: helmProjectMulti(ghcr),
			chart: "oci://registry.acme.io/team/app", wantOK: false,
		},
		{
			name: "no chart repos connected at all", vc: &types.ProjectConfig{},
			chart: "oci://ghcr.io/acme/redis", wantOK: false,
		},
		{
			name: "an HTTPS chart repo never authenticates an OCI pull", vc: helmProjectMulti(https),
			chart: "oci://charts.example.com/acme/redis", wantOK: false,
		},
		{
			name:  "coming_soon keyless slug yields nothing",
			vc:    helmProjectMulti(types.ProjectHelmRegistryConfig{Name: "ecr", Provider: "oci-ecr"}),
			chart: "oci://1234.dkr.ecr.eu-west-1.amazonaws.com/charts/app", wantOK: false,
		},
		{
			name: "empty chart URL", vc: helmProjectMulti(ghcr), chart: "", wantOK: false,
		},
		{
			// The security case: a bare string prefix would send the ghcr credential to an
			// attacker-controlled look-alike host.
			name: "look-alike host is not covered", vc: helmProjectMulti(ghcr),
			chart: "oci://ghcr.io.attacker.example/acme/redis", wantOK: false,
		},
		{
			// Longest prefix wins, so the more specific of two connected repos is used.
			name:   "longest prefix wins",
			vc:     helmProjectMulti(generic("registry.acme.io"), ghcr),
			chart:  "oci://registry.acme.io/team/app",
			wantOK: true, wantURL: "oci://registry.acme.io", wantUser: "u-oci-generic-cr",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, ok, _ := RepoCredForChartRepo(tc.vc, tc.chart)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v (cred %+v)", ok, tc.wantOK, got)
			}
			if !tc.wantOK {
				if got.Username != "" || got.Password != "" {
					t.Fatalf("no match must yield an empty credential, got %+v", got)
				}
				return
			}
			if got.URL != tc.wantURL {
				t.Errorf("URL = %q, want %q", got.URL, tc.wantURL)
			}
			if tc.wantUser != "" && got.Username != tc.wantUser {
				t.Errorf("Username = %q, want %q", got.Username, tc.wantUser)
			}
			if !got.EnableOCI {
				t.Error("matched credential must be an OCI one")
			}
		})
	}
}

// TestRepoCredForChartRepo_ReportsSkippedEntries asserts a misconfigured chart repo surfaces as a
// loggable error rather than being silently swallowed, mirroring HelmRepoCredSpecs.
func TestRepoCredForChartRepo_ReportsSkippedEntries(t *testing.T) {
	vc := &types.ProjectConfig{
		HelmRegistries: []types.ProjectHelmRegistryConfig{{Name: "ghcr", Provider: "oci-github-cr"}},
	}
	_, ok, err := RepoCredForChartRepo(vc, "oci://ghcr.io/acme/redis")
	if ok {
		t.Fatal("a chart repo with no credential must not match")
	}
	if err == nil {
		t.Fatal("expected the skipped entry to be reported")
	}
}

// TestRepoURLCovers locks the path-boundary rule directly.
func TestRepoURLCovers(t *testing.T) {
	if !repoURLCovers("oci://ghcr.io", "oci://ghcr.io") ||
		!repoURLCovers("oci://ghcr.io", "oci://ghcr.io/acme/redis") {
		t.Error("covered URLs reported as uncovered")
	}
	for _, chart := range []string{
		"oci://ghcr.io.attacker.example/x", "oci://ghcr.iox/acme", "oci://ghcr.i", "oci://other.io/acme",
	} {
		if repoURLCovers("oci://ghcr.io", chart) {
			t.Errorf("repoURLCovers(oci://ghcr.io, %q) = true, want false", chart)
		}
	}
}
