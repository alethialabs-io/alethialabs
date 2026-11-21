// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

// The cluster family's contract with a script: which exit code each refusal owns, where a written
// credential went and with what mode, and that no stream ever carries the credential unasked.

// runCode runs the real cobra tree and returns stdout, stderr and the exit code the command asked
// for: 0 when it returned normally.
func (e *kcEnv) runCode(args ...string) (stdout, stderr string, code int) {
	e.t.Helper()
	resetAllFlags()
	// The fatal path's format is restored with the exit hook: a run under `-o json` records json,
	// and left behind it would turn a later test's human error into an envelope.
	prevExit, prevFormat := exitFunc, errorFormat
	exitFunc = func(c int) { panic(miscExit{c}) }
	defer func() { exitFunc, errorFormat = prevExit, prevFormat }()
	stdout, stderr = captureStreams(e.t, func() {
		defer func() {
			if r := recover(); r != nil {
				exit, ok := r.(miscExit)
				if !ok {
					panic(r)
				}
				code = exit.code
			}
		}()
		execRootArgs(args)
		if err := rootCmd.Execute(); err != nil {
			code = -1
		}
	})
	// The command's own status lines go to kubeStatusOut, which newKCEnv points at e.stderr.
	stderr += e.stderr.String()
	e.stderr.Reset()
	return stdout, stderr, code
}

// kcFileMode returns the permission bits of a file.
func kcFileMode(t *testing.T, path string) os.FileMode {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	return fi.Mode().Perm()
}

// TestClusterKubeconfig_OutWritesAPrivateFileAndSaysWhere pins --out: the file is 0600, stdout is
// empty, stderr names the path and the mode, and the credential appears on neither stream.
func TestClusterKubeconfig_OutWritesAPrivateFileAndSaysWhere(t *testing.T) {
	env := newKCEnv(t)
	out := filepath.Join(t.TempDir(), "sub", "web.kubeconfig")
	stdout, stderr, code := env.runCode("cluster", "kubeconfig", "web-production", "--no-input", "--static", "--out", out)
	if code != 0 {
		t.Fatalf("exit %d\n%s", code, stderr)
	}
	if stdout != "" {
		t.Errorf("stdout must be empty without --out -, got %q", stdout)
	}
	if runtime.GOOS != "windows" {
		if mode := kcFileMode(t, out); mode != 0o600 {
			t.Errorf("the kubeconfig was written with mode %o, want 600", mode)
		}
	}
	for _, want := range []string{out, "mode 0600", kcContext} {
		if !strings.Contains(stderr, want) {
			t.Errorf("stderr does not say %q: %q", want, stderr)
		}
	}
	if strings.Contains(stderr, kcCanary) {
		t.Error("the credential reached stderr")
	}
	if strings.Contains(stderr, "deprecated") {
		t.Errorf("--out earned a deprecation line: %q", stderr)
	}
	if _, raw := readKC(t, out); !strings.Contains(raw, kcCanary) {
		t.Error("the file does not carry the credential it was asked to write")
	}
}

