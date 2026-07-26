// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// Generic OCI Helm registry — any OCI-compliant registry host (Harbor, JFrog, a self-hosted
// distribution, …) reachable with a host + username + password.
func init() {
	register("helm_registry", "oci-generic-cr", behavior{
		validate: func(ctx ComponentContext) error {
			if pcString(ctx.ProviderConfig, "registry_host", "") == "" {
				return fmt.Errorf("OCI registry host not set (provider_config.registry_host)")
			}
			if cred(ctx.Credentials, "username", "") == "" || cred(ctx.Credentials, "password", "") == "" {
				return fmt.Errorf("Generic OCI registry credential not connected (missing username or password)")
			}
			return nil
		},
		repoCred: func(ctx ComponentContext) RepoCred {
			return RepoCred{
				URL:       "oci://" + pcString(ctx.ProviderConfig, "registry_host", ""),
				Username:  cred(ctx.Credentials, "username", ""),
				Password:  cred(ctx.Credentials, "password", ""),
				EnableOCI: true,
			}
		},
	})
}
