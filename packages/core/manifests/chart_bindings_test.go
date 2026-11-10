// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import (
	"crypto/sha256"
	"encoding/hex"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func TestRenderExternalSecret_WithMarkerLabel(t *testing.T) {
	yaml, skipped, err := RenderExternalSecret(ExternalSecretParams{
		ServiceName: "web",
		Namespace:   "ns",
		Target:      types.ServiceBindingTarget{Kind: "database", Name: "orders"},
		Provider:    "aws",
		RemoteKey:   "arn:secret",
		Facets:      []string{"password"},
		Labels:      map[string]string{"alethia.io/byo-binding": "true"},
	})
	if err != nil || len(skipped) != 0 {
		t.Fatalf("render err=%v skipped=%v", err, skipped)
	}
	// The marker (for PruneChartBindingSecrets) AND the always-present labels are both there, and
	// the marker is a STRING once parsed: a YAML boolean label value fails the apply outright.
	docs := parseYAMLDocs(t, yaml)
	if len(docs) != 1 {
		t.Fatalf("want one document, got %d:\n%s", len(docs), yaml)
	}
	meta, _ := docs[0]["metadata"].(map[string]any)
	labels, _ := meta["labels"].(map[string]any)
	if got, ok := labels["alethia.io/byo-binding"].(string); !ok || got != "true" {
		t.Fatalf("marker label = %#v, want the string \"true\":\n%s", labels["alethia.io/byo-binding"], yaml)
	}
	if !strings.Contains(yaml, "app.kubernetes.io/managed-by: alethia") {
		t.Fatalf("fixed labels dropped when adding an extra one:\n%s", yaml)
	}
}

func chartDBBinding(facets ...[2]string) types.ServiceBinding {
	b := types.ServiceBinding{Target: types.ServiceBindingTarget{Kind: "database", Name: "orders"}}
	for _, f := range facets {
		b.Inject = append(b.Inject, types.ServiceBindingInjection{Env: f[0], From: types.ServiceBindingFacet(f[1])})
	}
	return b
}

func TestResolveChartWorkloadBindings_Satisfiable(t *testing.T) {
	binding := chartDBBinding(
		[2]string{"DB_HOST", "endpoint"},
		[2]string{"DB_PORT", "port"},
		[2]string{"DB_PASS", "password"},
	)
	valuePaths := map[string]string{
		ChartBindingKnob("database", "orders", "endpoint"): "externalDatabase.host",
		ChartBindingKnob("database", "orders", "port"):     "externalDatabase.port",
		ChartBindingKnob("database", "orders", "password"): "auth.existingSecret",
	}
	outputs := map[string]string{
		"rds_cluster_endpoint":               "db.internal:5432",
		"rds_master_credentials_secret_name": "arn:aws:secretsmanager:...:db-master",
	}

	res := ResolveChartWorkloadBindings("web", []types.ServiceBinding{binding}, valuePaths, outputs, "aws", "web-ns", nil, ChartBindingPolicy{})

	wantPatches := map[string]any{
		"externalDatabase.host": "db.internal:5432",
		"externalDatabase.port": "5432",
		"auth.existingSecret":   BindingSecretName("web", binding.Target), // web-database-orders
	}
	if !reflect.DeepEqual(res.Patches, wantPatches) {
		t.Fatalf("patches = %#v, want %#v", res.Patches, wantPatches)
	}
	if len(res.Unsatisfied) != 0 {
		t.Fatalf("unsatisfied = %v, want none", res.Unsatisfied)
	}
	if len(res.ExternalSecrets) != 1 {
		t.Fatalf("want 1 ExternalSecret, got %d", len(res.ExternalSecrets))
	}
	es := res.ExternalSecrets[0]
	if es.ServiceName != "web" || es.Namespace != "web-ns" || es.Provider != "aws" ||
		es.RemoteKey != "arn:aws:secretsmanager:...:db-master" ||
		!reflect.DeepEqual(es.Facets, []string{"password"}) {
		t.Fatalf("ExternalSecret params = %#v", es)
	}
	// The value the chart reads must be the SAME name the ExternalSecret materializes.
	if res.Patches["auth.existingSecret"] != BindingSecretName("web", es.Target) {
		t.Fatalf("existingSecret patch != BindingSecretName")
	}
	// No plaintext credential anywhere in the patches.
	for _, v := range res.Patches {
		if s, ok := v.(string); ok && s == "DB_PASS" {
			t.Fatal("a credential facet leaked a literal into the patches")
		}
	}
}

