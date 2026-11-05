// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// byoDBTarget is the database target every fixture here binds to.
var byoDBTarget = types.ServiceBindingTarget{Kind: types.ServiceBindingKindDatabase, Name: "primary"}

// byoDBBinding is a binding to target asking for facet.
func byoDBBinding(target types.ServiceBindingTarget, facet types.ServiceBindingFacet) types.ServiceBinding {
	return types.ServiceBinding{Target: target, Inject: []types.ServiceBindingInjection{{Env: "X", From: facet}}}
}

// byoDBConfig is environment envID with one BYO chart "acme-api" in namespace "apps" whose workload
// "api" carries bindings, and one native project secret.
func byoDBConfig(envID string, bindings ...types.ServiceBinding) *types.ProjectConfig {
	return &types.ProjectConfig{
		ID:            "proj-1",
		ProjectName:   "shop",
		EnvironmentID: envID,
		Region:        "eu-central-1",
		Databases:     []types.ProjectDatabaseConfig{{Name: "primary"}},
		Secrets:       []types.ProjectSecretConfig{{Name: "app-key", Generate: true, Length: 24}},
		AddOns: []types.AddOnInstall{{
			ID: "acme-api", Byo: true, Namespace: "apps",
			Workloads: []types.ChartWorkloadBinding{{Name: "api", Bindings: bindings}},
		}},
	}
}

// byoDBProviders are the three clouds this slice covers, with the field their entries are named by.
var byoDBProviders = []struct {
	cloud   string
	p       CloudProvider
	nameKey string
}{
	{"aws", &awsProvider{}, "secret_name"},
	{"gcp", &gcpProvider{}, "name"},
	{"azure", &azureProvider{}, "name"},
}

// byoEntries returns the custom_secrets entries whose name starts with the per-binding prefix.
func byoEntries(t *testing.T, tfvars map[string]interface{}, nameKey string) map[string]map[string]interface{} {
	t.Helper()
	list, ok := tfvars["custom_secrets"].([]map[string]interface{})
	if !ok {
		t.Fatalf("custom_secrets is %T, want []map[string]interface{}", tfvars["custom_secrets"])
	}
	out := map[string]map[string]interface{}{}
	for _, e := range list {
		n, _ := e[nameKey].(string)
		if strings.HasPrefix(n, manifests.ByoDBSecretKeyPrefix) {
			out[n] = e
		}
	}
	return out
}

// keeperUser is the rotation keeper naming the user for key, read from wherever that cloud keeps it.
func keeperUser(t *testing.T, cloud string, tfvars map[string]interface{}, entry map[string]interface{}, key string) string {
	t.Helper()
	if cloud == "aws" {
		k, ok := entry["keepers"].(map[string]string)
		if !ok {
			t.Fatalf("aws entry %s keepers is %T, want map[string]string", key, entry["keepers"])
		}
		return k["user"]
	}
	all, ok := tfvars["custom_secret_keepers"].(map[string]interface{})
	if !ok {
		t.Fatalf("%s custom_secret_keepers is %T, want map[string]interface{}", cloud, tfvars["custom_secret_keepers"])
	}
	k, _ := all[key].(map[string]interface{})
	s, _ := k["user"].(string)
	return s
}

