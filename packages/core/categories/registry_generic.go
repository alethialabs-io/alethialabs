// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// Every credential-based registry connector is runner-seeded (a dockerconfigjson imagePullSecret
// the runner applies post-apply — DominantRegistryPullSecretSpec → argocd.EnsureRegistryPullSecret),
// NOT a tofu module. Each provider registers a pullAuth returning the registry host + the
// username/password its credential maps to; only that mapping differs between them.

// Generic Registry — authenticate to any OCI/Docker registry with a URL,
// username, and password.
func init() {
	register("registry", "generic-cr", behavior{
		validate: func(ctx ComponentContext) error {
			if pcString(ctx.ProviderConfig, "registry_url", "") == "" {
				return fmt.Errorf("Generic registry URL not set (provider_config.registry_url)")
			}
			if cred(ctx.Credentials, "username", "") == "" || cred(ctx.Credentials, "password", "") == "" {
				return fmt.Errorf("Generic registry credential not connected (missing username or password)")
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
