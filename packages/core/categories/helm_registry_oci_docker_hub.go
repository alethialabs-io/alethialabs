// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// Docker Hub as an OCI Helm registry — charts pushed to registry-1.docker.io under a namespace.
// Authenticated with a Docker Hub username + access token.
func init() {
	register("helm_registry", "oci-docker-hub", behavior{
		validate: func(ctx ComponentContext) error {
			if cred(ctx.Credentials, "username", "") == "" || cred(ctx.Credentials, "access_token", "") == "" {
				return fmt.Errorf("Docker Hub OCI credential not connected (missing username or access token)")
			}
			return nil
		},
		repoCred: func(ctx ComponentContext) RepoCred {
			return RepoCred{
				URL:       "oci://registry-1.docker.io",
				Username:  cred(ctx.Credentials, "username", ""),
				Password:  cred(ctx.Credentials, "access_token", ""),
				EnableOCI: true,
			}
		},
	})
}
