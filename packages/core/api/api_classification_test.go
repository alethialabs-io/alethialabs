// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"encoding/json"
	"net/http"
	"testing"
)

// --- Classification ---

func TestListClassificationDimensions_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != "GET" || r.URL.Path != "/api/cli/classification/dimensions" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"dimensions": []map[string]any{
				{
					"id": "d1", "key": "data_class", "label": "Data class", "multi": false,
					"applies_to": []string{"project", "component"},
					"values": []map[string]any{
						{"id": "v1", "value": "public", "label": "Public"},
						{"id": "v2", "value": "restricted", "label": "Restricted"},
					},
				},
			},
		})
	}))

	dims, err := client.ListClassificationDimensions()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(dims) != 1 || dims[0].Key != "data_class" {
		t.Fatalf("unexpected dimensions: %+v", dims)
	}
	if len(dims[0].Values) != 2 || dims[0].Values[1].Value != "restricted" {
		t.Errorf("unexpected values: %+v", dims[0].Values)
	}
	if len(dims[0].AppliesTo) != 2 {
		t.Errorf("unexpected applies_to: %+v", dims[0].AppliesTo)
	}
}

func TestListClassificationDimensions_Error(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(map[string]string{"error": "forbidden"})
	}))

	if _, err := client.ListClassificationDimensions(); err == nil {
		t.Fatal("expected error for 403 response")
	}
}

func TestGetResourceClassifications_EscapesQuery(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/classification/assignments" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if got := r.URL.Query().Get("kind"); got != "project" {
			t.Errorf("expected kind=project, got %q", got)
		}
		if got := r.URL.Query().Get("id"); got != "a b&c" {
			t.Errorf("expected the id to survive escaping, got %q", got)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"assignments": []map[string]any{
				{"dimension_key": "data_class", "dimension_label": "Data class", "value": "restricted", "value_label": "Restricted"},
			},
		})
	}))

	got, err := client.GetResourceClassifications("project", "a b&c")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 || got[0].Value != "restricted" {
		t.Errorf("unexpected assignments: %+v", got)
	}
}

func TestAssignClassification_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != "POST" || r.URL.Path != "/api/cli/classification/assignments" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["kind"] != "project" || body["id"] != "p1" ||
			body["dimension_key"] != "data_class" || body["value_slug"] != "restricted" {
			t.Errorf("unexpected payload: %+v", body)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"assignments": []map[string]any{
				{"dimension_key": "data_class", "value": "restricted"},
			},
		})
	}))

	got, err := client.AssignClassification("project", "p1", "data_class", "restricted")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 || got[0].DimensionKey != "data_class" {
		t.Errorf("unexpected assignments: %+v", got)
	}
}

func TestAssignClassification_Rejected(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "unknown dimension"})
	}))

	if _, err := client.AssignClassification("project", "p1", "nope", "x"); err == nil {
		t.Fatal("expected error for 400 response")
	}
}

func TestUnassignClassification(t *testing.T) {
	tests := []struct {
		name         string
		kind         string
		id           string
		valueSlug    string
		responseCode int
		wantErr      bool
	}{
		{name: "success", kind: "project", id: "p1", valueSlug: "restricted", responseCode: http.StatusOK},
		{name: "not found", kind: "project", id: "p1", valueSlug: "gone", responseCode: http.StatusNotFound, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				assertAuth(t, r)
				if r.Method != "DELETE" || r.URL.Path != "/api/cli/classification/assignments" {
					t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
				}
				q := r.URL.Query()
				if q.Get("kind") != tt.kind || q.Get("id") != tt.id || q.Get("value_slug") != tt.valueSlug {
					t.Errorf("unexpected query: %s", r.URL.RawQuery)
				}
				if tt.wantErr {
					w.WriteHeader(tt.responseCode)
					json.NewEncoder(w).Encode(map[string]string{"error": "not found"})
					return
				}
				w.WriteHeader(tt.responseCode)
			}))

			err := client.UnassignClassification(tt.kind, tt.id, tt.valueSlug)
			if tt.wantErr && err == nil {
				t.Fatalf("expected error for status %d", tt.responseCode)
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

// --- Break-glass ---

func TestOpenBreakglassSession_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != "POST" || r.URL.Path != "/api/breakglass/session" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		if body["reason"] != "INC-42 stuck job" {
			t.Errorf("unexpected reason: %q", body["reason"])
		}
		json.NewEncoder(w).Encode(map[string]string{
			"sessionId": "bg-1", "expiresAt": "2026-01-01T01:00:00Z", "operator": "op@example.com",
		})
	}))

	session, err := client.OpenBreakglassSession("INC-42 stuck job")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if session.SessionID != "bg-1" || session.Operator != "op@example.com" {
		t.Errorf("unexpected session: %+v", session)
	}
}

