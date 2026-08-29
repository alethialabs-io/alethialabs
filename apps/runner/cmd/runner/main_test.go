// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"gopkg.in/yaml.v3"
)

func TestRunnerSlots(t *testing.T) {
	cases := []struct {
		val  string
		want int
	}{
		{"", 1},    // unset → single slot (today's behavior)
		{"1", 1},   //
		{"4", 4},   //
		{" 3 ", 3}, // trimmed
		{"0", 1},   // invalid (<1) → clamp to 1
		{"-2", 1},  // negative → 1
		{"abc", 1}, // non-numeric → 1
		{"2.5", 1}, // not an int → 1
	}
	for _, c := range cases {
		t.Setenv("ALETHIA_RUNNER_SLOTS", c.val)
		if got := runnerSlots(); got != c.want {
			t.Errorf("runnerSlots(%q) = %d, want %d", c.val, got, c.want)
		}
	}
}

// TestRunnerOperator pins the operator resolution the sandbox gate keys off: an explicit
// ALETHIA_RUNNER_OPERATOR wins outright, and with it absent the LEGACY ALETHIA_RUNNER_MODE
// values ("cloud-hosted" / "self-hosted") map onto the new vocabulary so an already-deployed
// task definition keeps working. Nothing configured at all → the documented "self" default.
func TestRunnerOperator(t *testing.T) {
	cases := []struct {
		name     string
		operator string // ALETHIA_RUNNER_OPERATOR ("" = absent)
		mode     string // ALETHIA_RUNNER_MODE     ("" = absent)
		want     string
	}{
		{"explicit managed", "managed", "", "managed"},
		{"explicit self", "self", "", "self"},
		{"explicit operator beats legacy mode", "managed", "self-hosted", "managed"},
		{"explicit self beats legacy cloud-hosted", "self", "cloud-hosted", "self"},
		{"legacy cloud-hosted → managed", "", "cloud-hosted", "managed"},
		{"legacy self-hosted → self", "", "self-hosted", "self"},
		{"nothing configured → self", "", "", "self"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv("ALETHIA_RUNNER_OPERATOR", c.operator)
			t.Setenv("ALETHIA_RUNNER_MODE", c.mode)
			if got := runnerOperator(); got != c.want {
				t.Errorf("runnerOperator(operator=%q, mode=%q) = %q, want %q", c.operator, c.mode, got, c.want)
			}
		})
	}
}

// TestRunnerProviders pins the per-cloud claim scoping parsed out of
// ALETHIA_RUNNER_PROVIDERS: a comma-separated list with each entry trimmed and empty
// entries dropped, and nil (claim any provider) when nothing is configured.
func TestRunnerProviders(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want []string
	}{
		{"unset → any provider", "", nil},
		{"single", "aws", []string{"aws"}},
		{"several", "aws,gcp,azure", []string{"aws", "gcp", "azure"}},
		{"padded entries are trimmed", " aws , gcp ", []string{"aws", "gcp"}},
		{"empty entries are dropped", "aws,,gcp", []string{"aws", "gcp"}},
		{"trailing separator", "hetzner,", []string{"hetzner"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv("ALETHIA_RUNNER_PROVIDERS", c.raw)
			if got := runnerProviders(); !reflect.DeepEqual(got, c.want) {
				t.Errorf("runnerProviders(%q) = %#v, want %#v", c.raw, got, c.want)
			}
		})
	}
}

// The subcommand table is the only thing standing between a one-shot Job and the normal agent boot.
// A renamed or dropped entry compiles cleanly, and the Job would silently try to register as a
// runner instead of doing its work — with an env that carries no runner token, so it would fail
// looking like a credential problem rather than a routing one.
//
// This is the LONG-RUNNING half: sidecars and exec-plugins whose name reaches a manifest through a
// Go []string the renderer builds, not as argv in a YAML literal. They are listed because nothing
// derivable names them. The one-shot Jobs are covered structurally by the test below instead —
// see the note there for why a list was not enough.
func TestSubcommandTableCoversEveryLongRunningMode(t *testing.T) {
	for _, name := range []string{
		"kube-token", "db-token", "db-authproxy", "registry-token", "helm-repo-token",
	} {
		if subcommands[name] == nil {
			t.Errorf("subcommand %q is not dispatched — its sidecar would boot the agent instead", name)
		}
	}
}

