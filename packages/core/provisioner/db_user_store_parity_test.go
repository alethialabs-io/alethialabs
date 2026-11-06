// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"io"
	"os"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestByoDBUserStore_CoversEveryKeyTheResolverLooksUp holds the two halves of the per-binding store
// together (docs/adr/byo-binding-db-users.md §2 and §4). cloud.ByoDBUserSecrets decides which keys tofu
// creates, BEFORE the deploy's add-on stage; the binding resolver looks keys up AFTER it, once
// configureByoCharts has moved a chart out of "default". Every key the resolver asks for must be one
// the store half created, or the binding is silently unsatisfied forever.
//
// The config covers the three cases where the halves could disagree: a BYO chart stored in "default"
// (moved to byo-<id>), a keyless target (no key on either side), and a catalog add-on with workloads
// (declared by both). The outputs carry exactly the store half's keys, every user is provisioned, and
// the real add-on stage then runs: a key the resolver needs and the store lacks is reported as "no
// secret for its own database user", and its ExternalSecret is not applied.
func TestByoDBUserStore_CoversEveryKeyTheResolverLooksUp(t *testing.T) {
	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
	t.Setenv("ALETHIA_KEYLESS_DB_AUTH_ENABLED", "true")

	keyless := true
	bind := func(target, facet string) types.ServiceBinding {
		return types.ServiceBinding{
			Target: types.ServiceBindingTarget{Kind: types.ServiceBindingKindDatabase, Name: target},
			Inject: []types.ServiceBindingInjection{{Env: "X", From: types.ServiceBindingFacet(facet)}},
		}
	}
	paths := func(prefix string, knobs ...string) map[string]string {
		out := map[string]string{}
		for _, k := range knobs {
			out[k] = prefix + ".existingSecret"
		}
		return out
	}
	vc := &types.ProjectConfig{
		ID: "proj-1", ProjectName: "shop", EnvironmentID: "env-1",
		Databases: []types.ProjectDatabaseConfig{{Name: "primary"}, {Name: "ledger", IamAuth: &keyless}},
		AddOns: []types.AddOnInstall{
			{ID: "acme-api", Byo: true, Namespace: "default", Workloads: []types.ChartWorkloadBinding{{
				Name:       "api",
				Bindings:   []types.ServiceBinding{bind("primary", "password"), bind("ledger", "password")},
				ValuePaths: paths("api", "bind:database:primary:password", "bind:database:ledger:password"),
			}}},
			{ID: "beta", Byo: true, Namespace: "team-beta", Workloads: []types.ChartWorkloadBinding{{
				Name:       "worker",
				Bindings:   []types.ServiceBinding{bind("primary", "username")},
				ValuePaths: paths("worker", "bind:database:primary:username"),
			}}},
			{ID: "grafana", Namespace: "monitoring", Workloads: []types.ChartWorkloadBinding{{
				Name:       "web",
				Bindings:   []types.ServiceBinding{bind("primary", "password")},
				ValuePaths: paths("web", "bind:database:primary:password"),
			}}},
		},
	}

	// The store half runs first, on the configuration as stored — as ProviderTfvars does.
	store := cloud.ByoDBUserSecrets(vc)
	names := map[string]interface{}{}
	users := []string{}
	for _, s := range store {
		names[s.Key] = "store/" + s.Key
		users = append(users, s.User)
	}
	provisioned := provisionedDBUsers(users...)
	outputs := map[string]interface{}{"custom_secret_names": names}

	// Then the add-on stage, as addon_stage.go runs it: configure (the move), then the bindings.
	c := newBindingCluster(t, `{"items":[]}`, 0)
	byo := configureByoCharts(vc, "", nil, nil, io.Discard, io.Discard)
	if len(byo.Moved) != 1 || byo.Moved[0].To != "byo-acme-api" || len(byo.Refused) != 0 {
		t.Fatalf("fixture: moved %+v refused %+v, want acme-api moved to byo-acme-api and nothing refused", byo.Moved, byo.Refused)
	}
	// The BYO users Job's declared set (read after the move) is exactly the store half's: a user the
	// Job declares with no key would make every run skip revocation, and a key with no declared user
	// would never be provisioned.
	declared := declaredByoDBUsers(vc, true, byo.Refused)
	if len(declared) != len(store) {
		t.Errorf("the Job declares %d users, the store half %d: %+v vs %+v", len(declared), len(store), declared, store)
	}
	for _, d := range declared {
		if names[d.Key] == nil {
			t.Errorf("the Job declares %s, whose key %s the store half never created", d.User, d.Key)
		}
	}
	var log strings.Builder
	st := applyByoChartBindingsExcept(vc, outputs, "aws", byo.Refused, provisioned, &log, io.Discard)

	if strings.Contains(log.String(), "no secret for its own database user") {
		t.Errorf("the resolver looked up a key the store half never created:\n%s\nstore: %+v", log.String(), store)
	}
	body, _ := os.ReadFile(c.applied)
	applied := strings.Count(string(body), "kind: ExternalSecret")
	// primary for acme-api, beta and grafana; ledger is keyless on both sides.
	if applied != 3 || st.Failures != 0 {
		t.Errorf("applied %d ExternalSecrets (failures %d), want 3:\n%s", applied, st.Failures, log.String())
	}
	if len(store) != 3 {
		t.Errorf("the store half declared %d keys, want 3 (no key for the keyless target): %+v", len(store), store)
	}
	for _, s := range store {
		if !strings.Contains(string(body), "store/"+s.Key) {
			t.Errorf("store key %s was created but no binding reads it", s.Key)
		}
	}
	if want := manifests.ByoBindingDBSecretKey("env-1", "byo-acme-api", "api", types.ServiceBindingTarget{Kind: types.ServiceBindingKindDatabase, Name: "primary"}); names[want] == nil {
		t.Errorf("no store key for the moved chart's binding in byo-acme-api: %v", names)
	}
}
