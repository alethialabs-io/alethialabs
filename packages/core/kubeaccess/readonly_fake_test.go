// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package kubeaccess

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeAPIServer is an in-memory stand-in for the slice of the Kubernetes API the read-only tier uses:
// server-side apply (PATCH, create-or-replace, roleRef immutability on ClusterRoleBindings), GET,
// DELETE with a UID precondition, and TokenRequest with a server-side expiry ceiling. It is an
// http.Handler, so the same fake serves the in-process KubeAPI adapter and a real TLS server.
type fakeAPIServer struct {
	mu      sync.Mutex
	objects map[string]map[string]any // object path (no query) → stored object
	uidSeq  int
	calls   []string // "METHOD path" in order

	// maxTokenTTL caps a TokenRequest's expirationSeconds, as --service-account-max-token-expiration does.
	maxTokenTTL time.Duration
	// tokenResponse, when set, replaces the TokenRequest status the server answers with.
	tokenResponse func(requested int64) map[string]any
	// rawTokenBody, when set, is written verbatim as the TokenRequest answer.
	rawTokenBody string
	// mutate edits an object the server is about to return from an apply (simulates other managers).
	mutate func(path string, obj map[string]any)
	// fail answers "METHOD path" with the given status before doing anything.
	fail map[string]int
	// lastTokenRequest is the decoded body of the last TokenRequest.
	lastTokenRequest map[string]any
	// lastDeleteBody is the decoded body of the last DELETE.
	lastDeleteBody map[string]any
	// token is the token value the server issues.
	token string
}

// newFakeAPIServer returns an empty fake cluster.
func newFakeAPIServer() *fakeAPIServer {
	return &fakeAPIServer{objects: map[string]map[string]any{}, token: "fake-sa-token-0001"}
}

// writeStatus writes a Kubernetes Status object.
func writeStatus(w http.ResponseWriter, code int, reason, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{"kind": "Status", "status": "Failure", "code": code, "reason": reason, "message": msg})
}

// writeJSON writes v as a 200/201 JSON answer.
func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// ServeHTTP implements the fake API.
func (f *fakeAPIServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	path := r.URL.Path
	f.calls = append(f.calls, r.Method+" "+path)
	if code, ok := f.fail[r.Method+" "+path]; ok {
		writeStatus(w, code, http.StatusText(code), "injected failure")
		return
	}
	body, _ := io.ReadAll(r.Body)
	switch {
	case r.Method == http.MethodPost && strings.HasSuffix(path, "/token"):
		f.serveToken(w, strings.TrimSuffix(path, "/token"), body)
	case r.Method == http.MethodPatch:
		f.serveApply(w, r, path, body)
	case r.Method == http.MethodGet:
		obj, ok := f.objects[path]
		if !ok {
			writeStatus(w, http.StatusNotFound, "NotFound", path+" not found")
			return
		}
		writeJSON(w, http.StatusOK, obj)
	case r.Method == http.MethodDelete:
		obj, ok := f.objects[path]
		if !ok {
			writeStatus(w, http.StatusNotFound, "NotFound", path+" not found")
			return
		}
		var opts map[string]any
		_ = json.Unmarshal(body, &opts)
		f.lastDeleteBody = opts
		if pre, ok := opts["preconditions"].(map[string]any); ok {
			if pre["uid"] != obj["metadata"].(map[string]any)["uid"] {
				writeStatus(w, http.StatusConflict, "Conflict", "uid precondition failed")
				return
			}
		}
		delete(f.objects, path)
		writeJSON(w, http.StatusOK, map[string]any{"kind": "Status", "status": "Success"})
	default:
		writeStatus(w, http.StatusMethodNotAllowed, "MethodNotAllowed", r.Method)
	}
}

