// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import (
	"io"
	"os"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// helmKeylessProject wires a project selecting one keyless ECR helm_registry with the given
// provider_config (no credentials — keyless reads only provider_config).
func helmKeylessProject(slug string, pc map[string]any) *types.ProjectConfig {
	return &types.ProjectConfig{
		HelmRegistries: []types.ProjectHelmRegistryConfig{{Name: "charts", Provider: slug, ProviderConfig: pc}},
	}
}

var ecrHelmPC = map[string]any{
	"target_account_id": "123456789012",
	"region":            "us-east-1",
	"registry_host":     "123456789012.dkr.ecr.us-east-1.amazonaws.com",
	"target_role_arn":   "arn:aws:iam::123456789012:role/alethia-ecr-helm-pull",
}

func TestKeylessHelmRepoTargets(t *testing.T) {
	// Private ECR → one target with the cross-account fields + an oci:// URL + deterministic Secret name.
	targets, err := KeylessHelmRepoTargets(helmKeylessProject("oci-ecr", ecrHelmPC))
	if err != nil {
		t.Fatal(err)
	}
	if len(targets) != 1 {
		t.Fatalf("want 1 target, got %d", len(targets))
	}
	tg := targets[0]
	if tg.Slug != "oci-ecr" || tg.Provider != "aws" || tg.Public || tg.TargetRoleArn == "" || tg.TargetAccountID != "123456789012" {
		t.Fatalf("private target wrong: %+v", tg)
	}
	if tg.RepoURL() != "oci://"+ecrHelmPC["registry_host"].(string) {
		t.Fatalf("RepoURL = %q", tg.RepoURL())
	}
	if !strings.HasPrefix(tg.SecretName(), "repo-helm-") || tg.SecretName() != HelmRepoCredSecretName(tg.RepoURL()) {
		t.Fatalf("SecretName = %q, want repo-helm-<hash> derived from the URL", tg.SecretName())
	}

	// Public ECR → one public target, fixed host, no cross-account role.
	pub, err := KeylessHelmRepoTargets(helmKeylessProject("oci-public-ecr", nil))
	if err != nil {
		t.Fatal(err)
	}
	if len(pub) != 1 || !pub[0].Public || pub[0].TargetRoleArn != "" || pub[0].RegistryHost != "public.ecr.aws" {
		t.Fatalf("public target wrong: %+v", pub)
	}

	// A STATIC (credential-based) helm registry is NOT a keyless target (mutual exclusion), and the
	// inverse: a keyless slug yields NO static spec.
	static := &types.ProjectConfig{HelmRegistries: []types.ProjectHelmRegistryConfig{{Name: "c", Provider: "oci-github-cr"}}}
	if tg, err := KeylessHelmRepoTargets(static); err != nil || len(tg) != 0 {
		t.Fatalf("static helm registry must not be keyless: %+v err=%v", tg, err)
	}
	if specs, err := HelmRepoCredSpecs(helmKeylessProject("oci-ecr", ecrHelmPC)); err != nil || len(specs) != 0 {
		t.Fatalf("keyless slug must yield no static spec: %+v err=%v", specs, err)
	}

	// Misconfigured private ECR (empty pc) → skipped fail-closed with an error, no target.
	bad, err := KeylessHelmRepoTargets(helmKeylessProject("oci-ecr", nil))
	if err == nil {
		t.Fatal("expected a fail-closed error for empty provider_config")
	}
	if len(bad) != 0 {
		t.Fatalf("a misconfigured target must not yield a result: %+v", bad)
	}

	// None / native → nothing.
	if tg, err := KeylessHelmRepoTargets(&types.ProjectConfig{}); err != nil || len(tg) != 0 {
		t.Fatalf("no helm registries → no targets: %+v err=%v", tg, err)
	}
}

func TestComposeKeylessHelmECRFlagGate(t *testing.T) {
	vc := helmKeylessProject("oci-ecr", ecrHelmPC)

	// Flag OFF → byte-identical: no helm_repo_pull_* tfvars are written.
	os.Unsetenv("ALETHIA_XACCT_HELM_ECR_ENABLED")
	off := map[string]any{}
	if _, err := Compose(t.TempDir(), "", vc, off, io.Discard); err != nil {
		t.Fatal(err)
	}
	if _, ok := off["helm_repo_pull_target_role_arns"]; ok {
		t.Fatal("flag off must NOT set helm_repo_pull_target_role_arns")
	}
	if _, ok := off["helm_repo_pull_public_enabled"]; ok {
		t.Fatal("flag off must NOT set helm_repo_pull_public_enabled")
	}

	// Flag ON → the private target role is exported, and the native registry/secrets guards are UNTOUCHED
	// (a keyless Helm pull identity is additive).
	t.Setenv("ALETHIA_XACCT_HELM_ECR_ENABLED", "true")
	on := map[string]any{}
	if _, err := Compose(t.TempDir(), "", vc, on, io.Discard); err != nil {
		t.Fatal(err)
	}
	arns, ok := on["helm_repo_pull_target_role_arns"].([]string)
	if !ok || len(arns) != 1 || arns[0] != ecrHelmPC["target_role_arn"] {
		t.Fatalf("helm_repo_pull_target_role_arns = %v", on["helm_repo_pull_target_role_arns"])
	}
	if on["registry_provider"] != "native" || on["secrets_provider"] != "native" {
		t.Fatalf("keyless helm must not touch native guards: registry=%v secrets=%v", on["registry_provider"], on["secrets_provider"])
	}

	// Flag ON + a public repo → the public flag is set, no role list.
	pubOn := map[string]any{}
	if _, err := Compose(t.TempDir(), "", helmKeylessProject("oci-public-ecr", nil), pubOn, io.Discard); err != nil {
		t.Fatal(err)
	}
	if pubOn["helm_repo_pull_public_enabled"] != true {
		t.Fatalf("a public repo must set helm_repo_pull_public_enabled, got %v", pubOn["helm_repo_pull_public_enabled"])
	}
	if _, ok := pubOn["helm_repo_pull_target_role_arns"]; ok {
		t.Fatal("a public-only project must not set a target role list")
	}
}