// TestClusterKubeconfig_MergeTightensAnOpenFileAndSaysWhere: a kubeconfig that was readable by
// others is 0600 after the merge, and the summary names the file for the exec shape too.
func TestClusterKubeconfig_MergeTightensAnOpenFileAndSaysWhere(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("permission bits are not a Windows concept")
	}
	env := newKCEnv(t)
	if err := os.MkdirAll(filepath.Dir(env.kubeconfig), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(env.kubeconfig, []byte("apiVersion: v1\nkind: Config\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, code := env.runCode("cluster", "kubeconfig", "web-production", "--no-input")
	if code != 0 {
		t.Fatalf("exit %d\n%s", code, stderr)
	}
	if mode := kcFileMode(t, env.kubeconfig); mode != 0o600 {
		t.Errorf("the merged kubeconfig has mode %o, want 600", mode)
	}
	for _, want := range []string{env.kubeconfig, "mode 0600"} {
		if !strings.Contains(stderr, want) {
			t.Errorf("stderr does not say %q: %q", want, stderr)
		}
	}
	if stdout != "" || strings.Contains(stderr, kcCanary) {
		t.Errorf("stdout %q; the credential must not be on stderr", stdout)
	}
}

// TestClusterKubeconfig_OutputFileStillWorksAndSaysItIsDeprecated: the older spelling writes the
// same file and earns exactly one line naming the new flag.
func TestClusterKubeconfig_OutputFileStillWorksAndSaysItIsDeprecated(t *testing.T) {
	env := newKCEnv(t)
	out := filepath.Join(t.TempDir(), "web.kubeconfig")
	_, stderr, code := env.runCode("cluster", "kubeconfig", "web-production", "--no-input", "--static", "--output", out)
	if code != 0 {
		t.Fatalf("exit %d\n%s", code, stderr)
	}
	if _, raw := readKC(t, out); !strings.Contains(raw, kcCanary) {
		t.Error("--output FILE no longer writes the kubeconfig")
	}
	if got := strings.Count(stderr, "deprecated"); got != 1 || !strings.Contains(stderr, "--out FILE") {
		t.Errorf("want one deprecation line naming --out, got %d in %q", got, stderr)
	}
}

// TestClusterKubeconfig_OutAndOutputAreNotCombined: naming the file twice, or a file and a merge,
// is a usage error and nothing is requested.
func TestClusterKubeconfig_OutAndOutputAreNotCombined(t *testing.T) {
	for _, extra := range [][]string{
		{"--out", "a", "--output", "b"},
		{"--merge", "--out", "a"},
	} {
		env := newKCEnv(t)
		args := append([]string{"cluster", "kubeconfig", "web-production", "--no-input"}, extra...)
		if _, _, code := env.runCode(args...); code == 0 {
			t.Errorf("%v was accepted", extra)
		}
		if len(env.console.posts) != 0 {
			t.Errorf("%v reached the network", extra)
		}
	}
}

// TestClusterKubeconfig_RefusalsOwnTheirExitCodes: each control-plane refusal exits with the code
// of its class, on stderr, with stdout empty and no credential anywhere.
func TestClusterKubeconfig_RefusalsOwnTheirExitCodes(t *testing.T) {
	cases := []struct {
		status int
		args   []string
		want   int
	}{
		{http.StatusUnauthorized, nil, clierr.ExitAuth},
		{http.StatusPaymentRequired, nil, clierr.ExitLimited},
		{http.StatusForbidden, nil, clierr.ExitForbidden},
		{http.StatusForbidden, []string{"--admin"}, clierr.ExitForbidden},
		{http.StatusNotFound, nil, clierr.ExitNotFound},
		{http.StatusConflict, nil, clierr.ExitConflict},
		{http.StatusUnprocessableEntity, []string{"--static"}, clierr.ExitUsage},
		{http.StatusTooManyRequests, nil, clierr.ExitLimited},
		{http.StatusInternalServerError, nil, clierr.ExitUnavailable},
	}
	for _, tc := range cases {
		t.Run(fmt.Sprintf("%d%v", tc.status, tc.args), func(t *testing.T) {
			env := newKCEnv(t)
			env.console.postStatus, env.console.postMsg = tc.status, "refused"
			args := append([]string{"cluster", "kubeconfig", "web-production", "--no-input"}, tc.args...)
			stdout, stderr, code := env.runCode(args...)
			if code != tc.want {
				t.Errorf("exit = %d, want %d\n%s", code, tc.want, stderr)
			}
			if stdout != "" {
				t.Errorf("stdout is not empty on a refusal: %q", stdout)
			}
			if strings.TrimSpace(stderr) == "" {
				t.Error("the refusal said nothing")
			}
		})
	}
}

// TestClusterKubeconfig_AFailedOrUnclaimedMintIsClassified: the runner failing the mint is a failed
// operation, and a mint no runner picked up is an outage a retry can fix.
func TestClusterKubeconfig_AFailedOrUnclaimedMintIsClassified(t *testing.T) {
	t.Run("the runner failed it", func(t *testing.T) {
		env := newKCEnv(t)
		env.console.polls, env.console.reason = []string{"failed"}, "The runner could not reach the cluster's API endpoint."
		_, stderr, code := env.runCode("cluster", "kubeconfig", "web-production", "--no-input")
		if code != clierr.ExitOperationFailed {
			t.Errorf("exit = %d, want %d\n%s", code, clierr.ExitOperationFailed, stderr)
		}
	})
	t.Run("no runner took it", func(t *testing.T) {
		env := newKCEnv(t)
		env.console.polls = []string{"expired"}
		_, stderr, code := env.runCode("cluster", "kubeconfig", "web-production", "--no-input")
		if code != clierr.ExitUnavailable || !strings.Contains(stderr, "alethia runner list") {
			t.Errorf("exit = %d, want %d with the runner hint\n%s", code, clierr.ExitUnavailable, stderr)
		}
	})
}

// TestClusterKubeconfig_FlagRefusalsAreUsageErrors: a bad flag exits 8 before any request.
func TestClusterKubeconfig_FlagRefusalsAreUsageErrors(t *testing.T) {
	for _, extra := range [][]string{
		{"--ttl", "5m"},
		{"--merge=false"},
		{"--output", "json"},
	} {
		env := newKCEnv(t)
		args := append([]string{"cluster", "kubeconfig", "web-production", "--no-input"}, extra...)
		stdout, stderr, code := env.runCode(args...)
		if code != clierr.ExitUsage || stdout != "" {
			t.Errorf("%v: exit %d, stdout %q — want %d and nothing\n%s", extra, code, stdout, clierr.ExitUsage, stderr)
		}
		if len(env.console.posts) != 0 {
			t.Errorf("%v reached the network", extra)
		}
	}
}

// TestClusterToken_RefusalsOwnTheirExitCodes: the exec plugin fails on stderr under its own name,
// with the class of the failure, an empty stdout for kubectl, and never the credential.
func TestClusterToken_RefusalsOwnTheirExitCodes(t *testing.T) {
	t.Run("not a cluster id", func(t *testing.T) {
		env := newKCEnv(t)
		stdout, stderr, code := env.runCode("cluster", "token", "web", "--no-input")
		if code != clierr.ExitUsage || stdout != "" || !strings.Contains(stderr, "alethia cluster token: ") {
			t.Errorf("exit %d stdout %q stderr %q", code, stdout, stderr)
		}
	})
	t.Run("no id and no terminal", func(t *testing.T) {
		env := newKCEnv(t)
		stdout, stderr, code := env.runCode("cluster", "token", "--no-input")
		if code != clierr.ExitInputRequired || stdout != "" || !strings.Contains(stderr, "a cluster id is required") {
			t.Errorf("exit %d stdout %q stderr %q", code, stdout, stderr)
		}
	})
	t.Run("the mint is refused", func(t *testing.T) {
		env := newKCEnv(t)
		env.console.postStatus, env.console.postMsg = http.StatusForbidden, "Forbidden"
		stdout, stderr, code := env.runCode("cluster", "token", kcClusterID, "--no-input")
		if code != clierr.ExitForbidden || stdout != "" {
			t.Errorf("exit %d stdout %q stderr %q", code, stdout, stderr)
		}
		if strings.Contains(stderr, kcCanary) {
			t.Error("the credential reached stderr")
		}
	})
}

// TestClusterToken_DebugOutputNeverCarriesTheCredential: with request diagnostics switched on, the
// credential is still only in the document on stdout.
func TestClusterToken_DebugOutputNeverCarriesTheCredential(t *testing.T) {
	// --debug turns the API client's request log on (root.go hands it the Printer's stderr).
	env := newKCEnv(t)
	stdout, stderr, code := env.runCode("cluster", "token", kcClusterID, "--no-input", "--debug")
	if code != 0 {
		t.Fatalf("exit %d\n%s", code, stderr)
	}
	if !strings.Contains(stdout, kcCanary) {
		t.Fatal("the plugin did not print the credential it exists to print")
	}
	if !strings.Contains(stderr, "/kubeconfig") {
		t.Fatalf("no request log reached stderr, so this test would pass on silence: %q", stderr)
	}
	if strings.Contains(stderr, kcCanary) {
		t.Errorf("the credential reached stderr under --debug: %q", stderr)
	}

	env = newKCEnv(t)
	out := filepath.Join(t.TempDir(), "web.kubeconfig")
	stdout, stderr, code = env.runCode("cluster", "kubeconfig", "web-production", "--no-input", "--static", "--out", out, "--debug")
	if code != 0 {
		t.Fatalf("exit %d\n%s", code, stderr)
	}
	if strings.Contains(stdout, kcCanary) || strings.Contains(stderr, kcCanary) {
		t.Errorf("the credential left the file under --debug: stdout %q stderr %q", stdout, stderr)
	}
}

// TestCluster_SelectorRefusalsOwnTheirExitCodes: the three ways "which cluster" has no answer.
func TestCluster_SelectorRefusalsOwnTheirExitCodes(t *testing.T) {
	prod := api.ClusterSummary{ID: "c1", ProjectName: "web", ClusterName: "web-production", Environment: "production"}
	staging := api.ClusterSummary{ID: "c2", ProjectName: "web", ClusterName: "web-staging", Environment: "staging"}
	prev := noInputMode
	noInputMode = true
	t.Cleanup(func() { noInputMode = prev })

	_, err := resolveCluster(nil, "web")
	if e := clierr.From(err); e.Exit != clierr.ExitNotFound || e.Hint == "" {
		t.Errorf("no clusters at all: %+v", e)
	}
	_, err = resolveCluster([]api.ClusterSummary{prod}, "shop")
	if e := clierr.From(err); e.Exit != clierr.ExitNotFound || e.Hint != "alethia cluster list" {
		t.Errorf("no match: %+v", e)
	}
	_, err = resolveCluster([]api.ClusterSummary{prod, staging}, "web")
	if e := clierr.From(err); e.Exit != clierr.ExitInputRequired || !strings.Contains(e.Message, "web-staging") {
		t.Errorf("ambiguous: %+v", e)
	}
	_, err = resolveCluster([]api.ClusterSummary{prod, staging}, "")
	e := clierr.From(err)
	if e.Exit != clierr.ExitInputRequired || !strings.Contains(e.Message, "web-production") {
		t.Errorf("no selector and no terminal: %+v", e)
	}
	if !errors.Is(err, errNoInput) {
		t.Error("the gate's own reason is no longer reachable from the refusal")
	}
	c, err := resolveCluster([]api.ClusterSummary{prod, staging}, "web-staging")
	if err != nil || c.ID != "c2" {
		t.Errorf("an exact selector did not resolve: %v %v", c, err)
	}
}

// TestClusterListAndGet_JSONShapesAndRefusal runs the two reads through the real tree under json,
// and the refusal of a selector that names nothing.
func TestClusterListAndGet_JSONShapesAndRefusal(t *testing.T) {
	env := newKCEnv(t)
	stdout, stderr, code := env.runCode("cluster", "list", "-o", "json", "--no-input")
	if code != 0 {
		t.Fatalf("list: exit %d\n%s", code, stderr)
	}
	var list []map[string]json.RawMessage
	if err := json.Unmarshal([]byte(stdout), &list); err != nil || len(list) == 0 {
		t.Fatalf("cluster list -o json is not a non-empty array: %v\n%s", err, stdout)
	}
	for _, key := range []string{"id", "project_name", "status"} {
		if _, ok := list[0][key]; !ok {
			t.Errorf("a listed cluster has no %q key: %s", key, stdout)
		}
	}

	stdout, stderr, code = env.runCode("cluster", "get", "web-production", "-o", "json", "--no-input")
	if code != 0 {
		t.Fatalf("get: exit %d\n%s", code, stderr)
	}
	var one map[string]json.RawMessage
	if err := json.Unmarshal([]byte(stdout), &one); err != nil {
		t.Fatalf("cluster get -o json is not one object: %v\n%s", err, stdout)
	}
	if _, ok := one["id"]; !ok {
		t.Errorf("the cluster has no id key: %s", stdout)
	}

	stdout, stderr, code = env.runCode("cluster", "get", "no-such-cluster", "-o", "json", "--no-input")
	if code != clierr.ExitNotFound || stdout != "" {
		t.Errorf("exit %d stdout %q, want %d and nothing", code, stdout, clierr.ExitNotFound)
	}
	var envelope struct {
		Error struct {
			Code string `json:"code"`
			Hint string `json:"hint"`
		} `json:"error"`
	}
	// From the envelope's opening key: a spinner's frames can precede it on the same line when the
	// test binary's stderr is a terminal.
	start := strings.LastIndex(stderr, `{"error"`)
	if start < 0 {
		t.Fatalf("under -o json the error is not an envelope on stderr: %q", stderr)
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(stderr[start:])), &envelope); err != nil {
		t.Fatalf("the error envelope does not parse: %v\n%q", err, stderr)
	}
	if envelope.Error.Code != clierr.CodeNotFound || envelope.Error.Hint != "alethia cluster list" {
		t.Errorf("error envelope = %+v", envelope.Error)
	}
}

// TestKubeExecClouds_FollowsTheOfferedSet: the help names only offered clouds, and never one that
// issues certificates.
func TestKubeExecClouds_FollowsTheOfferedSet(t *testing.T) {
	names := kubeExecClouds()
	if len(names) == 0 {
		t.Fatal("no cloud is named — this test covered nothing")
	}
	offered := enabledCloudNames()
	for _, n := range names {
		found := false
		for _, o := range offered {
			found = found || o == n
		}
		if !found {
			t.Errorf("%q is named in the kubeconfig help and is not an offered cloud", n)
		}
	}
	long := strings.ToLower(clusterKubeconfigCmd.Long)
	if strings.Contains(long, "alibaba") {
		t.Error("the kubeconfig help names a cloud that is not offered")
	}
	if len(names) >= len(offered) {
		t.Errorf("every offered cloud is listed as issuing tokens (%v of %v); a certificate cloud is missing from the exception set", names, offered)
	}
}
