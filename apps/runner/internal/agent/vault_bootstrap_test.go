// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// fakeVault records the ORDER of operations, which is the part that can be catastrophically wrong
// while every individual call looks correct.
type fakeVault struct {
	initialized bool
	sealed      bool
	healthErr   error

	calls      []string
	initKey    string
	initRoot   string
	initErr    error
	unsealErr  error
	kvErr      error
	putErr     error
	tokenErr   error
	revokeErr  error
	puts       map[string]string
	revoked    []string
	tokenValue string
}

func newFakeVault() *fakeVault {
	return &fakeVault{puts: map[string]string{}, initKey: "unseal-key", initRoot: "root-token", tokenValue: "eso-token"}
}

func (f *fakeVault) Health(context.Context) (bool, bool, error) {
	f.calls = append(f.calls, "health")
	return f.initialized, f.sealed, f.healthErr
}

func (f *fakeVault) Init(context.Context) (string, string, error) {
	f.calls = append(f.calls, "init")
	if f.initErr != nil {
		return "", "", f.initErr
	}
	f.initialized = true
	return f.initKey, f.initRoot, nil
}

func (f *fakeVault) Unseal(_ context.Context, key string) error {
	f.calls = append(f.calls, "unseal:"+key)
	if f.unsealErr != nil {
		return f.unsealErr
	}
	f.sealed = false
	return nil
}

func (f *fakeVault) EnableKV(_ context.Context, _, mount string) error {
	f.calls = append(f.calls, "enablekv:"+mount)
	return f.kvErr
}

func (f *fakeVault) PutSecret(_ context.Context, _, _, name, value string) error {
	f.calls = append(f.calls, "put:"+name)
	if f.putErr != nil {
		return f.putErr
	}
	f.puts[name] = value
	return nil
}

func (f *fakeVault) EnsureESOToken(context.Context, string, string, string) (string, error) {
	f.calls = append(f.calls, "esotoken")
	if f.tokenErr != nil {
		return "", f.tokenErr
	}
	return f.tokenValue, nil
}

func (f *fakeVault) RevokeSelf(_ context.Context, token string) error {
	f.calls = append(f.calls, "revoke:"+token)
	f.revoked = append(f.revoked, token)
	return f.revokeErr
}

// memState is an in-memory vaultStateStore.
type memState struct {
	data     map[string]string
	writes   []map[string]string
	readErr  error
	writeErr error
}

func newMemState(seed map[string]string) *memState {
	if seed == nil {
		seed = map[string]string{}
	}
	return &memState{data: seed}
}

func (m *memState) Read(context.Context) (map[string]string, error) {
	if m.readErr != nil {
		return nil, m.readErr
	}
	out := map[string]string{}
	for k, v := range m.data {
		out[k] = v
	}
	return out, nil
}

func (m *memState) Write(_ context.Context, data map[string]string) error {
	if m.writeErr != nil {
		return m.writeErr
	}
	snapshot := map[string]string{}
	for k, v := range data {
		snapshot[k] = v
	}
	m.writes = append(m.writes, snapshot)
	m.data = data
	return nil
}

// vaultOpts builds options seeding each named secret as a GENERATED one with the default sizing —
// the common case, and the one every existing assertion in this file is about.
func vaultOpts(names ...string) vaultBootstrapOpts {
	specs := make([]vaultSeedSpec, 0, len(names))
	for _, n := range names {
		specs = append(specs, vaultSeedSpec{Name: n, Generate: true, Length: 32})
	}
	return vaultBootstrapOpts{
		APIBase:        "http://addon-secrets-vault.secrets.svc.cluster.local:8200",
		StateSecret:    "alethia-vault-state",
		StateNamespace: "secrets",
		Secrets:        specs,
		ESOCredSecret:  "secretstore-hetzner-token",
		ESONamespace:   "external-secrets-operator",
		ESOCredKey:     "token",
	}
}

func noopSeed(context.Context, string) error { return nil }

// ── THE data-loss guard ────────────────────────────────────────────────────────────────────────