func TestResolveChartWorkloadBindings_UnsatisfiableCredential(t *testing.T) {
	binding := chartDBBinding([2]string{"DB_PASS", "password"})
	valuePaths := map[string]string{
		ChartBindingKnob("database", "orders", "password"): "auth.existingSecret",
	}

	// (a) No ESO store for the cloud (hetzner) → unsatisfied, no patch, no ExternalSecret.
	res := ResolveChartWorkloadBindings("web", []types.ServiceBinding{binding}, valuePaths,
		map[string]string{"rds_master_credentials_secret_name": "arn:secret"}, "hetzner", "ns", nil, ChartBindingPolicy{})
	if len(res.Patches) != 0 || len(res.ExternalSecrets) != 0 {
		t.Fatalf("hetzner should reference nothing: patches=%v es=%v", res.Patches, res.ExternalSecrets)
	}
	if len(res.Unsatisfied) != 1 {
		t.Fatalf("want the credential facet reported unsatisfied, got %v", res.Unsatisfied)
	}

	// (b) Store exists but the resource exported no master secret → unsatisfied, no dangling ref.
	res = ResolveChartWorkloadBindings("web", []types.ServiceBinding{binding}, valuePaths,
		map[string]string{}, "aws", "ns", nil, ChartBindingPolicy{})
	if _, referenced := res.Patches["auth.existingSecret"]; referenced {
		t.Fatal("must not reference an existingSecret that will not be materialized")
	}
	if len(res.Unsatisfied) != 1 {
		t.Fatalf("want unsatisfied, got %v", res.Unsatisfied)
	}
}

func TestResolveChartWorkloadBindings_MissingPath(t *testing.T) {
	binding := chartDBBinding([2]string{"DB_HOST", "endpoint"})
	res := ResolveChartWorkloadBindings("web", []types.ServiceBinding{binding},
		map[string]string{}, map[string]string{"rds_cluster_endpoint": "x"}, "aws", "ns", nil, ChartBindingPolicy{})
	if len(res.Patches) != 0 {
		t.Fatalf("no value-path → no patch, got %v", res.Patches)
	}
	if len(res.Unsatisfied) != 1 || res.Unsatisfied[0] != ChartBindingKnob("database", "orders", "endpoint") {
		t.Fatalf("want the knob reported unsatisfied, got %v", res.Unsatisfied)
	}
}

func TestSetByPath(t *testing.T) {
	m := map[string]any{"keep": 1}
	SetByPath(m, "a.b.c", "v")
	got, _ := m["a"].(map[string]any)
	inner, _ := got["b"].(map[string]any)
	if inner["c"] != "v" || m["keep"] != 1 {
		t.Fatalf("nested set failed: %#v", m)
	}
	// Empty path is a no-op.
	before := map[string]any{"x": 1}
	SetByPath(before, "", "y")
	if len(before) != 1 || before["x"] != 1 {
		t.Fatalf("empty path should no-op: %#v", before)
	}
	// A non-map intermediate is replaced with a map so the leaf lands.
	over := map[string]any{"a": 5}
	SetByPath(over, "a.b", 2)
	inner2, _ := over["a"].(map[string]any)
	if inner2["b"] != 2 {
		t.Fatalf("non-map intermediate not replaced: %#v", over)
	}
}

