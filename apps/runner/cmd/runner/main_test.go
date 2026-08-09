// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
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