// A Vault reporting UNINITIALIZED while this cluster already holds an unseal key has lost its
// storage. Re-initialising would create an EMPTY Vault, mint a new key, discard every stored secret,
// and report success — a silent total data loss that looks like a clean deploy.
func TestVaultBootstrapRefusesToReinitialiseAfterStorageLoss(t *testing.T) {
	v := newFakeVault()
	v.initialized = false // storage gone
	state := newMemState(map[string]string{
		vaultUnsealKeyField:   "old-key",
		vaultInitializedField: "true",
	})

	err := vaultBootstrap(context.Background(), vaultOpts("api-key"), v, state, noopSeed)
	if err == nil {
		t.Fatal("re-initialised a Vault whose storage was lost — every stored secret would be silently discarded")
	}
	if !strings.Contains(err.Error(), "UNINITIALIZED") {
		t.Errorf("error = %v, want the storage-loss refusal", err)
	}
	for _, c := range v.calls {
		if c == "init" {
			t.Fatal("called init despite holding an unseal key")
		}
	}
}

// ── first install ──────────────────────────────────────────────────────────────────────────────

func TestVaultBootstrapInitialisesUnsealsSeedsAndRevokesRoot(t *testing.T) {
	v := newFakeVault()
	state := newMemState(nil)

	if err := vaultBootstrap(context.Background(), vaultOpts("api-key", "signing-key"), v, state, noopSeed); err != nil {
		t.Fatalf("vaultBootstrap: %v", err)
	}

	want := []string{"health", "init", "unseal:unseal-key", "enablekv:secret", "put:api-key", "put:signing-key", "esotoken", "revoke:root-token"}
	if strings.Join(v.calls, ",") != strings.Join(want, ",") {
		t.Fatalf("call order =\n  %v\nwant\n  %v", v.calls, want)
	}
	// Each secret gets its OWN generated value — a shared one would make every secret in the project
	// the same string, which is the kind of thing nothing downstream would notice.
	if v.puts["api-key"] == v.puts["signing-key"] {
		t.Error("both secrets got the same generated value")
	}
	for name, val := range v.puts {
		if len(val) < 32 {
			t.Errorf("secret %q value is only %d chars", name, len(val))
		}
	}
}

// The unseal key must be persisted BEFORE the unseal attempt. Vault shows it exactly once, so a
// crash between init and the write leaves a Vault nobody can ever open — unrecoverable, not merely
// broken.
func TestVaultBootstrapPersistsTheUnsealKeyBeforeUnsealing(t *testing.T) {
	v := newFakeVault()
	v.unsealErr = errors.New("boom")
	state := newMemState(nil)

	if err := vaultBootstrap(context.Background(), vaultOpts(), v, state, noopSeed); err == nil {
		t.Fatal("an unseal failure was swallowed")
	}
	if len(state.writes) == 0 {
		t.Fatal("the unseal key was never persisted — a crash here leaves a Vault nobody can open")
	}
	if state.writes[0][vaultUnsealKeyField] != "unseal-key" {
		t.Errorf("first write = %v, want the unseal key", state.writes[0])
	}
	if state.writes[0][vaultInitializedField] != "true" {
		t.Error("the initialized marker was not persisted with the key — the data-loss guard depends on it")
	}
}

// ── re-runs ────────────────────────────────────────────────────────────────────────────────────

// The Job runs on every deploy. An already-configured Vault must be left completely alone: there is
// no root token any more (it was revoked), so re-running the configuration is impossible as well as
// unnecessary.
func TestVaultBootstrapIsANoOpOnAnAlreadyConfiguredVault(t *testing.T) {
	v := newFakeVault()
	v.initialized, v.sealed = true, false
	state := newMemState(map[string]string{
		vaultUnsealKeyField:   "k",
		vaultInitializedField: "true",
		vaultESOTokenField:    "t",
	})

	if err := vaultBootstrap(context.Background(), vaultOpts("api-key"), v, state, noopSeed); err != nil {
		t.Fatalf("vaultBootstrap: %v", err)
	}
	if strings.Join(v.calls, ",") != "health" {
		t.Errorf("calls = %v, want only a health check", v.calls)
	}
	if len(state.writes) != 0 {
		t.Errorf("rewrote state on a no-op run: %v", state.writes)
	}
}

