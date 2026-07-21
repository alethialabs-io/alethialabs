// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// GitHub Container Registry (ghcr.io) — pull with a GitHub username + PAT.
func init() {
	register("registry", "ghcr", behavior{
		validate: func(ctx ComponentContext) error {
			if cred(ctx.Credentials, "username", "") == "" || cred(ctx.Credentials, "password", "") == "" {
				return fmt.Errorf("GitHub Container Registry credential not connected (missing username or token)")
			}
			return nil
		},
		pullAuth: func(ctx ComponentContext) (string, string, string) {
			return "https://ghcr.io",
				cred(ctx.Credentials, "username", ""),
				cred(ctx.Credentials, "password", "")
		},
	})
}
