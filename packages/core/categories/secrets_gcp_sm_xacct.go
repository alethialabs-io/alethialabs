// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// GCP Secret Manager (cross-project, keyless) — read secrets from a Secret Manager in a DIFFERENT GCP
// project than the cluster, with no stored key. The in-cluster External Secrets Operator authenticates
// with the cluster's GKE Workload Identity and reads the target project directly (gcpsm.projectID);
// the customer bootstrap grants roles/secretmanager.secretAccessor on the target project to our
// Workload-Identity principal (Model B). No credential fields, no target role to assume — the
// projectID IS the address and the grant lives in the target project.
func init() {
	register("secrets", "gcp-sm-xacct", behavior{
		validate: func(ctx ComponentContext) error {
			pc := ctx.ProviderConfig
			if pcString(pc, "target_project_id", "") == "" {
				return fmt.Errorf("cross-project GCP Secret Manager: target project id not set (provider_config.target_project_id — the project that owns the secrets and granted your cluster's workload identity secretmanager.secretAccessor)")
			}
			return nil
		},
		keylessSecretStore: func(ctx ComponentContext) KeylessSecretTarget {
			pc := ctx.ProviderConfig
			return KeylessSecretTarget{
				Slug:            "gcp-sm-xacct",
				Provider:        "gcp",
				Region:          pcString(pc, "region", ""),
				TargetProjectID: pcString(pc, "target_project_id", ""),
			}
		},
	})
}
