// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package kubeaccess

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

var (
	defaultOpts  = ReadOnlyOptions{}
	nsPath       = "/api/v1/namespaces/alethia-system"
	saPath       = "/api/v1/namespaces/alethia-system/serviceaccounts/alethia-view"
	rolePath     = "/apis/rbac.authorization.k8s.io/v1/clusterroles/alethia:view"
	bindingPath  = "/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/alethia:view:alethia-system:alethia-view"
	bindingName  = "alethia:view:alethia-system:alethia-view"
	readVerbsSet = map[string]bool{"get": true, "list": true, "watch": true}
)

// TestReadOnlyRules_Invariants is the role's safety contract: it can read and nothing else, it
// cannot read Secrets, it names no wildcard anywhere, it reaches no subresource that executes or
// proxies, and it grants what decision 7 adds to `view` (nodes, namespaces, events).
func TestReadOnlyRules_Invariants(t *testing.T) {
	rules := ReadOnlyRules()
	if len(rules) == 0 {
		t.Fatal("no rules")
	}
	granted := map[string]bool{}
	for i, r := range rules {
		if len(r.ResourceNames) != 0 || len(r.NonResourceURLs) != 0 {
			t.Errorf("rule %d: resourceNames/nonResourceURLs must be empty: %+v", i, r)
		}
		if len(r.APIGroups) == 0 || len(r.Resources) == 0 || len(r.Verbs) == 0 {
			t.Errorf("rule %d is incomplete: %+v", i, r)
		}
		for _, g := range r.APIGroups {
			if strings.Contains(g, "*") {
				t.Errorf("rule %d: wildcard apiGroup %q", i, g)
			}
		}
		for _, v := range r.Verbs {
			if strings.Contains(v, "*") || !readVerbsSet[v] {
				t.Errorf("rule %d: verb %q is not get/list/watch", i, v)
			}
		}
		for _, res := range r.Resources {
			if strings.Contains(res, "*") {
				t.Errorf("rule %d: wildcard resource %q", i, res)
			}
			base, sub, _ := strings.Cut(res, "/")
			if base == "secrets" {
				t.Errorf("rule %d grants %q: the read-only role must never read Secrets", i, res)
			}
			switch sub {
			case "exec", "attach", "portforward", "proxy", "token", "ephemeralcontainers", "eviction":
				t.Errorf("rule %d grants the subresource %q", i, res)
			}
			for _, g := range r.APIGroups {
				granted[g+"/"+res] = true
			}
		}
	}
	for _, need := range []string{"/nodes", "/namespaces", "/events", "events.k8s.io/events", "/pods", "/pods/log", "apps/deployments"} {
		if !granted[need] {
			t.Errorf("the read-only role does not grant %q", need)
		}
	}
	rules[0].Verbs[0] = "delete"
	rules[0].Resources = append(rules[0].Resources, "secrets")
	if again := ReadOnlyRules(); again[0].Verbs[0] != "get" || strings.Contains(fmt.Sprint(again), "secrets") {
		t.Fatal("ReadOnlyRules shares state with its callers")
	}
}

// TestEnsure_IdempotentOneObjectEach runs Ensure twice and expects exactly four objects, each
// labelled, with the role, binding and ServiceAccount exactly as decided.
func TestEnsure_IdempotentOneObjectEach(t *testing.T) {
	srv := newFakeAPIServer()
	kube := fakeKube{srv}
	mustEnsure(t, kube, defaultOpts)
	first := srv.object(saPath)["metadata"].(map[string]any)["uid"]
	mustEnsure(t, kube, defaultOpts)
	if srv.count() != 4 {
		t.Fatalf("after two runs the cluster holds %d objects, want 4: %v", srv.count(), srv.objects)
	}
	if again := srv.object(saPath)["metadata"].(map[string]any)["uid"]; again != first {
		t.Fatalf("the second run replaced the ServiceAccount (uid %v → %v); tokens would be invalidated", first, again)
	}
	for _, p := range []string{nsPath, saPath, rolePath, bindingPath} {
		obj := srv.object(p)
		if obj == nil {
			t.Fatalf("%s was not created", p)
		}
		labels, _ := obj["metadata"].(map[string]any)["labels"].(map[string]any)
		if labels[ManagedByLabel] != ManagedByValue {
			t.Errorf("%s is not labelled %s=%s: %v", p, ManagedByLabel, ManagedByValue, labels)
		}
	}
	if srv.object(saPath)["automountServiceAccountToken"] != false {
		t.Error("the ServiceAccount must set automountServiceAccountToken: false")
	}
	role := srv.object(rolePath)
	if _, ok := role["aggregationRule"]; ok {
		t.Error("the ClusterRole must not aggregate")
	}
	var applied []PolicyRule
	raw, _ := json.Marshal(role["rules"])
	_ = json.Unmarshal(raw, &applied)
	if !rulesEqual(applied, ReadOnlyRules()) {
		t.Errorf("applied rules differ from ReadOnlyRules: %+v", applied)
	}
	binding := srv.object(bindingPath)
	if got := fmt.Sprint(binding["roleRef"]); got != "map[apiGroup:rbac.authorization.k8s.io kind:ClusterRole name:alethia:view]" {
		t.Errorf("roleRef = %s", got)
	}
	if got := fmt.Sprint(binding["subjects"]); got != "[map[kind:ServiceAccount name:alethia-view namespace:alethia-system]]" {
		t.Errorf("subjects = %s", got)
	}
	if defaultOpts.BindingName() != bindingName {
		t.Errorf("BindingName = %q", defaultOpts.BindingName())
	}
}

