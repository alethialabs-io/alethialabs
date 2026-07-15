// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"errors"
	"strings"
	"testing"
)

// The fixtures below are VERBATIM from real failed applies on Azure during the BYOC
// real-provisioning campaign (issue #526) — not invented. That matters: the whole bug is that we
// mis-classify what real clouds actually return.

// The WEDGE. Captured after Azure allocated an azurerm_managed_redis, failed it for capacity, and
// left it behind — every subsequent apply then died with this, permanently.
const fixtureAlreadyExists = `Error: a resource with the ID "/subscriptions/32f3d6ca-f9b5-48f1-b714-dcfb9cc661ae/resourceGroups/rg-e2e-e2edb01/providers/Microsoft.Cache/redisEnterprise/e2e-e2edb01-redis" already exists - to be managed via Terraform this resource needs to be imported into the State. Please see the resource documentation for "azurerm_managed_redis" for more information

  with module.azure_cache[0].azurerm_managed_redis.this,
  on modules/azure-cache-redis/main.tf line 23, in resource "azurerm_managed_redis" "this":
  23: resource "azurerm_managed_redis" "this" {`

// The CREATE that orphans it: the cloud accepted, allocated, then failed asynchronously.
const fixtureAllocationFailed = `Error: creating Redis Enterprise (Subscription: "32f3d6ca-f9b5-48f1-b714-dcfb9cc661ae"
Resource Group Name: "rg-e2e-e2eaz05"
Redis Enterprise Name: "e2e-e2eaz05-redis"): polling after Create: polling failed: the Azure API returned the following error:

Status: "Failed"
Code: "AllocationFailed"
Message: "Request failed due to insufficient capacity. Retry using a different Azure Managed Redis size, region or contact Azure support for assistance."

  with module.azure_cache[0].azurerm_managed_redis.this,
  on modules/azure-cache-redis/main.tf line 23, in resource "azurerm_managed_redis" "this":`

// An ORDINARY failure that leaves NOTHING behind — the case the original design correctly refused
// to alert on. Real: Azure rejected the SKU before creating anything.
const fixtureSkuRejected = `Error: creating Kubernetes Cluster: unexpected status 400 (400 Bad Request) with response: {
  "code": "BadRequest",
  "message": "The VM size of Standard_B2s is not allowed in your subscription in location 'germanywestcentral'."
 }

  with module.aks[0].azurerm_kubernetes_cluster.this,
  on modules/aks/main.tf line 22, in resource "azurerm_kubernetes_cluster" "this":`

// Another ordinary failure: a pure config/plan-time rejection. Nothing was created.
const fixtureValidation = `Error: Invalid value at 'body.database_version' (type.googleapis.com/google.cloud.sql.v1beta4.SqlDatabaseVersion), "POSTGRES_POSTGRES_16"

  with module.cloud_sql[0].google_sql_database_instance.this,
  on modules/cloud-sql/main.tf line 55, in resource "google_sql_database_instance" "this":`

func TestClassifyApplyError(t *testing.T) {
	tests := []struct {
		name        string
		err         error
		wantGrade   OrphanEvidence
		wantAddr    string
		wantCloudID string
	}{
		{
			name:      "nil error is never an orphan",
			err:       nil,
			wantGrade: OrphanNone,
		},
		{
			// THE WEDGE: provider states plainly that the resource exists outside state.
			name:        "already-exists/needs-import is CERTAIN, and yields an importable pair",
			err:         errors.New(fixtureAlreadyExists),
			wantGrade:   OrphanCertain,
			wantAddr:    "module.azure_cache[0].azurerm_managed_redis.this",
			wantCloudID: "/subscriptions/32f3d6ca-f9b5-48f1-b714-dcfb9cc661ae/resourceGroups/rg-e2e-e2edb01/providers/Microsoft.Cache/redisEnterprise/e2e-e2edb01-redis",
		},
		{
			// The create that CAUSES the wedge: accepted, then failed while polling.
			name:      "async create failure (polling + AllocationFailed) is LIKELY",
			err:       errors.New(fixtureAllocationFailed),
			wantGrade: OrphanLikely,
			wantAddr:  "module.azure_cache[0].azurerm_managed_redis.this",
		},
		{
			// NO OVER-ALERTING: the cloud refused before creating anything.
			name:      "sku rejected before create is NOT an orphan",
			err:       errors.New(fixtureSkuRejected),
			wantGrade: OrphanNone,
		},
		{
			// NO OVER-ALERTING: a plain validation error.
			name:      "validation error is NOT an orphan",
			err:       errors.New(fixtureValidation),
			wantGrade: OrphanNone,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ClassifyApplyError(tt.err, "")

			if got.Evidence != tt.wantGrade {
				t.Fatalf("evidence = %v, want %v", got.Evidence, tt.wantGrade)
			}
			if got.Address != tt.wantAddr {
				t.Errorf("address = %q, want %q", got.Address, tt.wantAddr)
			}
			if got.CloudID != tt.wantCloudID {
				t.Errorf("cloudID = %q, want %q", got.CloudID, tt.wantCloudID)
			}
			if tt.wantGrade == OrphanNone && got.Orphaned() {
				t.Error("Orphaned() must be false when there is no evidence (over-alerting is the bug we are avoiding)")
			}
			if tt.wantGrade != OrphanNone {
				if !got.Orphaned() {
					t.Error("Orphaned() must be true when there IS evidence")
				}
				if strings.TrimSpace(got.Reason) == "" {
					t.Error("a flagged orphan must carry an operator-facing reason, not a bare boolean")
				}
			}
		})
	}
}

// The CERTAIN case must hand the operator everything a `tofu import <addr> <id>` repair needs —
// otherwise the diagnosis is not actionable and the env stays wedged.
func TestCertainOrphanIsImportable(t *testing.T) {
	got := ClassifyApplyError(errors.New(fixtureAlreadyExists), "")

	if got.Evidence != OrphanCertain {
		t.Fatalf("evidence = %v, want certain", got.Evidence)
	}
	if got.Address == "" || got.CloudID == "" {
		t.Fatalf("import pair incomplete: address=%q cloudID=%q", got.Address, got.CloudID)
	}
	// The reason must actually tell the operator the env is wedged and name the remedy.
	for _, want := range []string{"wedged", "import"} {
		if !strings.Contains(strings.ToLower(got.Reason), want) {
			t.Errorf("reason should mention %q; got: %s", want, got.Reason)
		}
	}
}

// The error text and the `with <address>` line can arrive on different streams; the classifier must
// still stitch them together.
func TestClassifyReadsAddressFromStderr(t *testing.T) {
	err := errors.New(`Error: a resource with the ID "/subscriptions/x/redis/r" already exists - to be managed via Terraform this resource needs to be imported into the State.`)
	stderr := "\n  with module.azure_cache[0].azurerm_managed_redis.this,\n  on main.tf line 1:\n"

	got := ClassifyApplyError(err, stderr)
	if got.Evidence != OrphanCertain {
		t.Fatalf("evidence = %v, want certain", got.Evidence)
	}
	if got.Address != "module.azure_cache[0].azurerm_managed_redis.this" {
		t.Errorf("address = %q, want the address parsed out of stderr", got.Address)
	}
}
