// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// GitHub Container Registry as an OCI Helm registry — charts pushed to ghcr.io. Authenticated with a
// GitHub username + a PAT carrying the read:packages scope.
func init() {
	register("helm_registry", "oci-github-cr", behavior{
		validate: func(ctx ComponentContext) error {
			if cred(ctx.Credentials, "username", "") == "" || cred(ctx.Credentials, "password", "") == "" {
				return fmt.Errorf("GitHub Container Registry (OCI) credential not connected (missing username or token)")
			}
			return nil
		},
		repoCred: func(ctx ComponentContext) RepoCred {
			return RepoCred{
				URL:       "oci://ghcr.io",
				Username:  cred(ctx.Credentials, "username", ""),
				Password:  cred(ctx.Credentials, "password", ""),
				EnableOCI: true,
			}
		},
	})
}