// TestEnsure_OverwritesWidenedRole: a role of the same name that someone widened to read Secrets is
// put back to exactly the read-only rules.
func TestEnsure_OverwritesWidenedRole(t *testing.T) {
	srv := newFakeAPIServer()
	srv.objects[rolePath] = map[string]any{
		"kind":     "ClusterRole",
		"metadata": map[string]any{"name": ReadOnlyClusterRole, "uid": "old"},
		"rules":    []any{map[string]any{"apiGroups": []any{""}, "resources": []any{"secrets"}, "verbs": []any{"get"}}},
	}
	mustEnsure(t, fakeKube{srv}, defaultOpts)
	if strings.Contains(fmt.Sprint(srv.object(rolePath)["rules"]), "secrets") {
		t.Fatal("Ensure left a widened role in place")
	}
}

// TestEnsure_RecreatesBindingToAnotherRole: a binding of this name pointing at cluster-admin would
// make every "read-only" token admin; roleRef is immutable, so Ensure deletes and recreates it.
func TestEnsure_RecreatesBindingToAnotherRole(t *testing.T) {
	srv := newFakeAPIServer()
	srv.objects[bindingPath] = map[string]any{
		"kind":     "ClusterRoleBinding",
		"metadata": map[string]any{"name": bindingName, "uid": "old"},
		"roleRef":  map[string]any{"apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": "cluster-admin"},
	}
	mustEnsure(t, fakeKube{srv}, defaultOpts)
	if got := srv.object(bindingPath)["roleRef"].(map[string]any)["name"]; got != ReadOnlyClusterRole {
		t.Fatalf("binding roleRef = %v, want %s", got, ReadOnlyClusterRole)
	}

	// The delete itself failing is reported, not swallowed.
	srv = newFakeAPIServer()
	srv.objects[bindingPath] = map[string]any{
		"kind":     "ClusterRoleBinding",
		"metadata": map[string]any{"name": bindingName, "uid": "old"},
		"roleRef":  map[string]any{"name": "cluster-admin"},
	}
	srv.fail = map[string]int{"DELETE " + bindingPath: http.StatusForbidden}
	if err := EnsureReadOnlyAccess(context.Background(), fakeKube{srv}, defaultOpts); err == nil || !strings.Contains(err.Error(), "replace cluster role binding") {
		t.Fatalf("err = %v", err)
	}
}