// TestResolveChartWorkloadBindings_EngineAwarePort: a BYO chart bound to a MySQL database gets 3306,
// not Postgres's 5432. This is independent of keyless — the port facet was engine-blind on the
// password path too, so a MySQL-backed chart was handed a port nothing listens on.
func TestResolveChartWorkloadBindings_EngineAwarePort(t *testing.T) {
	binding := chartDBBinding([2]string{"DB_PORT", "port"})
	valuePaths := map[string]string{
		ChartBindingKnob("database", "orders", "port"): "externalDatabase.port",
	}
	cases := []struct {
		name     string
		dbs      []types.ProjectDatabaseConfig
		wantPort string
	}{
		{"mysql", []types.ProjectDatabaseConfig{{Name: "orders", EngineFamily: "mysql"}}, "3306"},
		{"postgres", []types.ProjectDatabaseConfig{{Name: "orders", EngineFamily: "postgres"}}, "5432"},
		// An unset family, or a database absent from the config, keeps the pre-MySQL default so
		// existing charts render byte-identically.
		{"unset", []types.ProjectDatabaseConfig{{Name: "orders"}}, "5432"},
		{"absent", nil, "5432"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := ResolveChartWorkloadBindings("web", []types.ServiceBinding{binding}, valuePaths,
				map[string]string{}, "aws", "ns", tc.dbs, ChartBindingPolicy{})
			if got := res.Patches["externalDatabase.port"]; got != tc.wantPort {
				t.Errorf("port = %v, want %s", got, tc.wantPort)
			}
		})
	}
}

// TestResolveChartWorkloadBindings_PolicyRefusals pins each ChartBindingPolicy refusal: the
// credential facet is unsatisfied with its reason, gets no patch and no ExternalSecret, and the
// non-secret facet beside it still resolves.
func TestResolveChartWorkloadBindings_PolicyRefusals(t *testing.T) {
	binding := chartDBBinding([2]string{"DB_HOST", "endpoint"}, [2]string{"DB_PASS", "password"})
	valuePaths := map[string]string{
		ChartBindingKnob("database", "orders", "endpoint"): "db.host",
		ChartBindingKnob("database", "orders", "password"): "db.existingSecret",
	}
	outputs := map[string]string{
		"rds_cluster_endpoint":               "db.internal",
		"rds_master_credentials_secret_name": "arn:secret",
	}
	iam := true
	keylessDB := []types.ProjectDatabaseConfig{{Name: "orders", IamAuth: &iam}}
	passKnob := ChartBindingKnob("database", "orders", "password")

	cases := []struct {
		name       string
		dbs        []types.ProjectDatabaseConfig
		policy     ChartBindingPolicy
		wantReason string // "" → the password facet resolves
	}{
		{name: "no policy", policy: ChartBindingPolicy{}},
		{name: "keyless flag on, keyless target", dbs: keylessDB, policy: ChartBindingPolicy{KeylessDBAuth: true}, wantReason: "keyless database"},
		{name: "keyless flag off, keyless target", dbs: keylessDB, policy: ChartBindingPolicy{}},
		{name: "keyless flag on, password target", policy: ChartBindingPolicy{KeylessDBAuth: true}},
		{name: "credential refusal", policy: ChartBindingPolicy{CredentialRefusal: "no owner"}, wantReason: "no owner"},
		{name: "taken name", policy: ChartBindingPolicy{TakenSecretNames: map[string]bool{"web-database-orders": true}}, wantReason: "already rendered by a first-class service"},
		{name: "other name taken", policy: ChartBindingPolicy{TakenSecretNames: map[string]bool{"other": true}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := ResolveChartWorkloadBindings("web", []types.ServiceBinding{binding}, valuePaths, outputs, "aws", "ns", tc.dbs, tc.policy)
			if res.Patches["db.host"] != "db.internal" {
				t.Errorf("the non-secret facet stopped resolving: %v", res.Patches)
			}
			_, patched := res.Patches["db.existingSecret"]
			if tc.wantReason == "" {
				if !patched || len(res.ExternalSecrets) != 1 || len(res.Unsatisfied) != 0 {
					t.Fatalf("password facet should resolve: patches=%v es=%v unsat=%v", res.Patches, res.ExternalSecrets, res.Unsatisfied)
				}
				return
			}
			if patched || len(res.ExternalSecrets) != 0 {
				t.Fatalf("a refused facet produced a patch or ExternalSecret: patches=%v es=%v", res.Patches, res.ExternalSecrets)
			}
			if !reflect.DeepEqual(res.Unsatisfied, []string{passKnob}) || !strings.Contains(res.UnsatisfiedReasons[passKnob], tc.wantReason) {
				t.Fatalf("unsat=%v reasons=%v, want %q with reason containing %q", res.Unsatisfied, res.UnsatisfiedReasons, passKnob, tc.wantReason)
			}
		})
	}
}

