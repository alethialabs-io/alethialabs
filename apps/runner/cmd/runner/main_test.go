// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"reflect"
	"testing"
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
func TestSubcommandTableCoversEveryMode(t *testing.T) {
	want := []string{
		"kube-token", "db-token", "db-authproxy", "db-bootstrap",
		"harbor-bootstrap", "registry-token", "helm-repo-token",
	}
	for _, name := range want {
		if subcommands[name] == nil {
			t.Errorf("subcommand %q is not dispatched — its Job would boot the agent instead", name)
		}
	}
	if len(subcommands) != len(want) {
		t.Errorf("the table has %d entries, this test knows %d — add the new one here so it stays covered",
			len(subcommands), len(want))
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
