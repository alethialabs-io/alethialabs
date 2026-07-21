// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// GitLab Container Registry — defaults to registry.gitlab.com; override the host
// for self-managed GitLab. Pull with a username + read_registry token.
func init() {
	register("registry", "gitlab-cr", behavior{
		validate: func(ctx ComponentContext) error {
			if cred(ctx.Credentials, "username", "") == "" || cred(ctx.Credentials, "password", "") == "" {
				return fmt.Errorf("GitLab Container Registry credential not connected (missing username or token)")
			}
			return nil
		},
		pullAuth: func(ctx ComponentContext) (string, string, string) {
			return pcString(ctx.ProviderConfig, "registry_url", "https://registry.gitlab.com"),
				cred(ctx.Credentials, "username", ""),
				cred(ctx.Credentials, "password", "")
		},
	})
}