// TestEnsure_VerifiesWhatTheServerHolds: the check is on the server's answer, not on what was sent.
func TestEnsure_VerifiesWhatTheServerHolds(t *testing.T) {
	cases := map[string]func(path string, obj map[string]any){
		"an aggregationRule another manager added": func(path string, obj map[string]any) {
			if path == rolePath {
				obj["aggregationRule"] = map[string]any{"clusterRoleSelectors": []any{}}
			}
		},
		"an extra rule": func(path string, obj map[string]any) {
			if path == rolePath {
				obj["rules"] = append(obj["rules"].([]any), map[string]any{"apiGroups": []any{""}, "resources": []any{"secrets"}, "verbs": []any{"get"}})
			}
		},
		"a changed verb": func(path string, obj map[string]any) {
			if path == rolePath {
				obj["rules"].([]any)[0].(map[string]any)["verbs"] = []any{"get", "list", "create"}
			}
		},
		"a second subject": func(path string, obj map[string]any) {
			if path == bindingPath {
				obj["subjects"] = append(obj["subjects"].([]any), map[string]any{"kind": "Group", "name": "system:authenticated"})
			}
		},
		"another role": func(path string, obj map[string]any) {
			if path == bindingPath {
				obj["roleRef"] = map[string]any{"apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": "admin"}
			}
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			srv := newFakeAPIServer()
			srv.mutate = mutate
			err := EnsureReadOnlyAccess(context.Background(), fakeKube{srv}, defaultOpts)
			if !errors.Is(err, ErrKubeAPI) {
				t.Fatalf("err = %v, want ErrKubeAPI", err)
			}
		})
	}
}

// TestEnsure_ReportsEachStep: a refusal at each step names that step and wraps ErrKubeAPI.
func TestEnsure_ReportsEachStep(t *testing.T) {
	steps := map[string]string{
		"PATCH " + nsPath:      "ensure namespace",
		"PATCH " + saPath:      "ensure service account",
		"PATCH " + rolePath:    "ensure cluster role alethia:view",
		"PATCH " + bindingPath: "ensure cluster role binding",
	}
	for call, want := range steps {
		srv := newFakeAPIServer()
		srv.fail = map[string]int{call: http.StatusForbidden}
		err := EnsureReadOnlyAccess(context.Background(), fakeKube{srv}, defaultOpts)
		var ae *APIError
		if !errors.As(err, &ae) || ae.Code != http.StatusForbidden || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: err = %v, want a 403 naming %q", call, err, want)
		}
	}
	if err := EnsureReadOnlyAccess(context.Background(), erroringKube{errors.New("dial refused")}, defaultOpts); err == nil {
		t.Error("a transport failure must be an error")
	}
}

// TestOptions_Validation: names Kubernetes would refuse are refused before any call.
func TestOptions_Validation(t *testing.T) {
	ctx := context.Background()
	kube := erroringKube{errors.New("must not be called")}
	for _, o := range []ReadOnlyOptions{{Namespace: "Alethia"}, {ServiceAccount: "a_b"}, {Namespace: strings.Repeat("a", 64)}} {
		if err := EnsureReadOnlyAccess(ctx, kube, o); err == nil || !strings.Contains(err.Error(), "DNS-1123") {
			t.Errorf("Ensure(%+v) = %v", o, err)
		}
		if _, err := MintReadOnlyToken(ctx, kube, o, time.Hour); err == nil || !strings.Contains(err.Error(), "DNS-1123") {
			t.Errorf("Mint(%+v) = %v", o, err)
		}
		if err := RevokeReadOnlyAccess(ctx, kube, o); err == nil || !strings.Contains(err.Error(), "DNS-1123") {
			t.Errorf("Revoke(%+v) = %v", o, err)
		}
	}
	custom := ReadOnlyOptions{Namespace: "team-a", ServiceAccount: "user-1"}
	srv := newFakeAPIServer()
	mustEnsure(t, fakeKube{srv}, custom)
	if srv.object("/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/alethia:view:team-a:user-1") == nil {
		t.Fatal("a custom identity did not get its own binding")
	}
}

// TestMint_SendsNoStatus: the TokenRequest body carries apiVersion, kind and spec only. A status
// with an empty expirationTimestamp is refused by a real API server with 400 (metav1.Time cannot
// decode ""), which failed every read-only mint on hetzner and gcp in the 2026-10-02 dev nightly.
func TestMint_SendsNoStatus(t *testing.T) {
	srv := newFakeAPIServer()
	kube := fakeKube{srv}
	mustEnsure(t, kube, defaultOpts)
	if _, err := MintReadOnlyToken(context.Background(), kube, defaultOpts, 15*time.Minute); err != nil {
		t.Fatal(err)
	}
	if st, ok := srv.lastTokenRequest["status"]; ok {
		t.Fatalf("TokenRequest body carried a status %v; a real API server refuses it with 400", st)
	}
	for _, k := range []string{"apiVersion", "kind", "spec"} {
		if _, ok := srv.lastTokenRequest[k]; !ok {
			t.Fatalf("TokenRequest body has no %q", k)
		}
	}
}