// TestByoBindingDBUserIdentity pins the per-binding user namer (docs/adr/byo-binding-db-users.md §1):
// deterministic; one user per binding Secret identity per environment (environment + namespace +
// BindingSecretName), so a different environment, namespace, workload or target is a different user; "" is the renderer's "default"; the user fits
// MySQL's 32-character limit; the secret key shares the user's hash and is Key Vault-safe (no "_").
func TestByoBindingDBUserIdentity(t *testing.T) {
	orders := types.ServiceBindingTarget{Kind: "database", Name: "orders"}
	user := ByoBindingDBUser("env-1", "apps", "web", orders)
	if user != ByoBindingDBUser("env-1", "apps", "web", orders) {
		t.Fatal("the namer is not deterministic")
	}
	if !regexp.MustCompile(`^alethia_byo_[0-9a-f]{12}$`).MatchString(user) || len(user) > 32 {
		t.Fatalf("user %q is not alethia_byo_<12 hex> within 32 characters", user)
	}
	key := ByoBindingDBSecretKey("env-1", "apps", "web", orders)
	if key != "alethia-byo-db-"+strings.TrimPrefix(user, "alethia_byo_") {
		t.Fatalf("secret key %q does not share the user %q's hash", key, user)
	}
	if strings.Contains(key, "_") {
		t.Fatalf("secret key %q carries an underscore, which a Key Vault name cannot", key)
	}
	// A literal pin, so a change to the derivation is a visible decision, not a silent re-keying of
	// every live user (each of which would then be revoked and re-created on the next deploy).
	if user != "alethia_byo_"+sha256Hex12("env-1\x00apps\x00web-database-orders") {
		t.Fatalf("user %q is not sha256(environment NUL namespace NUL BindingSecretName)", user)
	}
	distinct := map[string]string{
		"other environment": ByoBindingDBUser("env-2", "apps", "web", orders),
		"other namespace":   ByoBindingDBUser("env-1", "apps-2", "web", orders),
		"other workload":    ByoBindingDBUser("env-1", "apps", "worker", orders),
		"other target":      ByoBindingDBUser("env-1", "apps", "web", types.ServiceBindingTarget{Kind: "database", Name: "reports"}),
	}
	for name, other := range distinct {
		if other == user {
			t.Errorf("%s: same user %q", name, user)
		}
	}
	if ByoBindingDBUser("env-1", "", "web", orders) != ByoBindingDBUser("env-1", "default", "web", orders) {
		t.Error("an empty namespace is not the renderer's \"default\"")
	}
}

// sha256Hex12 is the first 12 hex characters of s's SHA-256, computed independently of the namer.
func sha256Hex12(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])[:12]
}

// dbUserFixture is one BYO workload "web" in "apps" bound to database orders, with the per-binding
// user for it provisioned and its key in the store.
func dbUserFixture() (types.ServiceBinding, map[string]string, map[string]string, *ByoDBUsers) {
	binding := chartDBBinding([2]string{"DB_HOST", "endpoint"}, [2]string{"DB_USER", "username"}, [2]string{"DB_PASS", "password"})
	valuePaths := map[string]string{
		ChartBindingKnob("database", "orders", "endpoint"): "db.host",
		ChartBindingKnob("database", "orders", "username"): "db.userSecret",
		ChartBindingKnob("database", "orders", "password"): "db.existingSecret",
	}
	outputs := map[string]string{
		"rds_cluster_endpoint":               "db.internal",
		"rds_master_credentials_secret_name": "acme/rds/master",
	}
	user := ByoBindingDBUser("env-1", "apps", "web", binding.Target)
	users := &ByoDBUsers{
		Environment: "env-1",
		SecretNames: map[string]string{ByoBindingDBSecretKey("env-1", "apps", "web", binding.Target): "use1-dev-acme-alethia-byo-db-x"},
		Provisioned: map[string]bool{user: true},
	}
	return binding, valuePaths, outputs, users
}

