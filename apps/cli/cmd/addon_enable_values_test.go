// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/spf13/cobra"
)

// resetFlagChanged clears one local flag's Changed bit now and after the test. cobra never resets
// it between Execute calls, and for a three-state flag the bit IS the state: left set, one subtest's
// --values-file would turn the next subtest's "no flag" into an explicit clear.
func resetFlagChanged(t *testing.T, cmd *cobra.Command, name string) {
	t.Helper()
	reset := func() {
		if f := cmd.Flags().Lookup(name); f != nil {
			f.Changed = false
		}
	}
	reset()
	t.Cleanup(reset)
}

// TestAddonEnableValuesFileFlag pins the wire form of `alethia addon enable --values-file` (#5545)
// over a real HTTP round trip. Leaving the flag out must leave `values_yaml` out of the body — the
// server then keeps the stored Advanced override. Before #5545 the two were indistinguishable and an
// unrelated `--set` silently removed the override; the explicit clear is `--values-file ""`, sent as
// JSON null, the same rule `--version` follows.
func TestAddonEnableValuesFileFlag(t *testing.T) {
	path := filepath.Join(t.TempDir(), "values.yaml")
	const content = "loki:\n  auth_enabled: false\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	cases := []struct {
		name    string
		args    []string
		present bool
		want    interface{}
	}{
		{name: "no flag leaves the field out (keep)", args: []string{"--set", "retention_days=14"}, present: false},
		{name: "a file is sent verbatim", args: []string{"--values-file", path}, present: true, want: content},
		{name: "an empty --values-file sends null (clear)", args: []string{"--values-file", ""}, present: true, want: nil},
		{name: "the = form of an empty value sends null", args: []string{"--values-file="}, present: true, want: nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			run, rec := addonEnv(t, http.StatusCreated)
			args := append([]string{"addon", "enable", "loki", "--project", "shop"}, tc.args...)
			exited, code, err := connInvoke(t, run, args...)
			if err != nil {
				t.Fatalf("execute: %v", err)
			}
			if exited {
				t.Fatalf("unexpected fatal exit (code %d)", code)
			}
			got, present := rec.body["values_yaml"]
			if present != tc.present {
				t.Fatalf("values_yaml present = %v, want %v (body %+v)", present, tc.present, rec.body)
			}
			if tc.present && got != tc.want {
				t.Errorf("values_yaml = %#v, want %#v", got, tc.want)
			}
		})
	}
}

// TestAddonEnableSetNull pins that `--set key=null` reaches the server as a JSON null for that key —
// the server's signal to reset that one setting to the add-on's default while the other stored
// settings are kept (#5545).
func TestAddonEnableSetNull(t *testing.T) {
	run, rec := addonEnv(t, http.StatusCreated)
	exited, code, err := connInvoke(t, run, "addon", "enable", "loki", "--project", "shop",
		"--set", "retention_days=null")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
	vals, ok := rec.body["values"].(map[string]interface{})
	if !ok {
		t.Fatalf("values missing: %+v", rec.body)
	}
	v, present := vals["retention_days"]
	if !present || v != nil {
		t.Errorf("retention_days = %#v (present %v), want an explicit null", v, present)
	}
}
