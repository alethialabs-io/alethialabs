// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// Harbor — a self-hosted Harbor registry at a customer-supplied host, pulled with
// a username (or robot account) + password/secret.
func init() {
	register("registry", "harbor", behavior{
		validate: func(ctx ComponentContext) error {
			if pcString(ctx.ProviderConfig, "registry_url", "") == "" {
				return fmt.Errorf("Harbor registry URL not set (provider_config.registry_url)")
			}
			if cred(ctx.Credentials, "username", "") == "" || cred(ctx.Credentials, "password", "") == "" {
				return fmt.Errorf("Harbor credential not connected (missing username or password)")
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
