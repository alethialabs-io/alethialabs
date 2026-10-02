// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/kubecache"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
)

// kcExecCredential is the ExecCredential `cluster token` prints, decoded.
type kcExecCredential struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Status     struct {
		ExpirationTimestamp time.Time `json:"expirationTimestamp"`
		Token               string    `json:"token"`
	} `json:"status"`
}

// decodeExecCredential parses stdout as exactly one ExecCredential.
func decodeExecCredential(t *testing.T, stdout string) kcExecCredential {
	t.Helper()
	var ec kcExecCredential
	dec := json.NewDecoder(strings.NewReader(stdout))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&ec); err != nil {
		t.Fatalf("stdout is not one ExecCredential: %v\n%q", err, stdout)
	}
	if dec.More() {
		t.Fatalf("stdout carries more than the ExecCredential: %q", stdout)
	}
	if ec.APIVersion != "client.authentication.k8s.io/v1" || ec.Kind != "ExecCredential" {
		t.Errorf("credential header %+v", ec)
	}
	return ec
}

// runToken runs `alethia cluster token <args>` through the cobra tree, returning stdout, stderr and
// whether it took the fatal path.
func (e *kcEnv) runToken(args ...string) (stdout, stderr string, err error) {
	e.t.Helper()
	_, restore := captureStderr(e.t)
	stdout, err = e.run(append([]string{"cluster", "token"}, args...)...)
	return stdout, restore(), err
}

// TestClusterToken_MissThenHit: a cold cache mints once and prints the credential; the next call is
// served from the cache with no request at all.
func TestClusterToken_MissThenHit(t *testing.T) {
	env := newKCEnv(t)
	stdout, stderr, err := env.runToken(kcClusterID)
	if err != nil {
		t.Fatalf("run: %v\n%s", err, stderr)
	}
	ec := decodeExecCredential(t, stdout)
	if ec.Status.Token != kcCanary || ec.Status.ExpirationTimestamp.Before(time.Now().Add(50*time.Minute)) {
		t.Errorf("credential %+v", ec.Status)
	}
	if strings.Contains(stderr, kcCanary) {
		t.Error("the credential reached stderr")
	}
	if len(env.console.posts) != 1 {
		t.Fatalf("want one mint, got %d", len(env.console.posts))
	}
	req := env.console.posts[0]
	if req.Shape != types.KubeconfigMintShapeExec || req.Tier != types.KubeconfigMintTierReadonly || req.TTLSeconds != 3600 {
		t.Errorf("with no profile the mint is read-only exec 1h, got %+v", req)
	}
	fi, err := os.Stat(filepath.Join(env.cache().Dir(), kcClusterID+".readonly.json"))
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Errorf("cache entry: %v %v", fi, err)
	}

	stdout2, _, err := env.runToken(kcClusterID)
	if err != nil {
		t.Fatalf("second run: %v", err)
	}
	if decodeExecCredential(t, stdout2).Status.Token != kcCanary {
		t.Error("the cache hit served a different credential")
	}
	if len(env.console.posts) != 1 {
		t.Errorf("a cache hit made a request: %d posts", len(env.console.posts))
	}
}

// TestClusterToken_TheSixtySecondSkew: an entry with 61s left is served; one with 59s left, or
// already expired, is re-minted.
func TestClusterToken_TheSixtySecondSkew(t *testing.T) {
	for _, tc := range []struct {
		left   time.Duration
		remint bool
	}{
		{61 * time.Second, false},
		{59 * time.Second, true},
		{-time.Hour, true},
	} {
		env := newKCEnv(t)
		if err := env.cache().Put(kubecache.Entry{ClusterID: kcClusterID, Tier: types.KubeconfigMintTierReadonly, Token: "OLD-TOKEN", ExpiresAt: time.Now().Add(tc.left)}); err != nil {
			t.Fatal(err)
		}
		stdout, stderr, err := env.runToken(kcClusterID)
		if err != nil {
			t.Fatalf("%v: %v\n%s", tc.left, err, stderr)
		}
		got := decodeExecCredential(t, stdout).Status.Token
		if tc.remint && (got != kcCanary || len(env.console.posts) != 1) {
			t.Errorf("%v left: want a re-mint, got %q after %d posts", tc.left, got, len(env.console.posts))
		}
		if !tc.remint && (got != "OLD-TOKEN" || len(env.console.posts) != 0) {
			t.Errorf("%v left: want the cached token, got %q after %d posts", tc.left, got, len(env.console.posts))
		}
	}
}

