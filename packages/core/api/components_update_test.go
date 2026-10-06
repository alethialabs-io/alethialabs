// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// TestUpdateComponent_PatchesTheNamedComponentInOneEnvironment pins the wire: PATCH to the named
// component's path, `?env=` carried, the name path-escaped, and a body of exactly `{fields}` with
// only the fields the caller passed.
func TestUpdateComponent_PatchesTheNamedComponentInOneEnvironment(t *testing.T) {
	var gotBody map[string]any
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != http.MethodPatch {
			t.Errorf("method %s, want PATCH", r.Method)
		}
		if r.URL.EscapedPath() != "/api/cli/projects/shop/components/databases/orders%2Fv2" {
			t.Errorf("path %s", r.URL.EscapedPath())
		}
		if got := r.URL.Query().Get("env"); got != "prod" {
			t.Errorf("env %q, want prod", got)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("content-type %q", ct)
		}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_, _ = io.WriteString(w, `{"component":{"id":"c1","kind":"databases","name":"orders/v2","status":"ACTIVE","cloud_identity_id":null,"config":{"max_capacity":8}}}`)
	}))
	comp, err := client.UpdateComponent("shop", "databases", "orders/v2", "prod", map[string]any{"max_capacity": 8})
	if err != nil {
		t.Fatalf("UpdateComponent: %v", err)
	}
	if comp == nil || comp.ID != "c1" || comp.Config["max_capacity"] != float64(8) {
		t.Errorf("decoded %+v", comp)
	}
	if len(gotBody) != 1 {
		t.Errorf("body carries more than `fields`: %v", gotBody)
	}
	fields, _ := gotBody["fields"].(map[string]any)
	if len(fields) != 1 || fields["max_capacity"] != float64(8) {
		t.Errorf("fields %v, want only max_capacity=8", fields)
	}
}

// TestUpdateComponent_NoEnvLeavesTheQueryOff: without an environment the URL carries no `?env=`,
// matching every other component call.
func TestUpdateComponent_NoEnvLeavesTheQueryOff(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RawQuery != "" {
			t.Errorf("query %q, want none", r.URL.RawQuery)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if fields, ok := body["fields"].(map[string]any); !ok || len(fields) != 0 {
			t.Errorf("nil fields must go as an empty object, got %v", body)
		}
		_, _ = io.WriteString(w, `{"component":{"id":"c1","kind":"caches","name":"c","status":"ACTIVE","config":{}}}`)
	}))
	if _, err := client.UpdateComponent("shop", "caches", "c", "", nil); err != nil {
		t.Fatalf("UpdateComponent: %v", err)
	}
}

// TestUpdateComponent_ARefusalIsTheServersMessage: a 400 is an error carrying the server's reason,
// so `apply` can show the person why the field was not changed.
func TestUpdateComponent_ARefusalIsTheServersMessage(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"error":"Unknown field(s) for databases: colour"}`)
	}))
	_, err := client.UpdateComponent("shop", "databases", "orders", "prod", map[string]any{"colour": "red"})
	if err == nil || !strings.Contains(err.Error(), "colour") {
		t.Fatalf("err = %v, want the server's refusal", err)
	}
}

// TestUpdateComponent_TransportFailuresAreErrors covers the three ways the request never gets an
// answer: a body that cannot be encoded, a URL that cannot be built, and a server that is gone.
func TestUpdateComponent_TransportFailuresAreErrors(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("no request should reach the server")
	}))
	if _, err := client.UpdateComponent("shop", "databases", "orders", "", map[string]any{"bad": func() {}}); err == nil || !strings.Contains(err.Error(), "marshal") {
		t.Errorf("an unencodable body: err = %v", err)
	}

	broken := *client
	broken.baseURL = "http://bad host\x7f"
	if _, err := broken.UpdateComponent("shop", "databases", "orders", "", map[string]any{"port": 1}); err == nil || !strings.Contains(err.Error(), "create request") {
		t.Errorf("an unbuildable URL: err = %v", err)
	}

	gone := *client
	gone.baseURL = "http://127.0.0.1:1/api"
	if _, err := gone.UpdateComponent("shop", "databases", "orders", "", map[string]any{"port": 1}); err == nil || !strings.Contains(err.Error(), "send request") {
		t.Errorf("an unreachable server: err = %v", err)
	}
}
