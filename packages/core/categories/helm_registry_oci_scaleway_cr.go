// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// Scaleway Container Registry as an OCI Helm registry — a region-scoped endpoint
// (rg.<region>.scw.cloud). The username is fixed to "nologin"; the password is a Scaleway secret key.
func init() {
	register("helm_registry", "oci-scaleway-cr", behavior{
		validate: func(ctx ComponentContext) error {
			if pcString(ctx.ProviderConfig, "registry_host", "") == "" {
				return fmt.Errorf("Scaleway OCI registry host not set (provider_config.registry_host)")
			}
			if cred(ctx.Credentials, "secret_key", "") == "" {
				return fmt.Errorf("Scaleway Container Registry credential not connected (missing secret key)")
			}
			return nil
		},
		repoCred: func(ctx ComponentContext) RepoCred {
			return RepoCred{
				URL:       "oci://" + pcString(ctx.ProviderConfig, "registry_host", ""),
				Username:  "nologin",
				Password:  cred(ctx.Credentials, "secret_key", ""),
				EnableOCI: true,
			}
		},
	})
}