// TestByoDBUserSecrets_EntriesPerCloud: with the flag on, each cloud's custom_secrets carries one
// generated, alphanumeric, 32-character entry per declared database binding, keyed with the
// environment ID, with a keeper naming its user — next to the project's own secret, unchanged.
func TestByoDBUserSecrets_EntriesPerCloud(t *testing.T) {
	t.Setenv(byoDBUsersFlag, "true")
	cfg := byoDBConfig("env-1", byoDBBinding(byoDBTarget, "password"))
	wantKey := manifests.ByoBindingDBSecretKey("env-1", "apps", "api", byoDBTarget)
	wantUser := manifests.ByoBindingDBUser("env-1", "apps", "api", byoDBTarget)

	for _, tc := range byoDBProviders {
		t.Run(tc.cloud, func(t *testing.T) {
			tfvars := tc.p.ProviderTfvars(cfg)
			got := byoEntries(t, tfvars, tc.nameKey)
			if len(got) != 1 {
				t.Fatalf("per-binding entries = %v, want exactly %s", got, wantKey)
			}
			e, ok := got[wantKey]
			if !ok {
				t.Fatalf("per-binding entries = %v, want key %s", got, wantKey)
			}
			if e["length"] != byoDBUserPasswordLength || byoDBUserPasswordLength != 32 {
				t.Errorf("length = %v, want 32", e["length"])
			}
			special := "special_chars"
			if tc.cloud == "aws" {
				special = "special"
				if _, has := e["override_special"]; has {
					t.Errorf("aws entry carries override_special; the password must be alphanumeric")
				}
				if _, has := e["manual"]; has {
					t.Errorf("aws entry is manual; it must be generated")
				}
			} else if e["generate"] != true {
				t.Errorf("generate = %v, want true", e["generate"])
			}
			if e[special] != false {
				t.Errorf("%s = %v, want false (alphanumeric)", special, e[special])
			}
			if u := keeperUser(t, tc.cloud, tfvars, e, wantKey); u != wantUser {
				t.Errorf("keeper user = %q, want %q", u, wantUser)
			}
			// The project's own secret is still there, as the provider built it.
			found := false
			for _, s := range tfvars["custom_secrets"].([]map[string]interface{}) {
				if s[tc.nameKey] == "app-key" {
					found = true
				}
			}
			if !found {
				t.Errorf("the project secret app-key is gone from custom_secrets")
			}
		})
	}
}

// TestByoDBUserSecrets_KeyCarriesEnvironment: the same binding in two environments gets two keys, and
// an environment with no ID gets none.
func TestByoDBUserSecrets_KeyCarriesEnvironment(t *testing.T) {
	b := byoDBBinding(byoDBTarget, "password")
	a := ByoDBUserSecrets(byoDBConfig("env-1", b))
	c := ByoDBUserSecrets(byoDBConfig("env-2", b))
	if len(a) != 1 || len(c) != 1 {
		t.Fatalf("got %v and %v, want one entry each", a, c)
	}
	if a[0].Key == c[0].Key || a[0].User == c[0].User {
		t.Errorf("env-1 and env-2 derived the same identity: %v / %v", a[0], c[0])
	}
	if a[0].Key != manifests.ByoBindingDBSecretKey("env-1", "apps", "api", byoDBTarget) {
		t.Errorf("key %s is not the namer's", a[0].Key)
	}
	if got := ByoDBUserSecrets(byoDBConfig("", b)); len(got) != 0 {
		t.Errorf("no environment ID: got %v, want none", got)
	}
}

// TestByoDBUserSecrets_FlagOffChangesNothing: with the flag off no cloud's tfvars gain an entry or a
// keeper map, so no existing environment plans differently.
func TestByoDBUserSecrets_FlagOffChangesNothing(t *testing.T) {
	t.Setenv(byoDBUsersFlag, "")
	cfg := byoDBConfig("env-1", byoDBBinding(byoDBTarget, "password"))
	for _, tc := range byoDBProviders {
		t.Run(tc.cloud, func(t *testing.T) {
			tfvars := tc.p.ProviderTfvars(cfg)
			if got := byoEntries(t, tfvars, tc.nameKey); len(got) != 0 {
				t.Errorf("flag off: per-binding entries %v, want none", got)
			}
			if _, has := tfvars["custom_secret_keepers"]; has {
				t.Errorf("flag off: custom_secret_keepers emitted")
			}
		})
	}
}

