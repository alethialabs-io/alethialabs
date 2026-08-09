// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// catGet resolves a provider or fails the test — the catalog and the behavior registry are
// expected to agree for every slug this file exercises.
func catGet(t *testing.T, category, slug string) *CategoryProvider {
	t.Helper()
	p, err := Get(category, slug)
	if err != nil {
		t.Fatalf("Get(%q, %q): %v", category, slug, err)
	}
	return p
}

// catValidateCase is one Validate expectation for a credential/config-driven adapter.
type catValidateCase struct {
	name    string
	pc      map[string]any
	creds   map[string]string
	wantErr string // substring the error must contain; "" means Validate must succeed
}

// catRunValidateCases pins each adapter's fail-closed ladder: every required field is checked in
// order and the message names the field the operator has to supply.
func catRunValidateCases(t *testing.T, category, slug string, cases []catValidateCase) {
	t.Helper()
	p := catGet(t, category, slug)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := p.Validate(ComponentContext{ProviderConfig: tc.pc, Credentials: tc.creds})
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("Validate() = %v, want nil", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("Validate() = nil, want an error containing %q", tc.wantErr)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("Validate() = %q, want it to contain %q", err, tc.wantErr)
			}
		})
	}
}

// TestCat_RegistryUsernamePasswordAdapters pins the fail-closed ladder and the docker-auth mapping
// of every username/password container-registry adapter: which field is missing decides the error,
// and PullAuth returns the host the dockerconfigjson `auths` key is built from.
func TestCat_RegistryUsernamePasswordAdapters(t *testing.T) {
	both := map[string]string{"username": "u", "password": "p"}

	t.Run("quay", func(t *testing.T) {
		catRunValidateCases(t, "registry", "quay", []catValidateCase{
			{name: "no credential", wantErr: "Quay credential not connected"},
			{name: "username only", creds: map[string]string{"username": "u"}, wantErr: "Quay credential not connected"},
			{name: "connected", creds: both},
		})
		host, user, pass, ok := catGet(t, "registry", "quay").PullAuth(ComponentContext{Credentials: both})
		if !ok || host != "https://quay.io" || user != "u" || pass != "p" {
			t.Fatalf("PullAuth = (%q, %q, %q, %v), want the quay.io default host", host, user, pass, ok)
		}
	})

	t.Run("gitlab-cr", func(t *testing.T) {
		catRunValidateCases(t, "registry", "gitlab-cr", []catValidateCase{
			{name: "no credential", wantErr: "GitLab Container Registry credential not connected"},
			{name: "connected", creds: both},
		})
		host, _, _, ok := catGet(t, "registry", "gitlab-cr").PullAuth(ComponentContext{Credentials: both})
		if !ok || host != "https://registry.gitlab.com" {
			t.Fatalf("PullAuth host = %q (ok=%v), want the registry.gitlab.com default", host, ok)
		}
	})

	t.Run("harbor", func(t *testing.T) {
		catRunValidateCases(t, "registry", "harbor", []catValidateCase{
			{name: "no host", creds: both, wantErr: "Harbor registry URL not set"},
			{name: "no credential", pc: map[string]any{"registry_url": "https://harbor.example"}, wantErr: "Harbor credential not connected"},
			{name: "connected", pc: map[string]any{"registry_url": "https://harbor.example"}, creds: both},
		})
		host, user, pass, ok := catGet(t, "registry", "harbor").PullAuth(ComponentContext{
			ProviderConfig: map[string]any{"registry_url": "https://harbor.example"},
			Credentials:    both,
		})
		if !ok || host != "https://harbor.example" || user != "u" || pass != "p" {
			t.Fatalf("PullAuth = (%q, %q, %q, %v)", host, user, pass, ok)
		}
	})

	t.Run("ghcr-enterprise", func(t *testing.T) {
		catRunValidateCases(t, "registry", "ghcr-enterprise", []catValidateCase{
			{name: "no host", creds: both, wantErr: "GitHub Enterprise registry URL not set"},
			{name: "no credential", pc: map[string]any{"registry_url": "https://ghe.example"}, wantErr: "GitHub Enterprise Container Registry credential not connected"},
			{name: "connected", pc: map[string]any{"registry_url": "https://ghe.example"}, creds: both},
		})
		host, user, pass, ok := catGet(t, "registry", "ghcr-enterprise").PullAuth(ComponentContext{
			ProviderConfig: map[string]any{"registry_url": "https://ghe.example"},
			Credentials:    both,
		})
		if !ok || host != "https://ghe.example" || user != "u" || pass != "p" {
			t.Fatalf("PullAuth = (%q, %q, %q, %v)", host, user, pass, ok)
		}
	})

	t.Run("scaleway-cr rejects a missing host", func(t *testing.T) {
		catRunValidateCases(t, "registry", "scaleway-cr", []catValidateCase{
			{name: "no host", creds: map[string]string{"secret_key": "k"}, wantErr: "Scaleway registry URL not set"},
		})
	})
}