// TestClusterToken_RemintsWithTheProfile: the tier, TTL and org chosen by `cluster kubeconfig` are
// what a later re-mint asks for, whatever the active org is now.
func TestClusterToken_RemintsWithTheProfile(t *testing.T) {
	env := newKCEnv(t)
	if err := env.cache().SetProfile(kubecache.Profile{ClusterID: kcClusterID, Tier: types.KubeconfigMintTierAdmin, TTLSeconds: 7200, OrgID: "o-cluster"}); err != nil {
		t.Fatal(err)
	}
	if _, stderr, err := env.runToken(kcClusterID); err != nil {
		t.Fatalf("run: %v\n%s", err, stderr)
	}
	req := env.console.posts[0]
	if req.Tier != types.KubeconfigMintTierAdmin || req.TTLSeconds != 7200 {
		t.Errorf("request %+v", req)
	}
	if env.console.orgs[0] != "o-cluster" {
		t.Errorf("the mint was scoped to %q, not the profile's org", env.console.orgs[0])
	}
	if e, _ := env.cache().Get(kcClusterID, types.KubeconfigMintTierAdmin); e == nil {
		t.Error("the admin entry was not cached")
	}

	// An explicit --org for this call wins over the profile.
	env2 := newKCEnv(t)
	_ = env2.cache().SetProfile(kubecache.Profile{ClusterID: kcClusterID, Tier: types.KubeconfigMintTierReadonly, TTLSeconds: 3600, OrgID: "o-cluster"})
	if _, stderr, err := env2.runToken(kcClusterID, "--org", "o-flag"); err != nil {
		t.Fatalf("run: %v\n%s", err, stderr)
	}
	if env2.console.orgs[0] != "o-flag" {
		t.Errorf("--org was overridden by the profile: %q", env2.console.orgs[0])
	}
}

// TestClusterToken_RefusesAnInsecureCacheFile: a credential file others can read is an error on
// stderr, never served and never silently replaced.
func TestClusterToken_RefusesAnInsecureCacheFile(t *testing.T) {
	env := newKCEnv(t)
	c := env.cache()
	if err := c.Put(kubecache.Entry{ClusterID: kcClusterID, Tier: types.KubeconfigMintTierReadonly, Token: kcCanary, ExpiresAt: time.Now().Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(c.Dir(), kcClusterID+".readonly.json"), 0o644); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, err := env.runToken(kcClusterID)
	if !errors.Is(err, errMiscExited) {
		t.Fatalf("want a fatal exit, got %v", err)
	}
	if stdout != "" || strings.Contains(stderr, kcCanary) {
		t.Errorf("an insecure entry leaked: stdout %q", stdout)
	}
	if !strings.Contains(stderr, "accessible by group or others") {
		t.Errorf("stderr %q", stderr)
	}
	if len(env.console.posts) != 0 {
		t.Error("an insecure cache must not be papered over with a fresh mint")
	}

	// The same holds for the profile.
	env2 := newKCEnv(t)
	c2 := env2.cache()
	_ = c2.SetProfile(kubecache.Profile{ClusterID: kcClusterID, Tier: types.KubeconfigMintTierReadonly, TTLSeconds: 3600})
	_ = os.Chmod(filepath.Join(c2.Dir(), kcClusterID+".profile.json"), 0o604)
	if _, _, err := env2.runToken(kcClusterID); !errors.Is(err, errMiscExited) {
		t.Errorf("an insecure profile: %v", err)
	}
}

// TestClusterToken_ConcurrentCallsShareOneMint: several kubectl processes on a cold cache produce
// one mint. Driven with goroutines on runClusterToken, because the lock is an OS file lock held per
// open file, which excludes within one process exactly as it does across processes.
func TestClusterToken_ConcurrentCallsShareOneMint(t *testing.T) {
	env := newKCEnv(t)
	env.console.readyDelay = 100 * time.Millisecond
	kubeMintSleep = func(time.Duration) {} // the env's recorder is not goroutine-safe

	const callers = 6
	var wg sync.WaitGroup
	outs := make([]bytes.Buffer, callers)
	errs := make([]error, callers)
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs[i] = runClusterToken([]string{kcClusterID}, &outs[i])
		}(i)
	}
	wg.Wait()
	for i := range outs {
		if errs[i] != nil {
			t.Fatalf("caller %d: %v", i, errs[i])
		}
		if decodeExecCredential(t, outs[i].String()).Status.Token != kcCanary {
			t.Errorf("caller %d got another credential", i)
		}
	}
	if n := env.console.kcPostCount(); n != 1 {
		t.Errorf("%d concurrent callers made %d mints, want 1", callers, n)
	}
}

