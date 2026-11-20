// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// regToken is the token the fake control plane hands out. It is distinctive so a search for it
// in a stream cannot match anything else.
const regToken = "tok-abc123"

func TestRunRunnerRegister(t *testing.T) {
	t.Run("stdout is the two assignments and nothing else", func(t *testing.T) {
		p, out, errOut := splitPrinter(ui.FormatTable)
		f := &fakeClient{}
		if err := runRunnerRegister(f, p, "box-1", "ci-1"); err != nil {
			t.Fatalf("runRunnerRegister: %v", err)
		}
		if f.regRunnerName != "box-1" || f.regRunnerIdentity != "ci-1" {
			t.Errorf("args not forwarded: %q / %q", f.regRunnerName, f.regRunnerIdentity)
		}
		// Env-assignment form, and ONLY that: the output is redirected straight into an env file.
		want := "ALETHIA_RUNNER_ID=run1\nALETHIA_RUNNER_TOKEN=" + regToken + "\n"
		if out.String() != want {
			t.Errorf("stdout = %q, want %q", out.String(), want)
		}
		said := errOut.String()
		// The one-shot warning is load-bearing: only the hash is stored, so a discarded token is gone.
		for _, need := range []string{"shown once", "ALETHIA_WEB_ORIGIN=", "ALETHIA_RUNNER_OPERATOR=self", "alethia runner list"} {
			if !strings.Contains(said, need) {
				t.Errorf("stderr missing %q:\n%s", need, said)
			}
		}
		if strings.Contains(said, regToken) {
			t.Errorf("the token is repeated on stderr:\n%s", said)
		}
	})

	t.Run("json carries the id and the token as fields, the token once", func(t *testing.T) {
		p, out, errOut := splitPrinter(ui.FormatJSON)
		if err := runRunnerRegister(&fakeClient{}, p, "box-1", "ci-1"); err != nil {
			t.Fatalf("runRunnerRegister: %v", err)
		}
		var doc map[string]any
		if err := json.Unmarshal(out.Bytes(), &doc); err != nil {
			t.Fatalf("stdout is not one json document: %v\n%s", err, out.String())
		}
		if doc["id"] != "run1" || doc["token"] != regToken || doc["cloud_identity_id"] != "ci-1" {
			t.Errorf("document = %v", doc)
		}
		for _, key := range []string{"id", "name", "token", "web_origin"} {
			if _, ok := doc[key]; !ok {
				t.Errorf("document has no %q key: %v", key, doc)
			}
		}
		if n := strings.Count(out.String(), regToken); n != 1 {
			t.Errorf("the token appears %d times in the document, want 1:\n%s", n, out.String())
		}
		if errOut.Len() != 0 {
			t.Errorf("stderr is not empty under json:\n%s", errOut.String())
		}
	})

	t.Run("csv is one row", func(t *testing.T) {
		p, out, _ := splitPrinter(ui.FormatCSV)
		if err := runRunnerRegister(&fakeClient{}, p, "box-1", ""); err != nil {
			t.Fatalf("runRunnerRegister: %v", err)
		}
		lines := strings.Split(strings.TrimSpace(out.String()), "\n")
		if len(lines) != 2 || lines[0] != "id,name,token,web_origin" || !strings.Contains(lines[1], regToken) {
			t.Errorf("csv = %q", out.String())
		}
	})

	t.Run("an empty cloud identity is not sent", func(t *testing.T) {
		f := &fakeClient{}
		if err := runRunnerRegister(f, testPrinter(io.Discard, ui.FormatTable), "box-2", ""); err != nil {
			t.Fatalf("runRunnerRegister: %v", err)
		}
		if f.regRunnerIdentity != "" {
			t.Errorf("empty identity became %q", f.regRunnerIdentity)
		}
	})

	t.Run("requires a name", func(t *testing.T) {
		f := &fakeClient{}
		err := runRunnerRegister(f, testPrinter(io.Discard, ui.FormatTable), "", "")
		if err == nil {
			t.Fatal("a nameless runner must be refused locally")
		}
		if e := clierr.From(err); e.Class != clierr.ClassInputRequired || e.Hint == "" {
			t.Errorf("class = %s, hint = %q; want input_required with a hint", e.Class, e.Hint)
		}
		if f.regRunnerName != "" {
			t.Error("the client must not be called without a name")
		}
	})

	t.Run("surfaces a server error", func(t *testing.T) {
		p, out, _ := splitPrinter(ui.FormatTable)
		if err := runRunnerRegister(&fakeClient{err: errBoom}, p, "box-3", ""); err == nil {
			t.Fatal("expected the server error to surface")
		}
		if out.Len() != 0 {
			t.Errorf("a failed registration wrote to stdout: %q", out.String())
		}
	})

	// A nil registration with no error would otherwise panic on reg.Runner — the shape a stubbed or
	// half-implemented server can produce.
	t.Run("a nil registration is an error, not a panic", func(t *testing.T) {
		if err := runRunnerRegister(nilRegClient{}, testPrinter(io.Discard, ui.FormatTable), "box-4", ""); err == nil {
			t.Fatal("expected an error for a nil registration")
		}
	})

	t.Run("a dry run sends nothing and prints no token", func(t *testing.T) {
		p, out, _ := splitPrinter(ui.FormatJSON)
		if err := printRunnerRegisterDryRun(p, "box-5", "ci-1"); err != nil {
			t.Fatalf("printRunnerRegisterDryRun: %v", err)
		}
		var doc struct {
			Kind   string `json:"kind"`
			Action string `json:"action"`
			DryRun bool   `json:"dry_run"`
			Object struct {
				Name string `json:"name"`
			} `json:"object"`
		}
		if err := json.Unmarshal(out.Bytes(), &doc); err != nil {
			t.Fatalf("not json: %v\n%s", err, out.String())
		}
		if doc.Kind != "runner" || doc.Action != "created" || !doc.DryRun || doc.Object.Name != "box-5" {
			t.Errorf("document = %+v", doc)
		}
		if strings.Contains(out.String(), "token") {
			t.Errorf("a dry run names a token:\n%s", out.String())
		}
	})
}