// TestCat_HelmRegistryStaticAdapters pins the fail-closed ladder of the statically-seeded
// helm_registry adapters (the ones ArgoCD authenticates with a username/password repo credential).
func TestCat_HelmRegistryStaticAdapters(t *testing.T) {
	both := map[string]string{"username": "u", "password": "p"}

	catRunValidateCases(t, "helm_registry", "helm-https", []catValidateCase{
		{name: "https: no repo url", creds: both, wantErr: "Helm repository URL not set"},
		{name: "https: no credential", pc: map[string]any{"repo_url": "https://charts.example"}, wantErr: "Helm repository credential not connected"},
		{name: "https: connected", pc: map[string]any{"repo_url": "https://charts.example"}, creds: both},
	})

	catRunValidateCases(t, "helm_registry", "oci-docker-hub", []catValidateCase{
		{name: "docker hub: no credential", wantErr: "Docker Hub OCI credential not connected"},
		{name: "docker hub: connected", creds: map[string]string{"username": "u", "access_token": "t"}},
	})

	catRunValidateCases(t, "helm_registry", "oci-generic-cr", []catValidateCase{
		{name: "generic oci: no host", creds: both, wantErr: "OCI registry host not set"},
		{name: "generic oci: no credential", pc: map[string]any{"registry_host": "oci.example"}, wantErr: "Generic OCI registry credential not connected"},
		{name: "generic oci: connected", pc: map[string]any{"registry_host": "oci.example"}, creds: both},
	})

	catRunValidateCases(t, "helm_registry", "oci-gitlab-cr", []catValidateCase{
		{name: "gitlab oci: no credential", wantErr: "GitLab Container Registry (OCI) credential not connected"},
		{name: "gitlab oci: connected", creds: both},
	})

	catRunValidateCases(t, "helm_registry", "oci-scaleway-cr", []catValidateCase{
		{name: "scaleway oci: no host", creds: map[string]string{"secret_key": "k"}, wantErr: "Scaleway OCI registry host not set"},
		{name: "scaleway oci: no credential", pc: map[string]any{"registry_host": "rg.fr-par.scw.cloud"}, wantErr: "Scaleway Container Registry credential not connected"},
		{name: "scaleway oci: connected", pc: map[string]any{"registry_host": "rg.fr-par.scw.cloud"}, creds: map[string]string{"secret_key": "k"}},
	})
}

// TestCat_HelmRegistryKeylessECRValidateLadder pins that the keyless OCI ECR chart-repo adapter
// refuses every half-configured cross-account target, naming the provider_config field that is
// missing — no half-built KeylessHelmRepoTarget ever reaches the refresher.
func TestCat_HelmRegistryKeylessECRValidateLadder(t *testing.T) {
	catRunValidateCases(t, "helm_registry", "oci-ecr", []catValidateCase{
		{name: "no account", wantErr: "target AWS account id not set"},
		{name: "no region", pc: map[string]any{"target_account_id": "111122223333"}, wantErr: "region not set"},
		{
			name:    "no registry host",
			pc:      map[string]any{"target_account_id": "111122223333", "region": "eu-central-1"},
			wantErr: "registry host not set",
		},
		{
			name: "no target role",
			pc: map[string]any{
				"target_account_id": "111122223333",
				"region":            "eu-central-1",
				"registry_host":     "111122223333.dkr.ecr.eu-central-1.amazonaws.com",
			},
			wantErr: "target role ARN not set",
		},
	})
}

// TestCat_KeylessRegistryValidateLadders pins the per-field fail-closed ladder of the three
// cross-account keyless container registries: the target is read from provider_config, so a
// missing reference must name itself rather than produce a target the refresher cannot use.
func TestCat_KeylessRegistryValidateLadders(t *testing.T) {
	catRunValidateCases(t, "registry", "ecr-xacct", []catValidateCase{
		{name: "ecr: no region", pc: map[string]any{"target_account_id": "111122223333"}, wantErr: "region not set"},
		{
			name:    "ecr: no registry host",
			pc:      map[string]any{"target_account_id": "111122223333", "region": "eu-central-1"},
			wantErr: "registry host not set",
		},
		{
			name: "ecr: no target role",
			pc: map[string]any{
				"target_account_id": "111122223333",
				"region":            "eu-central-1",
				"registry_host":     "111122223333.dkr.ecr.eu-central-1.amazonaws.com",
			},
			wantErr: "target role ARN not set",
		},
	})

	catRunValidateCases(t, "registry", "gar-xacct", []catValidateCase{
		{name: "gar: no region", pc: map[string]any{"target_project_id": "proj"}, wantErr: "region not set"},
		{
			name:    "gar: no registry host",
			pc:      map[string]any{"target_project_id": "proj", "region": "europe-west1"},
			wantErr: "registry host not set",
		},
		{
			name: "gar: no reader service account",
			pc: map[string]any{
				"target_project_id": "proj",
				"region":            "europe-west1",
				"registry_host":     "europe-west1-docker.pkg.dev",
			},
			wantErr: "target reader service account not set",
		},
	})

	catRunValidateCases(t, "registry", "acr-xacct", []catValidateCase{
		{name: "acr: no registry host", pc: map[string]any{"target_subscription_id": "sub"}, wantErr: "registry host not set"},
		{
			name:    "acr: no pull identity",
			pc:      map[string]any{"target_subscription_id": "sub", "registry_host": "reg.azurecr.io"},
			wantErr: "target pull identity client id not set",
		},
	})
}