// TestEveryRenderedJobSubcommandIsDispatched reads the subcommand name out of the argv the REAL
// manifest renderers emit, and asserts the table dispatches it.
//
// WHY THIS EXISTS, AND WHY THE LIST ABOVE DID NOT DO THE JOB. Until 2026-08-29 the only coverage
// here was a hand-typed allowlist plus `len(subcommands) != len(want)`. That shape catches a
// subcommand someone REMOVED. It is structurally incapable of catching one that was never ADDED:
// its "nothing found" branch is identical to its "nothing wrong" branch, and it never consults the
// renderers that actually invoke these names.
//
// What it missed: `vault-bootstrap` was emitted by two renderers from #2432 and #3154 and was
// never in the table at all. `agent.RunVaultBootstrap` — 646 lines, thoroughly unit-tested — was
// referenced only from its own test file. Both Vault bootstrap paths were dead in production and
// in e2e, and this test was green throughout. It cost five proof cells.
//
// So the expectation is DERIVED FROM THE EMITTER: drive each renderer, parse the YAML it produces,
// and take the subcommand of every runner-image container. A renderer that grows a new subcommand is
// covered the day it is written, with nothing to remember.
//
// The first version of this test shipped with the same hole one layer down, and `db-bootstrap` fell
// through it: the renderer list named only the three Vault/Harbor manifests, and the parser read only
// `containers`. `db-bootstrap` is emitted by manifests.RenderBootstrapJob as an INIT container, so it
// was neither listed nor reachable — dispatched in the table, asserted by nothing, and deleting its
// entry left every test in this package green while every keyless DB bootstrap Job on AWS, Azure and
// GCP died on a missing ALETHIA_WEB_ORIGIN. Both halves are fixed here: the three bootstrap Jobs are
// driven below, and jobSubcommands reads initContainers.
func TestEveryRenderedJobSubcommandIsDispatched(t *testing.T) {
	const image = "ghcr.io/alethialabs-io/runner:test"

	renders := []struct {
		what   string
		render func() (string, error)
	}{
		{
			// The marketplace Vault add-on (#3154) — passes --init-only.
			what: "argocd.AddOnBootstrapManifest (marketplace vault)",
			render: func() (string, error) {
				return argocd.AddOnBootstrapManifest(types.AddOnInstall{
					ID: "vault", Mode: "managed", Namespace: "vault",
					Bootstrap: &types.AddOnBootstrap{
						Kind:        types.AddOnBootstrapVaultInit,
						APIBase:     "http://addon-vault.vault.svc.cluster.local:8200",
						StateSecret: "alethia-vault-addon-state",
					},
				}, image)
			},
		},
		{
			// The platform Vault carrying hetzner's `secret` kind (#2432) — seeds and mints too.
			what: "argocd.HetznerVaultBootstrapJobManifest (platform vault)",
			render: func() (string, error) {
				return argocd.HetznerVaultBootstrapJobManifest(argocd.HetznerVault{
					Secrets: []argocd.HetznerVaultSecret{{Name: "api-key", Generate: true}},
				}, image)
			},
		},
		{
			// The Hetzner `registry` node's pull-robot bootstrap (#2431).
			what: "argocd.HarborBootstrapJobManifest",
			render: func() (string, error) {
				return argocd.HarborBootstrapJobManifest(argocd.HarborRegistry{
					Name: "app-images", Namespace: "registries", Host: "harbor.svc",
					PullSecretName: "app-images-pull", PullSecretNamespace: "default",
				}, image)
			},
		},
		// The keyless-database bootstrap Jobs (#1511) — the reason this file reads initContainers.
		// One per cloud, because each builds its own container list and only the shared init step
		// invokes the runner; a cloud that stopped emitting it would otherwise be invisible here.
		{
			what: "manifests.RenderBootstrapJob (aws)",
			render: func() (string, error) {
				res, err := manifests.RenderBootstrapJob(manifests.Options{
					Provider:    string(types.CloudProviderAws),
					RunnerImage: image,
					Outputs: map[string]string{
						"rds_cluster_endpoint":               "orders.abc.rds.amazonaws.com",
						"rds_database_name":                  "ordersdb",
						"rds_master_credentials_secret_name": "alethia/rds/orders",
					},
				}, types.ServiceBindingTarget{Kind: "database", Name: "orders-db"})
				return res.JobYAML, err
			},
		},
		{
			what: "manifests.RenderBootstrapJob (gcp)",
			render: func() (string, error) {
				res, err := manifests.RenderBootstrapJob(manifests.Options{
					Provider:    string(types.CloudProviderGcp),
					RunnerImage: image,
					Outputs: map[string]string{
						"cloud_sql_ip":                 "10.0.0.5",
						"cloud_sql_database":           "orders-prod",
						"cloud_sql_iam_user":           "appdb-1a2b@proj.iam",
						"cloud_sql_credentials_secret": "orders-prod-sql-credentials",
					},
				}, types.ServiceBindingTarget{Kind: "database", Name: "orders-db"})
				return res.JobYAML, err
			},
		},
		{
			// Azure is the one that mints its own admin token, so it invokes the runner TWICE —
			// `db-bootstrap` in the init step and `db-token --once` before it.
			what: "manifests.RenderBootstrapJob (azure)",
			render: func() (string, error) {
				res, err := manifests.RenderBootstrapJob(manifests.Options{
					Provider:    string(types.CloudProviderAzure),
					RunnerImage: image,
					Outputs: map[string]string{
						"azure_db_fqdn":            "orders.postgres.database.azure.com",
						"azure_db_name":            "orders_prod",
						"azure_db_admin_user":      "aks-orders-dbadmin",
						"azure_db_admin_client_id": "aaaa1111-2222-3333-4444-555566667777",
						"azure_db_app_oid":         "bbbb1111-2222-3333-4444-555566667777",
					},
				}, types.ServiceBindingTarget{Kind: "database", Name: "orders-db"})
				return res.JobYAML, err
			},
		},
	}

	seen := 0
	for _, r := range renders {
		manifest, err := r.render()
		if err != nil {
			t.Errorf("%s: render: %v", r.what, err)
			continue
		}
		names, err := jobSubcommands(manifest, image)
		if err != nil {
			t.Errorf("%s: %v", r.what, err)
			continue
		}
		if len(names) == 0 {
			t.Errorf("%s rendered no container argv — this test would pass vacuously, which is the "+
				"exact shape it replaced", r.what)
			continue
		}
		for _, name := range names {
			seen++
			if subcommands[name] == nil {
				t.Errorf("%s emits `runner %s`, but the table does not dispatch it — the Job would "+
					"boot the agent instead and die on a missing ALETHIA_WEB_ORIGIN, reading as a "+
					"credential problem rather than a routing one", r.what, name)
			}
		}
	}
	// A renderer list that silently emptied would otherwise report green. Assert the work happened.
	if seen == 0 {
		t.Fatal("no subcommand was extracted from any renderer — the guard measured nothing")
	}
}