func TestOpenBreakglassSession_NotAnOperator(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(map[string]string{"error": "not a break-glass operator"})
	}))

	if _, err := client.OpenBreakglassSession("INC-42"); err == nil {
		t.Fatal("expected error for 403 response")
	}
}

func TestMintBreakglassApproval(t *testing.T) {
	suppress := true
	tests := []struct {
		name      string
		input     *BreakglassActionInput
		wantInput bool
	}{
		{name: "without input", input: nil},
		{
			name:      "with input",
			input:     &BreakglassActionInput{To: "FAILED", ExpectedFrom: []string{"RUNNING"}, SuppressEmails: &suppress},
			wantInput: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				assertAuth(t, r)
				if r.Method != "POST" || r.URL.Path != "/api/breakglass/approval" {
					t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
				}
				var body map[string]json.RawMessage
				json.NewDecoder(r.Body).Decode(&body)
				if _, ok := body["input"]; ok != tt.wantInput {
					t.Errorf("input present = %v, want %v", ok, tt.wantInput)
				}
				json.NewEncoder(w).Encode(map[string]string{
					"approvalId": "ap-1", "action": "job.force_status", "resourceId": "job-1",
					"expiresAt": "2026-01-01T01:00:00Z", "approver": "op2@example.com", "note": "ok",
				})
			}))

			approval, err := client.MintBreakglassApproval("job.force_status", "job-1", "INC-42", tt.input)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if approval.ApprovalID != "ap-1" || approval.Approver != "op2@example.com" {
				t.Errorf("unexpected approval: %+v", approval)
			}
		})
	}
}

func TestExecuteBreakglass_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != "POST" || r.URL.Path != "/api/breakglass/execute" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var body BreakglassExecuteParams
		json.NewDecoder(r.Body).Decode(&body)
		if body.SessionID != "bg-1" || body.Action != "job.force_status" || body.ApprovalID != "ap-1" {
			t.Errorf("unexpected payload: %+v", body)
		}
		if body.Input == nil || body.Input.To != "FAILED" {
			t.Errorf("unexpected input: %+v", body.Input)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"ok": true, "detail": "job forced to FAILED", "data": map[string]any{"jobId": "job-1"},
		})
	}))

	result, err := client.ExecuteBreakglass(BreakglassExecuteParams{
		SessionID:  "bg-1",
		Action:     "job.force_status",
		ResourceID: "job-1",
		Reason:     "INC-42",
		ApprovalID: "ap-1",
		Input:      &BreakglassActionInput{To: "FAILED"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.OK || result.Detail != "job forced to FAILED" {
		t.Errorf("unexpected result: %+v", result)
	}
	if string(result.Data) == "" {
		t.Error("expected the raw data payload to survive")
	}
}

func TestExecuteBreakglass_Refused(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "approval expired"})
	}))

	if _, err := client.ExecuteBreakglass(BreakglassExecuteParams{SessionID: "bg-1", Action: "x", Reason: "y"}); err == nil {
		t.Fatal("expected error for 400 response")
	}
}
