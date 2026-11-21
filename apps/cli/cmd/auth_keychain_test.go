// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/credstore"
	"github.com/alethialabs-io/alethialabs/apps/cli/internal/version"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh"
)

// errNoKeychainInTests is what the system keychain answers for the whole suite unless a test asks
// for a working one.
var errNoKeychainInTests = errors.New("no system keychain in the test suite")

// The suite never reaches the credential store of the machine it runs on.
//
// Every command resolves its credential through the keychain first, so without this a test run on a
// developer's laptop would read their real sign-in, and a test that signs in would write one. The
// keyring library's own in-memory provider replaces the operating system's for the whole test
// binary, and it starts as a store that cannot be used — the state of a CI runner or a container —
// so every test written against the credentials file behaves as it always did. A test that wants a
// working keychain asks for one with keychainAvailable.
func init() {
	credstore.UseUnavailable(errNoKeychainInTests)
}

// keychainAvailable gives the test an empty, working system keychain and takes it away afterwards.
func keychainAvailable(t *testing.T) {
	t.Helper()
	credstore.UseMemory()
	t.Cleanup(func() { credstore.UseUnavailable(errNoKeychainInTests) })
}

// --- The fake control plane and the harness ---

// The values a test must never find in anything the CLI printed.
const (
	keychainRefreshCanary  = "refresh-canary-7f3a9c"
	keychainProviderCanary = "provider-canary-51be02"
)

// authFake is a control plane that serves the sign-in routes and whoami.
type authFake struct {
	srv *httptest.Server

	mu sync.Mutex
	// exchange is what an approved sign-in returns.
	exchange types.ExchangeResponse
	// renewed is the access token the refresh route hands out; empty refuses the refresh.
	renewed string
	// accepted are the bearer tokens whoami answers; any other gets a 401.
	accepted map[string]bool
	// refreshCalls and whoamiCalls count the requests each route received.
	refreshCalls, whoamiCalls int
}

// newAuthFake starts the fake, points the CLI at it in a fresh home directory with no supplied
// token, and returns it with the path of the credentials file.
func newAuthFake(t *testing.T) (*authFake, string) {
	t.Helper()
	credsPath := isolatedHome(t)
	fake := &authFake{accepted: map[string]bool{}}
	fake.srv = httptest.NewServer(http.HandlerFunc(fake.serve))
	t.Cleanup(fake.srv.Close)
	authCovOrigin(t, fake.srv.URL)
	t.Setenv(ServiceTokenEnv, "")

	prevBrowser := openBrowser
	openBrowser = func(string) error { return nil }
	t.Cleanup(func() {
		openBrowser = prevBrowser
		api.SetTokenRefresher(nil)
	})
	return fake, credsPath
}