// jobSubcommands parses a multi-document manifest and returns the subcommand every container built
// FROM THE RUNNER IMAGE invokes. Structural, not textual: the renderers emit YAML, so the YAML is
// what gets read — a comment or a flag value that happens to contain a subcommand name cannot fool
// it.
//
// It reads initContainers as well as containers. `db-bootstrap` is emitted ONLY as an init container
// (manifests.renderSQLInit writes /sql/init.sql for the client container that follows), so a reader
// of `containers` alone sees every keyless bootstrap Job on AWS, Azure and GCP as containing no
// runner invocation at all — which is how `db-bootstrap` sat dispatched-but-unasserted while the
// test above was written specifically to make that impossible.
//
// The runner-image filter is what makes reading both lists safe. A bootstrap Job also carries a
// postgres or mysql client container, and those are NOT runner invocations: the MySQL one overrides
// the entrypoint with `/bin/sh -c "…"`, so a naive args[0]/command[0] read would assert that
// `/bin/sh` is a runner subcommand and fail on a container that has nothing to do with the table.
// Matching on the image is exact, and it means a new sidecar on a third-party image cannot red this
// test while a new runner container is covered the day it is written.
func jobSubcommands(manifest, runnerImage string) ([]string, error) {
	type container struct {
		Image   string   `yaml:"image"`
		Command []string `yaml:"command"`
		Args    []string `yaml:"args"`
	}
	var out []string
	dec := yaml.NewDecoder(strings.NewReader(manifest))
	for {
		var doc struct {
			Spec struct {
				Template struct {
					Spec struct {
						InitContainers []container `yaml:"initContainers"`
						Containers     []container `yaml:"containers"`
					} `yaml:"spec"`
				} `yaml:"template"`
			} `yaml:"spec"`
		}
		err := dec.Decode(&doc)
		if errors.Is(err, io.EOF) {
			return out, nil
		}
		if err != nil {
			return nil, fmt.Errorf("parse rendered manifest: %w", err)
		}
		for _, c := range append(doc.Spec.Template.Spec.InitContainers, doc.Spec.Template.Spec.Containers...) {
			if c.Image != runnerImage {
				continue
			}
			// `command` overrides the entrypoint, so it comes first in argv when set. The subcommand
			// is the first word that is neither a flag nor a path — a `command` that re-states the
			// binary must not be mistaken for the mode it then invokes.
			for _, a := range append(append([]string{}, c.Command...), c.Args...) {
				if strings.HasPrefix(a, "-") || strings.Contains(a, "/") {
					continue
				}
				out = append(out, a)
				break
			}
		}
	}
}