// A restart re-seals Vault. The Job must unseal it from the stored key WITHOUT re-initialising and
// WITHOUT re-seeding — the secrets are already there and re-seeding would overwrite live values.
func TestVaultBootstrapUnsealsAfterARestartWithoutReseeding(t *testing.T) {
	v := newFakeVault()
	v.initialized, v.sealed = true, true
	state := newMemState(map[string]string{
		vaultUnsealKeyField:   "stored-key",
		vaultInitializedField: "true",
	})

	if err := vaultBootstrap(context.Background(), vaultOpts("api-key"), v, state, noopSeed); err != nil {
		t.Fatalf("vaultBootstrap: %v", err)
	}
	if strings.Join(v.calls, ",") != "health,unseal:stored-key" {
		t.Errorf("calls = %v, want health then unseal only", v.calls)
	}
	if len(v.puts) != 0 {
		t.Errorf("re-seeded %v after a restart — that overwrites live secret values", v.puts)
	}
}

func TestVaultBootstrapFailsWhenSealedWithNoStoredKey(t *testing.T) {
	v := newFakeVault()
	v.initialized, v.sealed = true, true
	err := vaultBootstrap(context.Background(), vaultOpts(), v, newMemState(nil), noopSeed)
	if err == nil || !strings.Contains(err.Error(), "no unseal key") {
		t.Fatalf("error = %v, want a refusal to proceed with a sealed Vault it cannot open", err)
	}
}

// ── the root token must not survive any exit path ──────────────────────────────────────────────

func TestVaultBootstrapRevokesRootEvenWhenConfigurationFails(t *testing.T) {
	for name, breakIt := range map[string]func(*fakeVault){
		"enable kv fails": func(v *fakeVault) { v.kvErr = errors.New("nope") },
		"put fails":       func(v *fakeVault) { v.putErr = errors.New("nope") },
		"token fails":     func(v *fakeVault) { v.tokenErr = errors.New("nope") },
	} {
		t.Run(name, func(t *testing.T) {
			v := newFakeVault()
			breakIt(v)
			if err := vaultBootstrap(context.Background(), vaultOpts("api-key"), v, newMemState(nil), noopSeed); err == nil {
				t.Fatal("a configuration failure was swallowed")
			}
			if len(v.revoked) != 1 || v.revoked[0] != "root-token" {
				t.Errorf("revoked %v — a root token left alive is a standing credential nobody meant to create", v.revoked)
			}
		})
	}
}

func TestVaultBootstrapFailsWhenTheESOCredentialCannotBeSeeded(t *testing.T) {
	v := newFakeVault()
	err := vaultBootstrap(context.Background(), vaultOpts("api-key"), v, newMemState(nil),
		func(context.Context, string) error { return errors.New("apply refused") })
	if err == nil || !strings.Contains(err.Error(), "seed the ESO credential") {
		t.Fatalf("error = %v, want the seeding failure", err)
	}
	// And root is still destroyed.
	if len(v.revoked) != 1 {
		t.Errorf("revoked %v, want the root token", v.revoked)
	}
}

func TestVaultBootstrapRejectsAnEmptyInitResponse(t *testing.T) {
	v := newFakeVault()
	v.initKey = ""
	if err := vaultBootstrap(context.Background(), vaultOpts(), v, newMemState(nil), noopSeed); err == nil {
		t.Fatal("an empty unseal key was accepted — the Vault could never be reopened")
	}
}

func TestRunVaultBootstrapRejectsAnIncompleteInvocation(t *testing.T) {
	err := RunVaultBootstrap(context.Background(), []string{"--api-base", "http://v"})
	if err == nil || !strings.Contains(err.Error(), "missing required flag") {
		t.Fatalf("error = %v, want a missing-flag report", err)
	}
}

// ── the real client, against an httptest Vault ─────────────────────────────────────────────────

