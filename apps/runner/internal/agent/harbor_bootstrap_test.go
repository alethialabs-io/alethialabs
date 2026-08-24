// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// fakeHarbor records what the bootstrap asked for, so the ORDERING and the verify-first branch can
// be asserted. Those are the parts that can be wrong without anything failing: a bootstrap that
// mints unconditionally still produces a working pull on the first deploy and only reveals itself as
// an orphaned robot per run, months later.
type fakeHarbor struct {
	healthyAfter int // become healthy on the Nth probe
	probes       int //nolint:unused // read via Healthy
	projectErr   error
	projects     []string
	projectOpts  []harborProjectOptions
	credOK       bool
	credChecked  [][2]string
	robots       []string
	robotErr     error
}

func (f *fakeHarbor) Healthy(context.Context) bool {
	f.probes++
	return f.probes > f.healthyAfter
}

func (f *fakeHarbor) EnsureProject(_ context.Context, name string, opts harborProjectOptions) error {
	if f.projectErr != nil {
		return f.projectErr
	}
	f.projects = append(f.projects, name)
	f.projectOpts = append(f.projectOpts, opts)
	return nil
}

func (f *fakeHarbor) CredentialWorks(_ context.Context, user, secret string) bool {
	f.credChecked = append(f.credChecked, [2]string{user, secret})
	return f.credOK
}

func (f *fakeHarbor) CreateRobot(_ context.Context, project, name string) (string, string, error) {
	if f.robotErr != nil {
		return "", "", f.robotErr
	}
	f.robots = append(f.robots, name)
	return "robot$" + project + "+" + name, "minted-secret", nil
}

/** A writer that records the payload it was handed, without a cluster. */
type recordingWriter struct {
	calls []string
	err   error
}

func (w *recordingWriter) write(_ context.Context, ns, name, payload string) error {
	if w.err != nil {
		return w.err
	}
	w.calls = append(w.calls, ns+"/"+name+" "+payload)
	return nil
}

/** An auth reader returning a fixed stored credential (or none). */
func storedAuth(user, secret string) func(context.Context, string, string, string) (string, string, error) {
	return func(context.Context, string, string, string) (string, string, error) {
		return user, secret, nil
	}
}

func testOpts() harborBootstrapOpts {
	return harborBootstrapOpts{
		APIBase:           "http://registry-app-images.registries.svc.cluster.local",
		RegistryHost:      "registry-app-images.registries.svc.cluster.local",
		Project:           "app-images",
		RobotName:         "alethia-pull",
		SecretName:        "registry-app-images-pull",
		SecretNamespace:   "default",
		AdminPasswordFile: "/harbor-admin/password",
	}
}

// THE central case. Harbor shows a robot secret once and never stores it, so re-minting on every
// deploy is not idempotence — it orphans a robot per run and rotates the credential out from under
// any pod mid-pull.
func TestHarborBootstrapDoesNotMintWhenTheStoredCredentialStillWorks(t *testing.T) {
	h := &fakeHarbor{credOK: true}
	w := &recordingWriter{}

	if err := harborBootstrap(context.Background(), testOpts(), h, w.write, storedAuth("robot$app-images+old", "old-secret")); err != nil {
		t.Fatalf("harborBootstrap: %v", err)
	}
	if len(h.robots) != 0 {
		t.Errorf("minted %v with a working credential already stored — Harbor cannot re-read a robot secret, so this orphans one per deploy", h.robots)
	}
	if len(w.calls) != 0 {
		t.Errorf("rewrote the pull secret unnecessarily: %v", w.calls)
	}
	if got := h.credChecked; len(got) != 1 || got[0] != [2]string{"robot$app-images+old", "old-secret"} {
		t.Errorf("probed %v, want exactly the stored credential", got)
	}
}

func TestHarborBootstrapMintsWhenTheStoredCredentialIsRejected(t *testing.T) {
	h := &fakeHarbor{credOK: false}
	w := &recordingWriter{}

	if err := harborBootstrap(context.Background(), testOpts(), h, w.write, storedAuth("robot$old", "stale")); err != nil {
		t.Fatalf("harborBootstrap: %v", err)
	}
	if len(h.robots) != 1 {
		t.Fatalf("minted %d robots, want 1", len(h.robots))
	}
	if len(w.calls) != 1 || !strings.Contains(w.calls[0], "default/registry-app-images-pull") {
		t.Fatalf("wrote %v, want the pull secret", w.calls)
	}
}