// TestResolveChartWorkloadBindings_DBUsers: in per-binding mode a database credential facet resolves
// to an ExternalSecret reading the binding's own key, under the same Secret name, and the
// administrative output is never referenced — not in the params, not in the rendered YAML.
func TestResolveChartWorkloadBindings_DBUsers(t *testing.T) {
	binding, valuePaths, outputs, users := dbUserFixture()
	res := ResolveChartWorkloadBindings("web", []types.ServiceBinding{binding}, valuePaths, outputs, "aws", "apps", nil, ChartBindingPolicy{DBUsers: users})

	if len(res.Unsatisfied) != 0 || len(res.ExternalSecrets) != 0 || len(res.DBUserSecrets) != 1 {
		t.Fatalf("unsat=%v adminES=%v dbUserES=%v, want exactly one per-binding ExternalSecret", res.Unsatisfied, res.ExternalSecrets, res.DBUserSecrets)
	}
	name := BindingSecretName("web", binding.Target)
	if res.Patches["db.existingSecret"] != name || res.Patches["db.userSecret"] != name || res.Patches["db.host"] != "db.internal" {
		t.Fatalf("patches = %v", res.Patches)
	}
	p := res.DBUserSecrets[0]
	if p.User != ByoBindingDBUser("env-1", "apps", "web", binding.Target) || p.RemoteKey != "use1-dev-acme-alethia-byo-db-x" ||
		!reflect.DeepEqual(p.Facets, []string{"password", "username"}) || p.Namespace != "apps" {
		t.Fatalf("params = %#v", p)
	}
	y, err := RenderByoDBUserExternalSecret(p)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(y, "acme/rds/master") {
		t.Fatalf("the per-binding ExternalSecret names the administrative secret:\n%s", y)
	}
	docs := parseYAMLDocs(t, y)
	spec, _ := docs[0]["spec"].(map[string]any)
	target, _ := spec["target"].(map[string]any)
	tmpl, _ := target["template"].(map[string]any)
	data, _ := tmpl["data"].(map[string]any)
	if target["name"] != name || data["username"] != p.User || data["password"] != "{{ .password }}" {
		t.Fatalf("target = %#v\n%s", target, y)
	}
	remote, _ := spec["data"].([]any)
	if len(remote) != 1 {
		t.Fatalf("want one remote read, got %#v", remote)
	}
	ref, _ := remote[0].(map[string]any)["remoteRef"].(map[string]any)
	if ref["key"] != "use1-dev-acme-alethia-byo-db-x" {
		t.Fatalf("remoteRef = %#v, want the binding's own key", ref)
	}
	if _, hasProperty := ref["property"]; hasProperty {
		t.Fatalf("a custom secret is a plain value; no property may be read: %#v", ref)
	}
}