// serve answers one request.
func (f *authFake) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/api/auth/cli/start":
		_, _ = w.Write([]byte("{}"))
	case "/api/auth/cli/exchange":
		_ = json.NewEncoder(w).Encode(f.exchange)
	case "/api/auth/cli/refresh":
		f.refreshCalls++
		if f.renewed == "" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"refused"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"access_token": f.renewed})
	case "/api/cli/whoami":
		f.whoamiCalls++
		if !f.accepted[strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")] {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"Unauthorized"}`))
			return
		}
		_, _ = w.Write([]byte(`{"user":{"id":"u1","email":"ada@x.com","name":"Ada"}}`))
	default:
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"not found"}`))
	}
}

// approves sets what the next sign-in returns: a live access token for email, with the two canaries
// beside it. It returns the access token.
func (f *authFake) approves(t *testing.T, email string) string {
	t.Helper()
	token := makeToken(t, time.Now().Add(time.Hour))
	f.mu.Lock()
	defer f.mu.Unlock()
	f.exchange = types.ExchangeResponse{
		AccessToken: token, RefreshToken: keychainRefreshCanary,
		ProviderToken: keychainProviderCanary, UserEmail: email,
	}
	f.accepted[token] = true
	return token
}

// renews sets the access token the refresh route hands out, and makes whoami accept it.
func (f *authFake) renews(t *testing.T) string {
	t.Helper()
	token := makeToken(t, time.Now().Add(2*time.Hour))
	f.mu.Lock()
	defer f.mu.Unlock()
	f.renewed = token
	f.accepted[token] = true
	return token
}

// counts returns how many refresh and whoami requests arrived.
func (f *authFake) counts() (refresh, whoami int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.refreshCalls, f.whoamiCalls
}

// authRun runs the command tree with args and returns what it wrote on each stream and its exit
// code, which is 0 when the fatal path was not taken.
func authRun(t *testing.T, args ...string) (stdout, stderr string, code int) {
	t.Helper()
	prevExit := exitFunc
	exitFunc = func(c int) { panic(authCovExit{c}) }
	t.Cleanup(func() {
		exitFunc = prevExit
		resetAllFlags()
		execRootArgs(nil)
	})
	resetAllFlags()
	stdout, stderr = captureStreams(t, func() {
		defer func() {
			r := recover()
			if r == nil {
				return
			}
			exit, ok := r.(authCovExit)
			if !ok {
				panic(r)
			}
			code = exit.code
		}()
		execRootArgs(args)
		_ = rootCmd.Execute()
	})
	return stdout, stderr, code
}

// leaked returns the secrets that appear in any of texts.
func leaked(secrets []string, texts ...string) []string {
	var found []string
	for _, secret := range secrets {
		if secret == "" {
			continue
		}
		for _, text := range texts {
			if strings.Contains(text, secret) {
				found = append(found, secret)
				break
			}
		}
	}
	return found
}

// keychainEntry returns the credential the system keychain holds for the fake, and whether there is
// one.
func keychainEntry(t *testing.T, origin string) (storedCredential, bool) {
	t.Helper()
	cred, err := readKeychainCredential(origin)
	if errors.Is(err, credstore.ErrNotFound) {
		return storedCredential{}, false
	}
	if err != nil {
		t.Fatalf("read the keychain: %v", err)
	}
	return cred, true
}

// fileExists reports whether path is there.
func fileExists(t *testing.T, path string) bool {
	t.Helper()
	_, err := os.Stat(path)
	if err != nil && !os.IsNotExist(err) {
		t.Fatalf("stat %s: %v", path, err)
	}
	return err == nil
}

// linesWith returns the lines of text that contain needle.
func linesWith(text, needle string) []string {
	var out []string
	for _, line := range strings.Split(text, "\n") {
		if strings.Contains(line, needle) {
			out = append(out, line)
		}
	}
	return out
}

// scriptedStore is a credential store whose behaviour a test writes down.
type scriptedStore struct {
	entries map[string]string
	// setErr fails every Set.
	setErr error
	// forget makes Set succeed without keeping what it was given.
	forget bool
	// block, when set, holds every call until it is closed.
	block chan struct{}
}

// Get returns the entry for account.
func (s *scriptedStore) Get(account string) (string, error) {
	if s.block != nil {
		<-s.block
	}
	secret, ok := s.entries[account]
	if !ok {
		return "", credstore.ErrNotFound
	}
	return secret, nil
}

// Set stores the entry for account, unless the script says otherwise.
func (s *scriptedStore) Set(account, secret string) error {
	if s.block != nil {
		<-s.block
	}
	if s.setErr != nil {
		return s.setErr
	}
	if !s.forget {
		s.entries[account] = secret
	}
	return nil
}

// Delete removes the entry for account.
func (s *scriptedStore) Delete(account string) error {
	if s.block != nil {
		<-s.block
	}
	if _, ok := s.entries[account]; !ok {
		return credstore.ErrNotFound
	}
	delete(s.entries, account)
	return nil
}

// useCredentialStore puts store in place of the system keychain for the test.
func useCredentialStore(t *testing.T, store credstore.Store) {
	t.Helper()
	prev := credentialStore
	credentialStore = store
	t.Cleanup(func() { credentialStore = prev })
}

// --- login: where the credential goes ---

// TestKeychain_LoginStoresInTheKeychainAndLeavesNoFile is the first half of the unit: with a system
// keychain, a sign-in puts the credential there, writes no credentials file, says which store it
// used in one stderr line, and reports the session on stdout as the mutation result.
func TestKeychain_LoginStoresInTheKeychainAndLeavesNoFile(t *testing.T) {
	fake, credsPath := newAuthFake(t)
	keychainAvailable(t)
	token := fake.approves(t, "ada@x.com")

	stdout, stderr, code := authRun(t, "login", "--output", "json")
	if code != 0 {
		t.Fatalf("login exited %d\n%s", code, stderr)
	}

	cred, ok := keychainEntry(t, fake.srv.URL)
	if !ok || cred.AccessToken != token || cred.RefreshToken != keychainRefreshCanary || cred.UserEmail != "ada@x.com" {
		t.Errorf("the keychain does not hold the sign-in (found=%v)", ok)
	}
	if cred.Origin != fake.srv.URL {
		t.Errorf("the credential records origin %q, want the control plane that issued it", cred.Origin)
	}
	if fileExists(t, credsPath) {
		t.Error("a credentials file was written although the keychain took the credential")
	}

	if got := linesWith(stderr, "system keychain"); len(got) != 1 {
		t.Errorf("want exactly one stderr line naming the store, got %d:\n%s", len(got), stderr)
	}

	var result struct {
		ID     string  `json:"id"`
		Kind   string  `json:"kind"`
		Action string  `json:"action"`
		Job    *JobRef `json:"job"`
		DryRun bool    `json:"dry_run"`
		Object struct {
			User     string `json:"user"`
			Origin   string `json:"origin"`
			StoredIn string `json:"stored_in"`
			Path     string `json:"path"`
		} `json:"object"`
	}
	if err := json.Unmarshal([]byte(stdout), &result); err != nil {
		t.Fatalf("stdout is not one json document: %v\n%s", err, stdout)
	}
	if result.Kind != "session" || result.Action != "created" || result.Job != nil || result.DryRun {
		t.Errorf("result = %+v", result)
	}
	if result.Object.User != "ada@x.com" || result.Object.Origin != fake.srv.URL ||
		result.Object.StoredIn != "keychain" || result.Object.Path != "" {
		t.Errorf("object = %+v", result.Object)
	}
	if result.ID != strings.TrimPrefix(fake.srv.URL, "http://") {
		t.Errorf("id = %q, want the control plane's host", result.ID)
	}

	if found := leaked([]string{token, keychainRefreshCanary, keychainProviderCanary}, stdout, stderr); len(found) > 0 {
		t.Errorf("login printed %d secret(s)", len(found))
	}
}

// TestKeychain_LoginFallsBackToAnOwnerOnlyFile is the fallback: with no usable keychain the
// credential goes to the credentials file, owner-only in an owner-only directory, and one stderr
// line says so and names the file.
func TestKeychain_LoginFallsBackToAnOwnerOnlyFile(t *testing.T) {
	fake, credsPath := newAuthFake(t)
	token := fake.approves(t, "ada@x.com")

	stdout, stderr, code := authRun(t, "login", "--output", "json")
	if code != 0 {
		t.Fatalf("login exited %d\n%s", code, stderr)
	}

	info, err := os.Stat(credsPath)
	if err != nil {
		t.Fatalf("the credentials file was not written: %v", err)
	}
	if info.Mode().Perm() != credentialsFileMode {
		t.Errorf("credentials file mode = %#o, want %#o", info.Mode().Perm(), credentialsFileMode)
	}
	dir, err := os.Stat(filepath.Dir(credsPath))
	if err != nil {
		t.Fatal(err)
	}
	if dir.Mode().Perm() != configDirMode {
		t.Errorf("configuration directory mode = %#o, want %#o", dir.Mode().Perm(), configDirMode)
	}

	notices := linesWith(stderr, "The system keychain could not be used here")
	if len(notices) != 1 || !strings.Contains(notices[0], credsPath) {
		t.Errorf("want one stderr line naming the fallback and the file, got %q", notices)
	}
	if !strings.Contains(stdout, `"stored_in":"file"`) && !strings.Contains(stdout, `"stored_in": "file"`) {
		t.Errorf("the result does not say the file was used: %s", stdout)
	}
	if found := leaked([]string{token, keychainRefreshCanary, keychainProviderCanary}, stdout, stderr); len(found) > 0 {
		t.Errorf("login printed %d secret(s)", len(found))
	}
}

// TestKeychain_AKeychainThatNeverAnswersFallsBackToTheFile pins the deadline: a keychain that hangs
// costs the limit once per call and then the file is used, so the command still finishes.
func TestKeychain_AKeychainThatNeverAnswersFallsBackToTheFile(t *testing.T) {
	fake, credsPath := newAuthFake(t)
	fake.approves(t, "ada@x.com")
	block := make(chan struct{})
	t.Cleanup(func() { close(block) })
	useCredentialStore(t, credstore.Bounded(&scriptedStore{entries: map[string]string{}, block: block}, 5*time.Millisecond))

	_, stderr, code := authRun(t, "login")
	if code != 0 {
		t.Fatalf("login exited %d\n%s", code, stderr)
	}
	if !fileExists(t, credsPath) {
		t.Error("the credential was not written to the file after the keychain timed out")
	}
}

// TestKeychain_InsecureStorageKeepsTheFile pins --insecure-storage: the file is used although a
// keychain is available, the notice says it was asked for, and a later renewal leaves it there.
func TestKeychain_InsecureStorageKeepsTheFile(t *testing.T) {
	fake, credsPath := newAuthFake(t)
	keychainAvailable(t)
	fake.approves(t, "ada@x.com")

	_, stderr, code := authRun(t, "login", "--insecure-storage")
	if code != 0 {
		t.Fatalf("login exited %d\n%s", code, stderr)
	}
	if _, ok := keychainEntry(t, fake.srv.URL); ok {
		t.Error("--insecure-storage still wrote to the keychain")
	}
	if !fileExists(t, credsPath) {
		t.Fatal("--insecure-storage wrote no credentials file")
	}
	if !strings.Contains(stderr, "--insecure-storage") {
		t.Errorf("the notice does not say the file was asked for:\n%s", stderr)
	}

	// Expire the stored access token, then let any command renew it.
	cred, _, err := loadStoredCredential()
	if err != nil {
		t.Fatal(err)
	}
	cred.AccessToken = makeToken(t, time.Now().Add(-time.Hour))
	if err := writeCredentialFile(credsPath, cred); err != nil {
		t.Fatal(err)
	}
	renewed := fake.renews(t)
	got, err := getAuthTokenInternal(false)
	if err != nil || got != renewed {
		t.Fatalf("renewal: got the renewed token = %v, err = %v", got == renewed, err)
	}
	if _, ok := keychainEntry(t, fake.srv.URL); ok {
		t.Error("a renewal moved a credential the user asked to keep in the file")
	}
	if !fileExists(t, credsPath) {
		t.Error("the renewal removed the credentials file")
	}
}

// --- migration ---

// TestKeychain_LoginMigratesAnExistingFile pins the migration on sign-in: a credentials file from
// before is replaced by the keychain entry and removed, and stderr says it moved.
func TestKeychain_LoginMigratesAnExistingFile(t *testing.T) {
	fake, credsPath := newAuthFake(t)
	keychainAvailable(t)
	if err := saveCredentials(credsPath, types.ExchangeResponse{
		AccessToken: makeToken(t, time.Now().Add(30*time.Minute)), RefreshToken: "old-refresh", UserEmail: "old@x.com",
	}); err != nil {
		t.Fatal(err)
	}
	token := fake.approves(t, "ada@x.com")

	_, stderr, code := authRun(t, "login", "--force")
	if code != 0 {
		t.Fatalf("login exited %d\n%s", code, stderr)
	}
	cred, ok := keychainEntry(t, fake.srv.URL)
	if !ok || cred.AccessToken != token {
		t.Fatalf("the keychain does not hold the new sign-in (found=%v)", ok)
	}
	if fileExists(t, credsPath) {
		t.Error("the credentials file survived the migration")
	}
	if got := linesWith(stderr, "moved into the system keychain"); len(got) != 1 || !strings.Contains(got[0], credsPath) {
		t.Errorf("want one stderr line saying the file was moved, got %q", got)
	}
}

// TestKeychain_RenewalMigratesAnExistingFile pins the migration on renewal: an expired file
// credential is renewed, the renewed credential lands in the keychain, and only then is the file
// removed.
func TestKeychain_RenewalMigratesAnExistingFile(t *testing.T) {
	fake, credsPath := newAuthFake(t)
	keychainAvailable(t)
	if err := saveCredentials(credsPath, types.ExchangeResponse{
		AccessToken: makeToken(t, time.Now().Add(-time.Hour)), RefreshToken: keychainRefreshCanary, UserEmail: "ada@x.com",
	}); err != nil {
		t.Fatal(err)
	}
	renewed := fake.renews(t)

	var got string
	var err error
	stdout, stderr := captureStreams(t, func() { got, err = getAuthTokenInternal(false) })
	if err != nil || got != renewed {
		t.Fatalf("renewal: got the renewed token = %v, err = %v", got == renewed, err)
	}
	cred, ok := keychainEntry(t, fake.srv.URL)
	if !ok || cred.AccessToken != renewed || cred.RefreshToken != keychainRefreshCanary || cred.UserEmail != "ada@x.com" {
		t.Errorf("the keychain does not hold the renewed credential (found=%v)", ok)
	}
	if fileExists(t, credsPath) {
		t.Error("the credentials file survived the migration")
	}
	if stdout != "" {
		t.Errorf("a renewal wrote on stdout: %q", stdout)
	}
	if len(linesWith(stderr, "moved into the system keychain")) != 1 {
		t.Errorf("stderr does not say the credential moved:\n%s", stderr)
	}
	if found := leaked([]string{renewed, keychainRefreshCanary}, stdout, stderr); len(found) > 0 {
		t.Errorf("the renewal printed %d secret(s)", len(found))
	}
}

// TestKeychain_AFileCredentialIsReadWithoutBeingMoved pins that reading is not migrating: a live
// file credential is used as it is, and stays where it is until a sign-in or a renewal writes.
func TestKeychain_AFileCredentialIsReadWithoutBeingMoved(t *testing.T) {
	fake, credsPath := newAuthFake(t)
	keychainAvailable(t)
	token := makeToken(t, time.Now().Add(time.Hour))
	if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: token, RefreshToken: "r"}); err != nil {
		t.Fatal(err)
	}

	got, err := getAuthTokenInternal(false)
	if err != nil || got != token {
		t.Fatalf("got the file's token = %v, err = %v", got == token, err)
	}
	if _, ok := keychainEntry(t, fake.srv.URL); ok {
		t.Error("a read moved the credential into the keychain")
	}
	if !fileExists(t, credsPath) {
		t.Error("a read removed the credentials file")
	}
}

// TestKeychain_TheFileIsKeptUntilTheKeychainEntryReadsBack is the safety of the migration: when the
// keychain accepts the write but does not hand the same entry back, or refuses the write, the
// credentials file is written and kept. The credential is never in neither place.
func TestKeychain_TheFileIsKeptUntilTheKeychainEntryReadsBack(t *testing.T) {
	for name, store := range map[string]*scriptedStore{
		"the entry does not read back": {entries: map[string]string{}, forget: true},
		"the write is refused":         {entries: map[string]string{}, setErr: errors.New("store is locked")},
	} {
		t.Run(name, func(t *testing.T) {
			fake, credsPath := newAuthFake(t)
			useCredentialStore(t, store)
			if err := saveCredentials(credsPath, types.ExchangeResponse{
				AccessToken: makeToken(t, time.Now().Add(-time.Hour)), RefreshToken: "r", UserEmail: "ada@x.com",
			}); err != nil {
				t.Fatal(err)
			}
			renewed := fake.renews(t)

			got, err := getAuthTokenInternal(false)
			if err != nil || got != renewed {
				t.Fatalf("renewal: got the renewed token = %v, err = %v", got == renewed, err)
			}
			data, err := os.ReadFile(credsPath)
			if err != nil {
				t.Fatalf("the credentials file was removed without a verified keychain entry: %v", err)
			}
			if !strings.Contains(string(data), renewed) {
				t.Error("the credentials file does not hold the renewed credential")
			}
			if len(store.entries) != 0 {
				t.Errorf("an unverified entry was left in the keychain: %d", len(store.entries))
			}
		})
	}
}

// TestKeychain_AMismatchedReadBackIsRemoved pins the other side of the read-back: an entry that
// comes back different from what was written is deleted rather than left to outrank the file.
func TestKeychain_AMismatchedReadBackIsRemoved(t *testing.T) {
	fake, credsPath := newAuthFake(t)
	fake.approves(t, "ada@x.com")
	store := &scriptedStore{entries: map[string]string{}}
	useCredentialStore(t, corruptingStore{store})

	if _, stderr, code := authRun(t, "login"); code != 0 {
		t.Fatalf("login exited %d\n%s", code, stderr)
	}
	if !fileExists(t, credsPath) {
		t.Error("the credential was not written to the file")
	}
	if len(store.entries) != 0 {
		t.Error("the entry that did not read back was left in the keychain")
	}
}

// corruptingStore keeps a different secret from the one it was given.
type corruptingStore struct{ *scriptedStore }

// Set stores a truncated copy of secret.
func (c corruptingStore) Set(account, secret string) error {
	return c.scriptedStore.Set(account, secret[:len(secret)/2])
}

// --- the supplied token ---

// TestKeychain_TheSuppliedTokenWinsAndIsNeverStored pins ALETHIA_TOKEN: it outranks a credential in
// the keychain and one in the file, it is returned as given, nothing is renewed, and neither store
// is written.
func TestKeychain_TheSuppliedTokenWinsAndIsNeverStored(t *testing.T) {
	const supplied = "alt_supplied-canary-9d41"
	fake, credsPath := newAuthFake(t)
	keychainAvailable(t)
	stored := makeToken(t, time.Now().Add(-time.Hour)) // expired, so a read of it would try to renew
	if _, err := storeCredential(storedCredential{ExchangeResponse: types.ExchangeResponse{
		AccessToken: stored, RefreshToken: "r", UserEmail: "ada@x.com",
	}}); err != nil {
		t.Fatal(err)
	}
	before, _ := keychainEntry(t, fake.srv.URL)
	t.Setenv(ServiceTokenEnv, supplied)

	got, err := getAuthTokenInternal(false)
	if err != nil || got != supplied {
		t.Fatalf("got the supplied token = %v, err = %v", got == supplied, err)
	}
	if refresh, _ := fake.counts(); refresh != 0 {
		t.Errorf("a supplied token caused %d renewal request(s)", refresh)
	}
	after, ok := keychainEntry(t, fake.srv.URL)
	if !ok || after.AccessToken != before.AccessToken {
		t.Error("the keychain entry changed while a supplied token was in use")
	}
	if fileExists(t, credsPath) {
		t.Error("a credentials file appeared while a supplied token was in use")
	}
	secret, err := credentialStore.Get(credentialAccount(fake.srv.URL))
	if err != nil || strings.Contains(secret, supplied) {
		t.Errorf("the supplied token reached the keychain (err=%v)", err)
	}
}

// TestKeychain_LoginRefusesWhileATokenIsSupplied pins the refusal: with ALETHIA_TOKEN set a sign-in
// would change nothing, so login exits 7 on stderr, starts no sign-in and stores nothing.
func TestKeychain_LoginRefusesWhileATokenIsSupplied(t *testing.T) {
	const supplied = "alt_supplied-canary-9d41"
	fake, credsPath := newAuthFake(t)
	keychainAvailable(t)
	fake.approves(t, "ada@x.com")
	t.Setenv(ServiceTokenEnv, supplied)

	stdout, stderr, code := authRun(t, "login", "--force", "--output", "json")
	if code != 7 {
		t.Errorf("exit code = %d, want 7", code)
	}
	if stdout != "" {
		t.Errorf("a refusal wrote on stdout: %q", stdout)
	}
	if !strings.Contains(stderr, `"code":"conflict"`) || !strings.Contains(stderr, ServiceTokenEnv) {
		t.Errorf("stderr does not carry the refusal: %s", stderr)
	}
	if _, ok := keychainEntry(t, fake.srv.URL); ok || fileExists(t, credsPath) {
		t.Error("a refused login stored a credential")
	}
	if found := leaked([]string{supplied}, stdout, stderr); len(found) > 0 {
		t.Error("the refusal printed the supplied token")
	}
}

// --- one control plane's credential is not another's ---

// TestKeychain_ACredentialIsUsedOnlyForTheControlPlaneThatIssuedIt pins the binding in both stores:
// after the CLI is pointed at another control plane, the credential the first one issued is not
// found, so it is not sent there.
func TestKeychain_ACredentialIsUsedOnlyForTheControlPlaneThatIssuedIt(t *testing.T) {
	for _, withKeychain := range []bool{true, false} {
		t.Run(fmt.Sprintf("keychain=%v", withKeychain), func(t *testing.T) {
			fake, _ := newAuthFake(t)
			if withKeychain {
				keychainAvailable(t)
			}
			fake.approves(t, "ada@x.com")
			if _, stderr, code := authRun(t, "login"); code != 0 {
				t.Fatalf("login exited %d\n%s", code, stderr)
			}
			if _, err := getAuthTokenInternal(false); err != nil {
				t.Fatalf("the credential is not usable for its own control plane: %v", err)
			}

			other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				t.Errorf("a request reached the other control plane: %s", r.URL.Path)
			}))
			t.Cleanup(other.Close)
			t.Setenv("ALETHIA_WEB_ORIGIN", other.URL)

			if _, err := getAuthTokenInternal(false); !errors.Is(err, errNotSignedIn) {
				t.Errorf("err = %v, want not signed in for the other control plane", err)
			}
		})
	}
}

// TestKeychain_TheSchemeIsPartOfTheBinding pins that the same host over another scheme is another
// control plane: the keychain files both under one account, so the recorded origin decides.
func TestKeychain_TheSchemeIsPartOfTheBinding(t *testing.T) {
	isolatedHome(t)
	keychainAvailable(t)
	t.Setenv(ServiceTokenEnv, "")
	t.Setenv("ALETHIA_WEB_ORIGIN", "https://console.example.test")
	if _, err := storeCredential(storedCredential{ExchangeResponse: types.ExchangeResponse{
		AccessToken: makeToken(t, time.Now().Add(time.Hour)),
	}}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := loadStoredCredential(); err != nil {
		t.Fatalf("the credential is not found for its own origin: %v", err)
	}

	t.Setenv("ALETHIA_WEB_ORIGIN", "http://console.example.test")
	if _, _, err := loadStoredCredential(); !errors.Is(err, errNotSignedIn) {
		t.Errorf("err = %v, want not signed in over the other scheme", err)
	}
}

// TestNormalizeOriginAndAccount pins the two reductions of a control-plane URL.
func TestNormalizeOriginAndAccount(t *testing.T) {
	for _, tc := range []struct{ in, origin, account string }{
		{"https://Console.Example.test/", "https://console.example.test", "console.example.test"},
		{"http://localhost:3000/some/path", "http://localhost:3000", "localhost:3000"},
		{" https://alethialabs.io ", "https://alethialabs.io", "alethialabs.io"},
		{"not a url", "not a url", "not a url"},
	} {
		if got := normalizeOrigin(tc.in); got != tc.origin {
			t.Errorf("normalizeOrigin(%q) = %q, want %q", tc.in, got, tc.origin)
		}
		if got := credentialAccount(tc.in); got != tc.account {
			t.Errorf("credentialAccount(%q) = %q, want %q", tc.in, got, tc.account)
		}
	}
}

// --- logout ---

// TestKeychain_LogoutRemovesBoth pins logout: a credential in the keychain and one in the file are
// both removed, the result says which, and a second run changes nothing and still succeeds.
func TestKeychain_LogoutRemovesBoth(t *testing.T) {
	fake, credsPath := newAuthFake(t)
	keychainAvailable(t)
	if _, err := storeCredential(storedCredential{ExchangeResponse: types.ExchangeResponse{
		AccessToken: makeToken(t, time.Now().Add(time.Hour)), UserEmail: "ada@x.com",
	}}); err != nil {
		t.Fatal(err)
	}
	// A file beside the keychain entry: what an older CLI on the same machine leaves.
	if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: "older", UserEmail: "ada@x.com"}); err != nil {
		t.Fatal(err)
	}

	stdout, stderr, code := authRun(t, "logout", "--output", "json")
	if code != 0 {
		t.Fatalf("logout exited %d\n%s", code, stderr)
	}
	if _, ok := keychainEntry(t, fake.srv.URL); ok {
		t.Error("the keychain entry survived logout")
	}
	if fileExists(t, credsPath) {
		t.Error("the credentials file survived logout")
	}

	type logoutResult struct {
		Kind   string     `json:"kind"`
		Action string     `json:"action"`
		Object logoutInfo `json:"object"`
	}
	var first logoutResult
	if err := json.Unmarshal([]byte(stdout), &first); err != nil {
		t.Fatalf("stdout is not one json document: %v\n%s", err, stdout)
	}
	if first.Kind != "session" || first.Action != "deleted" || !first.Object.Keychain || !first.Object.File {
		t.Errorf("result = %+v", first)
	}
	if first.Object.Origin != fake.srv.URL {
		t.Errorf("origin = %q", first.Object.Origin)
	}

	stdout, stderr, code = authRun(t, "logout", "--output", "json")
	if code != 0 {
		t.Fatalf("a second logout exited %d\n%s", code, stderr)
	}
	var second logoutResult
	if err := json.Unmarshal([]byte(stdout), &second); err != nil {
		t.Fatalf("stdout is not one json document: %v\n%s", err, stdout)
	}
	if second.Action != "unchanged" || second.Object.Keychain || second.Object.File {
		t.Errorf("a second logout reported %+v", second)
	}
}

// TestKeychain_LogoutSaysASuppliedTokenIsStillInForce pins the one thing logout cannot remove: it
// warns on stderr that ALETHIA_TOKEN is still set, and does not print it.
func TestKeychain_LogoutSaysASuppliedTokenIsStillInForce(t *testing.T) {
	const supplied = "alt_supplied-canary-9d41"
	newAuthFake(t)
	t.Setenv(ServiceTokenEnv, supplied)

	stdout, stderr, code := authRun(t, "logout")
	if code != 0 {
		t.Fatalf("logout exited %d\n%s", code, stderr)
	}
	if !strings.Contains(stderr, ServiceTokenEnv+" is still set") {
		t.Errorf("stderr does not warn about the supplied token:\n%s", stderr)
	}
	if found := leaked([]string{supplied}, stdout, stderr); len(found) > 0 {
		t.Error("logout printed the supplied token")
	}
}

// TestKeychain_LogoutFailsWhenTheKeychainEntryCannotBeDeleted pins that an entry which is there and
// cannot be removed is a failure on stderr, not a reported sign-out.
func TestKeychain_LogoutFailsWhenTheKeychainEntryCannotBeDeleted(t *testing.T) {
	fake, _ := newAuthFake(t)
	store := &scriptedStore{entries: map[string]string{credentialAccount(fake.srv.URL): "{}"}}
	useCredentialStore(t, undeletableStore{store})

	stdout, stderr, code := authRun(t, "logout")
	if code != 1 {
		t.Errorf("exit code = %d, want 1", code)
	}
	if stdout != "" {
		t.Errorf("a failed logout wrote on stdout: %q", stdout)
	}
	if !strings.Contains(stderr, "could not delete the credential from the system keychain") {
		t.Errorf("stderr does not say what failed:\n%s", stderr)
	}
}

// undeletableStore refuses every Delete.
type undeletableStore struct{ *scriptedStore }

// Delete fails.
func (undeletableStore) Delete(string) error { return errors.New("store is locked") }

// --- auth status and whoami ---

// TestAuthStatus_ReportsTheStoreAndNeverTheToken pins `auth status` for each place a credential can
// come from: the json names the user, the control plane, the source and the expiry, and the
// credential appears in neither stream, in neither format.
func TestAuthStatus_ReportsTheStoreAndNeverTheToken(t *testing.T) {
	const supplied = "alt_supplied-canary-9d41"
	for _, tc := range []struct {
		name, source string
		keychain     bool
		supplied     bool
	}{
		{name: "keychain", source: "keychain", keychain: true},
		{name: "file", source: "file"},
		{name: "environment", source: "env", keychain: true, supplied: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake, credsPath := newAuthFake(t)
			if tc.keychain {
				keychainAvailable(t)
			}
			expires := time.Now().Add(time.Hour).Truncate(time.Second)
			token := makeToken(t, expires)
			if _, err := storeCredential(storedCredential{ExchangeResponse: types.ExchangeResponse{
				AccessToken: token, RefreshToken: keychainRefreshCanary,
				ProviderToken: keychainProviderCanary, UserEmail: "ada@x.com",
			}}); err != nil {
				t.Fatal(err)
			}
			if tc.supplied {
				t.Setenv(ServiceTokenEnv, supplied)
			}
			secrets := []string{token, keychainRefreshCanary, keychainProviderCanary, supplied}

			stdout, stderr, code := authRun(t, "auth", "status", "--output", "json")
			if code != 0 {
				t.Fatalf("auth status exited %d\n%s", code, stderr)
			}
			var status struct {
				User      string     `json:"user"`
				Origin    string     `json:"origin"`
				Source    string     `json:"source"`
				StoredIn  string     `json:"stored_in"`
				Path      string     `json:"path"`
				ExpiresAt *time.Time `json:"expires_at"`
				Renews    bool       `json:"renews_automatically"`
			}
			if err := json.Unmarshal([]byte(stdout), &status); err != nil {
				t.Fatalf("stdout is not one json document: %v\n%s", err, stdout)
			}
			if status.Source != tc.source || status.Origin != fake.srv.URL || status.StoredIn == "" {
				t.Errorf("status = %+v", status)
			}
			if tc.supplied {
				if status.User != "" || status.ExpiresAt != nil || status.Renews {
					t.Errorf("a supplied token reported a stored sign-in's facts: %+v", status)
				}
			} else {
				if status.User != "ada@x.com" || !status.Renews {
					t.Errorf("status = %+v", status)
				}
				if status.ExpiresAt == nil || !status.ExpiresAt.Equal(expires) {
					t.Errorf("expires_at = %v, want %v", status.ExpiresAt, expires)
				}
			}
			if (tc.source == "file") != (status.Path == credsPath) {
				t.Errorf("path = %q for source %s", status.Path, tc.source)
			}
			if found := leaked(secrets, stdout, stderr); len(found) > 0 {
				t.Errorf("auth status --output json printed %d secret(s)", len(found))
			}

			table, stderr, code := authRun(t, "auth", "status")
			if code != 0 {
				t.Fatalf("auth status exited %d\n%s", code, stderr)
			}
			for _, want := range []string{"User", "Control plane", "Credential", "Expires", fake.srv.URL} {
				if !strings.Contains(table, want) {
					t.Errorf("the card is missing %q:\n%s", want, table)
				}
			}
			if found := leaked(secrets, table, stderr); len(found) > 0 {
				t.Errorf("auth status printed %d secret(s)", len(found))
			}
			if refresh, whoami := fake.counts(); refresh != 0 || whoami != 0 {
				t.Errorf("auth status made requests: %d refresh, %d whoami", refresh, whoami)
			}
		})
	}
}

// TestAuthStatus_WithNoCredentialExitsFourOnStderr pins the refusal: exit 4, the error envelope on
// stderr, nothing on stdout.
func TestAuthStatus_WithNoCredentialExitsFourOnStderr(t *testing.T) {
	newAuthFake(t)

	stdout, stderr, code := authRun(t, "auth", "status", "--output", "json")
	if code != 4 {
		t.Errorf("exit code = %d, want 4", code)
	}
	if stdout != "" {
		t.Errorf("a refusal wrote on stdout: %q", stdout)
	}
	if !strings.Contains(stderr, `"code":"auth_required"`) || !strings.Contains(stderr, "alethia login") {
		t.Errorf("stderr does not carry the refusal and the next step: %s", stderr)
	}
}

// TestWhoami_ReportsTheCredentialAndRefusesWithoutOne pins whoami: the json carries the identity
// and where the credential came from, never the credential; with no credential it exits 4 on stderr.
func TestWhoami_ReportsTheCredentialAndRefusesWithoutOne(t *testing.T) {
	fake, _ := newAuthFake(t)
	keychainAvailable(t)

	stdout, stderr, code := authRun(t, "whoami", "--output", "json")
	if code != 4 || stdout != "" || !strings.Contains(stderr, `"code":"auth_required"`) {
		t.Errorf("without a credential: code=%d stdout=%q stderr=%s", code, stdout, stderr)
	}

	token := fake.approves(t, "ada@x.com")
	if _, stderr, code := authRun(t, "login"); code != 0 {
		t.Fatalf("login exited %d\n%s", code, stderr)
	}
	stdout, stderr, code = authRun(t, "whoami", "--output", "json")
	if code != 0 {
		t.Fatalf("whoami exited %d\n%s", code, stderr)
	}
	var me struct {
		User struct {
			Email string `json:"email"`
		} `json:"user"`
		Credential struct {
			Source string `json:"source"`
			User   string `json:"user"`
		} `json:"credential"`
	}
	if err := json.Unmarshal([]byte(stdout), &me); err != nil {
		t.Fatalf("stdout is not one json document: %v\n%s", err, stdout)
	}
	if me.User.Email != "ada@x.com" || me.Credential.Source != "keychain" {
		t.Errorf("whoami = %+v", me)
	}
	if found := leaked([]string{token, keychainRefreshCanary, keychainProviderCanary}, stdout, stderr); len(found) > 0 {
		t.Errorf("whoami printed %d secret(s)", len(found))
	}

	table, _, code := authRun(t, "whoami")
	if code != 0 || !strings.Contains(table, "system keychain") || !strings.Contains(table, "Expires") {
		t.Errorf("the card does not say where the credential is (code=%d):\n%s", code, table)
	}
}

// --- renewal mid-command, and the request log ---

// TestKeychain_ARefusedStoredTokenIsRenewedOnceAndTheRequestResent pins the renewal the API client
// is handed for a stored credential: the control plane refuses the token of a request in flight,
// the credential is renewed once, the request is sent again and succeeds, and the store holds the
// renewed credential.
func TestKeychain_ARefusedStoredTokenIsRenewedOnceAndTheRequestResent(t *testing.T) {
	fake, _ := newAuthFake(t)
	keychainAvailable(t)
	// Live by its own clock, but not one the control plane accepts: a revoked or rotated token.
	refused := makeToken(t, time.Now().Add(time.Hour))
	if _, err := storeCredential(storedCredential{ExchangeResponse: types.ExchangeResponse{
		AccessToken: refused, RefreshToken: keychainRefreshCanary, UserEmail: "ada@x.com",
	}}); err != nil {
		t.Fatal(err)
	}
	renewed := fake.renews(t)

	stdout, stderr, code := authRun(t, "whoami", "--output", "json")
	if code != 0 {
		t.Fatalf("whoami exited %d\n%s", code, stderr)
	}
	if !strings.Contains(stdout, "ada@x.com") {
		t.Errorf("the resent request did not answer: %s", stdout)
	}
	if refresh, whoami := fake.counts(); refresh != 1 || whoami != 2 {
		t.Errorf("want one renewal and two whoami requests, got %d and %d", refresh, whoami)
	}
	if cred, ok := keychainEntry(t, fake.srv.URL); !ok || cred.AccessToken != renewed {
		t.Error("the keychain does not hold the renewed credential")
	}
	if found := leaked([]string{refused, renewed, keychainRefreshCanary}, stdout, stderr); len(found) > 0 {
		t.Errorf("the renewal printed %d secret(s)", len(found))
	}
}

// TestKeychain_ARefusedSuppliedTokenIsNotRenewed pins the other side: a token from the environment
// has nothing to renew it with, so a refusal is reported and no renewal is requested — even though
// the store holds a credential that could be renewed.
func TestKeychain_ARefusedSuppliedTokenIsNotRenewed(t *testing.T) {
	const supplied = "alt_supplied-canary-9d41"
	fake, _ := newAuthFake(t)
	keychainAvailable(t)
	if _, err := storeCredential(storedCredential{ExchangeResponse: types.ExchangeResponse{
		AccessToken: makeToken(t, time.Now().Add(time.Hour)), RefreshToken: keychainRefreshCanary,
	}}); err != nil {
		t.Fatal(err)
	}
	fake.renews(t)
	// Register a renewal the way an earlier command in the same process would have.
	if _, err := getAuthTokenInternal(false); err != nil {
		t.Fatal(err)
	}
	t.Setenv(ServiceTokenEnv, supplied)

	stdout, stderr, code := authRun(t, "whoami", "--output", "json")
	if code != 4 {
		t.Errorf("exit code = %d, want 4", code)
	}
	if stdout != "" {
		t.Errorf("a refusal wrote on stdout: %q", stdout)
	}
	if refresh, whoami := fake.counts(); refresh != 0 || whoami != 1 {
		t.Errorf("want no renewal and one whoami request, got %d and %d", refresh, whoami)
	}
	if found := leaked([]string{supplied, keychainRefreshCanary}, stdout, stderr); len(found) > 0 {
		t.Errorf("the refusal printed %d secret(s)", len(found))
	}
}

// TestKeychain_TheRequestLogIsOnStderrAndCarriesNoCredential pins the request log across a renewal,
// which is the run that handles the most secrets: the log is on stderr, stdout is still one json
// document, and neither stream carries the refused token, the renewed one or the refresh token.
func TestKeychain_TheRequestLogIsOnStderrAndCarriesNoCredential(t *testing.T) {
	fake, _ := newAuthFake(t)
	keychainAvailable(t)
	refused := makeToken(t, time.Now().Add(time.Hour))
	if _, err := storeCredential(storedCredential{ExchangeResponse: types.ExchangeResponse{
		AccessToken: refused, RefreshToken: keychainRefreshCanary,
		ProviderToken: keychainProviderCanary, UserEmail: "ada@x.com",
	}}); err != nil {
		t.Fatal(err)
	}
	renewed := fake.renews(t)
	t.Setenv(api.DebugEnv, "api")
	modeEnv(t, map[string]string{api.DebugEnv: "api"})

	stdout, stderr, code := authRun(t, "whoami", "--output", "json")
	if code != 0 {
		t.Fatalf("whoami exited %d\n%s", code, stderr)
	}
	if !json.Valid([]byte(stdout)) {
		t.Errorf("stdout is not one json document with the request log on:\n%s", stdout)
	}
	if strings.Contains(stdout, "debug:") {
		t.Errorf("the request log reached stdout:\n%s", stdout)
	}
	if len(linesWith(stderr, "debug: api > GET")) != 2 || !strings.Contains(stderr, "/api/cli/whoami") {
		t.Errorf("stderr does not carry the log of both attempts:\n%s", stderr)
	}
	if !strings.Contains(stderr, "Authorization: [redacted]") {
		t.Errorf("the log does not show the credential header withheld:\n%s", stderr)
	}
	if found := leaked([]string{refused, renewed, keychainRefreshCanary, keychainProviderCanary}, stdout, stderr); len(found) > 0 {
		t.Errorf("the run printed %d secret(s)", len(found))
	}
}

// --- a credential does not print ---

// TestStoredCredential_NeverFormatsItsTokens pins that a credential handed to a formatter — in an
// error, a log line, a test failure — prints as a placeholder under every verb.
func TestStoredCredential_NeverFormatsItsTokens(t *testing.T) {
	cred := storedCredential{ExchangeResponse: types.ExchangeResponse{
		AccessToken: "access-canary-aa11", RefreshToken: keychainRefreshCanary, ProviderToken: keychainProviderCanary,
	}}
	secrets := []string{"access-canary-aa11", keychainRefreshCanary, keychainProviderCanary}
	for _, text := range []string{
		fmt.Sprintf("%v", cred), fmt.Sprintf("%+v", cred), fmt.Sprintf("%#v", cred), cred.String(), fmt.Sprint(cred),
		fmt.Sprintf("%v", &cred), fmt.Sprintf("%+v", &cred),
		fmt.Errorf("could not store %v", cred).Error(),
		(&credentialSaveError{cause: errors.New("disk full")}).Error(),
	} {
		if found := leaked(secrets, text); len(found) > 0 {
			t.Errorf("a formatted credential carries %d secret(s): %q", len(found), text)
		}
	}
}

// TestKeychain_AStoreErrorIsNotShownWithTheSecret pins that a keychain failure during a sign-in
// reaches no stream, whatever the store put in its error.
func TestKeychain_AStoreErrorIsNotShownWithTheSecret(t *testing.T) {
	fake, _ := newAuthFake(t)
	token := fake.approves(t, "ada@x.com")
	useCredentialStore(t, echoingStore{})

	stdout, stderr, code := authRun(t, "login", "--debug")
	if code != 0 {
		t.Fatalf("login exited %d\n%s", code, stderr)
	}
	if found := leaked([]string{token, keychainRefreshCanary, keychainProviderCanary}, stdout, stderr); len(found) > 0 {
		t.Errorf("a store error carried %d secret(s) to the terminal", len(found))
	}
}

// echoingStore fails every write with an error that quotes the secret it was given.
type echoingStore struct{}

// Get finds nothing.
func (echoingStore) Get(string) (string, error) { return "", credstore.ErrNotFound }

// Set fails, quoting the secret.
func (echoingStore) Set(_, secret string) error { return fmt.Errorf("cannot store %s", secret) }

// Delete finds nothing.
func (echoingStore) Delete(string) error { return credstore.ErrNotFound }

// --- the smaller promises of login ---

// TestLogin_NoBrowserLeavesTheBrowserClosed pins --no-browser: the URL is still printed on stderr
// and the browser is not opened.
func TestLogin_NoBrowserLeavesTheBrowserClosed(t *testing.T) {
	fake, _ := newAuthFake(t)
	fake.approves(t, "ada@x.com")
	opened := 0
	openBrowser = func(string) error { opened++; return nil }

	stdout, stderr, code := authRun(t, "login", "--no-browser")
	if code != 0 {
		t.Fatalf("login exited %d\n%s", code, stderr)
	}
	if opened != 0 {
		t.Errorf("--no-browser opened the browser %d time(s)", opened)
	}
	if !strings.Contains(stderr, fake.srv.URL+"/cli/login?device_code=") {
		t.Errorf("the sign-in URL is not on stderr:\n%s", stderr)
	}
	if strings.Contains(stdout, "device_code") || !strings.Contains(stdout, "Signed in as ada@x.com") {
		t.Errorf("stdout should carry the result and nothing else: %q", stdout)
	}
}

// TestLogin_AgentModeNeedsNoTerminalAndAnswersInJSON pins the agent contract: no prompt, no
// spinner, one plain progress line on stderr and the json result on stdout without asking for it.
func TestLogin_AgentModeNeedsNoTerminalAndAnswersInJSON(t *testing.T) {
	fake, _ := newAuthFake(t)
	fake.approves(t, "ada@x.com")
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error {
		t.Error("agent mode must never open a form")
		return nil
	}
	t.Cleanup(func() { runHuhForm = prev })

	stdout, stderr, code := authRun(t, "login", "--agent", "yes")
	if code != 0 {
		t.Fatalf("login exited %d\n%s", code, stderr)
	}
	if !strings.Contains(stdout, `"action":"created"`) && !strings.Contains(stdout, `"action": "created"`) {
		t.Errorf("stdout is not the json result: %q", stdout)
	}
	if !strings.Contains(stderr, "Waiting for the sign-in to be approved in the browser") {
		t.Errorf("stderr carries no progress line:\n%s", stderr)
	}

	// Signed in already: the session is kept, without a question.
	stdout, stderr, code = authRun(t, "login", "--agent", "yes")
	if code != 0 {
		t.Fatalf("a second login exited %d\n%s", code, stderr)
	}
	if !strings.Contains(stdout, `"action":"unchanged"`) && !strings.Contains(stdout, `"action": "unchanged"`) {
		t.Errorf("a second login did not report the session as kept: %q", stdout)
	}
}

// TestLogin_ARefusedSignInExitsFiveOnStderr pins a refusal's exit code and stream for login: the
// person said no in the browser, so nothing is stored, stdout is empty and the exit code is 5.
func TestLogin_ARefusedSignInExitsFiveOnStderr(t *testing.T) {
	credsPath := isolatedHome(t)
	t.Setenv(ServiceTokenEnv, "")
	authCovServer(t, func(w http.ResponseWriter, r *http.Request) {
		authCovJSON(w, http.StatusForbidden, map[string]string{"error": deviceAccessDenied})
	})
	prevBrowser := openBrowser
	openBrowser = func(string) error { return nil }
	t.Cleanup(func() { openBrowser = prevBrowser })

	stdout, stderr, code := authRun(t, "login", "--output", "json")
	if code != 5 {
		t.Errorf("exit code = %d, want 5", code)
	}
	if stdout != "" {
		t.Errorf("a refused sign-in wrote on stdout: %q", stdout)
	}
	if !strings.Contains(stderr, `"code":"forbidden"`) {
		t.Errorf("stderr does not carry the refusal: %s", stderr)
	}
	if fileExists(t, credsPath) {
		t.Error("a refused sign-in stored a credential")
	}
}

// TestLogin_TheRegistrationHintIsShownUntilTheFirstSignIn pins the newcomer's line: it is a notice
// on stderr and never a question, and after one successful sign-in it is not shown again.
func TestLogin_TheRegistrationHintIsShownUntilTheFirstSignIn(t *testing.T) {
	fake, _ := newAuthFake(t)
	fake.approves(t, "ada@x.com")
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error {
		t.Error("a first sign-in must not ask anything")
		return nil
	}
	t.Cleanup(func() { runHuhForm = prev })

	_, stderr, code := authRun(t, "login")
	if code != 0 {
		t.Fatalf("login exited %d\n%s", code, stderr)
	}
	if !strings.Contains(stderr, "/auth/signin") {
		t.Errorf("a first sign-in does not point at the registration page:\n%s", stderr)
	}

	_, stderr, code = authRun(t, "login", "--force")
	if code != 0 {
		t.Fatalf("login --force exited %d\n%s", code, stderr)
	}
	if strings.Contains(stderr, "/auth/signin") {
		t.Errorf("the registration line was shown again after a sign-in:\n%s", stderr)
	}

	path, err := getPreferencesPath()
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("the preference was not saved: %v", err)
	}
	if info.Mode().Perm() != credentialsFileMode {
		t.Errorf("preferences mode = %#o, want %#o", info.Mode().Perm(), credentialsFileMode)
	}
}

// TestEnsureConfigDir_OnlyRemovesAccess pins the tightening: group and world access is taken away
// from an existing directory, and a directory the owner made read-only is left read-only.
func TestEnsureConfigDir_OnlyRemovesAccess(t *testing.T) {
	loose := filepath.Join(t.TempDir(), "alethia")
	if err := os.MkdirAll(loose, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(loose, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := ensureConfigDir(loose); err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Stat(loose); info.Mode().Perm() != 0o700 {
		t.Errorf("a loose directory is now %#o, want 0700", info.Mode().Perm())
	}

	readOnly := filepath.Join(t.TempDir(), "alethia")
	if err := os.MkdirAll(readOnly, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(readOnly, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(readOnly, 0o700) })
	if err := ensureConfigDir(readOnly); err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Stat(readOnly); info.Mode().Perm() != 0o500 {
		t.Errorf("a read-only directory is now %#o, want 0500", info.Mode().Perm())
	}
}

// TestRenderAuthStatus_CSVAndASuppliedToken pins the two renderings the command tests do not reach:
// the csv rows, and the user line for a supplied token, which names no account.
func TestRenderAuthStatus_CSVAndASuppliedToken(t *testing.T) {
	var out strings.Builder
	status := credentialStatus{Origin: "https://alethialabs.io", Source: "env", StoredIn: "the ALETHIA_TOKEN environment variable (not stored)"}
	if err := renderAuthStatus(&out, ui.FormatCSV, status); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Field,Value", "Control plane,https://alethialabs.io", "alethia whoami", "not stated by the token"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("csv is missing %q:\n%s", want, out.String())
		}
	}
}

// TestKeychain_LogoutRemovesAnUnfinishedCredentialsFile pins that what an interrupted write left
// beside the credentials file goes with the credential.
func TestKeychain_LogoutRemovesAnUnfinishedCredentialsFile(t *testing.T) {
	_, credsPath := newAuthFake(t)
	leftover := filepath.Join(filepath.Dir(credsPath), ".credentials-123456")
	if err := os.WriteFile(leftover, []byte(`{"access_token":"left-behind"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	stdout, stderr, code := authRun(t, "logout", "--output", "json")
	if code != 0 {
		t.Fatalf("logout exited %d\n%s", code, stderr)
	}
	if fileExists(t, leftover) {
		t.Error("the unfinished credentials file survived logout")
	}
	if !strings.Contains(stdout, `"action":"deleted"`) && !strings.Contains(stdout, `"action": "deleted"`) {
		t.Errorf("logout did not report the removal: %s", stdout)
	}
}