// TestClusterToken_Refusals: every way the plugin fails goes to stderr with a non-zero exit, and
// stdout stays empty for kubectl.
func TestClusterToken_Refusals(t *testing.T) {
	cases := []struct {
		name  string
		args  []string
		setup func(e *kcEnv)
		want  string
	}{
		{"not a uuid", []string{"web-production"}, nil, "is not a cluster id"},
		{"no id under --no-input", []string{"--no-input"}, nil, "a cluster id is required"},
		{"signed out", []string{kcClusterID}, func(e *kcEnv) {
			path, _ := getCredentialsPath()
			_ = os.Remove(path)
		}, "alethia login"},
		{"mint refused", []string{kcClusterID}, func(e *kcEnv) { e.console.postStatus, e.console.postMsg = 403, "Forbidden" }, "your role cannot mint"},
		{"mint failed", []string{kcClusterID}, func(e *kcEnv) {
			e.console.polls, e.console.reason = []string{"failed"}, "The cluster was not found in the cloud account."
		}, "The cluster was not found in the cloud account."},
		{"cache dir unusable", []string{kcClusterID}, func(e *kcEnv) {
			dir, _ := kubecache.DefaultDir()
			_ = os.MkdirAll(filepath.Dir(dir), 0o700)
			_ = os.WriteFile(dir, nil, 0o600)
		}, "kubecache"},
		{"no config dir", []string{kcClusterID}, func(e *kcEnv) {
			t.Setenv("HOME", "")
			t.Setenv("XDG_CONFIG_HOME", "")
		}, "config dir"},
		{"lock unusable", []string{kcClusterID}, func(e *kcEnv) {
			c := e.cache()
			_ = os.Mkdir(filepath.Join(c.Dir(), kcClusterID+".lock"), 0o700)
		}, "open lock"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := newKCEnv(t)
			if tc.setup != nil {
				tc.setup(env)
			}
			stdout, stderr, err := env.runToken(tc.args...)
			if !errors.Is(err, errMiscExited) {
				t.Fatalf("want a fatal exit, got %v", err)
			}
			if stdout != "" {
				t.Errorf("stdout must stay empty on failure, got %q", stdout)
			}
			if !strings.HasPrefix(stderr, "alethia cluster token: ") || !strings.Contains(stderr, tc.want) {
				t.Errorf("stderr %q does not say %q", stderr, tc.want)
			}
		})
	}
}

// TestClusterToken_PickerAtATerminal: a person who omits the id at a terminal is asked; the
// picker's first cluster is minted.
func TestClusterToken_PickerAtATerminal(t *testing.T) {
	env := newKCEnv(t)
	prevIn, prevOut, prevForm := stdinIsTTY, interactiveOutIsTTY, runHuhForm
	stdinIsTTY = func() bool { return true }
	interactiveOutIsTTY = func() bool { return true }
	runHuhForm = func(...*huh.Group) error { return nil }
	t.Cleanup(func() { stdinIsTTY, interactiveOutIsTTY, runHuhForm = prevIn, prevOut, prevForm })

	stdout, stderr, err := env.runToken()
	if err != nil {
		t.Fatalf("run: %v\n%s", err, stderr)
	}
	if decodeExecCredential(t, stdout).Status.Token != kcCanary {
		t.Error("no credential")
	}

	// The picker's failure arms: a signed-out session, a failed listing, an empty org.
	for name, setup := range map[string]func(e *kcEnv){
		"signed out": func(e *kcEnv) {
			path, _ := getCredentialsPath()
			_ = os.Remove(path)
		},
		"list fails":  func(e *kcEnv) { t.Setenv("ALETHIA_WEB_ORIGIN", "http://127.0.0.1:1") },
		"no clusters": func(e *kcEnv) { e.console.clusters = []map[string]any{} },
	} {
		e := newKCEnv(t)
		setup(e)
		if _, _, err := e.runToken(); !errors.Is(err, errMiscExited) {
			t.Errorf("%s: want a fatal exit, got %v", name, err)
		}
	}
}

