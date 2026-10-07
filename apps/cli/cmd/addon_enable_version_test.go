// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"net/http"
	"testing"
)

// resetAddonVersionFlag clears --version between Execute calls. cobra never resets a flag's value
// or its Changed bit, so without this one subtest's --version would leak into the next and the
// "no flag" case could not be reached.
func resetAddonVersionFlag(t *testing.T) {
	t.Helper()
	reset := func() {
		addonEnableVersion = ""
		if f := addonEnableCmd.Flags().Lookup("version"); f != nil {
			f.Changed = false
		}
	}
	reset()
	t.Cleanup(reset)
}

// TestAddonEnableVersionFlag pins the wire form of `alethia addon enable --version` (#5525) against a
// real HTTP round trip: a pin is sent as a string, an empty --version is sent as JSON null (the
// reset), and no flag leaves the field out of the body so the stored pin is kept.
func TestAddonEnableVersionFlag(t *testing.T) {
	cases := []struct {
		name    string
		args    []string
		present bool
		want    interface{}
	}{
		{name: "a pin is sent", args: []string{"--version", "58.2.1"}, present: true, want: "58.2.1"},
		{name: "an empty --version sends null", args: []string{"--version", ""}, present: true, want: nil},
		{name: "the = form of an empty value sends null", args: []string{"--version="}, present: true, want: nil},
		{name: "no flag leaves the field out", args: nil, present: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			run, rec := addonEnv(t, http.StatusCreated)
			resetAddonVersionFlag(t)
			args := append([]string{"addon", "enable", "kube-prometheus-stack", "--project", "shop"}, tc.args...)
			exited, code, err := connInvoke(t, run, args...)
			if err != nil {
				t.Fatalf("execute: %v", err)
			}
			if exited {
				t.Fatalf("unexpected fatal exit (code %d)", code)
			}
			if rec.method != http.MethodPost {
				t.Fatalf("method = %q, want POST", rec.method)
			}
			got, present := rec.body["version"]
			if present != tc.present {
				t.Fatalf("version present = %v, want %v (body %+v)", present, tc.present, rec.body)
			}
			if tc.present && got != tc.want {
				t.Errorf("version = %#v, want %#v", got, tc.want)
			}
			if rec.body["addon_id"] != "kube-prometheus-stack" {
				t.Errorf("addon_id = %v", rec.body["addon_id"])
			}
		})
	}
}