// TestCat_KeylessSecretStoreValidateLadders pins the per-field fail-closed ladder of the
// cross-account keyless secret managers — the External Secrets Operator gets a complete
// foreign-account reference or none at all.
func TestCat_KeylessSecretStoreValidateLadders(t *testing.T) {
	catRunValidateCases(t, "secrets", "aws-sm-xacct", []catValidateCase{
		{name: "aws: no region", pc: map[string]any{"target_account_id": "111122223333"}, wantErr: "region not set"},
		{
			name:    "aws: no target role",
			pc:      map[string]any{"target_account_id": "111122223333", "region": "eu-central-1"},
			wantErr: "target role ARN not set",
		},
	})

	catRunValidateCases(t, "secrets", "azure-kv-xacct", []catValidateCase{
		{name: "azure: no vault url", pc: map[string]any{"target_subscription_id": "sub"}, wantErr: "target vault URL not set"},
	})

	catRunValidateCases(t, "secrets", "alibaba-kms-xacct", []catValidateCase{
		{name: "alibaba: no region", pc: map[string]any{"target_account_id": "5555"}, wantErr: "region not set"},
		{
			name:    "alibaba: no target role",
			pc:      map[string]any{"target_account_id": "5555", "region": "eu-central-1"},
			wantErr: "target role ARN not set",
		},
		{
			name: "alibaba: no target OIDC provider",
			pc: map[string]any{
				"target_account_id": "5555",
				"region":            "eu-central-1",
				"target_role_arn":   "acs:ram::5555:role/eso",
			},
			wantErr: "target OIDC provider ARN not set",
		},
	})
}

// TestCat_GrafanaRejectsMissingCredential pins that Grafana Cloud fails on the credential before it
// ever looks at the remote-write URL.
func TestCat_GrafanaRejectsMissingCredential(t *testing.T) {
	catRunValidateCases(t, "observability", "grafana", []catValidateCase{
		{name: "no instance id", creds: map[string]string{"api_token": "t"}, wantErr: "missing Grafana Cloud instance_id or api_token"},
	})
}

// TestCat_SecretsGenericIsVaultUnderANeutralLabel pins that the `generic` KV store reuses the vault
// module's tfvars verbatim (a Vault-KV-API-compatible endpoint by documented scope) and fails closed
// without an endpoint address or token.
func TestCat_SecretsGenericIsVaultUnderANeutralLabel(t *testing.T) {
	p := catGet(t, "secrets", "generic")
	catRunValidateCases(t, "secrets", "generic", []catValidateCase{
		{name: "no address", creds: map[string]string{"token": "t"}, wantErr: "Generic KV store not connected"},
		{name: "connected", creds: map[string]string{"address": "https://kv.example", "token": "t"}},
	})

	v := p.Tfvars(ComponentContext{
		Credentials: map[string]string{"address": "https://kv.example", "token": "t"},
		Items:       []ComponentItem{{Name: "db-password"}},
	})
	if v["vault_address"] != "https://kv.example" || v["vault_token"] != "t" {
		t.Fatalf("generic tfvars did not map the endpoint credential: %+v", v)
	}
	if v["vault_mount_path"] != "secret" || v["vault_kv_version"] != "2" {
		t.Fatalf("generic tfvars defaults = %+v, want mount=secret kv=2", v)
	}
	names, ok := v["secret_names"].([]string)
	if !ok || len(names) != 1 || names[0] != "db-password" {
		t.Fatalf("secret_names = %v, want [db-password]", v["secret_names"])
	}
}

// TestCat_ProviderAccessorsReturnFalseWithoutBehavior pins that every optional-behavior accessor on
// CategoryProvider reports ok=false (rather than panicking or inventing a zero target) when the
// provider registered no such behavior.
func TestCat_ProviderAccessorsReturnFalseWithoutBehavior(t *testing.T) {
	p := &CategoryProvider{}
	ctx := ComponentContext{}

	if host, user, pass, ok := p.PullAuth(ctx); ok || host != "" || user != "" || pass != "" {
		t.Errorf("PullAuth = (%q, %q, %q, %v), want all-empty and ok=false", host, user, pass, ok)
	}
	if target, ok := p.KeylessRegistry(ctx); ok || target != (KeylessRegistryTarget{}) {
		t.Errorf("KeylessRegistry = (%+v, %v), want zero and ok=false", target, ok)
	}
	if target, ok := p.KeylessSecretStore(ctx); ok || target != (KeylessSecretTarget{}) {
		t.Errorf("KeylessSecretStore = (%+v, %v), want zero and ok=false", target, ok)
	}
	if store, ok := p.SaaSSecretStore(ctx); ok || store.Slug != "" || store.StoreName != "" {
		t.Errorf("SaaSSecretStore = (%+v, %v), want zero and ok=false", store, ok)
	}
	if target, ok := p.KeylessRepoCred(ctx); ok || target != (KeylessHelmRepoTarget{}) {
		t.Errorf("KeylessRepoCred = (%+v, %v), want zero and ok=false", target, ok)
	}
}