// TestClusterToken_ADirectoryInTheEntrysPlaceIsRefused: the read checks for a regular file.
func TestClusterToken_ADirectoryInTheEntrysPlaceIsRefused(t *testing.T) {
	env := newKCEnv(t)
	_ = os.MkdirAll(filepath.Join(env.cache().Dir(), kcClusterID+".readonly.json", "x"), 0o700)
	_, stderr, err := env.runToken(kcClusterID)
	if !errors.Is(err, errMiscExited) || !strings.Contains(stderr, "not a regular file") {
		t.Fatalf("want a refusal, got %v %q", err, stderr)
	}
}

// TestClusterToken_ACacheWriteFailureStillServes: the credential is good; only the shortcut is
// lost, and stderr says so without the credential. The cache directory is made read-only after the
// lock file exists, so the lock still opens but the entry's temp file cannot be created.
func TestClusterToken_ACacheWriteFailureStillServes(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root writes into a read-only directory")
	}
	env := newKCEnv(t)
	c := env.cache()
	unlock, err := c.Lock(t.Context(), kcClusterID) // creates the lock file
	if err != nil {
		t.Fatal(err)
	}
	unlock()
	if err := os.Chmod(c.Dir(), 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(c.Dir(), 0o700) })
	stdout, stderr, err := env.runToken(kcClusterID)
	if err != nil {
		t.Fatalf("a cache write failure must still serve: %v\n%s", err, stderr)
	}
	if decodeExecCredential(t, stdout).Status.Token != kcCanary {
		t.Error("no credential served")
	}
	if !strings.Contains(stderr, "could not cache the credential") || strings.Contains(stderr, kcCanary) {
		t.Errorf("stderr %q", stderr)
	}
}

// TestClusterToken_IsQuietForKubectl: the command opts out of the update notice, so nothing but the
// ExecCredential is ever written where kubectl reads.
func TestClusterToken_IsQuietForKubectl(t *testing.T) {
	if clusterTokenCmd.Annotations[skipUpdateNoticeAnnotation] != "true" {
		t.Error("cluster token must skip the update notice")
	}
}

// TestMintKubeCredential_RefusesAnInvalidRequestBeforeTheNetwork: the request is validated locally.
func TestMintKubeCredential_RefusesAnInvalidRequestBeforeTheNetwork(t *testing.T) {
	_, err := mintKubeCredential(nil, kubeMintSpec{ClusterID: kcClusterID, Tier: types.KubeconfigMintTierReadonly, Shape: types.KubeconfigMintShapeExec, TTLSeconds: 5})
	if !errors.Is(err, types.ErrKubeconfigMintInvalid) {
		t.Errorf("want ErrKubeconfigMintInvalid, got %v", err)
	}
	if kubeMintStatus(errors.New("plain")) != 0 {
		t.Error("a non-API error has no status")
	}
}

// TestClusterToken_NeverPromptsForALogin: even with a person at a terminal, an expired session is
// an error naming `alethia login` — the plugin never opens the "log in now?" prompt, because when
// kubectl runs it nobody can answer.
func TestClusterToken_NeverPromptsForALogin(t *testing.T) {
	env := newKCEnv(t)
	path, _ := getCredentialsPath()
	_ = os.Remove(path)
	prevIn, prevOut, prevPrompt := stdinIsTTY, interactiveOutIsTTY, authRequiredPrompt
	stdinIsTTY = func() bool { return true }
	interactiveOutIsTTY = func() bool { return true }
	asked := false
	authRequiredPrompt = func() (bool, error) { asked = true; return false, nil }
	t.Cleanup(func() { stdinIsTTY, interactiveOutIsTTY, authRequiredPrompt = prevIn, prevOut, prevPrompt })

	_, stderr, err := env.runToken(kcClusterID)
	if !errors.Is(err, errMiscExited) || !strings.Contains(stderr, "alethia login") {
		t.Fatalf("want a refusal naming `alethia login`, got %v %q", err, stderr)
	}
	if asked {
		t.Error("cluster token opened the login prompt")
	}
}
