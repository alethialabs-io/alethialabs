// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// Docker Hub — pluggable alternative to the cloud-native container registry.
func init() {
	register("registry", "dockerhub", behavior{
		tfvars: func(ctx ComponentContext) map[string]any {
			username := cred(ctx.Credentials, "username", "")
			namespace := pcString(ctx.ProviderConfig, "namespace", username)
			return map[string]any{
				"dockerhub_username":     username,
				"dockerhub_access_token": cred(ctx.Credentials, "access_token", ""),
				"dockerhub_namespace":    namespace,
				"repositories":           itemNames(ctx.Items),
			}
		},
		validate: func(ctx ComponentContext) error {
			if cred(ctx.Credentials, "username", "") == "" || cred(ctx.Credentials, "access_token", "") == "" {
				return fmt.Errorf("Docker Hub credential not connected (missing username or access_token)")
			}
			return nil
		},
	})
}