func TestHarborBootstrapMintsOnAFreshClusterWithNoSecret(t *testing.T) {
	h := &fakeHarbor{}
	w := &recordingWriter{}

	// No Secret yet — the first run. This must NOT be treated as an error, or every fresh cluster
	// fails before it can mint anything.
	if err := harborBootstrap(context.Background(), testOpts(), h, w.write, storedAuth("", "")); err != nil {
		t.Fatalf("harborBootstrap on a fresh cluster: %v", err)
	}
	if len(h.robots) != 1 || len(w.calls) != 1 {
		t.Fatalf("robots=%v writes=%v, want one of each", h.robots, w.calls)
	}
	if len(h.credChecked) != 0 {
		t.Errorf("probed %v with nothing stored", h.credChecked)
	}
}

// A replacement must not reuse the name: Harbor rejects a duplicate, and the previous robot's secret
// is unrecoverable — so re-minting under the same name would fail forever once a credential broke.
func TestHarborBootstrapMintsAUniqueRobotNameEachTime(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 8; i++ {
		h := &fakeHarbor{}
		w := &recordingWriter{}
		if err := harborBootstrap(context.Background(), testOpts(), h, w.write, storedAuth("", "")); err != nil {
			t.Fatalf("harborBootstrap: %v", err)
		}
		name := h.robots[0]
		if !strings.HasPrefix(name, "alethia-pull-") {
			t.Fatalf("robot name %q lost its base", name)
		}
		if seen[name] {
			t.Fatalf("robot name %q reused — Harbor rejects a duplicate and the old secret cannot be read back", name)
		}
		seen[name] = true
	}
}

func TestHarborBootstrapEnsuresTheProjectBeforeMinting(t *testing.T) {
	h := &fakeHarbor{}
	w := &recordingWriter{}
	if err := harborBootstrap(context.Background(), testOpts(), h, w.write, storedAuth("", "")); err != nil {
		t.Fatalf("harborBootstrap: %v", err)
	}
	if len(h.projects) != 1 || h.projects[0] != "app-images" {
		t.Fatalf("ensured %v, want [app-images]", h.projects)
	}
}

func TestHarborBootstrapFailsClosedWhenHarborRefusesTheProject(t *testing.T) {
	h := &fakeHarbor{projectErr: errors.New("403 forbidden")}
	w := &recordingWriter{}
	err := harborBootstrap(context.Background(), testOpts(), h, w.write, storedAuth("", ""))
	if err == nil {
		t.Fatal("ensure-project failure was swallowed")
	}
	if len(h.robots) != 0 {
		t.Errorf("minted into a project that does not exist: %v", h.robots)
	}
}

// A robot Harbor did not really issue must never be written: a Secret containing an empty password
// is a pull failure that looks exactly like a wrong credential.
func TestHarborBootstrapRefusesAnEmptyRobotResponse(t *testing.T) {
	h := &emptyRobotHarbor{}
	w := &recordingWriter{}
	err := harborBootstrap(context.Background(), testOpts(), h, w.write, storedAuth("", ""))
	if err == nil {
		t.Fatal("an empty robot name/secret was accepted")
	}
	if len(w.calls) != 0 {
		t.Errorf("wrote an empty credential: %v", w.calls)
	}
}

type emptyRobotHarbor struct{ fakeHarbor }

func (e *emptyRobotHarbor) CreateRobot(context.Context, string, string) (string, string, error) {
	return "", "", nil
}

func TestHarborBootstrapWaitsForHarborBeforeAnythingElse(t *testing.T) {
	h := &fakeHarbor{healthyAfter: 0}
	w := &recordingWriter{}
	if err := harborBootstrap(context.Background(), testOpts(), h, w.write, storedAuth("", "")); err != nil {
		t.Fatalf("harborBootstrap: %v", err)
	}
	if h.probes == 0 {
		t.Error("never probed health — a mint against a booting Harbor fails in a way that looks like a config error")
	}
}

