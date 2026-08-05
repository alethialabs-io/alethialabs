// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

// withNoInput forces the scripting/CI input mode for the duration of a test and
// restores the previous value.
func withNoInput(t *testing.T, v bool) {
	t.Helper()
	prev := noInputMode
	noInputMode = v
	t.Cleanup(func() { noInputMode = prev })
}

// TestSelectorsFailFastWithoutInput covers the requireInteractive guard on every
// interactive selector: with prompts disabled they must return errNoInput before
// touching the network, so a scripted invocation fails fast instead of blocking
// on a prompt that can never be answered.
func TestSelectorsFailFastWithoutInput(t *testing.T) {
	withNoInput(t, true)

	cases := []struct {
		name string
		call func() (string, error)
	}{
		{"selectProject", func() (string, error) { return selectProject("tok") }},
		{"selectRunner", func() (string, error) { return selectRunner("tok", "") }},
		{"selectCloudIdentity", func() (string, error) { return selectCloudIdentity("tok") }},
		{"selectRunnerDeployCloudIdentity", func() (string, error) { return selectRunnerDeployCloudIdentity("tok") }},
		{"promptRegion", promptRegion},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := tc.call()
			if !errors.Is(err, errNoInput) {
				t.Fatalf("%s = (%q, %v); want errNoInput", tc.name, got, err)
			}
			if got != "" {
				t.Errorf("%s returned %q; want the empty string on refusal", tc.name, got)
			}
		})
	}
}

// TestPickIdentityByProvider covers the non-interactive branch of the connector
// remove picker: a provider argument resolves to that connection, and an
// unconnected provider is a hard error rather than a silent pick of another one.
func TestPickIdentityByProvider(t *testing.T) {
	identities := []api.CloudIdentity{
		{ID: "id-aws", Provider: "aws", Label: "prod (aws)"},
		{ID: "id-gcp", Provider: "gcp", Label: "prod (gcp)"},
	}

	cases := []struct {
		name    string
		arg     string
		wantID  string
		wantErr bool
	}{
		{"exact provider", "gcp", "id-gcp", false},
		{"case insensitive", "AWS", "id-aws", false},
		{"unconnected provider", "azure", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := pickIdentity(identities, []string{tc.arg})
			if tc.wantErr {
				if err == nil {
					t.Fatalf("pickIdentity(%q) should error, got %+v", tc.arg, got)
				}
				if !strings.Contains(err.Error(), tc.arg) {
					t.Errorf("error should name the provider, got: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("pickIdentity(%q): %v", tc.arg, err)
			}
			if got == nil || got.ID != tc.wantID {
				t.Errorf("pickIdentity(%q) = %+v, want id %s", tc.arg, got, tc.wantID)
			}
		})
	}
}
