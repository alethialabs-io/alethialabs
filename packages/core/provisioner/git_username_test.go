// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestGitUsernameFor_ReadsTheProviderTheRunnerRecorded checks each repo's username comes from the
// provider recorded for THAT repo, so a GitHub apps repo and a Bitbucket chart repo in one deploy
// are each sent with their own username (#6599).
func TestGitUsernameFor_ReadsTheProviderTheRunnerRecorded(t *testing.T) {
	vc := &types.ProjectConfig{GitProviders: map[string]string{
		"https://github.com/acme/apps":     "github",
		"https://gitlab.example/acme/iac":  "gitlab",
		"https://bitbucket.org/acme/chart": "bitbucket",
	}}
	cases := map[string]string{
		"https://github.com/acme/apps":     "x-access-token",
		"https://gitlab.example/acme/iac":  "oauth2",
		"https://bitbucket.org/acme/chart": "x-token-auth",
		// No recorded provider: the username sent before providers were named.
		"https://bitbucket.org/acme/unrecorded": "x-access-token",
	}
	for repo, want := range cases {
		if got := gitUsernameFor(vc, repo); got != want {
			t.Errorf("gitUsernameFor(%q) = %q, want %q", repo, got, want)
		}
	}
	if got := gitUsernameFor(nil, "https://bitbucket.org/acme/chart"); got != "x-access-token" {
		t.Errorf("gitUsernameFor(nil, …) = %q, want x-access-token", got)
	}
}
