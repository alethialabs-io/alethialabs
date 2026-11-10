// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// placedConfig is a namespace placement onto an existing Fabric cluster, deploying into ns, with the
// host's namespaces as the console would send them (nil = the key absent).
func placedConfig(ns string, host *[]string) *types.ProjectConfig {
	vc := &types.ProjectConfig{
		ProjectName:             "acme",
		EnvironmentStage:        types.EnvironmentStage("dev"),
		PlacementMode:           types.PlacementModeNamespace,
		Namespace:               ns,
		PlacementHostNamespaces: host,
		EnvironmentID:           "env-1",
	}
	vc.Cluster.ClusterName = "acme-prod-cluster"
	return vc
}

// countCommands replaces the kubectl/shell seam with a counter, so a test can assert that NOTHING was
// run against the cluster.
func countCommands(t *testing.T) *int {
	t.Helper()
	orig := executeCommand
	t.Cleanup(func() { executeCommand = orig })
	n := 0
	executeCommand = func(string, string, []string, io.Writer, io.Writer) error {
		n++
		return nil
	}
	return &n
}

// TestRunNamespaceDeploy_RefusesAReservedNamespaceBeforeAnyClusterWrite (#6551) is the runner half of
// the property: a placement whose STORED namespace is reserved — from an older console, the API, or a
// row that predates the rule — is refused with a reason naming it, and nothing reaches the cluster.
// The PATH holds no kubectl, so a deploy that got past the check would fail on the preflight instead,
// with a different message: the control case below proves the check is what refused.
func TestRunNamespaceDeploy_RefusesAReservedNamespaceBeforeAnyClusterWrite(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	for _, tc := range []struct{ name, ns string }{
		{"the host's application namespace", appNamespace},
		{"the ArgoCD namespace", "argocd"},
		{"a kube- namespace", "kube-system"},
		{"the BYO database users namespace", "alethia-byo-db-users"},
		{"a BYO chart's derived namespace", "byo-payments"},
		{"a namespace the host's BYO chart chose", "payments"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, dry := range []bool{false, true} {
				ran := countCommands(t)
				_, err := runNamespaceDeploy(context.Background(), DeployParams{
					ProjectConfig: placedConfig(tc.ns, &[]string{"payments"}),
					Provider:      "aws",
					DryRun:        dry,
					Stdout:        io.Discard,
					Stderr:        io.Discard,
				})
				if err == nil || !strings.Contains(err.Error(), `namespace "`+tc.ns+`" is reserved on the host cluster`) {
					t.Fatalf("dry-run=%v: want a refusal naming %q, got %v", dry, tc.ns, err)
				}
				if !strings.Contains(err.Error(), "nothing was changed on the cluster") {
					t.Errorf("the refusal must say nothing was changed, got: %v", err)
				}
				if *ran != 0 {
					t.Errorf("dry-run=%v: %d commands ran before the refusal; want none", dry, *ran)
				}
			}
		})
	}

	t.Run("control: an ordinary namespace passes the check", func(t *testing.T) {
		_, err := runNamespaceDeploy(context.Background(), DeployParams{
			ProjectConfig: placedConfig("team-web", &[]string{"payments"}),
			Provider:      "aws",
			Stdout:        io.Discard,
			Stderr:        io.Discard,
		})
		if err == nil || !strings.Contains(err.Error(), "preflight check failed") {
			t.Fatalf("an ordinary namespace must get past the check to the kubectl preflight, got %v", err)
		}
	})
}

// TestRunNamespaceDeploy_FailsClosedWithoutTheHostNamespaces: a snapshot that does not carry the host's
// namespaces is refused, not treated as "the host uses none". An EMPTY list is the console saying it
// computed them and found none, and passes.
func TestRunNamespaceDeploy_FailsClosedWithoutTheHostNamespaces(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	ran := countCommands(t)
	_, err := runNamespaceDeploy(context.Background(), DeployParams{
		ProjectConfig: placedConfig("team-web", nil),
		Provider:      "aws",
		Stdout:        io.Discard,
		Stderr:        io.Discard,
	})
	if err == nil || !strings.Contains(err.Error(), "placement_host_namespaces") {
		t.Fatalf("a snapshot without the host's namespaces must be refused, naming the key, got %v", err)
	}
	if *ran != 0 {
		t.Errorf("%d commands ran before the refusal; want none", *ran)
	}
	_, err = runNamespaceDeploy(context.Background(), DeployParams{
		ProjectConfig: placedConfig("team-web", &[]string{}),
		Provider:      "aws",
		Stdout:        io.Discard,
		Stderr:        io.Discard,
	})
	if err == nil || !strings.Contains(err.Error(), "preflight check failed") {
		t.Fatalf("an empty host list must pass the check, got %v", err)
	}
}