// TestByoDBUserSecrets_RemovedBindingDropsEntry: removing one of two bindings removes exactly its
// entry, and the other keeps its key.
func TestByoDBUserSecrets_RemovedBindingDropsEntry(t *testing.T) {
	t.Setenv(byoDBUsersFlag, "true")
	reports := types.ServiceBindingTarget{Kind: types.ServiceBindingKindDatabase, Name: "reports"}
	both := byoDBConfig("env-1", byoDBBinding(byoDBTarget, "password"), byoDBBinding(reports, "username"))
	one := byoDBConfig("env-1", byoDBBinding(byoDBTarget, "password"))
	keep := manifests.ByoBindingDBSecretKey("env-1", "apps", "api", byoDBTarget)
	gone := manifests.ByoBindingDBSecretKey("env-1", "apps", "api", reports)
	for _, tc := range byoDBProviders {
		t.Run(tc.cloud, func(t *testing.T) {
			before := byoEntries(t, tc.p.ProviderTfvars(both), tc.nameKey)
			after := byoEntries(t, tc.p.ProviderTfvars(one), tc.nameKey)
			if len(before) != 2 {
				t.Fatalf("two bindings: entries %v, want 2", before)
			}
			if _, ok := after[keep]; !ok || len(after) != 1 {
				t.Errorf("after removal: entries %v, want only %s", after, keep)
			}
			if _, ok := after[gone]; ok {
				t.Errorf("after removal: %s still emitted", gone)
			}
		})
	}
}

// TestByoDBUserSecrets_DeclaredSet: which bindings declare a user — database targets with a credential
// facet only; keyless databases excluded while the keyless flag is on; the namespace the binding will
// live in; catalog add-ons with workloads included, as declaredByoBindings includes them.
func TestByoDBUserSecrets_DeclaredSet(t *testing.T) {
	cache := types.ServiceBindingTarget{Kind: "cache", Name: "c"}

	t.Run("endpoint facet only declares nothing", func(t *testing.T) {
		if got := ByoDBUserSecrets(byoDBConfig("env-1", byoDBBinding(byoDBTarget, "endpoint"))); len(got) != 0 {
			t.Errorf("got %v, want none", got)
		}
	})
	t.Run("non-database target declares nothing", func(t *testing.T) {
		if got := ByoDBUserSecrets(byoDBConfig("env-1", byoDBBinding(cache, "password"))); len(got) != 0 {
			t.Errorf("got %v, want none", got)
		}
	})
	t.Run("keyless database excluded only with the keyless flag", func(t *testing.T) {
		on := true
		cfg := byoDBConfig("env-1", byoDBBinding(byoDBTarget, "password"))
		cfg.Databases[0].IamAuth = &on
		t.Setenv(keylessDBAuthFlag, "true")
		if got := ByoDBUserSecrets(cfg); len(got) != 0 {
			t.Errorf("keyless on: got %v, want none", got)
		}
		t.Setenv(keylessDBAuthFlag, "")
		if got := ByoDBUserSecrets(cfg); len(got) != 1 {
			t.Errorf("keyless off: got %v, want one", got)
		}
	})
	t.Run("a BYO chart with no namespace keys on its own namespace", func(t *testing.T) {
		for _, ns := range []string{"", "default"} {
			cfg := byoDBConfig("env-1", byoDBBinding(byoDBTarget, "password"))
			cfg.AddOns[0].Namespace = ns
			got := ByoDBUserSecrets(cfg)
			want := manifests.ByoBindingDBSecretKey("env-1", "byo-acme-api", "api", byoDBTarget)
			if len(got) != 1 || got[0].Key != want {
				t.Errorf("namespace %q: got %v, want %s", ns, got, want)
			}
		}
	})
	t.Run("a catalog add-on with no namespace keys on default", func(t *testing.T) {
		cfg := byoDBConfig("env-1", byoDBBinding(byoDBTarget, "password"))
		cfg.AddOns[0].Byo = false
		cfg.AddOns[0].Namespace = ""
		got := ByoDBUserSecrets(cfg)
		want := manifests.ByoBindingDBSecretKey("env-1", "default", "api", byoDBTarget)
		if len(got) != 1 || got[0].Key != want {
			t.Errorf("got %v, want %s", got, want)
		}
	})
	t.Run("two facets of one binding are one user", func(t *testing.T) {
		b := byoDBBinding(byoDBTarget, "password")
		b.Inject = append(b.Inject, types.ServiceBindingInjection{Env: "U", From: "username"})
		if got := ByoDBUserSecrets(byoDBConfig("env-1", b, byoDBBinding(byoDBTarget, "username"))); len(got) != 1 {
			t.Errorf("got %v, want one", got)
		}
	})
}