// Vault answers sealed with 503 and uninitialized with 501 by default. The query pins both to 200 so
// those states are DATA, not transport errors — otherwise a sealed Vault reads as "not answering
// yet" and the bootstrap waits fifteen minutes for something already up.
func TestVaultAPIHealthReadsSealedAndUninitializedAsData(t *testing.T) {
	for _, c := range []struct{ init, sealed bool }{{false, true}, {true, true}, {true, false}} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !strings.Contains(r.URL.RawQuery, "sealedcode=200") || !strings.Contains(r.URL.RawQuery, "uninitcode=200") {
				t.Errorf("health query = %q, want sealed/uninit pinned to 200", r.URL.RawQuery)
			}
			fmt.Fprintf(w, `{"initialized":%t,"sealed":%t}`, c.init, c.sealed)
		}))
		v := &vaultAPI{base: srv.URL, http: srv.Client()}
		gotInit, gotSealed, err := v.Health(context.Background())
		if err != nil || gotInit != c.init || gotSealed != c.sealed {
			t.Errorf("Health() = (%v,%v,%v), want (%v,%v,nil)", gotInit, gotSealed, err, c.init, c.sealed)
		}
		srv.Close()
	}
}

func TestVaultAPIInitAsksForASingleShare(t *testing.T) {
	var body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b := make([]byte, r.ContentLength)
		_, _ = r.Body.Read(b)
		body = string(b)
		fmt.Fprint(w, `{"keys":["k1"],"root_token":"rt"}`)
	}))
	defer srv.Close()
	v := &vaultAPI{base: srv.URL, http: srv.Client()}
	key, root, err := v.Init(context.Background())
	if err != nil || key != "k1" || root != "rt" {
		t.Fatalf("Init() = (%q,%q,%v)", key, root, err)
	}
	// One share, threshold one. Splitting into N would be theatre: every share ends up in the same
	// Secret, so the threshold protects nothing and there is simply more material to lose.
	if !strings.Contains(body, `"secret_shares":1`) || !strings.Contains(body, `"secret_threshold":1`) {
		t.Errorf("init body = %q, want a single share with threshold 1", body)
	}
}

// A key that does not match the storage leaves Vault sealed and Vault reports 200 anyway. Reading
// only the status code would call that success and leave a sealed Vault behind a green deploy.
func TestVaultAPIUnsealFailsWhenVaultStaysSealed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"sealed":true}`)
	}))
	defer srv.Close()
	v := &vaultAPI{base: srv.URL, http: srv.Client()}
	if err := v.Unseal(context.Background(), "wrong"); err == nil {
		t.Error("a 200 that left Vault sealed was read as success")
	}
}

// Vault has no idempotent mount call: a second run gets 400 "path is already in use". Treating that
// as failure would make every deploy after the first fail.
func TestVaultAPIEnableKVToleratesAnExistingMount(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"errors":["path is already in use at secret/"]}`)
	}))
	defer srv.Close()
	v := &vaultAPI{base: srv.URL, http: srv.Client()}
	if err := v.EnableKV(context.Background(), "root", "secret"); err != nil {
		t.Errorf("an existing mount was treated as failure: %v", err)
	}
}

func TestVaultAPIEnableKVStillFailsOnARealError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()
	v := &vaultAPI{base: srv.URL, http: srv.Client()}
	if err := v.EnableKV(context.Background(), "root", "secret"); err == nil {
		t.Error("a 403 was treated as an existing mount")
	}
}

