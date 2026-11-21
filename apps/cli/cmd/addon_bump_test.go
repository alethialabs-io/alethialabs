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

// TestAddonBump (#6549): each answer is said with what to do next, a refusal always carries the
// manual instruction, and --again is passed through and nothing else sets it.
func TestAddonBump(t *testing.T) {
	for _, tc := range []struct {
		name   string
		reply  *api.GitopsBumpResult
		again  bool
		action ResultAction
		want   []string
	}{
		{"opened", func() *api.GitopsBumpResult { r := bumpResult("open"); r.Created = true; return r }(), false, ResultCreated,
			[]string{"Pull request opened: #42 https://github.com/acme/apps/pull/42", "spec.source.targetRevision", "addons/ingress-nginx.yaml", "4.15.1"}},
		{"already open", bumpResult("open"), false, ResultUnchanged, []string{"is already open: #42"}},
		{"merged", bumpResult("merged"), false, ResultUnchanged, []string{"was merged", "The next deploy reads 4.15.1"}},
		{"declined", bumpResult("declined"), false, ResultUnchanged, []string{"You closed pull request #42", "--again"}},
		{"refused", bumpResult("refused"), true, ResultUnchanged,
			[]string{"No pull request was opened.", "GitHub only", "set spec.source.targetRevision in addons/ingress-nginx.yaml to 4.15.1"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeBumper{reply: tc.reply}
			result, err := addonBump(f, "acme", "prod", "ingress-nginx", tc.again)
			if err != nil {
				t.Fatalf("addonBump: %v", err)
			}
			if result.Action != tc.action {
				t.Errorf("action = %q, want %q", result.Action, tc.action)
			}
			obj, ok := result.Object.(addonBumpObject)
			if !ok {
				t.Fatalf("object is %T", result.Object)
			}
			var out bytes.Buffer
			renderAddonBump(&out, obj.GitopsBumpResult)
			said := out.String() + addonBumpNote(obj.GitopsBumpResult)
			for _, w := range tc.want {
				if !strings.Contains(said, w) {
					t.Errorf("output is missing %q:\n%s", w, said)
				}
			}
			if f.got[3] != tc.again {
				t.Errorf("again = %v, want %v", f.got[3], tc.again)
			}
		})
	}

	if _, err := addonBump(&fakeBumper{}, "acme", "", "", false); err == nil {
		t.Error("an empty add-on id was sent")
	}
	if _, err := addonBump(&fakeBumper{err: errors.New("boom")}, "acme", "", "x", false); err == nil {
		t.Error("an API error was swallowed")
	}
}

// TestAddonBump_JSONCarriesThePullRequestAsFields is the spec's acceptance line for this command:
// `addon bump -o json` carries the pull request's url as a field, not only in prose.
func TestAddonBump_JSONCarriesThePullRequestAsFields(t *testing.T) {
	reply := bumpResult("open")
	reply.Created = true
	result, err := addonBump(&fakeBumper{reply: reply}, "acme", "prod", "ingress-nginx", false)
	if err != nil {
		t.Fatalf("addonBump: %v", err)
	}
	var out bytes.Buffer
	if err := testPrinter(&out, "json").Result(result, nil); err != nil {
		t.Fatalf("Result: %v", err)
	}
	var doc struct {
		ID     string `json:"id"`
		Kind   string `json:"kind"`
		Action string `json:"action"`
		Object struct {
			Project string `json:"project"`
			Env     string `json:"env"`
			Status  string `json:"status"`
			Number  int    `json:"number"`
			URL     string `json:"url"`
		} `json:"object"`
	}
	if err := json.Unmarshal(out.Bytes(), &doc); err != nil {
		t.Fatalf("not one json document: %v\n%s", err, out.String())
	}
	if doc.ID != "ingress-nginx" || doc.Kind != "addon" || doc.Action != "created" {
		t.Errorf("result = %+v", doc)
	}
	if doc.Object.URL != "https://github.com/acme/apps/pull/42" || doc.Object.Number != 42 || doc.Object.Status != "open" {
		t.Errorf("the pull request is not in the object: %+v", doc.Object)
	}
	if doc.Object.Project != "acme" || doc.Object.Env != "prod" {
		t.Errorf("the target is not in the object: %+v", doc.Object)
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
