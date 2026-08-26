// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #2835: the T2 stand-in served `git-token` but not `addon-secrets`, so the runner's fetch 404'd,
// `EnsureAddOnSecrets` received an empty map, and NO add-on could receive a secret in a run. minio
// then fell back to the chart generating its own credential at render time (#2822) — different on
// every reconcile, permanently OutOfSync.
//
// This is the pure half of the new handler: which add-ons get a secret, read out of the job's
// snapshot. No database, so it runs on every PR.

package e2e

import (
	"errors"
	"fmt"
	"testing"
)

func TestParseAddonSecretKeys(t *testing.T) {
	t.Parallel()

	t.Run("reads the keys of an add-on that declares a secretRef", func(t *testing.T) {
		t.Parallel()
		got, err := parseAddonSecretKeys([]byte(`{"addons":[
			{"id":"minio","secretRef":{"secretName":"alethia-addon-minio","keys":["rootPassword"]}}
		]}`))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(got) != 1 || len(got["minio"]) != 1 || got["minio"][0] != "rootPassword" {
			t.Fatalf("got %#v", got)
		}
	})

	// THE BRANCH THAT MATTERS. A permissive reader would mint and serve secrets for add-ons that
	// never asked for one — the opposite of the narrowing this change depends on.
	for _, tc := range []struct {
		name string
		raw  string
	}{
		{"no secretRef at all", `{"addons":[{"id":"reloader"}]}`},
		{"null secretRef", `{"addons":[{"id":"reloader","secretRef":null}]}`},
		{"empty key list", `{"addons":[{"id":"reloader","secretRef":{"keys":[]}}]}`},
		{"blank keys only", `{"addons":[{"id":"reloader","secretRef":{"keys":["","  "]}}]}`},
		{"blank add-on id", `{"addons":[{"id":"","secretRef":{"keys":["k"]}}]}`},
		{"no addons key", `{}`},
		{"empty addons list", `{"addons":[]}`},
	} {
		t.Run("yields nothing for "+tc.name, func(t *testing.T) {
			t.Parallel()
			got, err := parseAddonSecretKeys([]byte(tc.raw))
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(got) != 0 {
				t.Fatalf("got %#v, want none", got)
			}
		})
	}

	t.Run("blank keys are dropped but real ones survive alongside them", func(t *testing.T) {
		t.Parallel()
		got, err := parseAddonSecretKeys([]byte(
			`{"addons":[{"id":"harbor","secretRef":{"keys":["","coreSecret","  ","xsrfKey"]}}]}`))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(got["harbor"]) != 2 || got["harbor"][0] != "coreSecret" || got["harbor"][1] != "xsrfKey" {
			t.Fatalf("got %#v", got)
		}
	})

	t.Run("several add-ons are kept apart", func(t *testing.T) {
		t.Parallel()
		got, err := parseAddonSecretKeys([]byte(`{"addons":[
			{"id":"minio","secretRef":{"keys":["rootPassword"]}},
			{"id":"reloader"},
			{"id":"harbor","secretRef":{"keys":["coreSecret"]}}
		]}`))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(got) != 2 {
			t.Fatalf("got %#v, want minio and harbor only", got)
		}
	})

	t.Run("malformed JSON is an ERROR, not an empty result", func(t *testing.T) {
		t.Parallel()
		// "could not read the snapshot" and "this job enabled no secret-bearing add-on" are opposite
		// findings. Collapsing them would make the handler serve nothing and look correct doing it.
		if _, err := parseAddonSecretKeys([]byte(`{"addons":`)); err == nil {
			t.Fatal("expected an error for malformed JSON")
		}
		if _, err := parseAddonSecretKeys(nil); err == nil {
			t.Fatal("expected an error for nil input")
		}
	})
}

func TestMintAddonSecrets(t *testing.T) {
	t.Parallel()

	seq := func() func() (string, error) {
		n := 0
		return func() (string, error) { n++; return fmt.Sprintf("v%d", n), nil }
	}

	t.Run("mints a value for each requested key", func(t *testing.T) {
		t.Parallel()
		held := map[string]map[string]string{}
		got, err := mintAddonSecrets(held, map[string][]string{"minio": {"rootPassword"}}, seq())
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got["minio"]["rootPassword"] != "v1" {
			t.Fatalf("got %#v", got)
		}
	})

	// THE PROPERTY THIS EXISTS FOR. A value that changed between two fetches would reintroduce the
	// per-reconcile rotation of #2822 — the runner would seed a different Secret every deploy and
	// the chart would restart against credentials that moved underneath it.
	t.Run("a held value is STABLE across fetches", func(t *testing.T) {
		t.Parallel()
		held := map[string]map[string]string{}
		req := map[string][]string{"minio": {"rootPassword"}}
		first, _ := mintAddonSecrets(held, req, seq())
		second, _ := mintAddonSecrets(held, req, seq())
		if first["minio"]["rootPassword"] != second["minio"]["rootPassword"] {
			t.Fatalf("value rotated between fetches: %q then %q",
				first["minio"]["rootPassword"], second["minio"]["rootPassword"])
		}
	})

	t.Run("a NEW key on an add-on that already holds one is minted without disturbing it", func(t *testing.T) {
		t.Parallel()
		held := map[string]map[string]string{}
		first, _ := mintAddonSecrets(held, map[string][]string{"harbor": {"adminPassword"}}, seq())
		second, err := mintAddonSecrets(held,
			map[string][]string{"harbor": {"adminPassword", "secretKey"}}, seq())
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if second["harbor"]["adminPassword"] != first["harbor"]["adminPassword"] {
			t.Fatal("adding a key rotated the existing one")
		}
		if second["harbor"]["secretKey"] == "" {
			t.Fatal("new key not minted")
		}
	})

	t.Run("each add-on gets its own values", func(t *testing.T) {
		t.Parallel()
		held := map[string]map[string]string{}
		got, _ := mintAddonSecrets(held,
			map[string][]string{"minio": {"k"}, "harbor": {"k"}}, seq())
		if got["minio"]["k"] == got["harbor"]["k"] {
			t.Fatal("two add-ons share a credential")
		}
	})

	t.Run("no requested add-ons yields an empty set, not an error", func(t *testing.T) {
		t.Parallel()
		got, err := mintAddonSecrets(map[string]map[string]string{}, map[string][]string{}, seq())
		if err != nil || len(got) != 0 {
			t.Fatalf("got %#v, err %v", got, err)
		}
	})

	t.Run("an add-on requesting no keys is omitted entirely", func(t *testing.T) {
		t.Parallel()
		got, _ := mintAddonSecrets(map[string]map[string]string{},
			map[string][]string{"reloader": {}}, seq())
		if _, present := got["reloader"]; present {
			t.Fatalf("got %#v — an add-on with no keys must not appear", got)
		}
	})

	t.Run("a mint failure ABORTS rather than serving a partial set", func(t *testing.T) {
		t.Parallel()
		// A half-populated Secret makes the chart fail in a way that looks like a chart bug, which
		// is the most expensive kind of failure to diagnose.
		boom := func() (string, error) { return "", errors.New("entropy exhausted") }
		got, err := mintAddonSecrets(map[string]map[string]string{},
			map[string][]string{"minio": {"rootPassword"}}, boom)
		if err == nil {
			t.Fatalf("expected an error, got %#v", got)
		}
		if got != nil {
			t.Fatalf("a failure must not also return values: %#v", got)
		}
	})
}
