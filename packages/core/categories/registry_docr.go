// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// DigitalOcean Container Registry — registry.digitalocean.com. A DO API token is
// used as both the username and the password.
func init() {
	register("registry", "docr", behavior{
		validate: func(ctx ComponentContext) error {
			if cred(ctx.Credentials, "token", "") == "" {
				return fmt.Errorf("DigitalOcean Container Registry credential not connected (missing API token)")
			}
			return nil
		},
		pullAuth: func(ctx ComponentContext) (string, string, string) {
			token := cred(ctx.Credentials, "token", "")
			return "https://registry.digitalocean.com", token, token
		},
	})
}
