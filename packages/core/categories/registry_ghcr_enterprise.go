// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// GitHub Enterprise Container Registry — a GitHub Enterprise Server registry at
// a customer-supplied host, pulled with a username + PAT.
func init() {
	register("registry", "ghcr-enterprise", behavior{
		validate: func(ctx ComponentContext) error {
			if pcString(ctx.ProviderConfig, "registry_url", "") == "" {
				return fmt.Errorf("GitHub Enterprise registry URL not set (provider_config.registry_url)")
			}
			if cred(ctx.Credentials, "username", "") == "" || cred(ctx.Credentials, "password", "") == "" {
				return fmt.Errorf("GitHub Enterprise Container Registry credential not connected (missing username or token)")
			}
			return nil
		},
		pullAuth: func(ctx ComponentContext) (string, string, string) {
			return pcString(ctx.ProviderConfig, "registry_url", ""),
				cred(ctx.Credentials, "username", ""),
				cred(ctx.Credentials, "password", "")
		},
	})
}
