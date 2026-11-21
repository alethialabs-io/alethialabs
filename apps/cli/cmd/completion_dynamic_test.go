// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/spf13/cobra"
)

// completionFake is a control plane for the completions: fixed lists, one shared error, and the two
// ways a request can misbehave — never answering, and panicking.
type completionFake struct {
	mu       sync.Mutex
	orgs     []api.OrgSummary
	runners  []api.Runner
	clusters []api.ClusterSummary
	configs  []types.ConfigurationSummary
	envs     map[string][]api.Environment
	err      error
	block    chan struct{}
	panics   bool
	calls    []string
}

// record notes one call and applies the misbehaviour the fake was set up with.
func (f *completionFake) record(call string) error {
	f.mu.Lock()
	f.calls = append(f.calls, call)
	f.mu.Unlock()
	if f.block != nil {
		<-f.block
	}
	if f.panics {
		panic("control plane exploded")
	}
	return f.err
}

// called returns the calls made so far.
func (f *completionFake) called() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string{}, f.calls...)
}

// ListOrgs returns the fake's organizations.
func (f *completionFake) ListOrgs() ([]api.OrgSummary, error) { return f.orgs, f.record("orgs") }

// GetRunners returns the fake's runners.
func (f *completionFake) GetRunners() ([]api.Runner, error) { return f.runners, f.record("runners") }

// GetClusters returns the fake's clusters.
func (f *completionFake) GetClusters() ([]api.ClusterSummary, error) {
	return f.clusters, f.record("clusters")
}

// GetConfigurations returns the fake's projects.
func (f *completionFake) GetConfigurations() ([]types.ConfigurationSummary, error) {
	return f.configs, f.record("configs")
}

// ListEnvironments returns the fake's environments of one project.
func (f *completionFake) ListEnvironments(project string) ([]api.Environment, error) {
	return f.envs[project], f.record("envs:" + project)
}

// newCompletionFake returns a fake holding two of everything.
func newCompletionFake() *completionFake {
	return &completionFake{
		orgs: []api.OrgSummary{
			{ID: "org-1", Name: "Acme", Slug: "acme", Role: "owner"},
			{ID: "org-2", Name: "Beta Corp", Role: "member"},
		},
		runners: []api.Runner{
			{ID: "run-1", Name: "edge", Status: "online", Operator: "self", Provisioning: "deployed"},
			{ID: "run-2", Name: "shared", Status: "offline", Operator: "managed"},
		},
		clusters: []api.ClusterSummary{
			{ID: "cl-1", ClusterName: "alpha-prod", ProjectName: "alpha", Environment: "prod", Status: "ACTIVE"},
			{ID: "cl-2", ProjectName: "beta", Status: "PENDING"},
		},
		configs: []types.ConfigurationSummary{
			{ID: "p-1", ProjectName: "alpha", CloudProvider: "aws", Region: "eu-west-1"},
			{ID: "p-1b", ProjectName: "alpha", CloudProvider: "aws", Region: "eu-west-1"},
			{ID: "p-2", ProjectName: "beta", CloudProvider: "gcp"},
		},
		envs: map[string][]api.Environment{
			"alpha": {
				{ID: "e-1", Name: "prod", Stage: "production", Status: "ACTIVE"},
				{ID: "e-2", Name: "staging", Stage: "staging"},
			},
		},
	}
}

// useCompletionControlPlane points the completions at fake, signed in or not, for one test.
func useCompletionControlPlane(t *testing.T, fake completionLister, signedIn bool) {
	t.Helper()
	prevClient, prevCred := completionClientFor, completionCredential
	completionClientFor = func(string) completionLister { return fake }
	completionCredential = func() (string, bool) { return "tok", signedIn }
	t.Cleanup(func() { completionClientFor, completionCredential = prevClient, prevCred })
}

// runComplete runs `alethia __complete args...` through the real tree and returns both streams.
func runComplete(t *testing.T, args ...string) (stdout, stderr string) {
	t.Helper()
	resetFlagsAroundTest(t)
	var out, errb bytes.Buffer
	rootCmd.SetOut(&out)
	rootCmd.SetErr(&errb)
	t.Cleanup(func() {
		rootCmd.SetOut(nil)
		rootCmd.SetErr(nil)
	})
	execRootArgs(append([]string{cobra.ShellCompRequestCmd}, args...))
	if err := rootCmd.Execute(); err != nil {
		t.Fatalf("__complete %v: %v", args, err)
	}
	return out.String(), errb.String()
}