// The value lands under the pinned `value` field, which is what a secret-kind binding's
// ExternalSecret reads via remoteRef.property. A different field name authenticates fine and then
// resolves to nothing.
func TestVaultAPIPutSecretUsesThePinnedValueField(t *testing.T) {
	var body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b := make([]byte, r.ContentLength)
		_, _ = r.Body.Read(b)
		body = string(b)
		if !strings.HasPrefix(r.URL.Path, "/v1/secret/data/") {
			t.Errorf("path = %q, want a KV v2 data path", r.URL.Path)
		}
		if r.Header.Get("X-Vault-Token") == "" {
			t.Error("the write was not authenticated")
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	v := &vaultAPI{base: srv.URL, http: srv.Client()}
	if err := v.PutSecret(context.Background(), "root", "secret", "api-key", "s3cr3t"); err != nil {
		t.Fatalf("PutSecret: %v", err)
	}
	if !strings.Contains(body, `"value":"s3cr3t"`) {
		t.Errorf("body = %q, want the value under the pinned `value` field", body)
	}
}

// The ESO token lives in a Secret an operator can read, so it must be read-only and mount-scoped —
// no write, no delete, no sys/.
func TestVaultAPIESOTokenIsReadOnlyAndMountScoped(t *testing.T) {
	var policy string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b := make([]byte, r.ContentLength)
		_, _ = r.Body.Read(b)
		if strings.Contains(r.URL.Path, "/sys/policies/acl/") {
			// The policy arrives JSON-encoded; decode it so the assertions read the real HCL
			// rather than its escaping.
			var wrapper struct {
				Policy string `json:"policy"`
			}
			_ = json.Unmarshal(b, &wrapper)
			policy = wrapper.Policy
			w.WriteHeader(http.StatusNoContent)
			return
		}
		fmt.Fprint(w, `{"auth":{"client_token":"eso-tok"}}`)
	}))
	defer srv.Close()
	v := &vaultAPI{base: srv.URL, http: srv.Client()}
	tok, err := v.EnsureESOToken(context.Background(), "root", "alethia-eso-read", "secret")
	if err != nil || tok != "eso-tok" {
		t.Fatalf("EnsureESOToken() = (%q,%v)", tok, err)
	}
	if !strings.Contains(policy, `capabilities = ["read"]`) {
		t.Errorf("policy = %q, want read-only", policy)
	}
	for _, forbidden := range []string{`"create"`, `"update"`, `"delete"`, `"sudo"`, `"root"`, `path "sys/`} {
		if strings.Contains(policy, forbidden) {
			t.Errorf("policy grants %s: %q", forbidden, policy)
		}
	}
	if !strings.Contains(policy, `path "secret/data/*"`) {
		t.Errorf("policy is not scoped to the mount: %q", policy)
	}
}

// ── the real client's error branches, which all fail closed ───────────────────────────────────

// A Vault we cannot reach is not a Vault that is uninitialized, unsealed, or configured. Every one
// of these must surface as a failed Job, never as a state we then act on.
func TestVaultAPIFailsClosedWhenVaultIsUnreachable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	base := srv.URL
	srv.Close()

	v := &vaultAPI{base: base, http: &http.Client{}}
	ctx := context.Background()

	if _, _, err := v.Health(ctx); err == nil {
		t.Error("Health succeeded against an unreachable Vault")
	}
	if _, _, err := v.Init(ctx); err == nil {
		t.Error("Init succeeded against an unreachable Vault")
	}
	if err := v.Unseal(ctx, "k"); err == nil {
		t.Error("Unseal succeeded against an unreachable Vault")
	}
	if err := v.EnableKV(ctx, "root", "secret"); err == nil {
		t.Error("EnableKV succeeded against an unreachable Vault")
	}
	if err := v.PutSecret(ctx, "root", "secret", "n", "v"); err == nil {
		t.Error("PutSecret succeeded against an unreachable Vault")
	}
	if _, err := v.EnsureESOToken(ctx, "root", "p", "secret"); err == nil {
		t.Error("EnsureESOToken succeeded against an unreachable Vault")
	}
	if err := v.RevokeSelf(ctx, "root"); err == nil {
		t.Error("RevokeSelf succeeded against an unreachable Vault")
	}
}

func TestVaultAPIRejectsUnexpectedStatuses(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()
	v := &vaultAPI{base: srv.URL, http: srv.Client()}
	ctx := context.Background()

	if _, _, err := v.Health(ctx); err == nil {
		t.Error("a 403 health response was accepted")
	}
	if _, _, err := v.Init(ctx); err == nil {
		t.Error("a 403 init was accepted")
	}
	if err := v.Unseal(ctx, "k"); err == nil {
		t.Error("a 403 unseal was accepted")
	}
	if err := v.PutSecret(ctx, "root", "secret", "n", "v"); err == nil {
		t.Error("a 403 write was accepted")
	}
	if _, err := v.EnsureESOToken(ctx, "root", "p", "secret"); err == nil {
		t.Error("a 403 policy write was accepted")
	}
	if err := v.RevokeSelf(ctx, "root"); err == nil {
		t.Error("a 403 revoke was accepted")
	}
}

