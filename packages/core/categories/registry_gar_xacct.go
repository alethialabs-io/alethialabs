// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// Google Artifact Registry (cross-project, keyless) — pull from a GAR repository in a DIFFERENT GCP
// project than the cluster, with no stored key. The in-cluster `registry-token` refresher mints a GCP
// OAuth access token from the cluster's pull GSA (which the target project granted
// artifactregistry.reader). No credential fields — the connector references the target project +
// reader service account via provider_config.
func init() {
	register("registry", "gar-xacct", behavior{
		validate: func(ctx ComponentContext) error {
			pc := ctx.ProviderConfig
			if pcString(pc, "target_project_id", "") == "" {
				return fmt.Errorf("cross-project GAR: target GCP project id not set (provider_config.target_project_id)")
			}
			if pcString(pc, "region", "") == "" {
				return fmt.Errorf("cross-project GAR: region not set (provider_config.region)")
			}
			if pcString(pc, "registry_host", "") == "" {
				return fmt.Errorf("cross-project GAR: registry host not set (provider_config.registry_host, e.g. <region>-docker.pkg.dev)")
			}
			if pcString(pc, "target_service_account", "") == "" {
				return fmt.Errorf("cross-project GAR: target reader service account not set (provider_config.target_service_account — the GSA the target project granted artifactregistry.reader)")
			}
			return nil
		},
		keylessRegistry: func(ctx ComponentContext) KeylessRegistryTarget {
			pc := ctx.ProviderConfig
			return KeylessRegistryTarget{
				Slug:              "gar-xacct",
				Provider:          "gcp",
				RegistryHost:      pcString(pc, "registry_host", ""),
				Region:            pcString(pc, "region", ""),
				TargetProjectID:   pcString(pc, "target_project_id", ""),
				TargetIdentityRef: pcString(pc, "target_service_account", ""),
			}
		},
	})
}
