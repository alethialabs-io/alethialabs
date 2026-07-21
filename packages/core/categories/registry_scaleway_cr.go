// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// Scaleway Container Registry — a region-scoped endpoint (rg.<region>.scw.cloud).
// The username is fixed to "nologin"; the password is a Scaleway secret key.
func init() {
	register("registry", "scaleway-cr", behavior{
		validate: func(ctx ComponentContext) error {
			if pcString(ctx.ProviderConfig, "registry_url", "") == "" {
				return fmt.Errorf("Scaleway registry URL not set (provider_config.registry_url)")
			}
			if cred(ctx.Credentials, "secret_key", "") == "" {
				return fmt.Errorf("Scaleway Container Registry credential not connected (missing secret key)")
			}
			return nil
		},
		pullAuth: func(ctx ComponentContext) (string, string, string) {
			return pcString(ctx.ProviderConfig, "registry_url", ""),
				"nologin",
				cred(ctx.Credentials, "secret_key", "")
		},
	})
}