// TestResolveChartWorkloadBindings_DBUsersUnsatisfied: each reason a per-binding facet cannot resolve
// is reported, and none of them falls back to the administrative credential.
func TestResolveChartWorkloadBindings_DBUsersUnsatisfied(t *testing.T) {
	passKnob := ChartBindingKnob("database", "orders", "password")
	cases := []struct {
		name       string
		mutate     func(users *ByoDBUsers, dbs *[]types.ProjectDatabaseConfig, provider *string)
		wantReason string // "" → unsatisfied with no stated reason (no store)
	}{
		{name: "no environment", mutate: func(u *ByoDBUsers, _ *[]types.ProjectDatabaseConfig, _ *string) { u.Environment = "" }, wantReason: "has no ID"},
		{name: "user not provisioned", mutate: func(u *ByoDBUsers, _ *[]types.ProjectDatabaseConfig, _ *string) { u.Provisioned = nil }, wantReason: "was not provisioned"},
		{name: "no secret key", mutate: func(u *ByoDBUsers, _ *[]types.ProjectDatabaseConfig, _ *string) { u.SecretNames = nil }, wantReason: "no secret for its own database user"},
		{name: "mysql, user not provisioned", mutate: func(u *ByoDBUsers, dbs *[]types.ProjectDatabaseConfig, _ *string) {
			*dbs = []types.ProjectDatabaseConfig{{Name: "orders", EngineFamily: "mysql"}}
			u.Provisioned = nil
		}, wantReason: "was not provisioned"},
		{name: "no store", mutate: func(_ *ByoDBUsers, _ *[]types.ProjectDatabaseConfig, p *string) { *p = "hetzner" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			binding, valuePaths, outputs, users := dbUserFixture()
			var dbs []types.ProjectDatabaseConfig
			provider := "aws"
			tc.mutate(users, &dbs, &provider)
			res := ResolveChartWorkloadBindings("web", []types.ServiceBinding{binding}, valuePaths, outputs, provider, "apps", dbs, ChartBindingPolicy{DBUsers: users})
			if len(res.ExternalSecrets) != 0 || len(res.DBUserSecrets) != 0 {
				t.Fatalf("an unsatisfied facet produced an ExternalSecret: admin=%v dbUser=%v", res.ExternalSecrets, res.DBUserSecrets)
			}
			if _, patched := res.Patches["db.existingSecret"]; patched {
				t.Fatalf("an unsatisfied facet was patched: %v", res.Patches)
			}
			if !contains(res.Unsatisfied, passKnob) {
				t.Fatalf("unsat = %v, want %s", res.Unsatisfied, passKnob)
			}
			if got := res.UnsatisfiedReasons[passKnob]; !strings.Contains(got, tc.wantReason) || (tc.wantReason == "" && got != "") {
				t.Fatalf("reason = %q, want one containing %q", got, tc.wantReason)
			}
		})
	}

	// connection_string has no per-binding form.
	binding := chartDBBinding([2]string{"DB_URL", "connection_string"})
	_, _, outputs, users := dbUserFixture()
	knob := ChartBindingKnob("database", "orders", "connection_string")
	res := ResolveChartWorkloadBindings("web", []types.ServiceBinding{binding}, map[string]string{knob: "db.url"}, outputs, "aws", "apps", nil, ChartBindingPolicy{DBUsers: users})
	if len(res.DBUserSecrets) != 0 || !strings.Contains(res.UnsatisfiedReasons[knob], "not available for a per-binding database user") {
		t.Fatalf("connection_string: es=%v reasons=%v", res.DBUserSecrets, res.UnsatisfiedReasons)
	}
}

// TestResolveChartWorkloadBindings_DBUsersMySQL: a MySQL target in per-binding mode (#6467) binds like
// a Postgres one — the binding's own user and key, never the administrative output — and its
// `database` facet names the user's own database, which is named after the user. Until the user is
// provisioned, the `database` facet is refused with the credential facets' reason and patches nothing.
func TestResolveChartWorkloadBindings_DBUsersMySQL(t *testing.T) {
	mysql := []types.ProjectDatabaseConfig{{Name: "orders", EngineFamily: "mysql"}}
	binding, valuePaths, outputs, users := dbUserFixture()
	binding.Inject = append(binding.Inject, types.ServiceBindingInjection{Env: "DB_NAME", From: types.ServiceBindingFacetDatabase})
	dbKnob := ChartBindingKnob("database", "orders", "database")
	valuePaths[dbKnob] = "db.name"
	outputs["rds_database_name"] = "app"
	user := ByoBindingDBUser("env-1", "apps", "web", binding.Target)

	res := ResolveChartWorkloadBindings("web", []types.ServiceBinding{binding}, valuePaths, outputs, "aws", "apps", mysql, ChartBindingPolicy{DBUsers: users})
	if len(res.Unsatisfied) != 0 || len(res.ExternalSecrets) != 0 || len(res.DBUserSecrets) != 1 {
		t.Fatalf("unsat=%v reasons=%v adminES=%v dbUserES=%v", res.Unsatisfied, res.UnsatisfiedReasons, res.ExternalSecrets, res.DBUserSecrets)
	}
	if res.Patches["db.name"] != user {
		t.Errorf("database facet = %v, want the user's own database %s", res.Patches["db.name"], user)
	}
	if p := res.DBUserSecrets[0]; p.User != user || p.RemoteKey != "use1-dev-acme-alethia-byo-db-x" {
		t.Errorf("params = %#v", p)
	}
	if res.Patches["db.port"] != nil {
		t.Errorf("unexpected port patch %v", res.Patches["db.port"])
	}

	for name, mutate := range map[string]func(*ByoDBUsers){
		"not provisioned": func(u *ByoDBUsers) { u.Provisioned = nil },
		"no environment":  func(u *ByoDBUsers) { u.Environment = "" },
	} {
		t.Run(name, func(t *testing.T) {
			_, _, _, u := dbUserFixture()
			mutate(u)
			res := ResolveChartWorkloadBindings("web", []types.ServiceBinding{binding}, valuePaths, outputs, "aws", "apps", mysql, ChartBindingPolicy{DBUsers: u})
			if _, patched := res.Patches["db.name"]; patched {
				t.Fatalf("an unprovisioned user's database was named: %v", res.Patches)
			}
			if !contains(res.Unsatisfied, dbKnob) || res.UnsatisfiedReasons[dbKnob] == "" {
				t.Fatalf("database facet unsat=%v reasons=%v", res.Unsatisfied, res.UnsatisfiedReasons)
			}
			if res.UnsatisfiedReasons[dbKnob] != res.UnsatisfiedReasons[ChartBindingKnob("database", "orders", "password")] {
				t.Errorf("the database facet's reason %q differs from the credential facets' %q", res.UnsatisfiedReasons[dbKnob], res.UnsatisfiedReasons[ChartBindingKnob("database", "orders", "password")])
			}
		})
	}
}

