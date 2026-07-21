// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"errors"
	"testing"
)

// persistErrAPI embeds the shared mockAPI and makes UpdateJobStatus fail, to exercise the
// audit-verdict persist-failure path.
type persistErrAPI struct {
	*mockAPI
	err error
}

func (p *persistErrAPI) UpdateJobStatus(jobID, status, errMsg string, md map[string]any) error {
	return p.err
}

func auditJob(kind, input string) *Job {
	return &Job{ID: "audit-1", JobType: "AUDIT", ConfigSnapshot: map[string]any{
		"audit_kind":  kind,
		"audit_input": input,
	}}
}

func TestExecuteAudit_EmptyInputErrors(t *testing.T) {
	w := NewWithAPI(Config{Operator: "self"}, &mockAPI{})
	log := NewJobLogger(&mockAPI{}, "audit-1", "stdout")
	if err := w.executeAudit(context.Background(), auditJob("plan", ""), log, log); err == nil {
		t.Fatal("expected an error when audit_input is empty")
	}
}

// #986 regression: when the verify verdict can't be persisted, the audit job must FAIL, not
// silently return success.
func TestExecuteAudit_PersistFailureFailsTheJob(t *testing.T) {
	manifest := "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: demo\n"
	api := &persistErrAPI{mockAPI: &mockAPI{}, err: errors.New("console unreachable")}
	w := NewWithAPI(Config{Operator: "self"}, api)
	log := NewJobLogger(&mockAPI{}, "audit-1", "stdout")

	err := w.executeAudit(context.Background(), auditJob("manifests", manifest), log, log)
	if err == nil {
		t.Fatal("expected executeAudit to fail when the verdict can't be persisted")
	}
}

func TestExecuteAudit_SuccessPersistsVerdict(t *testing.T) {
	manifest := "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: demo\n"
	api := &mockAPI{}
	w := NewWithAPI(Config{Operator: "self"}, api)
	log := NewJobLogger(&mockAPI{}, "audit-1", "stdout")

	if err := w.executeAudit(context.Background(), auditJob("manifests", manifest), log, log); err != nil {
		t.Fatalf("executeAudit: %v", err)
	}
	api.mu.Lock()
	defer api.mu.Unlock()
	found := false
	for _, u := range api.statusUpdates {
		if u.metadata != nil {
			if _, ok := u.metadata["verify_result"]; ok {
				found = true
			}
		}
	}
	if !found {
		t.Fatal("executeAudit did not persist verify_result on success")
	}
}