// TestCredentialStatus_ExpiryText pins the three things the expiry line can say.
func TestCredentialStatus_ExpiryText(t *testing.T) {
	past := time.Now().Add(-time.Hour)
	future := time.Now().Add(time.Hour)
	for _, tc := range []struct {
		status credentialStatus
		want   string
	}{
		{credentialStatus{}, "not stated by the token"},
		{credentialStatus{ExpiresAt: &future, RenewsAutomatically: true}, "(renewed automatically)"},
		{credentialStatus{ExpiresAt: &past}, "(expired)"},
		{credentialStatus{ExpiresAt: &future}, "UTC"},
	} {
		if got := tc.status.expiryText(); !strings.Contains(got, tc.want) {
			t.Errorf("expiryText() = %q, want it to contain %q", got, tc.want)
		}
	}
}

// --- the arms a failure reaches ---

// authRunBrokenStdout runs the command tree with a stdout that rejects every write and returns the
// exit code.
func authRunBrokenStdout(t *testing.T, args ...string) (code int) {
	t.Helper()
	prevExit := exitFunc
	exitFunc = func(c int) { panic(authCovExit{c}) }
	t.Cleanup(func() {
		exitFunc = prevExit
		resetAllFlags()
		execRootArgs(nil)
	})
	resetAllFlags()
	_, restore := captureStderr(t)
	defer restore()
	covListWithBrokenStdout(t, func() {
		defer func() {
			r := recover()
			if r == nil {
				return
			}
			exit, ok := r.(authCovExit)
			if !ok {
				panic(r)
			}
			code = exit.code
		}()
		execRootArgs(args)
		_ = rootCmd.Execute()
	})
	return code
}

