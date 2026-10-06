// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"encoding/json"
	"errors"
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
	comp, err := client.UpdateComponent("shop", "databases", "orders/v2", "prod", map[string]any{"max_capacity": 8}, "")
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
	if _, err := client.UpdateComponent("shop", "caches", "c", "", nil, ""); err != nil {
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
	_, err := client.UpdateComponent("shop", "databases", "orders", "prod", map[string]any{"colour": "red"}, "")
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
	if _, err := client.UpdateComponent("shop", "databases", "orders", "", map[string]any{"bad": func() {}}, ""); err == nil || !strings.Contains(err.Error(), "marshal") {
		t.Errorf("an unencodable body: err = %v", err)
	}

	broken := *client
	broken.baseURL = "http://bad host\x7f"
	if _, err := broken.UpdateComponent("shop", "databases", "orders", "", map[string]any{"port": 1}, ""); err == nil || !strings.Contains(err.Error(), "create request") {
		t.Errorf("an unbuildable URL: err = %v", err)
	}

	gone := *client
	gone.baseURL = "http://127.0.0.1:1/api"
	if _, err := gone.UpdateComponent("shop", "databases", "orders", "", map[string]any{"port": 1}, ""); err == nil || !strings.Contains(err.Error(), "send request") {
		t.Errorf("an unreachable server: err = %v", err)
	}
}

// TestUpdateComponent_SendsTheRevisionAsIfMatch (#5551): the revision `plan` read rides the PATCH as a
// quoted If-Match, and an empty one sends no header at all — an unconditional write, as before.
func TestUpdateComponent_SendsTheRevisionAsIfMatch(t *testing.T) {
	var got []string
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = append(got, r.Header.Get("If-Match"))
		_, _ = io.WriteString(w, `{"component":{"id":"c1","kind":"databases","name":"orders","status":"ACTIVE","cloud_identity_id":null,"config":{},"updated_at":"2026-10-06T10:00:01.000Z"}}`)
	}))
	comp, err := client.UpdateComponent("shop", "databases", "orders", "prod", map[string]any{"port": 1}, "2026-10-06T10:00:00.000Z")
	if err != nil {
		t.Fatalf("UpdateComponent: %v", err)
	}
	if comp.UpdatedAt == nil || *comp.UpdatedAt != "2026-10-06T10:00:01.000Z" {
		t.Errorf("the new revision was not decoded: %+v", comp.UpdatedAt)
	}
	if _, err := client.UpdateComponent("shop", "databases", "orders", "prod", map[string]any{"port": 1}, ""); err != nil {
		t.Fatalf("UpdateComponent: %v", err)
	}
	if len(got) != 2 || got[0] != `"2026-10-06T10:00:00.000Z"` || got[1] != "" {
		t.Errorf("If-Match headers = %q, want the quoted revision then none", got)
	}
}

// TestUpdateComponent_AConflictCarriesTheServersCopy (#5551): a 409 with a conflict code is a
// *ComponentConflictError holding the server's copy, so `apply` can name the fields that changed.
func TestUpdateComponent_AConflictCarriesTheServersCopy(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = io.WriteString(w, `{"error":"databases/orders changed on the server since it was read","code":"component_changed","status":"ACTIVE","component":{"id":"c1","kind":"databases","name":"orders","status":"ACTIVE","cloud_identity_id":null,"config":{"port":6543},"updated_at":"2026-10-06T10:05:00.000Z"}}`)
	}))
	_, err := client.UpdateComponent("shop", "databases", "orders", "prod", map[string]any{"port": 1}, "2026-10-06T10:00:00.000Z")
	var conflict *ComponentConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("err = %v (%T), want *ComponentConflictError", err, err)
	}
	if conflict.Busy() || conflict.Code != ConflictComponentChanged || conflict.Status != "ACTIVE" {
		t.Errorf("conflict = %+v", conflict)
	}
	if conflict.Current == nil || conflict.Current.Config["port"] != float64(6543) {
		t.Errorf("the server's copy was not carried: %+v", conflict.Current)
	}
	if !strings.Contains(err.Error(), "changed on the server") || !strings.Contains(err.Error(), "409") {
		t.Errorf("message %q", err.Error())
	}
}

// TestUpdateComponent_BusyIsAConflictToo: the status gate's 409 is the same error with Busy() set.
func TestUpdateComponent_BusyIsAConflictToo(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = io.WriteString(w, `{"error":"databases/orders is CREATING","code":"component_busy","status":"CREATING","component":null}`)
	}))
	_, err := client.UpdateComponent("shop", "databases", "orders", "prod", map[string]any{"port": 1}, "")
	var conflict *ComponentConflictError
	if !errors.As(err, &conflict) || !conflict.Busy() || conflict.Status != "CREATING" {
		t.Fatalf("err = %v, want a busy conflict", err)
	}
}

// TestUpdateComponent_AnUncodedConflictIsAnAPIError: a 409 without one of the two codes (a duplicate
// name) is an ordinary *APIError carrying the server's message, prefixed like every other failure.
func TestUpdateComponent_AnUncodedConflictIsAnAPIError(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = io.WriteString(w, `{"error":"Component \"orders\" already exists"}`)
	}))
	_, err := client.UpdateComponent("shop", "databases", "orders", "prod", map[string]any{"port": 1}, "")
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.StatusCode != http.StatusConflict || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("err = %v, want an APIError with the server's message", err)
	}
	if !strings.HasPrefix(err.Error(), "failed to update component") {
		t.Errorf("message %q lost its prefix", err.Error())
	}
}

// TestUpsertComponent_PostsTheSingletonWithIfMatch: a singleton's update goes to the add route with
// no name, the fields only, and the revision as If-Match; a 201 is success.
func TestUpsertComponent_PostsTheSingletonWithIfMatch(t *testing.T) {
	var gotBody map[string]any
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/cli/projects/shop/components/cluster" {
			t.Errorf("%s %s", r.Method, r.URL.Path)
		}
		if got := r.URL.Query().Get("env"); got != "prod" {
			t.Errorf("env %q", got)
		}
		if got := r.Header.Get("If-Match"); gotBody == nil && got != `"2026-10-06T10:00:00.000Z"` {
			t.Errorf("If-Match %q", got)
		}
		if gotBody != nil {
			_, _ = io.Copy(io.Discard, r.Body)
		} else {
			_ = json.NewDecoder(r.Body).Decode(&gotBody)
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"component":{"id":"k1","kind":"cluster","name":"cluster","status":"ACTIVE","cloud_identity_id":null,"config":{"node_max_size":5},"updated_at":null}}`)
	}))
	comp, err := client.UpsertComponent("shop", "cluster", "prod", map[string]any{"node_max_size": 5}, "2026-10-06T10:00:00.000Z")
	if err != nil || comp == nil || comp.ID != "k1" {
		t.Fatalf("UpsertComponent: %v %+v", err, comp)
	}
	if _, named := gotBody["name"]; named || len(gotBody) != 1 {
		t.Errorf("body %v, want only fields", gotBody)
	}
	if _, err := client.UpsertComponent("shop", "cluster", "prod", nil, ""); err != nil {
		t.Errorf("nil fields: %v", err)
	}
}