// TestRunNamespaceDestroy_RefusesAReservedNamespaceAndDeletesNothing: a teardown deletes the Namespace
// object, so on a reserved namespace it would delete what the platform or the host runs there. It is
// refused before any delete; the control (an ordinary namespace, no apps repo) issues its Namespace delete.
func TestRunNamespaceDestroy_RefusesAReservedNamespaceAndDeletesNothing(t *testing.T) {
	stubKubectlOnPath(t)
	destroy := func(ns string) (int, error) {
		ran := countCommands(t)
		cfg := placedConfig(ns, &[]string{"payments"})
		err := runNamespaceDestroy(context.Background(), fakeNamespaceProvider{}, DestroyParams{
			ProjectConfig: cfg,
			Provider:      "gcp",
			KubeConn: func(context.Context, string, *types.ProjectConfig, string) (string, string, error) {
				return "https://api.example.invalid", "Y2E=", nil
			},
			NamespaceIdentity: func(context.Context, string, *types.ProjectConfig, string, string) error { return nil },
			Stdout:            io.Discard,
			Stderr:            io.Discard,
		})
		return *ran, err
	}
	for _, ns := range []string{"argocd", "byo-payments", "payments"} {
		ran, err := destroy(ns)
		if err == nil || !strings.Contains(err.Error(), "Refusing the teardown") || !strings.Contains(err.Error(), `"`+ns+`"`) {
			t.Errorf("teardown of reserved %q: want a refusal naming it, got %v", ns, err)
		}
		if ran != 0 {
			t.Errorf("teardown of reserved %q ran %d commands; want none", ns, ran)
		}
	}
	ran, err := destroy("team-web")
	if err != nil || ran != 1 {
		t.Fatalf("control: an ordinary namespace's teardown must issue its Namespace delete, got %d commands (err %v)", ran, err)
	}
}

// stubNamespaceRead answers the runner's `kubectl get namespace <ns>` with answer (or err), passes
// every other read to the real seam, and counts the cluster WRITES (every executeCommand) the deploy
// or teardown then issues.
func stubNamespaceRead(t *testing.T, ns, answer string, readErr error) *int {
	t.Helper()
	origRead, origRun := executeCommandWithOutput, executeCommand
	t.Cleanup(func() { executeCommandWithOutput, executeCommand = origRead, origRun })
	executeCommandWithOutput = func(cmd, dir string, env []string) (string, error) {
		if strings.HasPrefix(cmd, "kubectl get namespace "+ns+" ") {
			return answer, readErr
		}
		return origRead(cmd, dir, env)
	}
	writes := 0
	executeCommand = func(cmd, dir string, env []string, stdout, stderr io.Writer) error {
		writes++
		return origRun(cmd, dir, env, stdout, stderr)
	}
	return &writes
}

// namespaceJSON is `kubectl get namespace -o json` for a namespace carrying labels.
func namespaceJSON(labels string) string {
	return `{"apiVersion":"v1","kind":"Namespace","metadata":{"name":"team-web","labels":{` + labels + `}}}`
}

