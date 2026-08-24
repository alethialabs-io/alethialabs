// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// stubPullSecretSeed replaces the cluster call for one test and records what it was asked to write.
func stubPullSecretSeed(t *testing.T, err error) *[]string {
	t.Helper()
	prev := ensureRegistryPullSecret
	t.Cleanup(func() { ensureRegistryPullSecret = prev })
	calls := []string{}
	ensureRegistryPullSecret = func(name, ns, payload string, _, _ io.Writer) error {
		calls = append(calls, name+"/"+ns+" "+payload)
		return err
	}
	return &calls
}

// THE #2435 REGRESSION, from the caller's side.
//
// The pull Secret must be seeded by the RUNNER and must NOT appear in the manifest committed to the
// customer's apps repo. That repo is synced with `automated: {prune: true, selfHeal: true}` and no
// `ignoreDifferences`, so a Secret declared there is tracked with an empty docker config as its
// desired state — and ArgoCD heals the minted credential straight back to it.
func TestWriteRegistryRefresherSeedsThePullSecretOutsideGit(t *testing.T) {
	t.Setenv("ALETHIA_XACCT_REGISTRY_ENABLED", "true")
	t.Setenv("ALETHIA_RUNNER_IMAGE", "ghcr.io/alethialabs-io/runner:test")
	calls := stubPullSecretSeed(t, nil)
	dir := t.TempDir()

	skips, err := writeRegistryRefresher(dir, ecrXacctProject(),
		map[string]string{"ecr_pull_irsa_arn": "arn:aws:iam::111:role/ecr-pull"}, io.Discard)
	if err != nil || len(skips) != 0 {
		t.Fatalf("skips=%v err=%v", skips, err)
	}

	if len(*calls) != 1 {
		t.Fatalf("seeded %d secrets, want 1 — without it the refresher has nothing to patch", len(*calls))
	}
	if !strings.Contains((*calls)[0], `{"auths":{}}`) {
		t.Errorf("seeded %q, want the empty-auths placeholder", (*calls)[0])
	}

	body, rErr := os.ReadFile(filepath.Join(dir, "registry-pull-refresher.yaml"))
	if rErr != nil {
		t.Fatalf("read the committed manifest: %v", rErr)
	}
	for _, forbidden := range []string{"kind: Secret", "dockerconfigjson"} {
		if strings.Contains(string(body), forbidden) {
			t.Errorf("the manifest committed to the apps repo contains %q — ArgoCD selfHeal reverts the "+
				"minted credential to an empty docker config (#2435)", forbidden)
		}
	}
	// The refresher itself still goes to git, and still names the Secret in its RBAC.
	if !strings.Contains(string(body), "kind: Deployment") ||
		!strings.Contains(string(body), `resourceNames: ["ecr-xacct-pull"]`) {
		t.Errorf("the committed unit lost the refresher or its scoped Role:\n%s", body)
	}
}

// Fail closed: a refresher whose Secret was never created patches nothing forever, and the pull
// fails looking like a credential problem. Better a reported skip than a silent one.
func TestWriteRegistryRefresherFailsClosedWhenSeedingFails(t *testing.T) {
	t.Setenv("ALETHIA_XACCT_REGISTRY_ENABLED", "true")
	t.Setenv("ALETHIA_RUNNER_IMAGE", "ghcr.io/alethialabs-io/runner:test")
	stubPullSecretSeed(t, errors.New("kubectl refused"))
	dir := t.TempDir()

	skips, err := writeRegistryRefresher(dir, ecrXacctProject(),
		map[string]string{"ecr_pull_irsa_arn": "arn:aws:iam::111:role/ecr-pull"}, io.Discard)
	if err != nil {
		t.Fatalf("a seeding failure must be a skip, not a hard error: %v", err)
	}
	if len(skips) != 1 || !strings.Contains(skips[0], "pull secret not seeded") {
		t.Fatalf("skips = %v, want a reported seeding failure", skips)
	}
	// And nothing is committed, so the cluster never gets a refresher with no Secret to patch.
	if _, sErr := os.Stat(filepath.Join(dir, "registry-pull-refresher.yaml")); !os.IsNotExist(sErr) {
		t.Error("the refresher was committed even though its Secret could not be seeded")
	}
}