// TestByoDBUserSecrets_ReservedPrefixRefused: a project secret named with the per-binding prefix, in
// any case, is refused on all three clouds; a name that merely shares letters is not.
func TestByoDBUserSecrets_ReservedPrefixRefused(t *testing.T) {
	for _, tc := range byoDBProviders {
		t.Run(tc.cloud, func(t *testing.T) {
			for _, name := range []string{"alethia-byo-db-abc", "Alethia-BYO-DB-abc"} {
				cfg := byoDBConfig("env-1")
				cfg.Secrets = append(cfg.Secrets, types.ProjectSecretConfig{Name: name, Generate: true, Length: 16})
				err := tc.p.ValidateConfig(cfg)
				if err == nil || !strings.Contains(err.Error(), "reserved") {
					t.Errorf("secret %q: ValidateConfig = %v, want the reserved-prefix refusal", name, err)
				}
			}
			cfg := byoDBConfig("env-1")
			cfg.Secrets = append(cfg.Secrets, types.ProjectSecretConfig{Name: "alethia-byo-dbx", Generate: true, Length: 16})
			if err := tc.p.ValidateConfig(cfg); err != nil && strings.Contains(err.Error(), "reserved for the per-binding") {
				t.Errorf("alethia-byo-dbx refused: %v", err)
			}
		})
	}
}

// TestByoDBUserSecrets_TakenKeyNotDuplicated: a key already in custom_secrets (a path that skipped
// ValidateConfig) is not appended a second time.
func TestByoDBUserSecrets_TakenKeyNotDuplicated(t *testing.T) {
	t.Setenv(byoDBUsersFlag, "true")
	cfg := byoDBConfig("env-1", byoDBBinding(byoDBTarget, "password"))
	key := manifests.ByoBindingDBSecretKey("env-1", "apps", "api", byoDBTarget)
	got := withByoDBUserSecrets(cfg, []map[string]interface{}{{"secret_name": key}}, byoDBSecretsAWS)
	if n := len(got.([]map[string]interface{})); n != 1 {
		t.Errorf("custom_secrets has %d entries, want 1", n)
	}
}