// TestResolveChartWorkloadBindings_DatabaseFacet: outside a per-binding MySQL user, the `database`
// facet is the environment's database, from the output the Jobs connect with; it is a literal, never
// a Secret; a target that is not a database, or a cloud with no such output, leaves it unsatisfied.
func TestResolveChartWorkloadBindings_DatabaseFacet(t *testing.T) {
	iam := true
	knob := ChartBindingKnob("database", "orders", "database")
	db := chartDBBinding([2]string{"DB_NAME", "database"})
	paths := map[string]string{knob: "db.name"}
	_, _, _, users := dbUserFixture()
	for _, tc := range []struct {
		name     string
		provider string
		outputs  map[string]string
		dbs      []types.ProjectDatabaseConfig
		policy   ChartBindingPolicy
		want     string // "" → unsatisfied
	}{
		{"aws administrative", "aws", map[string]string{"rds_database_name": "app"}, nil, ChartBindingPolicy{}, "app"},
		{"gcp administrative", "gcp", map[string]string{"cloud_sql_database": "app-gcp"}, nil, ChartBindingPolicy{}, "app-gcp"},
		{"azure administrative", "azure", map[string]string{"azure_db_name": "app-az"}, nil, ChartBindingPolicy{}, "app-az"},
		{"mysql administrative", "aws", map[string]string{"rds_database_name": "app"}, []types.ProjectDatabaseConfig{{Name: "orders", EngineFamily: "mysql"}}, ChartBindingPolicy{}, "app"},
		{"postgres per-binding", "aws", map[string]string{"rds_database_name": "app"}, nil, ChartBindingPolicy{DBUsers: users}, "app"},
		{"mysql keyless", "aws", map[string]string{"rds_database_name": "app"}, []types.ProjectDatabaseConfig{{Name: "orders", EngineFamily: "mysql", IamAuth: &iam}}, ChartBindingPolicy{KeylessDBAuth: true, DBUsers: users}, "app"},
		{"no output", "hetzner", map[string]string{"rds_database_name": "app"}, nil, ChartBindingPolicy{}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			res := ResolveChartWorkloadBindings("web", []types.ServiceBinding{db}, paths, tc.outputs, tc.provider, "apps", tc.dbs, tc.policy)
			if len(res.ExternalSecrets) != 0 || len(res.DBUserSecrets) != 0 {
				t.Fatalf("a database name became a Secret: %v %v", res.ExternalSecrets, res.DBUserSecrets)
			}
			if tc.want == "" {
				if _, patched := res.Patches["db.name"]; patched || !contains(res.Unsatisfied, knob) {
					t.Fatalf("patches=%v unsat=%v, want unsatisfied", res.Patches, res.Unsatisfied)
				}
				return
			}
			if res.Patches["db.name"] != tc.want || len(res.Unsatisfied) != 0 {
				t.Fatalf("patches=%v unsat=%v, want db.name=%s", res.Patches, res.Unsatisfied, tc.want)
			}
		})
	}
	cache := types.ServiceBinding{Target: types.ServiceBindingTarget{Kind: types.ServiceBindingKindCache, Name: "c"},
		Inject: []types.ServiceBindingInjection{{Env: "X", From: types.ServiceBindingFacetDatabase}}}
	cacheKnob := ChartBindingKnob("cache", "c", "database")
	res := ResolveChartWorkloadBindings("web", []types.ServiceBinding{cache}, map[string]string{cacheKnob: "x"}, map[string]string{"rds_database_name": "app"}, "aws", "apps", nil, ChartBindingPolicy{})
	if !contains(res.Unsatisfied, cacheKnob) || len(res.Patches) != 0 {
		t.Fatalf("a cache binding was given a database name: %v %v", res.Patches, res.Unsatisfied)
	}
	if IsCredentialFacet("database") {
		t.Error("the database facet is a credential")
	}
}

