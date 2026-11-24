// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"fmt"
	"net/url"
)

// The client half of the apply approvals API (agent surface §4.3; routes in
// apps/console/app/api/approvals/**). A CLI login or a service token that asks to deploy or destroy
// is answered 403 `approval_required` by POST /api/jobs. It then requests an approval for the
// reviewed plan, a person decides it in the console (never through this API), and the CLI presents
// the approved id as QueueJobParams.ApprovalID.

// The two operations an approval covers.
const (
	ApprovalOperationDeploy  = "deploy"
	ApprovalOperationDestroy = "destroy"
)

// The effective statuses GET /api/approvals/{id} answers. Pending is the only one that can still
// change; approved is the only one a job can be queued with.
const (
	ApprovalStatusPending    = "pending"
	ApprovalStatusApproved   = "approved"
	ApprovalStatusRejected   = "rejected"
	ApprovalStatusExpired    = "expired"
	ApprovalStatusSuperseded = "superseded"
	ApprovalStatusConsumed   = "consumed"
)

// Approval is one approval as the approvals API returns it (lib/approvals/read.ts ApprovalView).
type Approval struct {
	ID        string `json:"id"`
	Status    string `json:"status"`
	Operation string `json:"operation"`
	ProjectID string `json:"project_id"`
	// EnvironmentID is the environment the approved operation runs against.
	EnvironmentID string `json:"environment_id"`
	PlanJobID     string `json:"plan_job_id"`
	// DigestPrefix is the first 8 characters of the approved plan's digest. The approval page shows
	// the same 8, so the person approving can check they approve the plan this CLI asked about.
	DigestPrefix string `json:"digest_prefix"`
	// ExpiresAt is when a pending or approved approval stops being usable (RFC 3339).
	ExpiresAt     string  `json:"expires_at"`
	DecidedAt     *string `json:"decided_at"`
	ConsumedJobID *string `json:"consumed_job_id"`
}

// ApprovalResponse is the body of both approvals routes: the approval and the console path where a
// person decides it. The path is relative; the client joins it to its own origin, so a self-hosted
// control plane is never sent to a hosted page.
type ApprovalResponse struct {
	Approval    Approval `json:"approval"`
	ApprovePath string   `json:"approve_path"`
}

// RequestApproval asks for a person's approval to run operation (ApprovalOperationDeploy or
// ApprovalOperationDestroy) from the PLAN job planJobID. It never queues a job. It is idempotent on
// plan, operation and requesting credential: asking again returns the live approval (pending or
// already approved) instead of a second one. reason is shown to the approver as untrusted text;
// empty sends none.
func (c *Client) RequestApproval(planJobID, operation, reason string) (*ApprovalResponse, error) {
	payload := map[string]interface{}{"plan_job_id": planJobID, "operation": operation}
	if reason != "" {
		payload["reason"] = reason
	}
	var resp ApprovalResponse
	if err := c.doPost(fmt.Sprintf("%s/approvals", c.baseURL), payload, &resp); err != nil {
		return nil, fmt.Errorf("failed to request an approval: %w", err)
	}
	return &resp, nil
}

// GetApproval reads one approval's effective status: a live approval past its expiry reads
// expired, and one whose plan is no longer current reads superseded.
func (c *Client) GetApproval(id string) (*ApprovalResponse, error) {
	var resp ApprovalResponse
	if err := c.doGet(fmt.Sprintf("%s/approvals/%s", c.baseURL, url.PathEscape(id)), &resp); err != nil {
		return nil, fmt.Errorf("failed to read approval %s: %w", id, err)
	}
	return &resp, nil
}
