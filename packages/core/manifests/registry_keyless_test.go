// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import (
	"strings"
	"testing"
)

func TestRenderRegistryRefresher_AWS(t *testing.T) {
	y, err := RenderRegistryRefresher(RegistryRefresher{
		Provider:      "aws",
		Namespace:     "default",
		SecretName:    "ecr-xacct-pull",
		RegistryHost:  "123456789012.dkr.ecr.us-east-1.amazonaws.com",
		Region:        "us-east-1",
		TargetRoleArn: "arn:aws:iam::999:role/pull",
		RunnerImage:   "ghcr.io/alethialabs-io/runner:test",
		SAAnnotations: map[string]string{"eks.amazonaws.com/role-arn": "arn:aws:iam::111:role/ecr-pull"},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"kind: ServiceAccount",
		"name: alethia-registry-pull",
		"eks.amazonaws.com/role-arn: \"arn:aws:iam::111:role/ecr-pull\"",
		// least-priv RBAC: get+patch on ONLY this Secret
		"resourceNames: [\"ecr-xacct-pull\"]",
		"verbs: [\"get\", \"patch\"]",
		"kind: RoleBinding",
		"kind: Deployment",
		"- registry-token",
		"- --provider",
		"- aws",
		"- --target-role-arn",
		"- arn:aws:iam::999:role/pull",
		"image: ghcr.io/alethialabs-io/runner:test",
	} {
		if !strings.Contains(y, want) {
			t.Errorf("aws refresher manifest missing %q:\n%s", want, y)
		}
	}
	// ── THE #2435 REGRESSION ─────────────────────────────────────────────────────────────────
	// This manifest is COMMITTED to the customer's apps repo, which ArgoCD syncs with
	// `automated: {prune: true, selfHeal: true}` and no `ignoreDifferences`. A Secret declared here
	// is therefore tracked with an empty docker config as its desired state, and ArgoCD heals the
	// credential the refresher just minted straight back to `{"auths":{}}`.
	//
	// The goldens above assert what IS rendered; nothing asserted what must NOT be, which is why the
	// defect shipped. The Secret is seeded by argocd.EnsureRegistryPullSecret from the runner
	// instead — with the prune label but no ArgoCD tracking metadata.
	for _, forbidden := range []string{
		"kind: Secret",
		"type: kubernetes.io/dockerconfigjson",
		".dockerconfigjson:",
	} {
		if strings.Contains(y, forbidden) {
			t.Errorf("the committed refresher unit contains %q — ArgoCD selfHeal will revert the minted "+
				"credential to an empty docker config (#2435):\n%s", forbidden, y)
		}
	}
	// The RBAC still names the Secret it patches, even though it no longer declares it.
	if !strings.Contains(y, "resourceNames: [\"ecr-xacct-pull\"]") {
		t.Errorf("the Role no longer scopes to the pull secret:\n%s", y)
	}
	// No RBAC beyond the one secret — must not grant create/list/delete or wildcard.
	for _, forbidden := range []string{"create", "list", "delete", "\"*\""} {
		if strings.Contains(y, forbidden) {
			t.Errorf("refresher RBAC too broad — contains %q:\n%s", forbidden, y)
		}
	}
}

func TestRenderRegistryRefresher_Azure(t *testing.T) {
	y, err := RenderRegistryRefresher(RegistryRefresher{
		Provider:      "azure",
		Namespace:     "default",
		SecretName:    "acr-xacct-pull",
		RegistryHost:  "acme.azurecr.io",
		RunnerImage:   "img:1",
		SAAnnotations: map[string]string{"azure.workload.identity/client-id": "cid-123"},
		SALabels:      map[string]string{"azure.workload.identity/use": "true"},
		PodLabels:     map[string]string{"azure.workload.identity/use": "true"},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"azure.workload.identity/client-id: \"cid-123\"",
		"azure.workload.identity/use: \"true\"", // both on the SA and the pod template
		"- azure",
	} {
		if !strings.Contains(y, want) {
			t.Errorf("azure refresher missing %q:\n%s", want, y)
		}
	}
	// Azure carries no --target-role-arn (that's AWS-only).
	if strings.Contains(y, "--target-role-arn") {
		t.Errorf("azure refresher must not carry --target-role-arn:\n%s", y)
	}
}

func TestRenderRegistryRefresher_FailClosed(t *testing.T) {
	// Missing required fields → error, never a half-wired manifest.
	if _, err := RenderRegistryRefresher(RegistryRefresher{Provider: "aws", SecretName: "s", RegistryHost: "h", RunnerImage: "i"}); err == nil {
		t.Error("aws without target role arn must fail closed")
	}
	if _, err := RenderRegistryRefresher(RegistryRefresher{Provider: "gcp", RegistryHost: "h", RunnerImage: "i"}); err == nil {
		t.Error("missing secret name must fail closed")
	}
}
