// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// azureUsersOutputs are the Azure keyless admin outputs plus every declared user's stored password.
func azureUsersOutputs(vc *types.ProjectConfig) map[string]interface{} {
	names := map[string]interface{}{}
	for _, d := range declaredByoDBUsers(vc, false, nil) {
		names[d.Key] = "store/" + d.Key
	}
	return map[string]interface{}{
		"azure_db_fqdn": "db.postgres.database.azure.com", "azure_db_name": "app",
		"azure_db_admin_user": "acme-dbadmin", "azure_db_admin_client_id": "11111111-2222-3333-4444-555555555555",
		"custom_secret_names": names,
	}
}

// runAzureUsers runs the BYO users run for vc on Azure.
func runAzureUsers(vc *types.ProjectConfig, outputs map[string]interface{}) (byoDBUsersOutcome, string) {
	var log strings.Builder
	out := runByoDBUsers(context.Background(), byoDBUsersInput{VC: vc, Outputs: outputs, Provider: "azure"}, &log, &log)
	return out, log.String()
}

// TestByoDBUsers_AzurePasswordModeRefusesWithAReason: an Azure database without Entra authentication
// has no administrator identity (the template creates it, and its outputs, only with iam_auth on), so
// the run is refused with a stated reason, touches no cluster, and is NOT a failed run (#6504). Both
// spellings of password mode are covered: iam_auth unset and iam_auth false.
func TestByoDBUsers_AzurePasswordModeRefusesWithAReason(t *testing.T) {
	off := false
	for name, iam := range map[string]*bool{"iam_auth unset": nil, "iam_auth false": &off} {
		t.Run(name, func(t *testing.T) {
			t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
			c := newUsersCluster(t)
			vc := usersConfig()
			vc.Databases[0].IamAuth = iam
			// The outputs a password-mode template yields: a connection, no admin identity.
			outputs := azureUsersOutputs(vc)
			delete(outputs, "azure_db_admin_user")
			delete(outputs, "azure_db_admin_client_id")
			out, log := runAzureUsers(vc, outputs)
			if out.Refusal != byoDBUsersAzurePasswordReason || out.Failed || len(out.Provisioned) != 0 || len(c.calls) != 0 {
				t.Fatalf("outcome %+v, calls %v\n%s", out, c.calls, log)
			}
			if !strings.Contains(log, "not run: "+byoDBUsersAzurePasswordReason) {
				t.Errorf("the refusal is not reported:\n%s", log)
			}
			assertFacetReason(t, vc, out, byoDBUsersAzurePasswordReason)
		})
	}
}

// TestByoDBUsers_AzureEntraModeRunsAsTheFederatedServiceAccount is the other side: with Entra
// authentication on, the refusal does not fire, the run provisions the declared users, and the
// admin credential it applies and then deletes is the ServiceAccount the template federates.
// Without this half the refusal above would also pass if every Azure run were refused.
func TestByoDBUsers_AzureEntraModeRunsAsTheFederatedServiceAccount(t *testing.T) {
	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
	c := newUsersCluster(t)
	api, worker := usersFor()
	c.message = resultOf(api, worker)
	vc := usersConfig()
	on := true
	vc.Databases[0].IamAuth = &on
	out, log := runAzureUsers(vc, azureUsersOutputs(vc))
	if out.Refusal != "" || out.Failed || !out.Provisioned[api] || !out.Provisioned[worker] {
		t.Fatalf("outcome %+v\n%s", out, log)
	}
	calls := strings.Join(c.calls, "\n")
	if !strings.Contains(calls, "/serviceaccounts/"+manifests.ByoDBUsersAzureServiceAccount) {
		t.Errorf("the run did not delete ServiceAccount %s:\n%s", manifests.ByoDBUsersAzureServiceAccount, calls)
	}
	assertCleanedUp(t, c)
}
