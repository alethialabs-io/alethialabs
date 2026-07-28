// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestAzureProvider_MySQLReachesTheTemplate pins the Go half of #1382. The template half was the
// bug — every resource in the azure-db module was gated on `is_postgres` while the module's own
// variable validation accepted "mysql", so selecting MySQL provisioned nothing and reported success.
//
// The provider was always correct, which is precisely why nothing caught it: the engine reached
// tfvars, and the template ignored it. This locks the contract the template now honours.
func TestAzureProvider_MySQLReachesTheTemplate(t *testing.T) {
	p := &azureProvider{}
	cfg := &types.ProjectConfig{
		Cluster:   types.ProjectClusterConfig{ProviderConfig: map[string]any{}},
		DNS:       types.ProjectDNSConfig{ProviderConfig: map[string]any{}},
		Databases: []types.ProjectDatabaseConfig{{Name: "main", EngineFamily: "mysql"}},
	}
	tfvars := p.ProviderTfvars(cfg)

	if got := tfvars["azure_db_engine"]; got != "mysql" {
		t.Errorf("azure_db_engine = %v, want mysql", got)
	}
	// MySQL Flexible Server accepts only 5.7 / 8.0.21 / 8.4 — a PostgreSQL-shaped major here is
	// rejected at apply with an error that names the field and not the reason.
	version, _ := tfvars["azure_db_engine_version"].(string)
	if version == "" {
		t.Fatal("azure_db_engine_version is empty — the catalog default did not resolve for mysql")
	}
	accepted := map[string]bool{"5.7": true, "8.0.21": true, "8.4": true}
	if !accepted[version] {
		t.Errorf("azure_db_engine_version = %q, which Azure MySQL does not accept", version)
	}
}