// nilRegClient returns (nil, nil) from RegisterRunner and panics on anything else, so the test can
// only exercise the path it names.
type nilRegClient struct{ apiClient }

func (nilRegClient) RegisterRunner(string, string) (*api.RunnerRegistration, error) {
	return nil, nil
}

// regEnv stands up isolated credentials and a fake control plane that serves ONLY
// /api/cli/runners/register, then returns a runner over the real cobra tree. Self-contained rather
// than bolted onto covListEnv, whose handler treats an unmapped path as a test failure.
func regEnv(t *testing.T, status int, body map[string]any) func(args ...string) error {
	t.Helper()
	credsPath := isolatedHome(t)
	tok := makeToken(t, time.Now().Add(time.Hour))
	if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: tok, RefreshToken: "r"}); err != nil {
		t.Fatalf("saveCredentials: %v", err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/cli/runners/register" {
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "not found: " + r.URL.Path})
			return
		}
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")
	prevName, prevID := registerRunnerName, registerCloudIdentity
	t.Cleanup(func() { registerRunnerName, registerCloudIdentity = prevName, prevID })
	registerRunnerName, registerCloudIdentity = "", ""
	return func(args ...string) error {
		execRootArgs(args)
		return rootCmd.Execute()
	}
}

func regOKBody() map[string]any {
	return map[string]any{
		"runner": map[string]any{
			"id": "r1", "name": "box", "operator": "self", "provisioning": "registered",
			"supported_providers": nil, "status": "OFFLINE", "last_heartbeat": nil,
			"version": "", "is_default": false, "created_at": "2026-01-01T00:00:00.000Z",
		},
		"runner_token": "tok-xyz",
	}
}

// TestRunnerRegisterCmd drives the cobra closure — the arm the unit tests above cannot reach,
// because it resolves the auth token and builds a real client.
func TestRunnerRegisterCmd(t *testing.T) {
	t.Run("name as a positional argument", func(t *testing.T) {
		run := regEnv(t, http.StatusCreated, regOKBody())
		exited, code, err := connInvoke(t, run, "runner", "register", "box")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if exited {
			t.Fatalf("unexpected fatal exit (code %d)", code)
		}
	})

	t.Run("name via --name", func(t *testing.T) {
		run := regEnv(t, http.StatusCreated, regOKBody())
		exited, code, err := connInvoke(t, run, "runner", "register", "--name", "box", "--cloud-identity-id", "ci-1")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if exited {
			t.Fatalf("unexpected fatal exit (code %d)", code)
		}
	})

	t.Run("no name is fatal", func(t *testing.T) {
		run := regEnv(t, http.StatusCreated, regOKBody())
		exited, code, err := connInvoke(t, run, "runner", "register")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if !exited || code == 0 {
			t.Fatalf("a nameless register must exit fatally, got exited=%v code=%d", exited, code)
		}
	})

	t.Run("a server refusal is fatal", func(t *testing.T) {
		run := regEnv(t, http.StatusForbidden, map[string]any{"error": "nope"})
		exited, code, err := connInvoke(t, run, "runner", "register", "box")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if !exited || code == 0 {
			t.Fatalf("a refused register must exit fatally, got exited=%v code=%d", exited, code)
		}
	})

	t.Run("unauthenticated is fatal", func(t *testing.T) {
		isolatedHome(t) // no credentials
		t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")
		run := func(args ...string) error {
			execRootArgs(args)
			return rootCmd.Execute()
		}
		exited, code, err := connInvoke(t, run, "runner", "register", "box")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if !exited || code == 0 {
			t.Fatalf("expected a fatal exit, got exited=%v code=%d", exited, code)
		}
	})
}