func TestHarborBootstrapRequiresEveryFlag(t *testing.T) {
	full := testOpts()
	if err := full.validate(); err != nil {
		t.Fatalf("a fully specified run was rejected: %v", err)
	}
	for _, drop := range []func(*harborBootstrapOpts){
		func(o *harborBootstrapOpts) { o.APIBase = "" },
		func(o *harborBootstrapOpts) { o.RegistryHost = "" },
		func(o *harborBootstrapOpts) { o.Project = "" },
		func(o *harborBootstrapOpts) { o.RobotName = "" },
		func(o *harborBootstrapOpts) { o.SecretName = "" },
		func(o *harborBootstrapOpts) { o.SecretNamespace = "" },
		func(o *harborBootstrapOpts) { o.AdminPasswordFile = "" },
	} {
		o := testOpts()
		drop(&o)
		if err := o.validate(); err == nil {
			t.Errorf("a run missing a required flag was accepted: %+v", o)
		}
	}
}

// ── the real client, against an httptest Harbor ────────────────────────────────────────────────

// The login and the secret MUST come from the response. Harbor prefixes and namespaces the account
// it issues, so a name rebuilt from the request is a login that does not exist — and the failure is
// a 401 at pull time, indistinguishable from a bad password.
func TestHarborAPICreateRobotReadsTheIssuedNameFromTheResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v2.0/robots" || r.Method != http.MethodPost {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		// Pull only, project-scoped, and bounded — asserted on the wire, not on our own struct.
		perms, _ := json.Marshal(body["permissions"])
		if !strings.Contains(string(perms), `"action":"pull"`) || strings.Contains(string(perms), `"action":"push"`) {
			t.Errorf("permissions = %s, want pull only", perms)
		}
		if body["level"] != "project" {
			t.Errorf("level = %v, want project", body["level"])
		}
		if d, ok := body["duration"].(float64); !ok || d <= 0 {
			t.Errorf("duration = %v, want a bounded positive number of days", body["duration"])
		}
		w.WriteHeader(http.StatusCreated)
		fmt.Fprint(w, `{"id":7,"name":"robot$app-images+alethia-pull-abc123","secret":"s3cr3t"}`)
	}))
	defer srv.Close()

	h := &harborAPI{base: srv.URL, admin: "pw", http: srv.Client()}
	login, secret, err := h.CreateRobot(context.Background(), "app-images", "alethia-pull")
	if err != nil {
		t.Fatalf("CreateRobot: %v", err)
	}
	if login != "robot$app-images+alethia-pull-abc123" {
		t.Errorf("login = %q — it must be Harbor's issued name, not one rebuilt from the request", login)
	}
	if secret != "s3cr3t" {
		t.Errorf("secret = %q", secret)
	}
}

func TestHarborAPIEnsureProjectToleratesAnExistingProject(t *testing.T) {
	// 201 (created) and 409 (already there) are both success — the Job runs on every deploy, so the
	// second run must not fail merely because the first one worked.
	for _, createCode := range []int{http.StatusCreated, http.StatusConflict} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.Method == http.MethodPost && r.URL.Path == "/api/v2.0/projects":
				w.WriteHeader(createCode)
			case r.Method == http.MethodPut:
				w.WriteHeader(http.StatusOK)
			case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/immutabletagrules"):
				fmt.Fprint(w, `[]`)
			default:
				w.WriteHeader(http.StatusOK)
			}
		}))
		h := &harborAPI{base: srv.URL, admin: "pw", http: srv.Client()}
		if err := h.EnsureProject(context.Background(), "app-images", harborProjectOptions{}); err != nil {
			t.Errorf("create status %d treated as failure: %v", createCode, err)
		}
		srv.Close()
	}
}

func TestHarborAPIEnsureProjectFailsOnAnythingElse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()
	h := &harborAPI{base: srv.URL, admin: "pw", http: srv.Client()}
	if err := h.EnsureProject(context.Background(), "app-images", harborProjectOptions{}); err == nil {
		t.Error("a 403 was treated as success")
	}
}

// A rule listing we cannot read is not "no rules": treating it as empty would create a duplicate
// rule on a project that already has one, on every single deploy.
func TestHarborAPIImmutableTagRuleFailsOnAnUnreadableListing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	h := &harborAPI{base: srv.URL, admin: "pw", http: srv.Client()}
	if err := h.ensureImmutableTagRule(context.Background(), "app-images", true); err == nil {
		t.Error("an unreadable rule listing was treated as an empty one")
	}
}

