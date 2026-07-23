// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// Every helm_registry connector is runner-seeded (an ArgoCD repository-credential Secret the runner
// applies post-apply — HelmRepoCredSpecs → argocd.EnsureHelmRepoCredential), NOT a tofu module. Each
// provider registers a repoCred returning the chart-repo URL + the username/password ArgoCD
// authenticates the chart pull with, and whether the repo is OCI; only that mapping differs.

// HTTPS chart repo — a classic index.yaml Helm repository (https://charts.example.com) behind HTTP
// basic auth. Not OCI: ArgoCD clones the index over HTTPS with username/password.
func init() {
	register("helm_registry", "helm-https", behavior{
		validate: func(ctx ComponentContext) error {
			if pcString(ctx.ProviderConfig, "repo_url", "") == "" {
				return fmt.Errorf("Helm repository URL not set (provider_config.repo_url)")
			}
			if cred(ctx.Credentials, "username", "") == "" || cred(ctx.Credentials, "password", "") == "" {
				return fmt.Errorf("Helm repository credential not connected (missing username or password)")
			}
			return nil
		},
		repoCred: func(ctx ComponentContext) RepoCred {
			return RepoCred{
				URL:       pcString(ctx.ProviderConfig, "repo_url", ""),
				Username:  cred(ctx.Credentials, "username", ""),
				Password:  cred(ctx.Credentials, "password", ""),
				EnableOCI: false,
			}
		},
	})
}
