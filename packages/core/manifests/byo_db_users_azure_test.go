// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// byoUsersAzureTemplate is the template that federates the admin identity to the BYO users Job.
const byoUsersAzureTemplate = "infra/templates/project/azure/app-db-identity.tf"

// byoUsersTemplateLocal reads one string local of the Azure identity template, failing when the
// assignment is gone (a missing local verifies nothing, so it is never read as a match).
func byoUsersTemplateLocal(t *testing.T, src, name string) string {
	t.Helper()
	m := regexp.MustCompile(`(?m)^\s*` + regexp.QuoteMeta(name) + `\s*=\s*"([^"]*)"`).FindStringSubmatch(src)
	if m == nil {
		t.Fatalf("local %s not found in %s; re-anchor this coupling", name, byoUsersAzureTemplate)
	}
	return m[1]
}

// TestByoDBUsers_AzureServiceAccountMatchesTheTemplate pins the federated subject of the Azure admin
// identity's BYO users credential to the ServiceAccount the Job runs as (#6504). An Azure federated
// credential matches its subject exactly, so a drift between the two does not fail the plan, the
// apply or the render: the Job's token exchange is refused at runtime and every per-binding user
// fails. The template cannot import Go, so the two spellings are compared here.
func TestByoDBUsers_AzureServiceAccountMatchesTheTemplate(t *testing.T) {
	root := irsaRepoRoot(t)
	if root == "" {
		t.Skip("go.work not found; not in a monorepo checkout — skipping template scrape")
	}
	b, err := os.ReadFile(filepath.Join(root, byoUsersAzureTemplate))
	if err != nil {
		t.Fatalf("read %s: %v (template moved? re-anchor this coupling)", byoUsersAzureTemplate, err)
	}
	src := string(b)
	if got := byoUsersTemplateLocal(t, src, "azure_byo_db_users_ksa_namespace"); got != ByoDBUsersNamespace {
		t.Errorf("template namespace %q, the Job runs in %q", got, ByoDBUsersNamespace)
	}
	if got := byoUsersTemplateLocal(t, src, "azure_byo_db_users_ksa_name"); got != ByoDBUsersAzureServiceAccount {
		t.Errorf("template ServiceAccount %q, the Job runs as %q", got, ByoDBUsersAzureServiceAccount)
	}
	// The locals must also be what the credential's subject is built from, on the admin identity.
	res := regexp.MustCompile(`(?s)resource "azurerm_federated_identity_credential" "db_admin_byo_users" \{(.*?)\n\}`).FindStringSubmatch(src)
	if res == nil {
		t.Fatalf("no db_admin_byo_users federated credential in %s", byoUsersAzureTemplate)
	}
	for _, want := range []string{
		`subject             = "system:serviceaccount:${local.azure_byo_db_users_ksa_namespace}:${local.azure_byo_db_users_ksa_name}"`,
		`parent_id           = one(azurerm_user_assigned_identity.db_admin[*].id)`,
	} {
		if !regexp.MustCompile(regexp.QuoteMeta(want)).MatchString(res[1]) {
			t.Errorf("db_admin_byo_users lacks %s", want)
		}
	}
}

// TestByoDBUsers_AzureRendersTheFederatedServiceAccount covers the Azure render path for both
// engines: the admin ServiceAccount is the fixed, federated name in the Job's namespace, the pod runs
// as it with the Workload Identity label, and the name does not vary with the environment, because
// the template's subject cannot.
func TestByoDBUsers_AzureRendersTheFederatedServiceAccount(t *testing.T) {
	for _, engine := range []string{"postgres", "mysql"} {
		for _, env := range []string{"env-1", "env-2"} {
			job, err := RenderByoDBUsersJob(ByoDBUsersJobParams{
				Provider: "azure", Engine: engine, RunnerImage: "ghcr.io/alethia/runner:1", Environment: env,
				Users: byoUsersTestUsers, RunID: "r1", Outputs: byoUsersTestOutputs["azure"],
			})
			if err != nil {
				t.Fatalf("%s/%s: render: %v", engine, env, err)
			}
			admin := job.Credentials[0]
			if admin.Resource != "serviceaccounts" || admin.Name != ByoDBUsersAzureServiceAccount {
				t.Fatalf("%s/%s: admin credential %s/%s, want serviceaccounts/%s", engine, env, admin.Resource, admin.Name, ByoDBUsersAzureServiceAccount)
			}
			sa := byoUsersDoc(t, admin.YAML)
			if dig(sa, "metadata", "name") != ByoDBUsersAzureServiceAccount || dig(sa, "metadata", "namespace") != ByoDBUsersNamespace {
				t.Errorf("%s/%s: ServiceAccount %v/%v", engine, env, dig(sa, "metadata", "namespace"), dig(sa, "metadata", "name"))
			}
			if dig(sa, "metadata", "labels", ByoDBUsersOwnerLabel) != env || dig(sa, "metadata", "labels", ByoDBUsersLabel) != ByoDBUsersLabelValue {
				t.Errorf("%s/%s: ServiceAccount labels %v; the sweep and cleanup select by them", engine, env, dig(sa, "metadata", "labels"))
			}
			jobDoc := byoUsersDoc(t, job.JobYAML)
			pod := dig(jobDoc, "spec", "template", "spec")
			if dig(pod, "serviceAccountName") != ByoDBUsersAzureServiceAccount {
				t.Errorf("%s/%s: pod runs as %v", engine, env, dig(pod, "serviceAccountName"))
			}
			if dig(jobDoc, "spec", "template", "metadata", "labels", "azure.workload.identity/use") != "true" {
				t.Errorf("%s/%s: pod lacks the Workload Identity label", engine, env)
			}
		}
	}
}
