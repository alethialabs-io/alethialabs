// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// An external test package, because the rules byo_db_users.go mirrors live in packages that import
// cloud (argocd, categories' caller, provisioner): only from outside can a test hold the mirror and
// the original side by side.
package cloud_test

import (
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/categories"
	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

var parityTarget = types.ServiceBindingTarget{Kind: types.ServiceBindingKindDatabase, Name: "primary"}

// parityConfig is one environment with one BYO chart id in namespace ns, its workload "api" bound to
// the database's password.
func parityConfig(id, ns string) *types.ProjectConfig {
	return &types.ProjectConfig{
		ID: "proj-1", ProjectName: "shop", EnvironmentID: "env-1",
		AddOns: []types.AddOnInstall{{
			ID: id, Byo: true, Namespace: ns,
			Workloads: []types.ChartWorkloadBinding{{Name: "api", Bindings: []types.ServiceBinding{{
				Target: parityTarget, Inject: []types.ServiceBindingInjection{{Env: "P", From: "password"}},
			}}}},
		}},
	}
}

// TestByoDBUserSecrets_OwnerLabelMatchesArgocd: the key is derived from the same environment value the
// binding lane passes the resolver — the owner label argocd stamps.
func TestByoDBUserSecrets_OwnerLabelMatchesArgocd(t *testing.T) {
	cfg := parityConfig("acme-api", "apps")
	env := cloud.ClassificationLabels(cfg)[argocd.ByoBindingOwnerLabel]
	if env == "" {
		t.Fatalf("no owner label for %v", cloud.ClassificationLabels(cfg))
	}
	got := cloud.ByoDBUserSecrets(cfg)
	if len(got) != 1 || got[0].Key != manifests.ByoBindingDBSecretKey(env, "apps", "api", parityTarget) {
		t.Errorf("got %v, want the key derived from owner label %q", got, env)
	}
}

// TestByoDBUserSecrets_ChartNamespaceMatchesArgocd: a BYO chart stored with no namespace is keyed on
// argocd.ByoChartNamespace, the namespace the add-on stage moves it to — including an id long enough
// to take the hashed form.
func TestByoDBUserSecrets_ChartNamespaceMatchesArgocd(t *testing.T) {
	for _, id := range []string{"acme-api", strings.Repeat("a", 59), strings.Repeat("long-chart-id-", 6), strings.Repeat("a", 49) + "-" + strings.Repeat("b", 20)} {
		for _, ns := range []string{"", argocd.ByoLegacyDefaultNamespace} {
			cfg := parityConfig(id, ns)
			env := cloud.ClassificationLabels(cfg)[argocd.ByoBindingOwnerLabel]
			want := manifests.ByoBindingDBSecretKey(env, argocd.ByoChartNamespace(id), "api", parityTarget)
			if got := cloud.ByoDBUserSecrets(cfg); len(got) != 1 || got[0].Key != want {
				t.Errorf("id %q namespace %q: got %v, want %s", id, ns, got, want)
			}
		}
	}
}

// TestByoDBUserSecrets_NativeGateMatchesCompose: ByoDBUserSecretsUnavailableReason is empty exactly
// when categories.Compose leaves `secrets_provider` at "native" — the value every template's
// custom_secrets gate reads.
func TestByoDBUserSecrets_NativeGateMatchesCompose(t *testing.T) {
	xacctPC := map[string]any{"target_account_id": "123456789012", "region": "eu-central-1", "target_role_arn": "arn:aws:iam::123456789012:role/r"}
	cases := map[string][]types.ProjectSecretConfig{
		"none":          nil,
		"native only":   {{Name: "a"}, {Name: "b", Provider: "native"}},
		"vault":         {{Name: "a"}, {Name: "b", Provider: "vault"}},
		"doppler":       {{Name: "b", Provider: "doppler", ProviderConfig: map[string]any{"project": "p", "config": "c"}}},
		"keyless xacct": {{Name: "a"}, {Name: "b", Provider: "aws-sm-xacct", ProviderConfig: xacctPC}},
		"xacct first":   {{Name: "b", Provider: "aws-sm-xacct", ProviderConfig: xacctPC}, {Name: "c", Provider: "vault"}},
		"vault first":   {{Name: "c", Provider: "vault"}, {Name: "b", Provider: "aws-sm-xacct", ProviderConfig: xacctPC}},
	}
	creds := []types.ConnectorCredential{
		{Category: "secrets", Slug: "vault", Credentials: map[string]string{"address": "https://vault.example", "token": "t"}},
		{Category: "secrets", Slug: "doppler", Credentials: map[string]string{"token": "t"}},
	}
	for name, secrets := range cases {
		t.Run(name, func(t *testing.T) {
			vc := &types.ProjectConfig{ProjectName: "shop", Secrets: secrets, ConnectorCredentials: creds}
			tfvars := map[string]any{}
			if _, err := categories.Compose(t.TempDir(), "", vc, tfvars, io.Discard); err != nil {
				t.Fatalf("Compose: %v", err)
			}
			native := tfvars["secrets_provider"] == "native"
			if reason := cloud.ByoDBUserSecretsUnavailableReason(vc); (reason == "") != native {
				t.Errorf("Compose secrets_provider = %v, but the unavailable reason is %q", tfvars["secrets_provider"], reason)
			}
		})
	}
}

// TestByoDBUserSecrets_FlagNamesMatchProvisioner: the provisioner reads the per-binding and keyless
// flags under the same names the cloud half reads them by. The provisioner's readers are unexported,
// so their source is read; the cloud half is checked by behaviour.
func TestByoDBUserSecrets_FlagNamesMatchProvisioner(t *testing.T) {
	_, here, _, _ := runtime.Caller(0)
	src, err := os.ReadFile(filepath.Join(filepath.Dir(here), "..", "provisioner", "byo_charts.go"))
	if err != nil {
		t.Fatal(err)
	}
	for _, flag := range []string{"ALETHIA_BYO_DB_USERS_ENABLED", "ALETHIA_KEYLESS_DB_AUTH_ENABLED"} {
		if !strings.Contains(string(src), `os.Getenv("`+flag+`") == "true"`) {
			t.Errorf("provisioner/byo_charts.go no longer reads %s", flag)
		}
	}

	p, err := cloud.NewCloudProvider("aws")
	if err != nil {
		t.Fatal(err)
	}
	count := func() int {
		n := 0
		for _, e := range p.ProviderTfvars(parityConfig("acme-api", "apps"))["custom_secrets"].([]map[string]interface{}) {
			if s, _ := e["secret_name"].(string); strings.HasPrefix(s, manifests.ByoDBSecretKeyPrefix) {
				n++
			}
		}
		return n
	}
	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
	if count() != 1 {
		t.Errorf("ALETHIA_BYO_DB_USERS_ENABLED=true did not turn the entries on")
	}
	cfg := parityConfig("acme-api", "apps")
	on := true
	cfg.Databases = []types.ProjectDatabaseConfig{{Name: "primary", IamAuth: &on}}
	t.Setenv("ALETHIA_KEYLESS_DB_AUTH_ENABLED", "true")
	if got := cloud.ByoDBUserSecrets(cfg); len(got) != 0 {
		t.Errorf("ALETHIA_KEYLESS_DB_AUTH_ENABLED=true did not exclude a keyless database: %v", got)
	}
}
