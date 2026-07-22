// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// Quay — defaults to quay.io; override the host for a self-hosted Quay. Pull with
// a username (or robot account) + token.
func init() {
	register("registry", "quay", behavior{
		validate: func(ctx ComponentContext) error {
			if cred(ctx.Credentials, "username", "") == "" || cred(ctx.Credentials, "password", "") == "" {
				return fmt.Errorf("Quay credential not connected (missing username or token)")
			}
			return nil
		},
		pullAuth: func(ctx ComponentContext) (string, string, string) {
			return pcString(ctx.ProviderConfig, "registry_url", "https://quay.io"),
				cred(ctx.Credentials, "username", ""),
				cred(ctx.Credentials, "password", "")
		},
	})
}