// TestAuthFamily_AResultThatCannotBeWrittenIsFatal pins that each command of the family reports a
// stdout it cannot write to, instead of exiting 0 having printed nothing.
func TestAuthFamily_AResultThatCannotBeWrittenIsFatal(t *testing.T) {
	fake, _ := newAuthFake(t)
	fake.approves(t, "ada@x.com")

	for _, args := range [][]string{
		{"login", "--output", "json"},
		{"auth", "status", "--output", "json"},
		{"logout", "--output", "json"},
	} {
		if code := authRunBrokenStdout(t, args...); code != 1 {
			t.Errorf("%s with an unwritable stdout exited %d, want 1", strings.Join(args, " "), code)
		}
	}
}

// TestAsAuthRequired_LeavesOtherErrorsAlone pins that only a missing credential is given the
// authentication class.
func TestAsAuthRequired_LeavesOtherErrorsAlone(t *testing.T) {
	other := errors.New("disk full")
	if got := asAuthRequired(other); got != other {
		t.Errorf("asAuthRequired changed an unrelated error: %v", got)
	}
	if got := asAuthRequired(fmt.Errorf("wrapped: %w", errNotSignedIn)); got == nil || !errors.Is(got, errNotSignedIn) {
		t.Errorf("asAuthRequired lost the missing-credential error: %v", got)
	}
}