// A credential we cannot CONFIRM must be replaced, never trusted: trusting it yields a cluster that
// cannot pull and a Job that reports success.
func TestHarborAPICredentialWorksOnlyOnA200(t *testing.T) {
	for code, want := range map[int]bool{
		http.StatusOK: true, http.StatusUnauthorized: false,
		http.StatusInternalServerError: false, http.StatusNotFound: false,
	} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/v2/" {
				t.Errorf("probed %s, want /v2/", r.URL.Path)
			}
			if u, p, ok := r.BasicAuth(); !ok || u != "robot$x" || p != "s" {
				t.Errorf("probe sent %q/%q, ok=%v", u, p, ok)
			}
			w.WriteHeader(code)
		}))
		h := &harborAPI{base: srv.URL, admin: "pw", http: srv.Client()}
		if got := h.CredentialWorks(context.Background(), "robot$x", "s"); got != want {
			t.Errorf("status %d → %v, want %v", code, got, want)
		}
		srv.Close()
	}
}

func TestHarborAPIHealthyNeedsNoAuth(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v2.0/health" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	h := &harborAPI{base: srv.URL, admin: "pw", http: srv.Client()}
	if !h.Healthy(context.Background()) {
		t.Error("a 200 health response was not read as healthy")
	}
}

// The dockerconfigjson written must name the SAME host the kubelet pulls from. A mismatch is not an
// error anywhere — the entry is simply never matched, and the pull fails looking like a bad password.
func TestHarborBootstrapWritesTheCredentialUnderThePullHost(t *testing.T) {
	h := &fakeHarbor{}
	w := &recordingWriter{}
	o := testOpts()
	if err := harborBootstrap(context.Background(), o, h, w.write, storedAuth("", "")); err != nil {
		t.Fatalf("harborBootstrap: %v", err)
	}
	payload := strings.SplitN(w.calls[0], " ", 2)[1]
	var cfg struct {
		Auths map[string]struct {
			Username string `json:"username"`
			Password string `json:"password"`
			Auth     string `json:"auth"`
		} `json:"auths"`
	}
	if err := json.Unmarshal([]byte(payload), &cfg); err != nil {
		t.Fatalf("payload is not a dockerconfigjson: %v", err)
	}
	entry, ok := cfg.Auths[o.RegistryHost]
	if !ok {
		t.Fatalf("auths keys = %v, want the pull host %q", keysOf(cfg.Auths), o.RegistryHost)
	}
	if !strings.HasPrefix(entry.Username, "robot$") {
		t.Errorf("username = %q, want Harbor's issued robot login", entry.Username)
	}
	if entry.Auth != "" {
		decoded, err := base64.StdEncoding.DecodeString(entry.Auth)
		if err != nil {
			t.Fatalf("auth is not base64: %v", err)
		}
		if !strings.HasPrefix(string(decoded), entry.Username+":") {
			t.Errorf("auth %q does not match username %q", decoded, entry.Username)
		}
	}
}

func keysOf[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// ── flag parsing and the credential read-back ─────────────────────────────────────────────────

func TestRunHarborBootstrapRejectsAnIncompleteInvocation(t *testing.T) {
	err := RunHarborBootstrap(context.Background(), []string{"--project", "app-images"})
	if err == nil {
		t.Fatal("a run missing most flags was accepted")
	}
	if !strings.Contains(err.Error(), "missing required flag") {
		t.Errorf("error = %v, want a missing-flag report", err)
	}
}

// Falling through to Harbor's chart default is the failure this exists to prevent: an empty file
// means the seeding step did not run, and continuing would authenticate as Harbor12345.
func TestRunHarborBootstrapRefusesAnEmptyAdminPassword(t *testing.T) {
	dir := t.TempDir()
	pw := dir + "/password"
	if err := os.WriteFile(pw, []byte("   \n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	err := RunHarborBootstrap(context.Background(), []string{
		"--api-base", "http://harbor.invalid", "--registry-host", "harbor.invalid",
		"--project", "p", "--robot", "r", "--secret-name", "s",
		"--secret-namespace", "default", "--admin-password-file", pw,
	})
	if err == nil || !strings.Contains(err.Error(), "default credential") {
		t.Fatalf("error = %v, want a refusal to use a default credential", err)
	}
}

func TestRunHarborBootstrapReportsAnUnreadableAdminPassword(t *testing.T) {
	err := RunHarborBootstrap(context.Background(), []string{
		"--api-base", "http://harbor.invalid", "--registry-host", "harbor.invalid",
		"--project", "p", "--robot", "r", "--secret-name", "s",
		"--secret-namespace", "default", "--admin-password-file", "/nope/missing",
	})
	if err == nil || !strings.Contains(err.Error(), "read admin password") {
		t.Fatalf("error = %v, want a read failure", err)
	}
}

func TestWaitForHarborGivesUpRatherThanHanging(t *testing.T) {
	// A context already cancelled stands in for the bound elapsing, without a 15-minute test.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := waitForHarbor(ctx, &neverHealthy{}); err == nil {
		t.Error("waited forever on a Harbor that never answers")
	}
}