// TestByoDBUserSecrets_KeepersPassthroughPrecedence: on GCP and Azure `custom_secret_keepers` is now
// written by the typed mapping, so the user's own value is read from the cluster, DNS and network
// provider_config by hand. Each alone still reaches the plan, flag on or off, and when two name it
// the one merged first wins — what mergeProviderConfig's merge-if-absent did before the key was
// reserved.
func TestByoDBUserSecrets_KeepersPassthroughPrecedence(t *testing.T) {
	// set puts a keeper map naming its source into the i-th root passthrough source of cfg.
	type source struct {
		name string
		set  func(cfg *types.ProjectConfig, v map[string]any)
	}
	pcOf := func(v map[string]any) map[string]any { return map[string]any{"custom_secret_keepers": v} }
	sources := []source{
		{"cluster", func(c *types.ProjectConfig, v map[string]any) { c.Cluster.ProviderConfig = pcOf(v) }},
		{"dns", func(c *types.ProjectConfig, v map[string]any) { c.DNS.ProviderConfig = pcOf(v) }},
		{"network", func(c *types.ProjectConfig, v map[string]any) { c.Network.ProviderConfig = pcOf(v) }},
	}
	clouds := []struct {
		cloud   string
		p       CloudProvider
		sources []source
	}{
		{"gcp", &gcpProvider{}, sources},
		{"azure", &azureProvider{}, sources},
	}
	// winner is which source's map reached custom_secret_keepers.
	winner := func(t *testing.T, tfvars map[string]interface{}) string {
		t.Helper()
		all, ok := tfvars["custom_secret_keepers"].(map[string]interface{})
		if !ok {
			t.Fatalf("custom_secret_keepers is %T, want a map", tfvars["custom_secret_keepers"])
		}
		k, _ := all["app-key"].(map[string]interface{})
		s, _ := k["from"].(string)
		return s
	}
	for _, flag := range []string{"", "true"} {
		t.Setenv(byoDBUsersFlag, flag)
		for _, tc := range clouds {
			t.Run(tc.cloud+"/flag="+flag, func(t *testing.T) {
				for i, s := range tc.sources {
					cfg := byoDBConfig("env-1", byoDBBinding(byoDBTarget, "password"))
					s.set(cfg, map[string]any{"app-key": map[string]any{"from": s.name}})
					if got := winner(t, tc.p.ProviderTfvars(cfg)); got != s.name {
						t.Errorf("only %s sets it: reached %q", s.name, got)
					}
					if i == 0 {
						continue
					}
					prev := tc.sources[i-1]
					prev.set(cfg, map[string]any{"app-key": map[string]any{"from": prev.name}})
					if got := winner(t, tc.p.ProviderTfvars(cfg)); got != prev.name {
						t.Errorf("%s and %s both set it: %q won, want %s (merged first)", prev.name, s.name, got, prev.name)
					}
				}
			})
		}
	}
}

// TestByoDBUserSecrets_NonNativeProvider: with a credential-based secrets provider the template
// empties custom_secrets, so no entry is emitted and the reason names the cause; a keyless
// cross-account store is additive and leaves the native store, and the entries, in place.
func TestByoDBUserSecrets_NonNativeProvider(t *testing.T) {
	t.Setenv(byoDBUsersFlag, "true")
	for _, tc := range byoDBProviders {
		t.Run(tc.cloud, func(t *testing.T) {
			vault := byoDBConfig("env-1", byoDBBinding(byoDBTarget, "password"))
			vault.Secrets = append(vault.Secrets, types.ProjectSecretConfig{Name: "ext", Provider: "vault"})
			if got := byoEntries(t, tc.p.ProviderTfvars(vault), tc.nameKey); len(got) != 0 {
				t.Errorf("vault provider: entries %v, want none", got)
			}
			if r := ByoDBUserSecretsUnavailableReason(vault); !strings.Contains(r, `"vault"`) || !strings.Contains(r, "native secrets provider") {
				t.Errorf("vault provider: reason %q, want one naming vault and the native provider", r)
			}

			xacct := byoDBConfig("env-1", byoDBBinding(byoDBTarget, "password"))
			xacct.Secrets = append(xacct.Secrets, types.ProjectSecretConfig{Name: "ext", Provider: "aws-sm-xacct"})
			if got := byoEntries(t, tc.p.ProviderTfvars(xacct), tc.nameKey); len(got) != 1 {
				t.Errorf("keyless cross-account store: entries %v, want one", got)
			}
			if r := ByoDBUserSecretsUnavailableReason(xacct); r != "" {
				t.Errorf("keyless cross-account store: reason %q, want none", r)
			}
		})
	}
}