// RevokeSelf is the one call whose SUCCESS matters most — a root token left alive is a standing
// credential nobody meant to create — so its happy path is asserted explicitly, including that it
// sends the token it was given rather than an ambient one.
func TestVaultAPIRevokeSelfSendsTheTokenItWasGiven(t *testing.T) {
	var seen string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/auth/token/revoke-self" {
			t.Errorf("path = %q, want the self-revoke endpoint", r.URL.Path)
		}
		seen = r.Header.Get("X-Vault-Token")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	v := &vaultAPI{base: srv.URL, http: srv.Client()}
	if err := v.RevokeSelf(context.Background(), "root-token"); err != nil {
		t.Fatalf("RevokeSelf: %v", err)
	}
	if seen != "root-token" {
		t.Errorf("revoked with %q, want the root token", seen)
	}
}

func TestVaultAPIRejectsUndecodableBodies(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `not json`)
	}))
	defer srv.Close()
	v := &vaultAPI{base: srv.URL, http: srv.Client()}
	ctx := context.Background()
	if _, _, err := v.Health(ctx); err == nil {
		t.Error("an undecodable health body was accepted")
	}
	if _, _, err := v.Init(ctx); err == nil {
		t.Error("an undecodable init body was accepted")
	}
	if err := v.Unseal(ctx, "k"); err == nil {
		t.Error("an undecodable unseal body was accepted")
	}
}