type neverHealthy struct{ fakeHarbor }

func (n *neverHealthy) Healthy(context.Context) bool { return false }

// A missing Secret is the FIRST RUN, not a failure — returning an error here would fail every fresh
// cluster before it could mint anything.
func TestReadPullSecretAuthTreatsAMissingSecretAsNoCredential(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(dir+"/kubectl", []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatalf("write stub: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	user, secret, err := readPullSecretAuth(context.Background(), "default", "missing", "host")
	if err != nil || user != "" || secret != "" {
		t.Fatalf("got (%q,%q,%v), want empty with no error", user, secret, err)
	}
}

func TestReadPullSecretAuthDecodesBothCredentialShapes(t *testing.T) {
	for name, payload := range map[string]string{
		"username+password": `{"auths":{"h":{"username":"robot$x","password":"s"}}}`,
		"base64 auth":       `{"auths":{"h":{"auth":"` + base64.StdEncoding.EncodeToString([]byte("robot$x:s")) + `"}}}`,
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			encoded := base64.StdEncoding.EncodeToString([]byte(payload))
			script := "#!/bin/sh\nprintf '%s' " + encoded + "\n"
			if err := os.WriteFile(dir+"/kubectl", []byte(script), 0o755); err != nil {
				t.Fatalf("write stub: %v", err)
			}
			t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

			user, secret, err := readPullSecretAuth(context.Background(), "default", "s", "h")
			if err != nil {
				t.Fatalf("readPullSecretAuth: %v", err)
			}
			if user != "robot$x" || secret != "s" {
				t.Errorf("got (%q,%q), want (robot$x, s)", user, secret)
			}
		})
	}
}

