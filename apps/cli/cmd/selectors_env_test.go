// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

type fakeEnvLister struct {
	envs []api.Environment
	err  error
}

func (f fakeEnvLister) ListEnvironments(string) ([]api.Environment, error) {
	return f.envs, f.err
}

func TestResolveEnvironmentID(t *testing.T) {
	lister := fakeEnvLister{envs: []api.Environment{
		{ID: "env-dev", Name: "development", IsDefault: true},
		{ID: "env-stg", Name: "staging"},
	}}

	// Empty name → "" so the server resolves the default env (back-compat); the lister is not even consulted.
	if id, err := resolveEnvironmentID(fakeEnvLister{err: errors.New("must not be called")}, "p", ""); err != nil || id != "" {
		t.Fatalf("empty --env should return (\"\", nil), got (%q, %v)", id, err)
	}

	// A known name resolves to its id.
	if id, err := resolveEnvironmentID(lister, "p", "staging"); err != nil || id != "env-stg" {
		t.Fatalf(`--env staging should resolve to "env-stg", got (%q, %v)`, id, err)
	}

	// An unknown name is a hard error that lists the available environments (no silent default).
	_, err := resolveEnvironmentID(lister, "p", "prod")
	if err == nil {
		t.Fatal("unknown --env should error, not silently fall back to the default")
	}
	if !strings.Contains(err.Error(), "development") || !strings.Contains(err.Error(), "staging") {
		t.Errorf("error should list available env names, got: %v", err)
	}

	// A transport error is propagated.
	if _, err := resolveEnvironmentID(fakeEnvLister{err: errors.New("boom")}, "p", "staging"); err == nil {
		t.Fatal("a ListEnvironments error should propagate")
	}
}