// TestResolveChartWorkloadBindings_DBUsersKeylessStillWins: the keyless refusal comes before the
// per-binding mode, so a keyless target gets no password secret of either kind.
func TestResolveChartWorkloadBindings_DBUsersKeylessStillWins(t *testing.T) {
	binding, valuePaths, outputs, users := dbUserFixture()
	iam := true
	res := ResolveChartWorkloadBindings("web", []types.ServiceBinding{binding}, valuePaths, outputs, "aws", "apps",
		[]types.ProjectDatabaseConfig{{Name: "orders", IamAuth: &iam}}, ChartBindingPolicy{KeylessDBAuth: true, DBUsers: users})
	if len(res.DBUserSecrets) != 0 || !strings.Contains(res.UnsatisfiedReasons[ChartBindingKnob("database", "orders", "password")], "keyless database") {
		t.Fatalf("es=%v reasons=%v", res.DBUserSecrets, res.UnsatisfiedReasons)
	}
}

// TestRenderByoDBUserExternalSecret_Refusals: the renderer fails closed on every input it cannot
// render safely, and a username-only binding does not receive the password.
func TestRenderByoDBUserExternalSecret_Refusals(t *testing.T) {
	good := ByoDBUserSecretParams{
		ServiceName: "web", Namespace: "apps", Target: types.ServiceBindingTarget{Kind: "database", Name: "orders"},
		Provider: "aws", User: ByoBindingDBUser("env-1", "apps", "web", types.ServiceBindingTarget{Kind: "database", Name: "orders"}),
		RemoteKey: "use1-dev-acme-alethia-byo-db-x", Facets: []string{"username"},
		Labels: map[string]string{"alethia.io/byo-binding": "true"},
	}
	y, err := RenderByoDBUserExternalSecret(good)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(y, "password: ") {
		t.Fatalf("a username-only binding's Secret carries the password:\n%s", y)
	}
	meta, _ := parseYAMLDocs(t, y)[0]["metadata"].(map[string]any)
	labels, _ := meta["labels"].(map[string]any)
	if labels["alethia.io/byo-binding"] != "true" {
		t.Fatalf("label not a string \"true\": %#v", labels)
	}
	for name, mutate := range map[string]func(*ByoDBUserSecretParams){
		"no store":         func(p *ByoDBUserSecretParams) { p.Provider = "hetzner" },
		"admin user":       func(p *ByoDBUserSecretParams) { p.User = "postgres" },
		"no remote key":    func(p *ByoDBUserSecretParams) { p.RemoteKey = " " },
		"multi-line key":   func(p *ByoDBUserSecretParams) { p.RemoteKey = "a\nb" },
		"no usable facets": func(p *ByoDBUserSecretParams) { p.Facets = []string{"connection_string"} },
	} {
		t.Run(name, func(t *testing.T) {
			p := good
			mutate(&p)
			if y, err := RenderByoDBUserExternalSecret(p); err == nil {
				t.Fatalf("rendered:\n%s", y)
			}
		})
	}
}

// contains reports whether s holds v.
func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}