// A credential stored under a DIFFERENT host is not this registry's credential. Returning it would
// make the verify step probe the wrong thing and skip a mint that was needed.
func TestReadPullSecretAuthIgnoresAnotherHostsEntry(t *testing.T) {
	dir := t.TempDir()
	payload := base64.StdEncoding.EncodeToString([]byte(`{"auths":{"other":{"username":"u","password":"p"}}}`))
	if err := os.WriteFile(dir+"/kubectl", []byte("#!/bin/sh\nprintf '%s' "+payload+"\n"), 0o755); err != nil {
		t.Fatalf("write stub: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	user, secret, err := readPullSecretAuth(context.Background(), "default", "s", "h")
	if err != nil || user != "" || secret != "" {
		t.Fatalf("got (%q,%q,%v), want empty", user, secret, err)
	}
}

// ── the two canvas switches Harbor honours natively ───────────────────────────────────────────

func TestHarborBootstrapCarriesTheCanvasSwitches(t *testing.T) {
	for _, c := range []struct{ immutable, scanning bool }{
		{false, false}, {true, false}, {false, true}, {true, true},
	} {
		h := &fakeHarbor{}
		o := testOpts()
		o.ImmutableTags, o.VulnerabilityScanning = c.immutable, c.scanning
		if err := harborBootstrap(context.Background(), o, h, (&recordingWriter{}).write, storedAuth("", "")); err != nil {
			t.Fatalf("harborBootstrap: %v", err)
		}
		if len(h.projectOpts) != 1 {
			t.Fatalf("ensured %d projects, want 1", len(h.projectOpts))
		}
		got := h.projectOpts[0]
		if got.ImmutableTags != c.immutable || got.VulnerabilityScanning != c.scanning {
			t.Errorf("carried %+v, want immutable=%v scanning=%v", got, c.immutable, c.scanning)
		}
	}
}

// auto_scan must be re-asserted on an EXISTING project, or a switch toggled after the first deploy
// leaves the canvas and the registry permanently disagreeing — with the canvas showing the new value.
func TestHarborAPIEnsureProjectReassertsAutoScanOnAnExistingProject(t *testing.T) {
	var putBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v2.0/projects":
			w.WriteHeader(http.StatusConflict) // already exists
		case r.Method == http.MethodPut && r.URL.Path == "/api/v2.0/projects/app-images":
			b, _ := io.ReadAll(r.Body)
			putBody = string(b)
			w.WriteHeader(http.StatusOK)
		case r.URL.Path == "/api/v2.0/projects/app-images/immutabletagrules":
			fmt.Fprint(w, `[]`)
		default:
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer srv.Close()

	h := &harborAPI{base: srv.URL, admin: "pw", http: srv.Client()}
	if err := h.EnsureProject(context.Background(), "app-images", harborProjectOptions{VulnerabilityScanning: true}); err != nil {
		t.Fatalf("EnsureProject: %v", err)
	}
	if !strings.Contains(putBody, `"auto_scan":"true"`) {
		t.Errorf("PUT body = %q, want auto_scan re-asserted", putBody)
	}
}

// Turning the switch OFF must actually remove the rule. On is easy to test; off is the direction
// that silently does nothing, and a one-way switch is worse than no switch.
func TestHarborAPIImmutableTagRuleIsTwoWay(t *testing.T) {
	t.Run("off deletes the existing rule", func(t *testing.T) {
		deleted := []string{}
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/immutabletagrules"):
				fmt.Fprint(w, `[{"id":7,"disabled":false}]`)
			case r.Method == http.MethodDelete:
				deleted = append(deleted, r.URL.Path)
				w.WriteHeader(http.StatusOK)
			default:
				w.WriteHeader(http.StatusOK)
			}
		}))
		defer srv.Close()
		h := &harborAPI{base: srv.URL, admin: "pw", http: srv.Client()}
		if err := h.ensureImmutableTagRule(context.Background(), "app-images", false); err != nil {
			t.Fatalf("ensureImmutableTagRule: %v", err)
		}
		if len(deleted) != 1 || !strings.HasSuffix(deleted[0], "/immutabletagrules/7") {
			t.Errorf("deleted %v, want the existing rule", deleted)
		}
	})

	t.Run("on is idempotent — no duplicate rule per deploy", func(t *testing.T) {
		posts := 0
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.Method {
			case http.MethodGet:
				fmt.Fprint(w, `[{"id":7,"disabled":false}]`) // already has one
			case http.MethodPost:
				posts++
				w.WriteHeader(http.StatusCreated)
			default:
				w.WriteHeader(http.StatusOK)
			}
		}))
		defer srv.Close()
		h := &harborAPI{base: srv.URL, admin: "pw", http: srv.Client()}
		if err := h.ensureImmutableTagRule(context.Background(), "app-images", true); err != nil {
			t.Fatalf("ensureImmutableTagRule: %v", err)
		}
		if posts != 0 {
			t.Errorf("created %d rules on a project that already has one — every deploy would add another", posts)
		}
	})

	t.Run("on creates the rule when absent, over every repository and tag", func(t *testing.T) {
		var body string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.Method {
			case http.MethodGet:
				fmt.Fprint(w, `[]`)
			case http.MethodPost:
				b, _ := io.ReadAll(r.Body)
				body = string(b)
				w.WriteHeader(http.StatusCreated)
			default:
				w.WriteHeader(http.StatusOK)
			}
		}))
		defer srv.Close()
		h := &harborAPI{base: srv.URL, admin: "pw", http: srv.Client()}
		if err := h.ensureImmutableTagRule(context.Background(), "app-images", true); err != nil {
			t.Fatalf("ensureImmutableTagRule: %v", err)
		}
		// "Immutable tags", not "immutable some tags" — a narrower default is a setting nobody asked for.
		if !strings.Contains(body, `"pattern":"**"`) || !strings.Contains(body, `"disabled":false`) {
			t.Errorf("rule body = %q, want an enabled rule over ** / **", body)
		}
	})
}

// ── error branches, which are the ones that must FAIL CLOSED ──────────────────────────────────