// TestCat_SaaSStoreCredKeyMissingRole pins that CredKey answers "" for a role this store has no key
// for, so a ClusterSecretStore template asking for an element the provider does not use renders
// empty rather than the wrong key.
func TestCat_SaaSStoreCredKeyMissingRole(t *testing.T) {
	store := SecretsSaaSStore{
		Creds: []SecretsSaaSCredRef{{Role: SaaSCredToken, Key: "token", CredentialField: "token"}},
	}
	if got := store.CredKey(string(SaaSCredToken)); got != "token" {
		t.Fatalf("CredKey(token) = %q, want token", got)
	}
	if got := store.CredKey(string(SaaSCredClientID)); got != "" {
		t.Fatalf("CredKey(clientId) = %q, want \"\" for a store with no such element", got)
	}
}

// TestCat_ProviderConfigLookupsMissBySlug pins that both connection-level provider_config lookups
// return nil when no component of the project selected that slug — the caller then builds a
// config-less context rather than borrowing another provider's settings.
func TestCat_ProviderConfigLookupsMissBySlug(t *testing.T) {
	vc := &types.ProjectConfig{
		Secrets:             []types.ProjectSecretConfig{{Name: "s", Provider: "vault", ProviderConfig: map[string]any{"mount_path": "kv"}}},
		ContainerRegistries: []types.ProjectContainerRegistryConfig{{Name: "r", Provider: "dockerhub", ProviderConfig: map[string]any{"x": "y"}}},
	}
	if got := secretsProviderConfig(vc, "doppler"); got != nil {
		t.Errorf("secretsProviderConfig(doppler) = %v, want nil", got)
	}
	if got := registryProviderConfig(vc, "ghcr"); got != nil {
		t.Errorf("registryProviderConfig(ghcr) = %v, want nil", got)
	}
}

