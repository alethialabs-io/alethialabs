// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"io"
	"strings"
	"testing"

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
