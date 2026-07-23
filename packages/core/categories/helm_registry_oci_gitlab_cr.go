// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// GitLab Container Registry as an OCI Helm registry — charts pushed to registry.gitlab.com (or a
// self-managed GitLab registry host). Authenticated with a username + a deploy/personal token.
func init() {
	register("helm_registry", "oci-gitlab-cr", behavior{
		validate: func(ctx ComponentContext) error {
			if cred(ctx.Credentials, "username", "") == "" || cred(ctx.Credentials, "password", "") == "" {
				return fmt.Errorf("GitLab Container Registry (OCI) credential not connected (missing username or token)")
			}
			return nil
		},
		repoCred: func(ctx ComponentContext) RepoCred {
			return RepoCred{
				URL:       "oci://" + pcString(ctx.ProviderConfig, "registry_host", "registry.gitlab.com"),
				Username:  cred(ctx.Credentials, "username", ""),
				Password:  cred(ctx.Credentials, "password", ""),
				EnableOCI: true,
			}
		},
	})
}