// TestStoreCredential_KeychainWithoutAConfigDirectory pins that the keychain needs no configuration
// directory: with none resolvable, the credential is stored and there is no file to remove.
func TestStoreCredential_KeychainWithoutAConfigDirectory(t *testing.T) {
	keychainAvailable(t)
	t.Setenv("HOME", "")
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("ALETHIA_WEB_ORIGIN", "https://console.example.test")

	write, err := storeCredential(storedCredential{ExchangeResponse: types.ExchangeResponse{AccessToken: "a"}})
	if err != nil || write.Source != credentialFromKeychain || write.Migrated {
		t.Errorf("write = %+v, err = %v", write, err)
	}
}

// TestStoreCredential_ReportsAFileItCouldNotRemove pins the one way a verified keychain write still
// fails: the old credentials file is in the way and cannot be removed, and the error says the
// credential is safe in the keychain.
func TestStoreCredential_ReportsAFileItCouldNotRemove(t *testing.T) {
	credsPath := isolatedHome(t)
	keychainAvailable(t)
	t.Setenv("ALETHIA_WEB_ORIGIN", "https://console.example.test")
	// A non-empty directory where the file is expected: os.Remove refuses it.
	if err := os.MkdirAll(filepath.Join(credsPath, "child"), 0o700); err != nil {
		t.Fatal(err)
	}

	write, err := storeCredential(storedCredential{ExchangeResponse: types.ExchangeResponse{AccessToken: "a"}})
	if err == nil || !strings.Contains(err.Error(), "is in the system keychain") {
		t.Fatalf("err = %v, want it to say where the credential is", err)
	}
	if write.Source != credentialFromKeychain {
		t.Errorf("write = %+v", write)
	}
	if _, ok := keychainEntry(t, "https://console.example.test"); !ok {
		t.Error("the keychain does not hold the credential the error says it holds")
	}
}