// TestMint_ServerClampWins: the server caps the TTL; the returned expiry is the server's, and the
// request carried exactly the asked-for expirationSeconds.
func TestMint_ServerClampWins(t *testing.T) {
	srv := newFakeAPIServer()
	srv.maxTokenTTL = time.Hour
	kube := fakeKube{srv}
	mustEnsure(t, kube, defaultOpts)
	before := time.Now()
	tok, err := MintReadOnlyToken(context.Background(), kube, defaultOpts, 8*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if got := srv.lastTokenRequest["spec"].(map[string]any)["expirationSeconds"]; got != float64(28800) {
		t.Fatalf("expirationSeconds sent = %v, want 28800", got)
	}
	if aud, ok := srv.lastTokenRequest["spec"].(map[string]any)["audiences"]; ok {
		t.Fatalf("audiences must be left to the server default, sent %v", aud)
	}
	if tok.Token != srv.token {
		t.Fatal("wrong token returned")
	}
	if d := tok.ExpiresAt.Sub(before); d < 59*time.Minute || d > 61*time.Minute {
		t.Fatalf("ExpiresAt is %s after the request, want the server's clamped ~1h", d)
	}

	// Unclamped: the requested TTL comes back.
	srv.maxTokenTTL = 0
	tok, err = MintReadOnlyToken(context.Background(), kube, defaultOpts, 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if d := time.Until(tok.ExpiresAt); d < 14*time.Minute || d > 16*time.Minute {
		t.Fatalf("ExpiresAt in %s, want ~15m", d)
	}
}

// TestMint_RefusesTTLOutsideBounds: 15m–8h, whole seconds.
func TestMint_RefusesTTLOutsideBounds(t *testing.T) {
	kube := erroringKube{errors.New("must not be called")}
	for _, ttl := range []time.Duration{0, 899 * time.Second, 28801 * time.Second, time.Hour + 500*time.Millisecond} {
		if _, err := MintReadOnlyToken(context.Background(), kube, defaultOpts, ttl); err == nil || strings.Contains(err.Error(), "must not be called") {
			t.Errorf("ttl %s: err = %v, want a bounds refusal", ttl, err)
		}
	}
}

// TestMint_RefusesBadAnswers covers every way a TokenRequest answer can be unusable.
func TestMint_RefusesBadAnswers(t *testing.T) {
	cases := map[string]func(int64) map[string]any{
		"no token": func(int64) map[string]any {
			return map[string]any{"expirationTimestamp": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}
		},
		"no expiry": func(int64) map[string]any { return map[string]any{"token": "x"} },
		"already expired": func(int64) map[string]any {
			return map[string]any{"token": "x", "expirationTimestamp": time.Now().Add(-time.Minute).UTC().Format(time.RFC3339)}
		},
		"extended to a year": func(int64) map[string]any {
			return map[string]any{"token": "x", "expirationTimestamp": time.Now().Add(365 * 24 * time.Hour).UTC().Format(time.RFC3339)}
		},
	}
	for name, resp := range cases {
		t.Run(name, func(t *testing.T) {
			srv := newFakeAPIServer()
			mustEnsure(t, fakeKube{srv}, defaultOpts)
			srv.tokenResponse = resp
			if _, err := MintReadOnlyToken(context.Background(), fakeKube{srv}, defaultOpts, time.Hour); !errors.Is(err, ErrKubeAPI) {
				t.Fatalf("err = %v", err)
			}
		})
	}
	// Within the skew tolerance is accepted.
	srv := newFakeAPIServer()
	mustEnsure(t, fakeKube{srv}, defaultOpts)
	srv.tokenResponse = func(int64) map[string]any {
		return map[string]any{"token": "x", "expirationTimestamp": time.Now().Add(time.Hour + 2*time.Minute).UTC().Format(time.RFC3339)}
	}
	if _, err := MintReadOnlyToken(context.Background(), fakeKube{srv}, defaultOpts, time.Hour); err != nil {
		t.Fatalf("2 minutes of skew was refused: %v", err)
	}
	// No ServiceAccount yet: the API's 404 surfaces.
	if _, err := MintReadOnlyToken(context.Background(), fakeKube{newFakeAPIServer()}, defaultOpts, time.Hour); !isStatus(err, http.StatusNotFound) {
		t.Fatalf("mint without Ensure: err = %v, want 404", err)
	}
}

// TestRevoke deletes the binding then the ServiceAccount, by UID, leaves the role and namespace,
// tolerates absence, and refuses an object it did not create.
func TestRevoke(t *testing.T) {
	ctx := context.Background()
	srv := newFakeAPIServer()
	kube := fakeKube{srv}
	mustEnsure(t, kube, defaultOpts)
	uid := srv.object(saPath)["metadata"].(map[string]any)["uid"]
	srv.calls = nil
	if err := RevokeReadOnlyAccess(ctx, kube, defaultOpts); err != nil {
		t.Fatal(err)
	}
	if srv.object(bindingPath) != nil || srv.object(saPath) != nil {
		t.Fatal("revoke left the binding or the ServiceAccount")
	}
	if srv.object(rolePath) == nil || srv.object(nsPath) == nil {
		t.Fatal("revoke removed the role or the namespace")
	}
	want := []string{"GET " + bindingPath, "DELETE " + bindingPath, "GET " + saPath, "DELETE " + saPath}
	if fmt.Sprint(srv.calls) != fmt.Sprint(want) {
		t.Fatalf("calls = %v, want %v (binding first)", srv.calls, want)
	}
	if got := srv.lastDeleteBody["preconditions"].(map[string]any)["uid"]; got != uid {
		t.Fatalf("delete precondition uid = %v, want %v", got, uid)
	}
	if err := RevokeReadOnlyAccess(ctx, kube, defaultOpts); err != nil {
		t.Fatalf("a second revoke must succeed: %v", err)
	}

	// An unlabelled ServiceAccount of the same name is refused and kept.
	srv.objects[saPath] = map[string]any{"metadata": map[string]any{"name": "alethia-view", "uid": "theirs"}}
	if err := RevokeReadOnlyAccess(ctx, kube, defaultOpts); err == nil || !strings.Contains(err.Error(), "did not create") {
		t.Fatalf("err = %v", err)
	}
	if srv.object(saPath) == nil {
		t.Fatal("revoke deleted an object it did not create")
	}

	// Read and delete failures surface; a 404 on delete (raced away) does not.
	for call, code := range map[string]int{"GET " + bindingPath: 500, "DELETE " + bindingPath: 403} {
		s := newFakeAPIServer()
		mustEnsure(t, fakeKube{s}, defaultOpts)
		s.fail = map[string]int{call: code}
		if err := RevokeReadOnlyAccess(ctx, fakeKube{s}, defaultOpts); !isStatus(err, code) {
			t.Errorf("%s → %d: err = %v", call, code, err)
		}
	}
	s := newFakeAPIServer()
	mustEnsure(t, fakeKube{s}, defaultOpts)
	s.fail = map[string]int{"DELETE " + bindingPath: http.StatusNotFound}
	if err := RevokeReadOnlyAccess(ctx, fakeKube{s}, defaultOpts); err != nil {
		t.Fatalf("a binding deleted between read and delete: %v", err)
	}
	// An object without a UID is deleted without a precondition.
	s = newFakeAPIServer()
	s.objects[saPath] = map[string]any{"metadata": map[string]any{"name": "alethia-view", "labels": map[string]any{ManagedByLabel: ManagedByValue}}}
	if err := RevokeReadOnlyAccess(ctx, fakeKube{s}, defaultOpts); err != nil || s.object(saPath) != nil {
		t.Fatalf("err = %v, sa = %v", err, s.object(saPath))
	}
	if _, ok := s.lastDeleteBody["preconditions"]; ok {
		t.Fatal("a precondition was sent without a uid")
	}
}

// TestMintedToken_NeverPrints: every fmt verb and JSON redact the token.
func TestMintedToken_NeverPrints(t *testing.T) {
	tok := MintedToken{Token: "canary-token-value", ExpiresAt: time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)}
	for _, verb := range []string{"%v", "%+v", "%#v", "%s", "%q", "%x", "%d"} {
		out := fmt.Sprintf(verb, tok)
		if strings.Contains(out, "canary") || !strings.Contains(out, "<redacted>") {
			t.Errorf("%s printed %q", verb, out)
		}
	}
	if out := fmt.Sprintf("%v", &tok); strings.Contains(out, "canary") {
		t.Errorf("pointer printed %q", out)
	}
	raw, _ := json.Marshal(tok)
	if strings.Contains(string(raw), "canary") || string(raw) != `{"expires_at":"2026-10-01T12:00:00Z"}` {
		t.Errorf("json = %s", raw)
	}
}