// TestRunNamespaceDeploy_RefusesANamespaceItDoesNotOwn (#6551): a namespace on no list can still be
// the host's (its own GitOps repo created it) or a sibling placement's. The runner reads it after
// minting kube access and BEFORE its first write, and refuses unless it carries THIS environment's
// owner label. Absent is the first deploy, which creates it labelled.
func TestRunNamespaceDeploy_RefusesANamespaceItDoesNotOwn(t *testing.T) {
	deploy := func(t *testing.T, answer string, readErr error) (int, error) {
		t.Helper()
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		depArgoTemplates(t)
		depNoSlowProbes(t)
		writes := stubNamespaceRead(t, "team-web", answer, readErr)
		var out strings.Builder
		_, err := RunDeployV2(t.Context(), DeployParams{
			ProjectConfig:   depPlacementConfig(types.PlacementModeNamespace, "team-web"),
			Provider:        "hetzner",
			TalosKubeconfig: depTalosMinter("apiVersion: v1\nkind: Config\n"),
			Stdout:          &out,
			Stderr:          &out,
		})
		return *writes, err
	}
	for _, tc := range []struct{ name, answer string }{
		{"another environment's namespace", namespaceJSON(`"alethia.io/placement":"namespace","alethia.io/environment-id":"env-2"`)},
		{"the host's own namespace, no owner label", namespaceJSON(`"team":"payments"`)},
		{"a namespace with no labels at all", `{"metadata":{"name":"team-web"}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			writes, err := deploy(t, tc.answer, nil)
			if err == nil || !strings.Contains(err.Error(), `namespace "team-web" already exists on the cluster and does not belong to this environment`) {
				t.Fatalf("want a refusal naming the namespace, got %v", err)
			}
			if writes != 0 {
				t.Errorf("%d cluster writes before the refusal; want none", writes)
			}
		})
	}
	t.Run("a read that fails refuses (fail closed)", func(t *testing.T) {
		writes, err := deploy(t, "", errors.New("forbidden"))
		if err == nil || !strings.Contains(err.Error(), "could not read namespace") || writes != 0 {
			t.Fatalf("want a fail-closed refusal with no writes, got %v (%d writes)", err, writes)
		}
	})
	t.Run("an unparseable answer refuses (fail closed)", func(t *testing.T) {
		if _, err := deploy(t, "not json", nil); err == nil || !strings.Contains(err.Error(), "could not parse namespace") {
			t.Fatalf("want a fail-closed refusal, got %v", err)
		}
	})
	t.Run("control: its own namespace deploys", func(t *testing.T) {
		writes, err := deploy(t, namespaceJSON(`"alethia.io/environment-id":"env-1"`), nil)
		if err != nil || writes == 0 {
			t.Fatalf("its own labelled namespace must deploy, got %v (%d writes)", err, writes)
		}
	})
	t.Run("control: a first deploy (no namespace yet) deploys", func(t *testing.T) {
		writes, err := deploy(t, "", nil)
		if err != nil || writes == 0 {
			t.Fatalf("a first deploy must create the namespace, got %v (%d writes)", err, writes)
		}
	})
}

// TestRunNamespaceDeploy_FailsClosedWithoutAnEnvironmentID: with no environment id there is no owner
// label to compare, so the runner cannot tell its namespace from someone else's, and refuses.
func TestRunNamespaceDeploy_FailsClosedWithoutAnEnvironmentID(t *testing.T) {
	vc := placedConfig("team-web", &[]string{})
	vc.EnvironmentID = ""
	if err := namespaceOwnershipRefusal(vc, "team-web", "deploy"); err == nil || !strings.Contains(err.Error(), "no environment_id") {
		t.Fatalf("want a refusal naming the missing environment id, got %v", err)
	}
}

// TestRunNamespaceDestroy_RefusesANamespaceItDoesNotOwn: the teardown deletes the Namespace, so it reads
// it first and refuses — before any delete — unless it is this environment's.
func TestRunNamespaceDestroy_RefusesANamespaceItDoesNotOwn(t *testing.T) {
	stubKubectlOnPath(t)
	teardown := func(answer string) (int, error) {
		writes := stubNamespaceRead(t, "team-web", answer, nil)
		err := runNamespaceDestroy(context.Background(), fakeNamespaceProvider{}, DestroyParams{
			ProjectConfig: placedConfig("team-web", &[]string{}),
			Provider:      "gcp",
			KubeConn: func(context.Context, string, *types.ProjectConfig, string) (string, string, error) {
				return "https://api.example.invalid", "Y2E=", nil
			},
			NamespaceIdentity: func(context.Context, string, *types.ProjectConfig, string, string) error { return nil },
			Stdout:            io.Discard,
			Stderr:            io.Discard,
		})
		return *writes, err
	}
	writes, err := teardown(namespaceJSON(`"alethia.io/environment-id":"env-2"`))
	if err == nil || !strings.Contains(err.Error(), "Refusing the teardown") || writes != 0 {
		t.Fatalf("another environment's namespace: want a refusal with no deletes, got %v (%d deletes)", err, writes)
	}
	writes, err = teardown(namespaceJSON(`"alethia.io/environment-id":"env-1"`))
	if err != nil || writes == 0 {
		t.Fatalf("control: its own namespace must be torn down, got %v (%d deletes)", err, writes)
	}
}

// TestNamespaceOwnerLabelIsTheEnvironmentHandle pins the label the check reads to the one the tenant
// render stamps on the Namespace it creates — so a first deploy's namespace passes its second deploy.
func TestNamespaceOwnerLabelIsTheEnvironmentHandle(t *testing.T) {
	vc := placedConfig("team-web", &[]string{})
	vc.EnvironmentID = "11111111-2222-4333-8444-555555555555"
	m, err := argocd.RenderNamespaceTenant(namespaceTenantInput(vc, "team-web"))
	if err != nil {
		t.Fatal(err)
	}
	ns := strings.SplitN(m.Isolation, "\n---\n", 2)[0]
	if !strings.Contains(ns, "kind: Namespace") || !strings.Contains(ns, namespaceOwnerLabel+`: "`+vc.EnvironmentID+`"`) {
		t.Fatalf("the rendered Namespace must carry %s=%s, got:\n%s", namespaceOwnerLabel, vc.EnvironmentID, ns)
	}
}