// Vault returning no key at all must not read as "initialised with an empty key".
func TestVaultAPIInitToleratesAnEmptyKeyList(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"keys":[],"root_token":"rt"}`)
	}))
	defer srv.Close()
	v := &vaultAPI{base: srv.URL, http: srv.Client()}
	key, root, err := v.Init(context.Background())
	if err != nil || key != "" || root != "rt" {
		t.Fatalf("Init() = (%q,%q,%v), want an empty key reported as empty", key, root, err)
	}
	// …and the algorithm refuses it, which is what actually protects the deploy.
	fake := newFakeVault()
	fake.initKey = ""
	if bErr := vaultBootstrap(context.Background(), vaultOpts(), fake, newMemState(nil), noopSeed); bErr == nil {
		t.Error("an empty unseal key was accepted by the bootstrap")
	}
}

func TestWaitForVaultReturnsTheStateOnceVaultAnswers(t *testing.T) {
	v := newFakeVault()
	v.healthErr = errors.New("connection refused")
	// Answer on the second probe.
	go func() { time.Sleep(20 * time.Millisecond); v.healthErr = nil; v.initialized = true }()
	init, sealed, err := waitForVault(context.Background(), v)
	if err != nil {
		t.Fatalf("waitForVault: %v", err)
	}
	if !init || sealed {
		t.Errorf("waitForVault = (%v,%v), want (true,false)", init, sealed)
	}
}

func TestVaultBootstrapReportsAStateReadFailure(t *testing.T) {
	state := newMemState(nil)
	state.readErr = errors.New("kubectl refused")
	if err := vaultBootstrap(context.Background(), vaultOpts(), newFakeVault(), state, noopSeed); err == nil {
		t.Error("an unreadable state Secret was treated as absent — that would re-initialise a live Vault")
	}
}

func TestVaultBootstrapReportsAStateWriteFailure(t *testing.T) {
	state := newMemState(nil)
	state.writeErr = errors.New("apply refused")
	if err := vaultBootstrap(context.Background(), vaultOpts(), newFakeVault(), state, noopSeed); err == nil {
		t.Error("a failed unseal-key write was swallowed — the Vault could never be reopened")
	}
}

// ── the sizing the canvas offers, honoured ─────────────────────────────────────────────────────

// The canvas offers `generate`, `length` and `special_chars` on EVERY cloud. The four managed ones
// carry all three into their secret store (aws_provider.go buildSecrets); if this path ignored them,
// a Hetzner project would present three switches that change nothing — which is the exact state
// offer-parity refuses, and it caught this file's first draft doing it.
func TestVaultBootstrapHonoursTheDeclaredLengthAndAlphabet(t *testing.T) {
	v := newFakeVault()
	o := vaultOpts()
	o.Secrets = []vaultSeedSpec{
		{Name: "short", Generate: true, Length: 16},
		{Name: "long-special", Generate: true, Length: 64, SpecialChars: true},
		{Name: "unset-length", Generate: true},
	}
	if err := vaultBootstrap(context.Background(), o, v, newMemState(nil), noopSeed); err != nil {
		t.Fatalf("vaultBootstrap: %v", err)
	}
	if got := len(v.puts["short"]); got != 16 {
		t.Errorf("length 16 produced a %d-character value", got)
	}
	if got := len(v.puts["long-special"]); got != 64 {
		t.Errorf("length 64 produced a %d-character value", got)
	}
	// An unset length is the canvas default, not zero — a zero-length secret authenticates nothing.
	if got := len(v.puts["unset-length"]); got != vaultSeedDefaultLength {
		t.Errorf("an unset length produced a %d-character value, want the %d default", got, vaultSeedDefaultLength)
	}
	// special_chars must actually widen the alphabet, not merely be accepted. Probabilistic in
	// principle — the chance a 64-character draw from a 78-character alphabet contains no special is
	// (62/78)^64, about 1 in 10^6.4 — but the test would be vacuous without asserting it at all.
	if !strings.ContainsAny(v.puts["long-special"], vaultSeedSpecials) {
		t.Errorf("special_chars produced a value with no special character: %q", v.puts["long-special"])
	}
	if strings.ContainsAny(v.puts["short"], vaultSeedSpecials) {
		t.Errorf("a secret that did NOT ask for special chars got one: %q", v.puts["short"])
	}
}

// MANUAL secrets carry the same semantics as `manual: true` on the managed clouds: the store holds
// no value, and the operator supplies one. Writing a placeholder would be indistinguishable from a
// real value to every consumer — worse than an honest absence.
func TestVaultBootstrapWritesNothingForAManualSecret(t *testing.T) {
	v := newFakeVault()
	o := vaultOpts()
	o.Secrets = []vaultSeedSpec{
		{Name: "operator-supplied"},
		{Name: "generated", Generate: true, Length: 24},
	}
	if err := vaultBootstrap(context.Background(), o, v, newMemState(nil), noopSeed); err != nil {
		t.Fatalf("vaultBootstrap: %v", err)
	}
	if _, wrote := v.puts["operator-supplied"]; wrote {
		t.Error("a manual secret was given a generated value — the operator's value would be silently shadowed")
	}
	if len(v.puts["generated"]) != 24 {
		t.Errorf("the generated secret alongside it was not written correctly: %q", v.puts["generated"])
	}
}

// The `--secrets` grammar is the ONLY channel between the renderer and this Job, and a spec it
// silently skipped would be an ExternalSecret resolving nothing, discovered days later.
func TestParseVaultSeedSpecsIsTotalAndFailClosed(t *testing.T) {
	got, err := parseVaultSeedSpecs("api-key:32:1, signing-key:0:0 ,legacy:manual")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	want := []vaultSeedSpec{
		{Name: "api-key", Generate: true, Length: 32, SpecialChars: true},
		{Name: "signing-key", Generate: true},
		{Name: "legacy"},
	}
	if len(got) != len(want) {
		t.Fatalf("parsed %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("spec[%d] = %+v, want %+v", i, got[i], want[i])
		}
	}
	if empty, eErr := parseVaultSeedSpecs(""); eErr != nil || len(empty) != 0 {
		t.Errorf("an empty argument parsed to %v, %v", empty, eErr)
	}
	for _, bad := range []string{
		"api-key",            // no form at all
		"api-key:auto",       // not `manual`, not a length
		"api-key:32",         // a length with no special-chars flag
		"api-key:32:2",       // a flag that is neither 0 nor 1
		"api-key:-1:0",       // a negative length
		":32:0",              // no name
		"api-key:32:0:extra", // too many fields
	} {
		if _, bErr := parseVaultSeedSpecs(bad); bErr == nil {
			t.Errorf("spec %q was accepted — an unparsed secret is one that silently never gets seeded", bad)
		}
	}
}

// A hostile or mistyped length must not ask the pod to allocate an unbounded string; the Job runs
// with no memory limit of its own.
func TestGenerateSecretValueBoundsTheLength(t *testing.T) {
	got, err := generateSecretValue(vaultSeedSpec{Name: "x", Generate: true, Length: vaultSeedMaxLength * 10})
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if len(got) != vaultSeedMaxLength {
		t.Errorf("an absurd length produced %d characters, want the %d ceiling", len(got), vaultSeedMaxLength)
	}
}
