// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"testing"
)

// approvalBody is the approvals API's answer for one approval (apps/console/lib/approvals/read.ts).
func approvalBody(status string) map[string]any {
	return map[string]any{
		"approval": map[string]any{
			"id": "a1", "status": status, "operation": "deploy", "project_id": "p1", "environment_id": "e1",
			"plan_job_id": "j1", "digest_prefix": "a1b2c3d4", "expires_at": "2026-12-01T00:00:00.000Z",
			"decided_at": nil, "consumed_job_id": nil,
		},
		"approve_path": "/approvals/a1",
	}
}

// RequestApproval posts the plan, the operation and the note to /api/approvals, and leaves the note
// out when there is none.
func TestRequestApproval(t *testing.T) {
	isolateConfigDir(t)
	var bodies []map[string]any
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != http.MethodPost || r.URL.Path != "/api/approvals" {
			t.Errorf("%s %s, want POST /api/approvals", r.Method, r.URL.Path)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		bodies = append(bodies, body)
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(approvalBody(ApprovalStatusPending))
	}))

	resp, err := c.RequestApproval("j1", ApprovalOperationDeploy, "ship it")
	if err != nil {
		t.Fatal(err)
	}
	if resp.Approval.ID != "a1" || resp.Approval.Status != ApprovalStatusPending || resp.Approval.DigestPrefix != "a1b2c3d4" ||
		resp.ApprovePath != "/approvals/a1" || resp.Approval.DecidedAt != nil {
		t.Errorf("decoded %+v", resp)
	}
	if _, err := c.RequestApproval("j1", ApprovalOperationDestroy, ""); err != nil {
		t.Fatal(err)
	}
	if bodies[0]["plan_job_id"] != "j1" || bodies[0]["operation"] != "deploy" || bodies[0]["reason"] != "ship it" {
		t.Errorf("first body %+v", bodies[0])
	}
	if _, sent := bodies[1]["reason"]; sent || bodies[1]["operation"] != "destroy" {
		t.Errorf("an empty note must not be sent: %+v", bodies[1])
	}
}

// A refusal keeps the control plane's status and code, so the CLI can classify it.
func TestRequestApproval_Refused(t *testing.T) {
	isolateConfigDir(t)
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": "Plan j1 has not succeeded", "code": "plan_not_approvable"})
	}))
	_, err := c.RequestApproval("j1", ApprovalOperationDeploy, "")
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.StatusCode != http.StatusConflict || apiErr.Code != "plan_not_approvable" {
		t.Errorf("got %v", err)
	}
}

// GetApproval reads /api/approvals/{id} with the id escaped into one path segment.
func TestGetApproval(t *testing.T) {
	isolateConfigDir(t)
	var gotPath string
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		gotPath = r.URL.EscapedPath()
		if r.URL.Path == "/api/approvals/missing" {
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "Approval not found", "code": "not_found"})
			return
		}
		_ = json.NewEncoder(w).Encode(approvalBody(ApprovalStatusApproved))
	}))
	resp, err := c.GetApproval("a1")
	if err != nil || resp.Approval.Status != ApprovalStatusApproved || gotPath != "/api/approvals/a1" {
		t.Errorf("got %+v, %v at %q", resp, err, gotPath)
	}
	if _, err := c.GetApproval("a/b"); err != nil || gotPath != "/api/approvals/a%2Fb" {
		t.Errorf("the id must stay one path segment: %q (%v)", gotPath, err)
	}
	if _, err := c.GetApproval("missing"); err == nil {
		t.Error("a 404 must be an error")
	}
}

// QueueJobFull presents an approval as approval_id, and only when one is set.
func TestQueueJobFull_ApprovalID(t *testing.T) {
	isolateConfigDir(t)
	var bodies []map[string]any
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		bodies = append(bodies, body)
		_ = json.NewEncoder(w).Encode(map[string]any{"job": map[string]any{"id": "j2", "status": "QUEUED"}})
	}))
	if _, err := c.QueueJobFull(QueueJobParams{JobType: "DEPLOY", PlanJobID: "j1", ApprovalID: "a1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.QueueJobFull(QueueJobParams{JobType: "DEPLOY", PlanJobID: "j1"}); err != nil {
		t.Fatal(err)
	}
	if bodies[0]["approval_id"] != "a1" {
		t.Errorf("the approval was not presented: %+v", bodies[0])
	}
	if _, sent := bodies[1]["approval_id"]; sent {
		t.Errorf("no approval must send no approval_id: %+v", bodies[1])
	}
}