// noFiles is the directive line every completion here ends with: no file-name fallback.
const noFiles = ":4\n"

// TestCompletion_NamesEachResource drives `alethia __complete` for each of the five resources and
// reads exactly what the shell would receive.
func TestCompletion_NamesEachResource(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"project argument, one line per project", []string{"project", "get", ""},
			"alpha\taws · eu-west-1\nbeta\tgcp\n"},
		{"project flag", []string{"project", "preview", "--project", ""},
			"alpha\taws · eu-west-1\nbeta\tgcp\n"},
		{"project flag filtered by what was typed", []string{"project", "preview", "--project", "b"},
			"beta\tgcp\n"},
		{"environments of the --project given", []string{"project", "preview", "--project", "alpha", "--env", ""},
			"prod\tproduction · ACTIVE\nstaging\tstaging\n"},
		{"environments of the project argument", []string{"export", "alpha", "--env", ""},
			"prod\tproduction · ACTIVE\nstaging\tstaging\n"},
		{"runner ids for the id argument", []string{"runner", "remove", ""},
			"run-1\tedge · online\nrun-2\tshared · offline\n"},
		{"runner names for --runner", []string{"runner", "remove", "--runner", ""},
			"edge\tonline · self·deployed\nshared\toffline · managed\n"},
		{"cluster selectors", []string{"cluster", "get", ""},
			"alpha-prod\talpha · prod · ACTIVE\ncl-2\tbeta · PENDING\n"},
		{"cluster selectors for kubeconfig", []string{"cluster", "kubeconfig", "al"},
			"alpha-prod\talpha · prod · ACTIVE\n"},
		{"cluster ids for token", []string{"cluster", "token", ""},
			"cl-1\talpha-prod · alpha · prod · ACTIVE\ncl-2\tbeta · PENDING\n"},
		{"org slugs for switch, the id when there is none", []string{"org", "switch", ""},
			"acme\tAcme · owner\norg-2\tBeta Corp · member\n"},
		{"org ids for --org on any command", []string{"version", "--org", ""},
			"org-1\tAcme · owner\norg-2\tBeta Corp · member\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			useCompletionControlPlane(t, newCompletionFake(), true)
			stdout, stderr := runComplete(t, tc.args...)
			if stdout != tc.want+noFiles {
				t.Errorf("stdout:\n%q\nwant:\n%q", stdout, tc.want+noFiles)
			}
			assertOnlyCobraOnStderr(t, stderr)
		})
	}
}

// assertOnlyCobraOnStderr fails when stderr carries anything but cobra's own directive note, which
// every completion script discards.
func assertOnlyCobraOnStderr(t *testing.T, stderr string) {
	t.Helper()
	var extra []string
	for _, line := range strings.Split(strings.TrimSpace(stderr), "\n") {
		if !strings.HasPrefix(line, "Completion ended with directive:") {
			extra = append(extra, line)
		}
	}
	if len(extra) > 0 {
		t.Errorf("stderr carries more than cobra's note: %q", extra)
	}
}

// TestCompletion_FailsSilent is the acceptance criterion: whatever goes wrong, stdout carries the
// directive and no candidate, and stderr nothing of ours.
func TestCompletion_FailsSilent(t *testing.T) {
	prevTimeout := completionTimeout
	completionTimeout = 50 * time.Millisecond
	t.Cleanup(func() { completionTimeout = prevTimeout })

	refused := newCompletionFake()
	refused.err = errors.New("500 from the control plane")
	exploding := newCompletionFake()
	exploding.panics = true
	hung := newCompletionFake()
	hung.block = make(chan struct{})
	t.Cleanup(func() { close(hung.block) })

	cases := []struct {
		name     string
		fake     *completionFake
		signedIn bool
	}{
		{"the API refuses", refused, true},
		{"the fetch panics", exploding, true},
		{"the API never answers", hung, true},
		{"nobody is signed in", newCompletionFake(), false},
	}
	for _, tc := range cases {
		for _, args := range [][]string{
			{"project", "get", ""},
			{"project", "preview", "--project", "alpha", "--env", ""},
			{"runner", "remove", ""},
			{"cluster", "get", ""},
			{"org", "switch", ""},
		} {
			t.Run(tc.name+"/"+strings.Join(args, " "), func(t *testing.T) {
				useCompletionControlPlane(t, tc.fake, tc.signedIn)
				start := time.Now()
				stdout, stderr := runComplete(t, args...)
				if stdout != noFiles {
					t.Errorf("stdout = %q, want only the directive %q", stdout, noFiles)
				}
				assertOnlyCobraOnStderr(t, stderr)
				if elapsed := time.Since(start); elapsed > 2*time.Second {
					t.Errorf("took %s, the deadline is %s", elapsed, completionTimeout)
				}
			})
		}
	}
}