// TestByoDBUserSecrets_KeepersExtendPassthrough: on GCP and Azure a user's own custom_secret_keepers
// (cluster passthrough) survive, and a keeper the user set on a per-binding key is kept beside the
// user keeper — so a rotation handle the user turned still turns.
func TestByoDBUserSecrets_KeepersExtendPassthrough(t *testing.T) {
	t.Setenv(byoDBUsersFlag, "true")
	key := manifests.ByoBindingDBSecretKey("env-1", "apps", "api", byoDBTarget)
	for _, tc := range byoDBProviders[1:] {
		t.Run(tc.cloud, func(t *testing.T) {
			cfg := byoDBConfig("env-1", byoDBBinding(byoDBTarget, "password"))
			cfg.Cluster.ProviderConfig = map[string]any{"custom_secret_keepers": map[string]any{
				"app-key": map[string]any{"rotated": "2026-11-01"},
				key:       map[string]any{"rotated": "2026-11-02"},
			}}
			all, ok := tc.p.ProviderTfvars(cfg)["custom_secret_keepers"].(map[string]interface{})
			if !ok {
				t.Fatalf("custom_secret_keepers missing")
			}
			if k, _ := all["app-key"].(map[string]interface{}); k["rotated"] != "2026-11-01" {
				t.Errorf("the project secret's keeper was lost: %v", all["app-key"])
			}
			k, _ := all[key].(map[string]interface{})
			if k["rotated"] != "2026-11-02" || k["user"] != manifests.ByoBindingDBUser("env-1", "apps", "api", byoDBTarget) {
				t.Errorf("per-binding keepers = %v, want the user's rotation keeper and the user", k)
			}
		})
	}
}

// readTemplate reads a file under infra/templates/project with whitespace runs folded to one space.
func readTemplate(t *testing.T, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(templateRepoRoot(t), "infra", "templates", "project", rel))
	if err != nil {
		t.Fatalf("read %s: %v", rel, err)
	}
	return regexp.MustCompile(`\s+`).ReplaceAllString(string(b), " ")
}

// requireText fails unless every snippet is in the folded template text.
func requireText(t *testing.T, rel string, snippets ...string) {
	t.Helper()
	body := readTemplate(t, rel)
	for _, s := range snippets {
		if !strings.Contains(body, s) {
			t.Errorf("%s no longer contains %q", rel, s)
		}
	}
}

// TestByoDBUserSecrets_TemplatesStoreAndExposeThem pins the template half this slice relies on: each
// cloud creates custom_secrets with random_password, honours the keeper this file sends, gates the
// list on the native provider (the case ByoDBUserSecretsUnavailableReason names), and exports
// custom_secret_names keyed by the entry key — Azure's export is new here, and the identity map is
// right only while modules/key-vault names each secret by its key.
func TestByoDBUserSecrets_TemplatesStoreAndExposeThem(t *testing.T) {
	requireText(t, "aws/custom_secrets.tf", `custom_secrets = var.secrets_provider == "native" ? var.custom_secrets : []`)
	requireText(t, "aws/modules/awssm-passgen/main.tf",
		`special = lookup(each.value, "special", false)`,
		`each.value.keepers == null ? {} : each.value.keepers`)
	requireText(t, "aws/outputs.tf", `output "custom_secret_names" { value = module.custom_secrets_password_module.secret_names`)

	requireText(t, "gcp/secret-manager.tf", `secrets = var.secrets_provider == "native" ? var.custom_secrets : []`, `secret_keepers = var.custom_secret_keepers`)
	requireText(t, "gcp/modules/secret-manager/main.tf", `special = each.value.special_chars`, `keepers = lookup(var.secret_keepers, each.key, {})`)
	requireText(t, "gcp/outputs.tf", `output "custom_secret_names" {`)

	requireText(t, "azure/key-vault.tf", `secrets = var.secrets_provider == "native" ? var.custom_secrets : []`, `secret_keepers = var.custom_secret_keepers`)
	requireText(t, "azure/modules/key-vault/main.tf",
		`special = each.value.special_chars`,
		`keepers = lookup(var.secret_keepers, each.key, {})`,
		`resource "azurerm_key_vault_secret" "this" { for_each = local.all_secrets name = each.key`)
	requireText(t, "azure/outputs.tf", `output "custom_secret_names" { description = "Map of custom secret keys to their Key Vault secret names" value = { for k, _ in module.key_vault.secret_ids : k => k } }`)
}

