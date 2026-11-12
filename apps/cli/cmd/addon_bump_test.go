// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// fakeBumper records the one call `bump` makes and answers with a canned result.
type fakeBumper struct {
	got   []any
	reply *api.GitopsBumpResult
	err   error
}

func (f *fakeBumper) RequestGitopsBump(project, env, addonID string, again bool) (*api.GitopsBumpResult, error) {
	f.got = []any{project, env, addonID, again}
	return f.reply, f.err
}

func bumpResult(status string) *api.GitopsBumpResult {
	r := &api.GitopsBumpResult{
		Status: status, Version: "4.15.1", File: "addons/ingress-nginx.yaml", Field: "spec.source.targetRevision",
	}
	if status != "refused" {
		n := 42
		r.Number, r.URL = &n, ptr("https://github.com/acme/apps/pull/42")
	} else {
		r.Reason, r.Message = ptr("provider-not-supported"), ptr("Alethia opens these pull requests on GitHub only.")
	}
	return r
}

// TestRunAddonBump (#6549): each answer is said with what to do next, a refusal always carries the
// manual instruction, and --again is passed through and nothing else sets it.
func TestRunAddonBump(t *testing.T) {
	for _, tc := range []struct {
		name  string
		reply *api.GitopsBumpResult
		again bool
		want  []string
	}{
		{"opened", func() *api.GitopsBumpResult { r := bumpResult("open"); r.Created = true; return r }(), false,
			[]string{"Pull request opened: #42 https://github.com/acme/apps/pull/42", "spec.source.targetRevision", "addons/ingress-nginx.yaml", "4.15.1"}},
		{"already open", bumpResult("open"), false, []string{"is already open: #42"}},
		{"merged", bumpResult("merged"), false, []string{"was merged", "The next deploy reads 4.15.1"}},
		{"declined", bumpResult("declined"), false, []string{"You closed pull request #42", "--again"}},
		{"refused", bumpResult("refused"), true,
			[]string{"No pull request was opened.", "GitHub only", "set spec.source.targetRevision in addons/ingress-nginx.yaml to 4.15.1"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeBumper{reply: tc.reply}
			var out bytes.Buffer
			if err := runAddonBump(f, &out, "acme", "prod", "ingress-nginx", tc.again); err != nil {
				t.Fatalf("runAddonBump: %v", err)
			}
			for _, w := range tc.want {
				if !strings.Contains(out.String(), w) {
					t.Errorf("output is missing %q:\n%s", w, out.String())
				}
			}
			if f.got[3] != tc.again {
				t.Errorf("again = %v, want %v", f.got[3], tc.again)
			}
		})
	}

	if err := runAddonBump(&fakeBumper{}, &bytes.Buffer{}, "acme", "", "", false); err == nil {
		t.Error("an empty add-on id was sent")
	}
	if err := runAddonBump(&fakeBumper{err: errors.New("boom")}, &bytes.Buffer{}, "acme", "", "x", false); err == nil {
		t.Error("an API error was swallowed")
	}
}

// bumpEnv is a signed-in CLI pointed at a fake console that answers POST .../addons/bump with
// `reply` at `status`, recording the request it was sent.
func bumpEnv(t *testing.T, status int, reply any) (func(args ...string) error, *addonRec) {
	t.Helper()
	rec := &addonRec{}
	credsPath := isolatedHome(t)
	tok := makeToken(t, time.Now().Add(time.Hour))
	if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: tok, RefreshToken: "r"}); err != nil {
		t.Fatalf("saveCredentials: %v", err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/addons/bump") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		rec.method, rec.query = r.Method, r.URL.RawQuery
		_ = json.NewDecoder(r.Body).Decode(&rec.body)
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(reply)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")
	prev := addonBumpAgain
	t.Cleanup(func() { addonBumpAgain = prev })
	addonBumpAgain = false
	resetAddonPersistentFlags(t)
	return func(args ...string) error {
		execRootArgs(args)
		return rootCmd.Execute()
	}, rec
}

// TestAddonBumpCmd drives `alethia addon bump` end to end against a fake console: the request names
// the add-on and --again, a refusal is an answer (exit 0), and a server error is fatal.
func TestAddonBumpCmd(t *testing.T) {
	t.Run("POSTs the add-on and --again to the bump endpoint", func(t *testing.T) {
		run, rec := bumpEnv(t, http.StatusOK, bumpResult("open"))
		exited, code, err := connInvoke(t, run, "addon", "bump", "ingress-nginx", "--project", "shop", "--env", "prod", "--again")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if exited {
			t.Fatalf("unexpected fatal exit (code %d)", code)
		}
		if rec.method != "POST" || rec.body["addon_id"] != "ingress-nginx" || rec.body["again"] != true {
			t.Errorf("request = %s %+v", rec.method, rec.body)
		}
		if !strings.Contains(rec.query, "env=prod") {
			t.Errorf("the environment was not sent: %q", rec.query)
		}
	})

	t.Run("a refusal is an answer, not a failure", func(t *testing.T) {
		run, _ := bumpEnv(t, http.StatusOK, bumpResult("refused"))
		exited, code, err := connInvoke(t, run, "addon", "bump", "ingress-nginx", "--project", "shop")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if exited {
			t.Fatalf("a refusal exited %d", code)
		}
	})

	t.Run("a server error is fatal", func(t *testing.T) {
		run, _ := bumpEnv(t, http.StatusInternalServerError, map[string]string{"error": "Internal Server Error"})
		exited, code, err := connInvoke(t, run, "addon", "bump", "ingress-nginx", "--project", "shop")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if !exited || code == 0 {
			t.Fatalf("expected a fatal exit, got exited=%v code=%d", exited, code)
		}
	})

	t.Run("signed out is fatal before any request", func(t *testing.T) {
		isolatedHome(t)
		t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")
		resetAddonPersistentFlags(t)
		run := func(a ...string) error {
			execRootArgs(a)
			return rootCmd.Execute()
		}
		exited, code, err := connInvoke(t, run, "addon", "bump", "ingress-nginx", "--project", "shop")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if !exited || code == 0 {
			t.Fatalf("expected a fatal exit, got exited=%v code=%d", exited, code)
		}
	})
}