func TestDispatchSubcommandFallsThroughToTheNormalBoot(t *testing.T) {
	for _, args := range [][]string{nil, {}, {"--verbose"}, {"not-a-subcommand"}, {"kube-tokens"}} {
		handled, err := dispatchSubcommand(context.Background(), args)
		if handled {
			t.Errorf("dispatchSubcommand(%v) claimed the args — the runner would never boot", args)
		}
		if err != nil {
			t.Errorf("dispatchSubcommand(%v) errored on a fall-through: %v", args, err)
		}
	}
}

func TestDispatchSubcommandRunsTheNamedModeAndReportsItsError(t *testing.T) {
	prev := subcommands
	t.Cleanup(func() { subcommands = prev })

	var gotArgs []string
	subcommands = map[string]func(context.Context, []string) error{
		"ok":   func(_ context.Context, a []string) error { gotArgs = a; return nil },
		"fail": func(context.Context, []string) error { return errors.New("boom") },
	}

	handled, err := dispatchSubcommand(context.Background(), []string{"ok", "--flag", "v"})
	if !handled || err != nil {
		t.Fatalf("handled=%v err=%v, want handled with no error", handled, err)
	}
	// The subcommand's own args are passed through, with its name stripped.
	if len(gotArgs) != 2 || gotArgs[0] != "--flag" || gotArgs[1] != "v" {
		t.Errorf("passed %v, want [--flag v]", gotArgs)
	}

	// A failure is RETURNED, not exited on, so the caller decides — and so this is testable at all.
	handled, err = dispatchSubcommand(context.Background(), []string{"fail"})
	if !handled || err == nil {
		t.Fatalf("handled=%v err=%v, want handled with an error", handled, err)
	}
}