// TestByoDBUserSecrets_ESOCanReadThem pins the external-secrets operator's read grant over the
// custom secrets on each cloud — the grant a binding ExternalSecret reading a per-binding key needs.
// AWS: the IRSA policy's ARN pattern is the awssm-passgen name prefix plus "*". GCP: secretAccessor per
// custom secret, on the same secret_id the module creates. Azure: "Key Vault Secrets User" on the
// project's vault, which covers every secret in it.
func TestByoDBUserSecrets_ESOCanReadThem(t *testing.T) {
	requireText(t, "aws/custom_secrets.tf", `secret_name_prefix = "${local.aws_regions_short[var.region]}-${var.environment}-${var.project_name}-"`)
	requireText(t, "aws/locals.tf", `"arn:aws:secretsmanager:${var.region}:${var.aws_account_id}:secret:${local.aws_regions_short[var.region]}-${var.environment}-${var.project_name}-*"`)

	requireText(t, "gcp/workload-identity.tf",
		`resource "google_secret_manager_secret_iam_member" "external_secrets_accessor" {`,
		`for_each = var.provision_gke && var.secrets_provider == "native" ? { for s in var.custom_secrets : s.name => s } : {}`,
		`secret_id = "${var.environment}-${var.project_name}-${each.key}" role = "roles/secretmanager.secretAccessor"`)
	requireText(t, "gcp/modules/secret-manager/main.tf", `secret_id = "${var.environment}-${var.project_name}-${each.key}"`)

	requireText(t, "azure/workload-identity.tf",
		`resource "azurerm_role_assignment" "external_secrets_kv" { count = var.provision_aks ? 1 : 0 scope = module.key_vault.vault_id role_definition_name = "Key Vault Secrets User"`)
}

// TestByoDBUserSecrets_KeeperShapes: every shape a passthrough keeper map arrives in is extended, and
// one that is not a map is handed back untouched for the template to refuse, with no keeper added.
func TestByoDBUserSecrets_KeeperShapes(t *testing.T) {
	t.Setenv(byoDBUsersFlag, "true")
	cfg := byoDBConfig("env-1", byoDBBinding(byoDBTarget, "password"))
	key := manifests.ByoBindingDBSecretKey("env-1", "apps", "api", byoDBTarget)
	shapes := map[string]interface{}{
		"json":         map[string]interface{}{"app-key": map[string]interface{}{"r": "1"}},
		"typed inner":  map[string]interface{}{"app-key": map[string]string{"r": "1"}},
		"typed nested": map[string]map[string]string{"app-key": {"r": "1"}},
	}
	for name, v := range shapes {
		got, ok := customSecretKeepers(cfg, []map[string]any{{"custom_secret_keepers": v}})
		m, isMap := got.(map[string]interface{})
		if !ok || !isMap {
			t.Fatalf("%s: got %T, want a map", name, got)
		}
		if k, _ := m["app-key"].(map[string]interface{}); k["r"] != "1" {
			t.Errorf("%s: the user's keeper was lost: %v", name, m["app-key"])
		}
		if k, _ := m[key].(map[string]interface{}); k["user"] == nil {
			t.Errorf("%s: no per-binding keeper: %v", name, m)
		}
	}
	got, ok := customSecretKeepers(cfg, []map[string]any{{"custom_secret_keepers": "not-a-map"}})
	if !ok || got != "not-a-map" {
		t.Errorf("a non-map value: got %v, %v, want it handed back unchanged", got, ok)
	}
	if r := ByoDBUserSecretsUnavailableReason(nil); r != "" || ByoDBUserSecrets(nil) != nil {
		t.Errorf("a nil config must yield nothing")
	}
}
