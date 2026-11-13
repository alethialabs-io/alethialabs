// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package git

// The git providers a token can come from, spelled as the console's `git-token` route names them
// in its `provider` field. The console resolves the provider from the repo's exact host
// (apps/console/lib/git/provider-host.ts), including a self-hosted GitLab host the runner has no
// configuration for, so the runner takes the name it is given rather than reading the host again.
const (
	ProviderGitHub    = "github"
	ProviderGitLab    = "gitlab"
	ProviderBitbucket = "bitbucket"
)

// defaultTokenUsername is the username every runner sent before the console named a provider. A
// console that predates the `provider` field still gets it, which keeps GitHub (and GitLab, which
// does not check the username) working exactly as before.
const defaultTokenUsername = "x-access-token"

// TokenUsername returns the HTTP Basic username that goes with an OAuth access token from provider:
//
//   - github: `x-access-token`.
//   - gitlab: `oauth2`, the username GitLab documents for an OAuth token.
//   - bitbucket: `x-token-auth`. Bitbucket Cloud rejects any other username for an access token,
//     for a clone as well as a push.
//
// An empty or unknown provider gets `x-access-token`, the username sent before providers were named.
func TokenUsername(provider string) string {
	switch provider {
	case ProviderGitLab:
		return "oauth2"
	case ProviderBitbucket:
		return "x-token-auth"
	default:
		return defaultTokenUsername
	}
}
