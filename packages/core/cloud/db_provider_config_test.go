// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// dbTfvars renders a single-database project for one provider.
func dbTfvars(p CloudProvider, db types.ProjectDatabaseConfig) map[string]interface{} {
	return p.ProviderTfvars(&types.ProjectConfig{
		Cluster:   types.ProjectClusterConfig{ProviderConfig: map[string]any{}},
		DNS:       types.ProjectDNSConfig{ProviderConfig: map[string]any{}},
		Databases: []types.ProjectDatabaseConfig{db},
	})
}

func hasString(ss []string, want string) bool {
	for _, s := range ss {
		if s == want {
			return true
		}
	}
	return false
}

// The MySQL general log records EVERY statement with its literal parameter values. Defaulting it on
// shipped whatever the application put in a WHERE clause to the customer's CloudWatch. It is now
// opt-in; audit still covers the security-forensics case.
func TestAWSRDSLogExports_GeneralIsOptIn(t *testing.T) {
	p := &awsProvider{}

	t.Run("mysql default omits general but keeps audit", func(t *testing.T) {
		tf := dbTfvars(p, types.ProjectDatabaseConfig{Name: "app", EngineFamily: "mysql"})
		logs, _ := tf["rds_logs_exports"].([]string)
		if hasString(logs, "general") {
			t.Errorf("rds_logs_exports = %v — `general` logs every statement with literal values; it must be opt-in", logs)
		}
		for _, want := range []string{"audit", "error", "slowquery"} {
			if !hasString(logs, want) {
				t.Errorf("rds_logs_exports = %v, missing %q", logs, want)
			}
		}
		if hasString(logs, "postgresql") {
			t.Errorf("rds_logs_exports = %v — Aurora MySQL rejects the postgresql log type", logs)
		}
	})

	t.Run("postgres default is unchanged", func(t *testing.T) {
		tf := dbTfvars(p, types.ProjectDatabaseConfig{Name: "app", EngineFamily: "postgres"})
		if logs, _ := tf["rds_logs_exports"].([]string); len(logs) != 1 || logs[0] != "postgresql" {
			t.Errorf("rds_logs_exports = %v, want [postgresql]", logs)
		}
	})

	t.Run("an explicit provider_config set wins, including opting general back in", func(t *testing.T) {
		tf := dbTfvars(p, types.ProjectDatabaseConfig{
			Name: "app", EngineFamily: "mysql",
			// []any of string is what a JSONB round-trip actually produces.
			ProviderConfig: map[string]any{"log_exports": []any{"error", "general"}},
		})
		logs, _ := tf["rds_logs_exports"].([]string)
		if len(logs) != 2 || logs[0] != "error" || logs[1] != "general" {
			t.Errorf("rds_logs_exports = %v, want the tenant's explicit [error general]", logs)
		}
	})

	t.Run("an engine-invalid set is passed through, not silently sanitized", func(t *testing.T) {
		// RDS-ENGINE-003 (checks_data.tf) blocks this fail-closed at apply with a message naming the
		// valid types. Dropping the entry here would hide what the tenant asked for and leave them
		// debugging a config that silently did something else.
		tf := dbTfvars(p, types.ProjectDatabaseConfig{
			Name: "app", EngineFamily: "mysql",
			ProviderConfig: map[string]any{"log_exports": []any{"postgresql"}},
		})
		if logs, _ := tf["rds_logs_exports"].([]string); !hasString(logs, "postgresql") {
			t.Errorf("rds_logs_exports = %v — the tenant's set must reach the fail-closed tf guard intact", logs)
		}
	})

	t.Run("log_exports is never emitted as a bare tfvar", func(t *testing.T) {
		// It is consumed under the name rds_logs_exports; leaking it through the passthrough would
		// emit a variable the template does not declare, failing the apply.
		tf := dbTfvars(p, types.ProjectDatabaseConfig{
			Name: "app", EngineFamily: "mysql",
			ProviderConfig: map[string]any{"log_exports": []any{"error"}},
		})
		if _, leaked := tf["log_exports"]; leaked {
			t.Error("log_exports leaked into tfvars as an undeclared variable")
		}
	})
}

// The security property of the passthrough. iam_auth is only emitted when the canvas set it, so an
// unreserved provider_config key would let a tenant switch keyless on for a cloud × engine cell the
// canvas never offered — straight past the offer-parity guard (#1508) and the visibleWhen gate
// (#1510). Every cloud must reserve its own flag UNCONDITIONALLY, not merely merge-if-absent.
func TestDBProviderConfig_CannotEnableKeylessOutOfBand(t *testing.T) {
	for _, tc := range []struct {
		name     string
		provider CloudProvider
		flags    []string
	}{
		{"aws", &awsProvider{}, []string{"rds_iam_auth_enabled", "rds_iam_irsa"}},
		{"gcp", &gcpProvider{}, []string{"cloud_sql_iam_auth"}},
		{"azure", &azureProvider{}, []string{"azure_db_iam_auth"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pc := map[string]any{}
			for _, f := range tc.flags {
				pc[f] = true
			}
			// IamAuth deliberately nil — the canvas did NOT offer keyless for this cell.
			tf := dbTfvars(tc.provider, types.ProjectDatabaseConfig{
				Name: "app", EngineFamily: "mysql", ProviderConfig: pc,
			})
			for _, f := range tc.flags {
				if v, present := tf[f]; present {
					t.Errorf("%s = %v — provider_config switched keyless on for a cell the canvas never "+
						"offered, bypassing the offer-parity guard", f, v)
				}
			}
		})
	}
}

// The point of the passthrough: a template variable with no typed Go field is reachable by name.
func TestDBProviderConfig_PassesUnmodelledKnobsThrough(t *testing.T) {
	for _, tc := range []struct {
		name     string
		provider CloudProvider
	}{
		{"aws", &awsProvider{}},
		{"gcp", &gcpProvider{}},
		{"azure", &azureProvider{}},
		{"alibaba", &alibabaProvider{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tf := dbTfvars(tc.provider, types.ProjectDatabaseConfig{
				Name: "app", EngineFamily: "postgres",
				ProviderConfig: map[string]any{"some_template_only_knob": "v"},
			})
			if tf["some_template_only_knob"] != "v" {
				t.Errorf("unmodelled knob did not reach tfvars: %v", tf["some_template_only_knob"])
			}
		})
	}
}

// A typed mapping must always beat the passthrough — mergeProviderConfig is merge-if-absent, and a
// provider_config key silently overriding a canvas value would make the canvas a liar.
func TestDBProviderConfig_DoesNotClobberTypedValues(t *testing.T) {
	tf := dbTfvars(&awsProvider{}, types.ProjectDatabaseConfig{
		Name: "app", EngineFamily: "postgres", InstanceClass: "db.r6g.large",
		ProviderConfig: map[string]any{"rds_instance_type": "db.t3.micro"},
	})
	if tf["rds_instance_type"] != "db.r6g.large" {
		t.Errorf("rds_instance_type = %v, want the canvas value db.r6g.large", tf["rds_instance_type"])
	}
}
