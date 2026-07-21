// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// Docker Hub — pluggable alternative to the cloud-native container registry. It has no OpenTofu
// module: its only artifact is a dockerconfigjson imagePullSecret, which the runner seeds
// post-apply from pullAuth (mirrors external-dns / add-on secrets, which are runner-seeded too).
func init() {
	register("registry", "dockerhub", behavior{
		validate: func(ctx ComponentContext) error {
			if cred(ctx.Credentials, "username", "") == "" || cred(ctx.Credentials, "access_token", "") == "" {
				return fmt.Errorf("Docker Hub credential not connected (missing username or access_token)")
			}
			return nil
		},
		pullAuth: func(ctx ComponentContext) (string, string, string) {
			// The Docker Hub v1 registry endpoint is the conventional dockerconfig `auths` key.
			return "https://index.docker.io/v1/",
				cred(ctx.Credentials, "username", ""),
				cred(ctx.Credentials, "access_token", "")
		},
	})
}
