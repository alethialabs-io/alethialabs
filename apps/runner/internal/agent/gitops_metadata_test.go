// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/provisioner"
)

// TestDeployMetadata_CarriesGitopsStatus asserts the gitops_status surface (issue #574)
// crosses into execution_metadata: mode/repo/failed_step/services reach the console, and
// the blob still passes the secret denylist (the error text is sanitized at the source —
// this locks that the KEY ITSELF isn't secret-named and dropped by the backstop).
func TestDeployMetadata_CarriesGitopsStatus(t *testing.T) {
	result := &provisioner.PlanResult{
		ClusterName: "prod-eks",
		GitopsStatus: &argocd.GitopsStatus{
			Mode:       "gitops",
			AppsRepo:   "https://github.com/acme/apps",
			ArgocdApp:  argocd.UserAppsApplicationName,
			FailedStep: argocd.GitopsStepRepoCredentials,
			Error:      "failed to apply repo credentials: exit 1",
		},
	}
	metadata := buildDeployMetadata(result)
	if dropped := scrubMetadataTree(metadata); len(dropped) > 0 {
		t.Fatalf("gitops_status tripped the secret denylist: %v", dropped)
	}
	gs, ok := metadata["gitops_status"].(*argocd.GitopsStatus)
	if !ok {
		t.Fatalf("gitops_status missing or wrong type: %T", metadata["gitops_status"])
	}
	if gs.FailedStep != argocd.GitopsStepRepoCredentials || gs.AppsRepo != "https://github.com/acme/apps" {
		t.Errorf("gitops_status = %+v", gs)
	}

	// A result WITHOUT gitops status (pre-#574 / dry-run) must not emit the key at all.
	if md := buildDeployMetadata(&provisioner.PlanResult{ClusterName: "x"}); md["gitops_status"] != nil {
		t.Errorf("nil GitopsStatus must omit the key, got %v", md["gitops_status"])
	}
}

// TestReadPlanResult_FailurePathPartialResult locks the #574 failure transport: a
// GitOps-wiring hard-fail writes result.json with BOTH a partial PlanResult (carrying
// gitops_status) and the stage error — and readPlanResult must return the partial result
// so postDeployMetadata can post it. This is the exact shape writeStageResult produces
// when runDeployStage gets (non-nil result, non-nil err) from RunDeployV2.
func TestReadPlanResult_FailurePathPartialResult(t *testing.T) {
	workDir := t.TempDir()
	partial := &provisioner.PlanResult{
		ClusterName: "prod-eks",
		GitopsStatus: &argocd.GitopsStatus{
			Mode:       "gitops",
			AppsRepo:   "https://github.com/acme/apps",
			FailedStep: argocd.GitopsStepGitToken,
			Error:      "GitOps requested (apps repo https://github.com/acme/apps) but no git access token is available",
		},
	}
	raw, err := json.Marshal(partial)
	if err != nil {
		t.Fatalf("marshal partial result: %v", err)
	}
	res := stageResult{PlanResult: raw}
	stageErr := os.ErrDeadlineExceeded // any non-nil error; writeStageResult stringifies it
	if got := writeStageResult(workDir, res, stageErr); got != stageErr {
		t.Fatalf("writeStageResult must return the stage error, got %v", got)
	}

	// The parent's failure-path read: the partial result must come back intact.
	readBack, err := readPlanResult(workDir)
	if err != nil {
		t.Fatalf("readPlanResult on failure-path result.json: %v", err)
	}
	if readBack == nil || readBack.GitopsStatus == nil {
		t.Fatalf("partial PlanResult lost on the failure path: %+v", readBack)
	}
	if readBack.GitopsStatus.FailedStep != argocd.GitopsStepGitToken {
		t.Errorf("failed_step = %q", readBack.GitopsStatus.FailedStep)
	}

	// And the error is recorded alongside (the console's job error_message channel).
	b, _ := os.ReadFile(filepath.Join(workDir, "result.json"))
	if !strings.Contains(string(b), `"error"`) {
		t.Errorf("result.json missing the stage error: %s", b)
	}
}