// serveApply implements server-side apply as create-or-replace, keeping the UID, and refusing a
// roleRef change on a ClusterRoleBinding the way the real API does (422 Invalid).
func (f *fakeAPIServer) serveApply(w http.ResponseWriter, r *http.Request, path string, body []byte) {
	if r.Header.Get("Content-Type") != applyType || r.URL.Query().Get("fieldManager") != FieldManager || r.URL.Query().Get("force") != "true" {
		writeStatus(w, http.StatusUnsupportedMediaType, "UnsupportedMediaType", "not a forced server-side apply")
		return
	}
	var obj map[string]any
	if err := json.Unmarshal(body, &obj); err != nil {
		writeStatus(w, http.StatusBadRequest, "BadRequest", "bad body")
		return
	}
	meta := obj["metadata"].(map[string]any)
	if old, ok := f.objects[path]; ok {
		if obj["kind"] == "ClusterRoleBinding" && fmt.Sprint(old["roleRef"]) != fmt.Sprint(obj["roleRef"]) {
			writeStatus(w, http.StatusUnprocessableEntity, "Invalid", "roleRef: Invalid value: cannot change roleRef")
			return
		}
		meta["uid"] = old["metadata"].(map[string]any)["uid"]
	} else {
		f.uidSeq++
		meta["uid"] = fmt.Sprintf("uid-%d", f.uidSeq)
	}
	if f.mutate != nil {
		f.mutate(path, obj)
	}
	f.objects[path] = obj
	writeJSON(w, http.StatusOK, obj)
}

// serveToken implements TokenRequest for an existing ServiceAccount.
func (f *fakeAPIServer) serveToken(w http.ResponseWriter, saPath string, body []byte) {
	if _, ok := f.objects[saPath]; !ok {
		writeStatus(w, http.StatusNotFound, "NotFound", "serviceaccounts not found")
		return
	}
	if f.rawTokenBody != "" {
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, f.rawTokenBody)
		return
	}
	var req map[string]any
	_ = json.Unmarshal(body, &req)
	f.lastTokenRequest = req
	requested := int64(req["spec"].(map[string]any)["expirationSeconds"].(float64))
	var status map[string]any
	if f.tokenResponse != nil {
		status = f.tokenResponse(requested)
	} else {
		ttl := time.Duration(requested) * time.Second
		if f.maxTokenTTL > 0 && ttl > f.maxTokenTTL {
			ttl = f.maxTokenTTL
		}
		status = map[string]any{"token": f.token, "expirationTimestamp": time.Now().Add(ttl).UTC().Format(time.RFC3339)}
	}
	req["status"] = status
	writeJSON(w, http.StatusCreated, req)
}

// object returns a stored object (nil if absent).
func (f *fakeAPIServer) object(path string) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.objects[path]
}

// count returns how many objects are stored.
func (f *fakeAPIServer) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.objects)
}

// fakeKube adapts the fake to KubeAPI in-process, through the real handler.
type fakeKube struct{ srv *fakeAPIServer }

// Do serves one request through the fake's handler.
func (k fakeKube) Do(ctx context.Context, method, path, contentType string, body []byte) (int, []byte, error) {
	var rdr io.Reader
	if body != nil {
		rdr = strings.NewReader(string(body))
	}
	req := httptest.NewRequestWithContext(ctx, method, "https://fake"+path, rdr)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	rec := httptest.NewRecorder()
	k.srv.ServeHTTP(rec, req)
	return rec.Code, rec.Body.Bytes(), nil
}

// erroringKube fails every call at the transport level.
type erroringKube struct{ err error }

// Do returns the configured transport error.
func (k erroringKube) Do(context.Context, string, string, string, []byte) (int, []byte, error) {
	return 0, nil, k.err
}

// mustEnsure runs EnsureReadOnlyAccess and fails the test on error.
func mustEnsure(t *testing.T, kube KubeAPI, opts ReadOnlyOptions) {
	t.Helper()
	if err := EnsureReadOnlyAccess(context.Background(), kube, opts); err != nil {
		t.Fatalf("EnsureReadOnlyAccess: %v", err)
	}
}