// TestCat_RelModulePathKeepsUnprefixedPaths pins that a catalog module_path without the
// "categories/" prefix is passed through untouched (the prefix is stripped only when present).
func TestCat_RelModulePathKeepsUnprefixedPaths(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"categories/dns/cloudflare", "dns/cloudflare"},
		{"dns/cloudflare", "dns/cloudflare"},
		{"categories/", "categories/"},
		{"", ""},
	} {
		if got := relModulePath(tc.in); got != tc.want {
			t.Errorf("relModulePath(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// TestCat_CopyTreeRejectsMissingAndNonDirSources pins that vendoring a module refuses a source that
// does not exist or is a file — a half-copied categories/ directory would plan against nothing.
func TestCat_CopyTreeRejectsMissingAndNonDirSources(t *testing.T) {
	root := t.TempDir()

	if err := copyTree(filepath.Join(root, "absent"), filepath.Join(root, "dst")); err == nil {
		t.Fatal("copyTree() on a missing source = nil, want a stat error")
	}

	file := filepath.Join(root, "main.tf")
	if err := os.WriteFile(file, []byte("# not a module dir\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := copyTree(file, filepath.Join(root, "dst"))
	if err == nil || !strings.Contains(err.Error(), "module path is not a directory") {
		t.Fatalf("copyTree() on a file = %v, want a not-a-directory error", err)
	}
}

// TestCat_CopyTreeReportsAnUnreadableEntry pins that a module directory holding an entry whose
// contents cannot be read (here a dangling symlink — Walk lstats it as a plain file, the read then
// follows it and fails) surfaces the read error instead of vendoring a truncated module.
func TestCat_CopyTreeReportsAnUnreadableEntry(t *testing.T) {
	src := filepath.Join(t.TempDir(), "module")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(src, "absent.tf"), filepath.Join(src, "main.tf")); err != nil {
		t.Skipf("symlinks unavailable on this filesystem: %v", err)
	}

	if err := copyTree(src, filepath.Join(t.TempDir(), "dst")); err == nil {
		t.Fatal("copyTree() = nil, want the unreadable entry's read error")
	}
}

// TestCat_ComposeUnknownSlugFailsPerCategory pins that a config_snapshot naming a provider slug the
// catalog does not carry fails the compose of that category loudly, instead of silently leaving the
// native guard on.
func TestCat_ComposeUnknownSlugFailsPerCategory(t *testing.T) {
	t.Run("dns", func(t *testing.T) {
		vc := &types.ProjectConfig{}
		vc.DNS = types.ProjectDNSConfig{Enabled: true, Provider: "cov-no-such-dns"}
		if _, err := Compose(t.TempDir(), "", vc, map[string]any{}, io.Discard); err == nil {
			t.Fatal("Compose() = nil, want an unknown-provider error")
		}
	})

	t.Run("observability", func(t *testing.T) {
		vc := &types.ProjectConfig{}
		vc.Observability = types.ProjectObservabilityConfig{Enabled: true, Provider: "cov-no-such-obs"}
		if _, err := Compose(t.TempDir(), "", vc, map[string]any{}, io.Discard); err == nil {
			t.Fatal("Compose() = nil, want an unknown-provider error")
		}
	})

	t.Run("secrets", func(t *testing.T) {
		vc := &types.ProjectConfig{
			Secrets: []types.ProjectSecretConfig{{Name: "s", Provider: "cov-no-such-secrets"}},
		}
		if _, err := Compose(t.TempDir(), "", vc, map[string]any{}, io.Discard); err == nil {
			t.Fatal("Compose() = nil, want an unknown-provider error")
		}
	})

	t.Run("registry", func(t *testing.T) {
		vc := &types.ProjectConfig{
			ContainerRegistries: []types.ProjectContainerRegistryConfig{{Name: "r", Provider: "cov-no-such-registry"}},
		}
		if _, err := Compose(t.TempDir(), "", vc, map[string]any{}, io.Discard); err == nil {
			t.Fatal("Compose() = nil, want an unknown-provider error")
		}
	})
}

// TestCat_ComposeObservability pins the singleton observability leg: a connected Grafana Cloud
// selection composes its module, and a selection whose credential never arrived fails the compose
// rather than emitting a module with empty tfvars.
func TestCat_ComposeObservability(t *testing.T) {
	newProject := func(creds map[string]string) *types.ProjectConfig {
		vc := &types.ProjectConfig{}
		vc.Observability = types.ProjectObservabilityConfig{
			Enabled:        true,
			Provider:       "grafana",
			ProviderConfig: map[string]any{"remote_write_url": "https://rw.grafana.test"},
		}
		if creds != nil {
			vc.ConnectorCredentials = []types.ConnectorCredential{
				{Category: "observability", Slug: "grafana", Credentials: creds},
			}
		}
		return vc
	}

	var log bytes.Buffer
	n, err := Compose(t.TempDir(), "", newProject(map[string]string{"instance_id": "i", "api_token": "t"}), map[string]any{}, &log)
	if err != nil {
		t.Fatalf("Compose() error = %v", err)
	}
	if n != 1 {
		t.Fatalf("composed modules = %d, want 1", n)
	}
	if !bytes.Contains(log.Bytes(), []byte("Composed observability provider: grafana")) {
		t.Fatalf("compose log missing the observability module message: %s", log.String())
	}

	if _, err := Compose(t.TempDir(), "", newProject(nil), map[string]any{}, io.Discard); err == nil {
		t.Fatal("Compose() = nil, want a validation error for grafana with no credential")
	}
}

// TestCat_ComposeCredentialRegistrySetsGuardWithoutAModule pins the credential-based registry leg:
// it flips registry_provider (switching the cloud template's native registry off) and composes NO
// tofu module, because its only artifact is the runner-seeded dockerconfigjson.
func TestCat_ComposeCredentialRegistrySetsGuardWithoutAModule(t *testing.T) {
	vc := dockerhubProject(map[string]string{"username": "alice", "access_token": "tok"})
	tfvars := map[string]any{}
	var log bytes.Buffer

	n, err := Compose(t.TempDir(), "", vc, tfvars, &log)
	if err != nil {
		t.Fatalf("Compose() error = %v", err)
	}
	if n != 0 {
		t.Fatalf("composed modules = %d, want 0 (a pluggable registry has no tofu module)", n)
	}
	if tfvars["registry_provider"] != "dockerhub" {
		t.Fatalf("registry_provider = %v, want dockerhub", tfvars["registry_provider"])
	}
	if tfvars["registry_pull_provider"] != "native" {
		t.Fatalf("registry_pull_provider = %v, want native (a static registry is not keyless)", tfvars["registry_pull_provider"])
	}
	if !bytes.Contains(log.Bytes(), []byte("pull secret is runner-seeded post-apply")) {
		t.Fatalf("compose log missing the runner-seeded note: %s", log.String())
	}

	// The same selection with no credential attached must fail the compose, not seed a blank secret.
	if _, err := Compose(t.TempDir(), "", dockerhubProject(nil), map[string]any{}, io.Discard); err == nil {
		t.Fatal("Compose() = nil, want a registry validation error")
	}
}

// TestCat_ComposeRejectsHalfConfiguredKeylessSelections pins that a keyless registry / secret
// manager whose provider_config is incomplete fails the compose before a plan is produced — the
// separate xacct guard is never set for a target the refresher could not use.
func TestCat_ComposeRejectsHalfConfiguredKeylessSelections(t *testing.T) {
	t.Run("registry", func(t *testing.T) {
		vc := &types.ProjectConfig{
			ContainerRegistries: []types.ProjectContainerRegistryConfig{{
				Name:           "app",
				Provider:       "ecr-xacct",
				ProviderConfig: map[string]any{"target_account_id": "111122223333"}, // no region/host/role
			}},
		}
		tfvars := map[string]any{}
		if _, err := Compose(t.TempDir(), "", vc, tfvars, io.Discard); err == nil {
			t.Fatal("Compose() = nil, want a keyless registry validation error")
		}
		if tfvars["registry_pull_provider"] != "native" {
			t.Fatalf("registry_pull_provider = %v, want it left native on a failed validation", tfvars["registry_pull_provider"])
		}
	})

	t.Run("secrets", func(t *testing.T) {
		vc := &types.ProjectConfig{
			Secrets: []types.ProjectSecretConfig{{
				Name:           "db",
				Provider:       "aws-sm-xacct",
				ProviderConfig: map[string]any{"target_account_id": "111122223333"}, // no region/role
			}},
		}
		tfvars := map[string]any{}
		if _, err := Compose(t.TempDir(), "", vc, tfvars, io.Discard); err == nil {
			t.Fatal("Compose() = nil, want a keyless secret-store validation error")
		}
		if tfvars["secrets_xacct_provider"] != "native" {
			t.Fatalf("secrets_xacct_provider = %v, want it left native on a failed validation", tfvars["secrets_xacct_provider"])
		}
	})
}

// TestCat_ComposeSecretsModuleFailures pins the two ways the credential-based secrets leg fails
// closed: a credential that never arrived, and a categories source tree missing the module the
// selected provider names.
func TestCat_ComposeSecretsModuleFailures(t *testing.T) {
	newProject := func(creds map[string]string) *types.ProjectConfig {
		vc := &types.ProjectConfig{
			Secrets: []types.ProjectSecretConfig{{Name: "db-password", Provider: "vault"}},
		}
		if creds != nil {
			vc.ConnectorCredentials = []types.ConnectorCredential{
				{Category: "secrets", Slug: "vault", Credentials: creds},
			}
		}
		return vc
	}

	if _, err := Compose(t.TempDir(), "", newProject(map[string]string{"address": "https://vault.test"}), map[string]any{}, io.Discard); err == nil {
		t.Fatal("Compose() = nil, want a vault validation error for a missing token")
	}

	connected := newProject(map[string]string{"address": "https://vault.test", "token": "root"})
	_, err := Compose(t.TempDir(), t.TempDir(), connected, map[string]any{}, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "failed to copy vault module") {
		t.Fatalf("Compose() = %v, want a module-copy failure for an empty categories source dir", err)
	}
}

// TestCat_ComposeReportsAnUnwritableWorkDir pins that a work directory the module file cannot be
// written into surfaces as an error rather than a silently module-less plan.
func TestCat_ComposeReportsAnUnwritableWorkDir(t *testing.T) {
	vc := &types.ProjectConfig{}
	vc.DNS = types.ProjectDNSConfig{
		Enabled:        true,
		Provider:       "cloudflare",
		DomainName:     "example.com",
		ProviderConfig: map[string]any{"zone_id": "z1"},
	}
	vc.ConnectorCredentials = []types.ConnectorCredential{
		{Category: "dns", Slug: "cloudflare", Credentials: map[string]string{"api_token": "tok"}},
	}

	missing := filepath.Join(t.TempDir(), "no-such-dir")
	_, err := Compose(missing, "", vc, map[string]any{}, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "_categories.tf.json") {
		t.Fatalf("Compose() = %v, want a _categories.tf.json write failure", err)
	}
}

// TestCat_ComposeWarnsOnASkippedKeylessHelmTarget pins that one misconfigured keyless Helm ECR repo
// is logged and skipped rather than sinking the whole compose — the other repos still deploy.
func TestCat_ComposeWarnsOnASkippedKeylessHelmTarget(t *testing.T) {
	t.Setenv("ALETHIA_XACCT_HELM_ECR_ENABLED", "true")

	vc := &types.ProjectConfig{
		HelmRegistries: []types.ProjectHelmRegistryConfig{
			{Name: "broken", Provider: "oci-ecr", ProviderConfig: map[string]any{"target_account_id": "111122223333"}},
			{Name: "public", Provider: "oci-public-ecr"},
		},
	}
	tfvars := map[string]any{}
	var log bytes.Buffer

	if _, err := Compose(t.TempDir(), "", vc, tfvars, &log); err != nil {
		t.Fatalf("Compose() error = %v — a bad chart repo must not fail the compose", err)
	}
	if !bytes.Contains(log.Bytes(), []byte("some keyless Helm ECR targets were skipped")) {
		t.Fatalf("compose log missing the skip warning: %s", log.String())
	}
	if tfvars["helm_repo_pull_public_enabled"] != true {
		t.Fatalf("helm_repo_pull_public_enabled = %v, want true — the healthy public repo still wires", tfvars["helm_repo_pull_public_enabled"])
	}
	if _, ok := tfvars["helm_repo_pull_target_role_arns"]; ok {
		t.Fatal("helm_repo_pull_target_role_arns was set from a target that failed validation")
	}
}

// TestCat_HelmRepoSpecsDedupeSameURL pins that connecting the same chart repo twice yields ONE
// ArgoCD repo-credential Secret — the name is derived from the URL, so a duplicate would just
// rewrite the same object.
func TestCat_HelmRepoSpecsDedupeSameURL(t *testing.T) {
	entry := types.ProjectHelmRegistryConfig{
		Provider:       "helm-https",
		ProviderConfig: map[string]any{"repo_url": "https://charts.example.test"},
	}
	vc := &types.ProjectConfig{
		HelmRegistries: []types.ProjectHelmRegistryConfig{entry, entry},
		ConnectorCredentials: []types.ConnectorCredential{
			{Category: "helm_registry", Slug: "helm-https", Credentials: map[string]string{"username": "u", "password": "p"}},
		},
	}

	specs, err := HelmRepoCredSpecs(vc)
	if err != nil {
		t.Fatalf("HelmRepoCredSpecs() error = %v", err)
	}
	if len(specs) != 1 {
		t.Fatalf("specs = %d, want 1 (the same URL connected twice is one Secret)", len(specs))
	}
	if specs[0].Name != HelmRepoCredSecretName("https://charts.example.test") {
		t.Fatalf("Name = %q, want the URL-derived name", specs[0].Name)
	}
}

// TestCat_KeylessHelmRepoTargetsDedupeSameHost pins that the same keyless ECR chart registry
// connected twice yields ONE refresher target — both would patch the same repo-cred Secret.
func TestCat_KeylessHelmRepoTargetsDedupeSameHost(t *testing.T) {
	entry := types.ProjectHelmRegistryConfig{
		Provider: "oci-ecr",
		ProviderConfig: map[string]any{
			"target_account_id": "111122223333",
			"region":            "eu-central-1",
			"registry_host":     "111122223333.dkr.ecr.eu-central-1.amazonaws.com",
			"target_role_arn":   "arn:aws:iam::111122223333:role/charts",
		},
	}
	vc := &types.ProjectConfig{HelmRegistries: []types.ProjectHelmRegistryConfig{entry, entry}}

	targets, err := KeylessHelmRepoTargets(vc)
	if err != nil {
		t.Fatalf("KeylessHelmRepoTargets() error = %v", err)
	}
	if len(targets) != 1 {
		t.Fatalf("targets = %d, want 1 (the same registry connected twice is one refresher)", len(targets))
	}
	if targets[0].SecretName() != HelmRepoCredSecretName(targets[0].RepoURL()) {
		t.Fatalf("SecretName = %q, want the URL-derived name", targets[0].SecretName())
	}
}

// catRegisterTemp registers a behavior (and optionally its catalog meta) for the duration of one
// test, restoring both registries afterwards. It reproduces the half-added provider the lookups are
// written to refuse — a slug whose impl and catalog entry disagree.
func catRegisterTemp(t *testing.T, category, slug string, b behavior, withMeta bool) {
	t.Helper()
	key := category + "/" + slug
	if _, exists := behaviors[key]; exists {
		t.Fatalf("%q already registered — pick a slug the real catalog does not use", key)
	}
	behaviors[key] = b
	if withMeta {
		metaIndex[key] = providerMeta{Category: category, Slug: slug, ModulePath: "categories/" + key}
	}
	t.Cleanup(func() {
		delete(behaviors, key)
		delete(metaIndex, key)
	})
}

// TestCat_HalfAddedProviderFailsClosed pins that every dominant-selection lookup refuses a provider
// whose impl and catalog entry disagree — a behavior with no catalog row, or a catalog row with no
// impl — rather than returning a partially-resolved target.
func TestCat_HalfAddedProviderFailsClosed(t *testing.T) {
	t.Run("catalog row without an impl", func(t *testing.T) {
		key := "dns/cov-meta-only"
		metaIndex[key] = providerMeta{Category: "dns", Slug: "cov-meta-only", ModulePath: "categories/" + key}
		t.Cleanup(func() { delete(metaIndex, key) })

		_, err := Get("dns", "cov-meta-only")
		if err == nil || !strings.Contains(err.Error(), "no registered behavior") {
			t.Fatalf("Get() = %v, want a missing-impl error", err)
		}
	})

	t.Run("registry pull secret", func(t *testing.T) {
		catRegisterTemp(t, "registry", "cov-orphan-reg", behavior{
			pullAuth: func(ComponentContext) (string, string, string) { return "h", "u", "p" },
		}, false)
		vc := &types.ProjectConfig{
			ContainerRegistries: []types.ProjectContainerRegistryConfig{{Name: "r", Provider: "cov-orphan-reg"}},
		}
		if _, err := DominantRegistryPullSecretSpec(vc); err == nil {
			t.Fatal("DominantRegistryPullSecretSpec() = nil, want an unknown-provider error")
		}
	})

	t.Run("registry without a pull-auth mapping", func(t *testing.T) {
		catRegisterTemp(t, "registry", "cov-nopull-reg", behavior{}, true)
		vc := &types.ProjectConfig{
			ContainerRegistries: []types.ProjectContainerRegistryConfig{{Name: "r", Provider: "cov-nopull-reg"}},
		}
		_, err := DominantRegistryPullSecretSpec(vc)
		if err == nil || !strings.Contains(err.Error(), "no pull-auth mapping") {
			t.Fatalf("DominantRegistryPullSecretSpec() = %v, want a missing pull-auth error", err)
		}
	})

	t.Run("keyless registry target", func(t *testing.T) {
		catRegisterTemp(t, "registry", "cov-orphan-keyless-reg", behavior{
			keylessRegistry: func(ComponentContext) KeylessRegistryTarget { return KeylessRegistryTarget{} },
		}, false)
		vc := &types.ProjectConfig{
			ContainerRegistries: []types.ProjectContainerRegistryConfig{{Name: "r", Provider: "cov-orphan-keyless-reg"}},
		}
		if _, err := DominantRegistryKeylessTarget(vc); err == nil {
			t.Fatal("DominantRegistryKeylessTarget() = nil, want an unknown-provider error")
		}
	})

	t.Run("keyless secret target", func(t *testing.T) {
		catRegisterTemp(t, "secrets", "cov-orphan-keyless-sec", behavior{
			keylessSecretStore: func(ComponentContext) KeylessSecretTarget { return KeylessSecretTarget{} },
		}, false)
		vc := &types.ProjectConfig{
			Secrets: []types.ProjectSecretConfig{{Name: "s", Provider: "cov-orphan-keyless-sec"}},
		}
		if _, err := DominantKeylessSecretTarget(vc); err == nil {
			t.Fatal("DominantKeylessSecretTarget() = nil, want an unknown-provider error")
		}
	})

	t.Run("saas secret store", func(t *testing.T) {
		catRegisterTemp(t, "secrets", "cov-orphan-saas-sec", behavior{
			saasSecretStore: func(ComponentContext) SecretsSaaSStore { return SecretsSaaSStore{} },
		}, false)
		vc := &types.ProjectConfig{
			Secrets: []types.ProjectSecretConfig{{Name: "s", Provider: "cov-orphan-saas-sec"}},
		}
		if _, err := DominantSecretsSaaSStore(vc); err == nil {
			t.Fatal("DominantSecretsSaaSStore() = nil, want an unknown-provider error")
		}
	})

	t.Run("helm repo credential", func(t *testing.T) {
		catRegisterTemp(t, "helm_registry", "cov-orphan-helm", behavior{
			repoCred: func(ComponentContext) RepoCred { return RepoCred{} },
		}, false)
		vc := &types.ProjectConfig{
			HelmRegistries: []types.ProjectHelmRegistryConfig{{Name: "h", Provider: "cov-orphan-helm"}},
		}
		specs, err := HelmRepoCredSpecs(vc)
		if err == nil {
			t.Fatal("HelmRepoCredSpecs() = nil error, want an unknown-provider error")
		}
		if len(specs) != 0 {
			t.Fatalf("specs = %d, want 0 — a half-added provider seeds nothing", len(specs))
		}
	})

	t.Run("keyless helm repo target", func(t *testing.T) {
		catRegisterTemp(t, "helm_registry", "cov-orphan-helm-keyless", behavior{
			keylessRepoCred: func(ComponentContext) KeylessHelmRepoTarget { return KeylessHelmRepoTarget{} },
		}, false)
		vc := &types.ProjectConfig{
			HelmRegistries: []types.ProjectHelmRegistryConfig{{Name: "h", Provider: "cov-orphan-helm-keyless"}},
		}
		targets, err := KeylessHelmRepoTargets(vc)
		if err == nil {
			t.Fatal("KeylessHelmRepoTargets() = nil error, want an unknown-provider error")
		}
		if len(targets) != 0 {
			t.Fatalf("targets = %d, want 0 — a half-added provider refreshes nothing", len(targets))
		}
	})
}

// TestCat_CopyTreeReportsAnUnwalkableSubdirectory pins that a module directory holding a
// subdirectory whose entries cannot be listed aborts the vendoring with that error, instead of
// silently vendoring the module minus the unreadable subtree — a truncated module plans clean and
// applies wrong.
func TestCat_CopyTreeReportsAnUnwalkableSubdirectory(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root — a 0000 directory is still readable, so Walk reports no error")
	}
	src := filepath.Join(t.TempDir(), "module")
	sealed := filepath.Join(src, "sealed")
	if err := os.MkdirAll(sealed, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sealed, "main.tf"), []byte("# hidden\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(sealed, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(sealed, 0o755) })

	if err := copyTree(src, filepath.Join(t.TempDir(), "dst")); err == nil {
		t.Fatal("copyTree() = nil, want the unlistable subdirectory's error")
	}
}