// TestGetAuthToken_ACredentialWithNoRefreshTokenIsUsedAsItIs pins the stored credential that cannot
// be renewed: while it is live it is returned, and once it has expired the answer is to sign in.
func TestGetAuthToken_ACredentialWithNoRefreshTokenIsUsedAsItIs(t *testing.T) {
	_, credsPath := newAuthFake(t)
	live := makeToken(t, time.Now().Add(time.Hour))
	if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: live}); err != nil {
		t.Fatal(err)
	}
	if got, err := getAuthTokenInternal(false); err != nil || got != live {
		t.Errorf("a live credential was not returned: err = %v", err)
	}

	if err := saveCredentials(credsPath, types.ExchangeResponse{
		AccessToken: makeToken(t, time.Now().Add(-time.Hour)),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := getAuthTokenInternal(false); !errors.Is(err, errNotSignedIn) {
		t.Errorf("err = %v, want a request to sign in", err)
	}
}

// TestRenewStoredCredential_RefusesWhatItCannotRenew pins the three refusals of the renewal the API
// client is handed: a supplied token, no stored credential, and a stored one with no refresh token.
// None of them makes a request.
func TestRenewStoredCredential_RefusesWhatItCannotRenew(t *testing.T) {
	fake, credsPath := newAuthFake(t)
	fake.renews(t)

	if _, err := renewStoredCredential(); !errors.Is(err, errNotSignedIn) {
		t.Errorf("with nothing stored: err = %v", err)
	}

	if err := saveCredentials(credsPath, types.ExchangeResponse{
		AccessToken: makeToken(t, time.Now().Add(time.Hour)),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := renewStoredCredential(); !errors.Is(err, errCredentialUnusable) {
		t.Errorf("with no refresh token: err = %v", err)
	}

	t.Setenv(ServiceTokenEnv, "alt_supplied-canary-9d41")
	if _, err := renewStoredCredential(); err == nil || strings.Contains(err.Error(), "alt_supplied") {
		t.Errorf("with a supplied token: err = %v", err)
	}

	if refresh, _ := fake.counts(); refresh != 0 {
		t.Errorf("a refused renewal made %d request(s)", refresh)
	}
}

// TestTokenExpiry_ATokenThatDoesNotSay pins the two tokens with no expiry to read: one that is not
// a token of this shape at all, and one whose claims name none.
func TestTokenExpiry_ATokenThatDoesNotSay(t *testing.T) {
	if _, ok := tokenExpiry("alt_not-a-jwt"); ok {
		t.Error("an opaque token reported an expiry")
	}
	// An unsigned token whose claims name a subject and no expiry.
	part := func(v string) string { return base64.RawURLEncoding.EncodeToString([]byte(v)) }
	if _, ok := tokenExpiry(part(`{"alg":"none"}`) + "." + part(`{"sub":"u1"}`) + "."); ok {
		t.Error("a token with no exp claim reported an expiry")
	}
}

// TestRemoveCredentialTempFiles pins the sweep logout runs beside the credentials file.
func TestRemoveCredentialTempFiles(t *testing.T) {
	if removed, err := removeCredentialTempFiles(filepath.Join(t.TempDir(), "absent")); removed || err != nil {
		t.Errorf("a missing directory: removed=%v err=%v", removed, err)
	}

	notADir := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(notADir, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := removeCredentialTempFiles(notADir); err == nil {
		t.Error("a path that is not a directory reported success")
	}

	dir := t.TempDir()
	keep := filepath.Join(dir, "preferences.json")
	if err := os.WriteFile(keep, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".credentials-1"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if removed, err := removeCredentialTempFiles(dir); !removed || err != nil {
		t.Errorf("removed=%v err=%v", removed, err)
	}
	if !fileExists(t, keep) {
		t.Error("the sweep removed a file that is not an unfinished credentials file")
	}
}

// TestKeychain_LogoutFailsOnAnUnfinishedFileItCannotRemove pins that a leftover logout cannot delete
// is a failure on stderr rather than a reported sign-out.
func TestKeychain_LogoutFailsOnAnUnfinishedFileItCannotRemove(t *testing.T) {
	_, credsPath := newAuthFake(t)
	// A non-empty directory under the leftover's name: os.Remove refuses it.
	if err := os.MkdirAll(filepath.Join(filepath.Dir(credsPath), ".credentials-stuck", "child"), 0o700); err != nil {
		t.Fatal(err)
	}

	stdout, stderr, code := authRun(t, "logout")
	if code != 1 || stdout != "" {
		t.Errorf("code=%d stdout=%q", code, stdout)
	}
	if !strings.Contains(stderr, "could not delete an unfinished credentials file") {
		t.Errorf("stderr does not say what failed:\n%s", stderr)
	}
}

// TestLogin_FailuresThatStoreNothing pins login's remaining refusals, each with its exit code, an
// empty stdout and no stored credential: an approval that carries no credential, a control plane
// that is failing, a --token on the command line, and a credential that cannot be stored.
func TestLogin_FailuresThatStoreNothing(t *testing.T) {
	t.Run("an approval with no credential", func(t *testing.T) {
		_, credsPath := newAuthFake(t) // the fake's exchange answers with an empty response
		stdout, stderr, code := authRun(t, "login", "--output", "json")
		if code != 4 || stdout != "" || !strings.Contains(stderr, `"code":"auth_required"`) {
			t.Errorf("code=%d stdout=%q stderr=%s", code, stdout, stderr)
		}
		if fileExists(t, credsPath) {
			t.Error("an empty credential was stored")
		}
	})

	t.Run("a failing control plane", func(t *testing.T) {
		credsPath := isolatedHome(t)
		t.Setenv(ServiceTokenEnv, "")
		authCovServer(t, func(w http.ResponseWriter, r *http.Request) {
			authCovJSON(w, http.StatusBadGateway, map[string]string{"error": "upstream"})
		})
		prevBrowser := openBrowser
		openBrowser = func(string) error { return nil }
		t.Cleanup(func() { openBrowser = prevBrowser })

		stdout, stderr, code := authRun(t, "login", "--output", "json")
		if code != 11 || stdout != "" || !strings.Contains(stderr, `"code":"service_unavailable"`) {
			t.Errorf("code=%d stdout=%q stderr=%s", code, stdout, stderr)
		}
		if fileExists(t, credsPath) {
			t.Error("a failed sign-in stored a credential")
		}
	})

	t.Run("a token on the command line", func(t *testing.T) {
		fake, credsPath := newAuthFake(t)
		fake.approves(t, "ada@x.com")
		stdout, stderr, code := authRun(t, "login", "--token", "alt_flag-canary-77", "--output", "json")
		if code != 7 || stdout != "" || !strings.Contains(stderr, "--token is set") {
			t.Errorf("code=%d stdout=%q stderr=%s", code, stdout, stderr)
		}
		if strings.Contains(stderr, "alt_flag-canary-77") {
			t.Error("the refusal printed the token")
		}
		if fileExists(t, credsPath) {
			t.Error("a refused login stored a credential")
		}
	})

	t.Run("a credential that cannot be stored", func(t *testing.T) {
		fake, credsPath := newAuthFake(t)
		token := fake.approves(t, "ada@x.com")
		// No keychain, and a regular file where the configuration directory must be.
		dir := filepath.Dir(credsPath)
		if err := os.RemoveAll(dir); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(dir, []byte("not a directory"), 0o600); err != nil {
			t.Fatal(err)
		}

		stdout, stderr, code := authRun(t, "login")
		if code != 1 || stdout != "" {
			t.Errorf("code=%d stdout=%q stderr=%s", code, stdout, stderr)
		}
		if found := leaked([]string{token, keychainRefreshCanary, keychainProviderCanary}, stdout, stderr); len(found) > 0 {
			t.Errorf("the failure printed %d secret(s)", len(found))
		}
	})
}

// TestLogin_InterruptingTheSpinnerExits130 pins a sign-in the person stops with ctrl-c while the
// browser half is still pending: it is an interruption, not a success and not an unclassified
// failure, and nothing is stored.
func TestLogin_InterruptingTheSpinnerExits130(t *testing.T) {
	credsPath := isolatedHome(t)
	t.Setenv(ServiceTokenEnv, "")
	savePreferences(cliPreferences{HideLoginWarning: true})
	authCovServer(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/start") {
			authCovJSON(w, http.StatusOK, map[string]string{})
			return
		}
		authCovJSON(w, http.StatusNotFound, map[string]string{"error": "pending"})
	})
	// Bound the poll the abandoned wait leaves behind.
	prevInterval, prevTimeout := loginPollInterval, loginPollTimeout
	loginPollInterval, loginPollTimeout = 20*time.Millisecond, 200*time.Millisecond
	t.Cleanup(func() { loginPollInterval, loginPollTimeout = prevInterval, prevTimeout })
	authCovHeadless(t, tea.WithInput(strings.NewReader("\x03")))
	authCovTTY(t)

	stdout, stderr, code := authRun(t, "login")
	if code != 130 {
		t.Errorf("exit code = %d, want 130\n%s", code, stderr)
	}
	if stdout != "" {
		t.Errorf("an interrupted sign-in wrote on stdout: %q", stdout)
	}
	if fileExists(t, credsPath) {
		t.Error("an interrupted sign-in stored a credential")
	}
	// Let the abandoned poll run out before the fake control plane closes.
	time.Sleep(300 * time.Millisecond)
}

// TestAuthStatus_ATokenOnTheCommandLine pins the fourth source: --token is reported as the flag, as
// not stored, and is not printed.
func TestAuthStatus_ATokenOnTheCommandLine(t *testing.T) {
	newAuthFake(t)
	stdout, stderr, code := authRun(t, "auth", "status", "--token", "alt_flag-canary-77", "--output", "json")
	if code != 0 {
		t.Fatalf("auth status exited %d\n%s", code, stderr)
	}
	if !strings.Contains(stdout, `"source":"flag"`) && !strings.Contains(stdout, `"source": "flag"`) {
		t.Errorf("the source is not the flag: %s", stdout)
	}
	if strings.Contains(stdout+stderr, "alt_flag-canary-77") {
		t.Error("auth status printed the token")
	}
}

// TestDeviceUserAgent_NamesADevelopmentBuild pins what a build with no version calls itself on the
// consent screen.
func TestDeviceUserAgent_NamesADevelopmentBuild(t *testing.T) {
	prev := version.Version
	version.Version = ""
	t.Cleanup(func() { version.Version = prev })
	if got := deviceUserAgent(); !strings.HasPrefix(got, deviceClientName+"/dev (") {
		t.Errorf("deviceUserAgent() = %q", got)
	}
}