// TestCompletion_OffersNothingItCannotKnow covers the inputs that must not reach the control plane:
// an --env with no project to list, a second positional argument, and a --project that names a GCP
// project rather than an Alethia one.
func TestCompletion_OffersNothingItCannotKnow(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"--env with no project", []string{"project", "preview", "--env", ""}, noFiles},
		{"a second argument", []string{"project", "get", "alpha", ""}, noFiles},
		// No completion is registered for it, so cobra answers with its default directive.
		{"connector gcp --project", []string{"connector", "gcp", "--project", ""}, ":0\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fake := newCompletionFake()
			useCompletionControlPlane(t, fake, true)
			stdout, _ := runComplete(t, tc.args...)
			if stdout != tc.want {
				t.Errorf("stdout = %q, want %q", stdout, tc.want)
			}
			if calls := fake.called(); len(calls) != 0 {
				t.Errorf("reached the control plane: %v", calls)
			}
		})
	}
}

// TestCompletion_SkipsTheUpgradeNotice pins that a completion never runs the upgrade check, whose
// output would land in the middle of a TAB press.
func TestCompletion_SkipsTheUpgradeNotice(t *testing.T) {
	useCompletionControlPlane(t, newCompletionFake(), true)
	prev := checkForUpdate
	reached := false
	checkForUpdate = func(string, string) { reached = true }
	t.Cleanup(func() { checkForUpdate = prev })
	runComplete(t, "org", "switch", "")
	if reached {
		t.Error("`__complete` ran the upgrade check")
	}
}

// TestCompletion_TablesNameRealCommands keeps the two hand-written tables honest: a path that no
// longer names a command would silently complete nothing.
func TestCompletion_TablesNameRealCommands(t *testing.T) {
	var stale []string
	check := func(path string, needProject bool) {
		found, _, err := rootCmd.Find(strings.Fields(path)[1:])
		if err != nil || found.CommandPath() != path {
			stale = append(stale, path)
			return
		}
		if needProject && found.Flags().Lookup("project") == nil {
			stale = append(stale, path+" (no --project)")
		}
	}
	for path := range positionalCompletions {
		check(path, false)
	}
	for path := range foreignProjectFlags {
		check(path, true)
	}
	for _, path := range []string{"alethia export", "alethia config export"} {
		check(path, false)
	}
	if len(stale) > 0 {
		t.Errorf("completion tables name commands that do not exist: %v", stale)
	}
}

// TestCompletion_KeepsACompletionAlreadyThere pins that the walk never replaces a completion a
// command or flag registered itself.
func TestCompletion_KeepsACompletionAlreadyThere(t *testing.T) {
	own := func(*cobra.Command, []string, string) ([]cobra.Completion, cobra.ShellCompDirective) {
		return []cobra.Completion{"mine"}, cobra.ShellCompDirectiveNoFileComp
	}
	root := &cobra.Command{Use: "alethia"}
	org := &cobra.Command{Use: "org"}
	sw := &cobra.Command{Use: "switch", ValidArgsFunction: own}
	project := &cobra.Command{Use: "project"}
	get := &cobra.Command{Use: "get", ValidArgs: []string{"static"}}
	get.Flags().String("runner", "", "")
	if err := get.RegisterFlagCompletionFunc("runner", own); err != nil {
		t.Fatal(err)
	}
	root.AddCommand(org, project)
	org.AddCommand(sw)
	project.AddCommand(get)

	attachDynamicCompletions(root)

	got, _ := sw.ValidArgsFunction(sw, nil, "")
	if len(got) != 1 || got[0] != "mine" {
		t.Errorf("org switch completion replaced: %v", got)
	}
	if get.ValidArgsFunction != nil {
		t.Error("a command with static ValidArgs was given a dynamic completion")
	}
	fn, ok := get.GetFlagCompletionFunc("runner")
	if !ok {
		t.Fatal("--runner lost its completion")
	}
	if got, _ := fn(get, nil, ""); len(got) != 1 || got[0] != "mine" {
		t.Errorf("--runner completion replaced: %v", got)
	}
}