// A Harbor we cannot reach is not a Harbor with no rules, no project and no robot. Every one of
// these must surface as a failed Job so the deploy warns, rather than a "success" that leaves the
// cluster unable to pull.
func TestHarborAPIFailsClosedWhenHarborIsUnreachable(t *testing.T) {
	// A closed server: every call is a transport error, not a status.
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	base := srv.URL
	srv.Close()

	h := &harborAPI{base: base, admin: "pw", http: &http.Client{}}
	ctx := context.Background()

	if h.Healthy(ctx) {
		t.Error("an unreachable Harbor reported healthy")
	}
	if err := h.EnsureProject(ctx, "app-images", harborProjectOptions{}); err == nil {
		t.Error("EnsureProject succeeded against an unreachable Harbor")
	}
	if err := h.ensureImmutableTagRule(ctx, "app-images", true); err == nil {
		t.Error("ensureImmutableTagRule succeeded against an unreachable Harbor")
	}
	if _, _, err := h.CreateRobot(ctx, "app-images", "r"); err == nil {
		t.Error("CreateRobot succeeded against an unreachable Harbor")
	}
	// A credential we cannot CONFIRM must read as not-working, so the caller replaces it.
	if h.CredentialWorks(ctx, "u", "p") {
		t.Error("an unreachable Harbor confirmed a credential")
	}
}

func TestHarborAPICreateRobotRejectsAnUnexpectedStatusOrBody(t *testing.T) {
	t.Run("non-201", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusForbidden)
		}))
		defer srv.Close()
		h := &harborAPI{base: srv.URL, admin: "pw", http: srv.Client()}
		if _, _, err := h.CreateRobot(context.Background(), "p", "r"); err == nil {
			t.Error("a 403 produced a robot")
		}
	})
	t.Run("undecodable body", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusCreated)
			fmt.Fprint(w, `not json`)
		}))
		defer srv.Close()
		h := &harborAPI{base: srv.URL, admin: "pw", http: srv.Client()}
		if _, _, err := h.CreateRobot(context.Background(), "p", "r"); err == nil {
			t.Error("an undecodable response produced a robot")
		}
	})
}

func TestHarborAPIImmutableTagRuleReportsACreateOrDeleteFailure(t *testing.T) {
	t.Run("create fails", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodGet {
				fmt.Fprint(w, `[]`)
				return
			}
			w.WriteHeader(http.StatusInternalServerError)
		}))
		defer srv.Close()
		h := &harborAPI{base: srv.URL, admin: "pw", http: srv.Client()}
		if err := h.ensureImmutableTagRule(context.Background(), "p", true); err == nil {
			t.Error("a failed create was reported as success")
		}
	})
	t.Run("delete fails", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodGet {
				fmt.Fprint(w, `[{"id":7}]`)
				return
			}
			w.WriteHeader(http.StatusInternalServerError)
		}))
		defer srv.Close()
		h := &harborAPI{base: srv.URL, admin: "pw", http: srv.Client()}
		if err := h.ensureImmutableTagRule(context.Background(), "p", false); err == nil {
			t.Error("a failed delete was reported as success — the switch would appear to turn off")
		}
	})
	t.Run("undecodable listing", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			fmt.Fprint(w, `not json`)
		}))
		defer srv.Close()
		h := &harborAPI{base: srv.URL, admin: "pw", http: srv.Client()}
		if err := h.ensureImmutableTagRule(context.Background(), "p", true); err == nil {
			t.Error("an undecodable listing was treated as empty")
		}
	})
}

func TestHarborAPIEnsureProjectReportsAFailedAutoScanUpdate(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			w.WriteHeader(http.StatusConflict)
			return
		}
		w.WriteHeader(http.StatusInternalServerError) // the PUT
	}))
	defer srv.Close()
	h := &harborAPI{base: srv.URL, admin: "pw", http: srv.Client()}
	if err := h.EnsureProject(context.Background(), "p", harborProjectOptions{VulnerabilityScanning: true}); err == nil {
		t.Error("a failed auto_scan update was reported as success")
	}
}

// A write failure must propagate: a green Job with no credential in the Secret is the worst outcome,
// because the deploy reports success and every pull fails.
func TestHarborBootstrapPropagatesAWriteFailure(t *testing.T) {
	w := &recordingWriter{err: errors.New("patch refused")}
	err := harborBootstrap(context.Background(), testOpts(), &fakeHarbor{}, w.write, storedAuth("", ""))
	if err == nil || !strings.Contains(err.Error(), "write pull secret") {
		t.Fatalf("error = %v, want a write failure", err)
	}
}

func TestHarborBootstrapPropagatesAMintFailure(t *testing.T) {
	h := &fakeHarbor{robotErr: errors.New("quota exceeded")}
	err := harborBootstrap(context.Background(), testOpts(), h, (&recordingWriter{}).write, storedAuth("", ""))
	if err == nil || !strings.Contains(err.Error(), "create robot") {
		t.Fatalf("error = %v, want a mint failure", err)
	}
}