// TestCompletion_ACommandThatGrowsAClusterFlagIsCompleted covers the --cluster arm, which no command
// in the tree defines yet: a flag added by that name is completed with cluster selectors.
func TestCompletion_ACommandThatGrowsAClusterFlagIsCompleted(t *testing.T) {
	useCompletionControlPlane(t, newCompletionFake(), true)
	root := &cobra.Command{Use: "alethia"}
	logs := &cobra.Command{Use: "logs"}
	logs.Flags().String("cluster", "", "")
	root.AddCommand(logs)
	attachDynamicCompletions(root)
	fn, ok := logs.GetFlagCompletionFunc("cluster")
	if !ok {
		t.Fatal("--cluster has no completion")
	}
	got, directive := fn(logs, nil, "")
	want := []cobra.Completion{"alpha-prod\talpha · prod · ACTIVE", "cl-2\tbeta · PENDING"}
	if strings.Join(got, "|") != strings.Join(want, "|") || directive != cobra.ShellCompDirectiveNoFileComp {
		t.Errorf("got %q (%d), want %q", got, directive, want)
	}
}

// TestCompletion_MarksOnlyTheCompletionCommandQuiet drives the annotation directly.
func TestCompletion_MarksOnlyTheCompletionCommandQuiet(t *testing.T) {
	root := &cobra.Command{Use: "alethia"}
	complete := &cobra.Command{Use: cobra.ShellCompRequestCmd}
	other := &cobra.Command{Use: "other"}
	root.AddCommand(complete, other)
	markCompletionCommandsQuiet(root)
	if complete.Annotations[skipUpdateNoticeAnnotation] != "true" {
		t.Error("__complete is not marked")
	}
	if other.Annotations != nil {
		t.Errorf("another command was marked: %v", other.Annotations)
	}
}

// TestCompletionCredential_UsesOnlyACredentialUsableAsItStands covers the credential a completion
// reads: a supplied token, a live stored sign-in, and the two it must not use — an expired one,
// which it does not renew, and none at all.
func TestCompletionCredential_UsesOnlyACredentialUsableAsItStands(t *testing.T) {
	const origin = "https://cp.example.test"
	stored := func(t *testing.T, token string) {
		t.Helper()
		body, err := json.Marshal(storedCredential{
			ExchangeResponse: types.ExchangeResponse{AccessToken: token, RefreshToken: "refresh"},
			Origin:           origin,
		})
		if err != nil {
			t.Fatal(err)
		}
		useCredentialStore(t, &scriptedStore{entries: map[string]string{credentialAccount(origin): string(body)}})
	}
	setup := func(t *testing.T) {
		t.Helper()
		isolatedHome(t)
		authCovOrigin(t, origin)
		t.Setenv(ServiceTokenEnv, "")
		prev := serviceTokenFlag
		serviceTokenFlag = ""
		t.Cleanup(func() { serviceTokenFlag = prev })
	}

	t.Run("a supplied token", func(t *testing.T) {
		setup(t)
		t.Setenv(ServiceTokenEnv, "svc-token")
		if tok, ok := completionCredential(); !ok || tok != "svc-token" {
			t.Errorf("got %q, %v", tok, ok)
		}
	})
	t.Run("a live stored sign-in", func(t *testing.T) {
		setup(t)
		live := makeToken(t, time.Now().Add(time.Hour))
		stored(t, live)
		if tok, ok := completionCredential(); !ok || tok != live {
			t.Errorf("got %q, %v", tok, ok)
		}
	})
	t.Run("an expired stored sign-in is not renewed", func(t *testing.T) {
		setup(t)
		stored(t, makeToken(t, time.Now().Add(-time.Hour)))
		if tok, ok := completionCredential(); ok {
			t.Errorf("used %q", tok)
		}
	})
	t.Run("not signed in", func(t *testing.T) {
		setup(t)
		useCredentialStore(t, &scriptedStore{entries: map[string]string{}})
		if tok, ok := completionCredential(); ok {
			t.Errorf("used %q", tok)
		}
	})
}
