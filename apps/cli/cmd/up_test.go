// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/manifest"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/spec"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// `alethia up` is the golden path as one command, and the property under test throughout is that
// EVERY STEP IS SKIPPED WHEN ALREADY SATISFIED. A command that redid its work would not be
// resumable, and resumability is the whole reason it is one command rather than a runbook.

func upResetFlags() {
	upBinder.Reset()
	initBinder.Reset()
}

func upEnv(t *testing.T, s *projServer) projHarness {
	t.Helper()
	h := projEnv(t, s)
	applyResetFlags()
	upResetFlags()
	t.Cleanup(func() { applyResetFlags(); upResetFlags() })
	run := h.run
	h.run = func(args ...string) bool {
		applyResetFlags()
		upResetFlags()
		return run(args...)
	}
	return h
}

// chdirTo moves into a fresh directory, so `alethia.yaml` resolution is about THIS test's
// directory rather than whatever the package happens to be run from.
func chdirTo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Chdir(dir)
	return dir
}

func TestUp_WithEverythingInPlaceIsApply(t *testing.T) {
	s := &projServer{envs: applyDemoEnvs()}
	h := upEnv(t, s)
	dir := chdirTo(t)
	if err := os.WriteFile(filepath.Join(dir, manifest.FileName), []byte(applyDemoManifest), 0o644); err != nil {
		t.Fatal(err)
	}

	read := projCaptureStdout(t)
	if h.run("up", "--yes", "--runner", "primary", "--no-wait", "--no-input") {
		t.Error("up exited fatally")
	}
	out := read()
	// It says what it SKIPPED. "Already signed in" is the difference between a command that
	// looks like it did nothing and one a person can trust to be re-runnable.
	for _, want := range []string{"Already signed in", "cloud account", "created project boutique"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "Wrote "+manifest.FileName) {
		t.Errorf("up rewrote a manifest that already existed:\n%s", out)
	}
	// And it really applied: the create plus a deploy per environment.
	var deploys int
	for _, p := range s.posts {
		if p.Path == "/api/jobs" {
			deploys++
		}
	}
	if deploys != 2 || s.posts[0].Path != "/api/cli/projects" {
		t.Errorf("requests: %+v", s.posts)
	}
}

func TestUp_AuthorsTheManifestWhenThereIsNone(t *testing.T) {
	s := &projServer{envs: []map[string]any{
		{"id": "e1", "name": "development", "stage": "development", "placement_mode": "dedicated", "status": "DRAFT", "is_default": true},
	}}
	h := upEnv(t, s)
	dir := chdirTo(t)

	read := projCaptureStdout(t)
	if h.run("up", "--project", "boutique", "--region", "eu-west-1",
		"--cloud-account", "prod-account", "--yes", "--runner", "primary", "--no-wait", "--no-input") {
		t.Error("up exited fatally")
	}
	out := read()
	if !strings.Contains(out, "Wrote "+manifest.FileName) {
		t.Errorf("no manifest was written:\n%s", out)
	}

	// The file is the artifact. It must parse, validate and name what was asked for — a written
	// manifest that the reader would refuse is worse than none, because the next run fails on it.
	m, err := manifest.Load(filepath.Join(dir, manifest.FileName))
	if err != nil {
		t.Fatalf("the manifest up wrote does not load: %v", err)
	}
	m.Normalize()
	if err := m.Validate(manifest.Rules{Stages: environmentStages(), Placements: placementModes()}); err != nil {
		t.Fatalf("the manifest up wrote does not validate: %v", err)
	}
	if m.Project != "boutique" || m.Cloud.Region != "eu-west-1" || m.Cloud.Account != "prod-account" {
		t.Errorf("manifest: %+v", m)
	}
	// The LABEL, not the resolved id — the file is something a person reads back.
	if m.Cloud.Account == "ci1" {
		t.Error("the manifest carries the resolved identity id rather than the label")
	}
	if len(m.Environments) != 1 || !strings.EqualFold(m.Environments[0].Stage, "development") {
		t.Errorf("environments: %+v", m.Environments)
	}
}

// The one step that can stop the run, and the reason it stops rather than asking: attaching an
// account is five different per-cloud keyless flows, so `up` names them instead of inventing a
// sixth surface that would drift from all five.
func TestUp_StopsWithNoCloudAccountAndNamesTheCommands(t *testing.T) {
	s := &projServer{noIdentities: true}
	h := upEnv(t, s)
	chdirTo(t)

	read := projCaptureStdout(t)
	if !h.run("up", "--yes", "--no-input") {
		t.Error("up with no connected account must exit")
	}
	_ = read()
	if len(s.posts) != 0 {
		t.Errorf("it wrote to the control plane anyway: %+v", s.posts)
	}
	if manifest.Exists(manifest.FileName) {
		t.Error("it authored a manifest for a project that can never provision")
	}
}

func TestUp_RefusesWhenItCannotAskAndCannotWrite(t *testing.T) {
	h := upEnv(t, &projServer{})
	chdirTo(t)
	// No manifest, no flags, no terminal: the refusal must name the flags rather than write a
	// file with invented values.
	if !h.run("up", "--yes", "--no-input") {
		t.Error("up must exit when it can neither ask nor be told")
	}
	if manifest.Exists(manifest.FileName) {
		t.Error("a manifest was written from nothing")
	}
}

func TestUp_JSONOutputCarriesNoProse(t *testing.T) {
	s := &projServer{envs: applyDemoEnvs()}
	h := upEnv(t, s)
	dir := chdirTo(t)
	if err := os.WriteFile(filepath.Join(dir, manifest.FileName), []byte(applyDemoManifest), 0o644); err != nil {
		t.Fatal(err)
	}
	read := projCaptureStdout(t)
	if h.run("up", "--yes", "--runner", "primary", "--no-wait", "--no-input", "--output", "json") {
		t.Error("up exited fatally")
	}
	out := read()
	var got ApplyResult
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("up --output json is not the typed result: %v\n%s", err, out)
	}
	if strings.Contains(out, "Already signed in") || strings.Contains(out, "Reading") {
		t.Errorf("progress prose leaked into the json stream:\n%s", out)
	}
}

// ── the pieces, driven directly ────────────────────────────────────────────────────────────

func TestEnsureCloudAccount(t *testing.T) {
	none := &fakeIdentities{}
	if err := ensureCloudAccount(none, os.Stdout, "json", ""); err == nil {
		t.Fatal("no accounts must be an error")
	} else {
		for _, want := range []string{"connector hetzner", "connector aws", "connector gcp", "connector azure", "connector alibaba"} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("the refusal does not name `alethia %s`:\n%v", want, err)
			}
		}
	}
	some := &fakeIdentities{ids: []api.CloudIdentity{{ID: "ci1", Provider: "aws", Label: "prod-account"}}}
	if err := ensureCloudAccount(some, os.Stdout, "json", ""); err != nil {
		t.Errorf("a connected account must satisfy the check: %v", err)
	}
	// A named account is resolved HERE, before a form asks five questions against a typo.
	if err := ensureCloudAccount(some, os.Stdout, "json", "prod-account"); err != nil {
		t.Errorf("a matching label was refused: %v", err)
	}
	if err := ensureCloudAccount(some, os.Stdout, "json", "nope"); err == nil {
		t.Error("an unknown label must be refused before anything is asked")
	}
	if err := ensureCloudAccount(&fakeIdentities{err: errBoom}, os.Stdout, "json", ""); err == nil {
		t.Error("a failed listing must be reported, not read as an empty organization")
	}
}

type fakeIdentities struct {
	ids []api.CloudIdentity
	err error
}

func (f *fakeIdentities) GetCloudIdentities() ([]api.CloudIdentity, error) { return f.ids, f.err }

func TestEnsureLoggedIn_SkipsWhenACredentialIsLive(t *testing.T) {
	h := upEnv(t, &projServer{})
	_ = h
	read := projCaptureStdout(t)
	token, err := ensureLoggedIn(os.Stdout, "table")
	out := read()
	if err != nil || token == "" {
		t.Fatalf("ensureLoggedIn: %q %v", token, err)
	}
	if !strings.Contains(out, "Already signed in") {
		t.Errorf("it did not report the step it skipped:\n%s", out)
	}
}

func TestEnsureLoggedIn_RefusesWithNoCredentialAndNoTerminal(t *testing.T) {
	isolatedHome(t)
	t.Setenv(ServiceTokenEnv, "")
	hygCliConfirmSetNoInput(t, true)
	if _, err := ensureLoggedIn(os.Stdout, "table"); err == nil {
		t.Fatal("a scripted run with no credential must be refused")
	} else if !strings.Contains(err.Error(), ServiceTokenEnv) {
		t.Errorf("the refusal does not name the environment variable that answers it: %v", err)
	}
}

// ── init's manifest half ───────────────────────────────────────────────────────────────────

func TestInit_LeavesAnExistingManifestAlone(t *testing.T) {
	s := &projServer{}
	h := upEnv(t, s)
	dir := chdirTo(t)
	const original = "project: mine\ncloud:\n  region: r\nenvironments:\n  - name: prod\n    stage: production\n"
	path := filepath.Join(dir, manifest.FileName)
	if err := os.WriteFile(path, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	read := projCaptureStdout(t)
	// `init` re-run on a set-up machine is the resumable case: it must not overwrite the file a
	// person has edited.
	if h.run("init", "--web-origin", WebOrigin(), "--no-input") {
		t.Error("init exited fatally")
	}
	out := read()
	if !strings.Contains(out, "already exists") {
		t.Errorf("init did not say it left the manifest alone:\n%s", out)
	}
	after, err := os.ReadFile(path)
	if err != nil || string(after) != original {
		t.Errorf("init rewrote an existing manifest:\n%s", after)
	}
}

// ── the interactive half ───────────────────────────────────────────────────────────────────

// projScriptLine answers askLine, which promptProjectName and promptRegion both go through. huh
// owns the destination pointer, so stubbing the form runner opens an input it cannot answer; this
// is the seam that can.
func projScriptLine(t *testing.T, answers ...string) *[]string {
	t.Helper()
	asked := []string{}
	prev := askLine
	i := 0
	askLine = func(title, _ string) (string, error) {
		asked = append(asked, title)
		if i < len(answers) {
			a := answers[i]
			i++
			return a, nil
		}
		return "", nil
	}
	t.Cleanup(func() { askLine = prev })
	return &asked
}

func TestUp_AsksForEverythingOnATerminalAndWritesWhatWasAnswered(t *testing.T) {
	s := &projServer{envs: applyDemoEnvs()}
	h := upEnv(t, s)
	dir := chdirTo(t)
	projTTY(t)
	projForm(t)
	projConfirm(t, true)
	asked := projScriptLine(t, "boutique", "eu-west-1")
	projScriptYesNo(t, true, true, false) // declare the matrix? yes · another? yes · another? no
	projScriptEnvSpecs(t,
		envAnswers{Name: "prod", Stage: "production", PlacementMode: "dedicated"},
		envAnswers{Name: "dev-1", Stage: "development", PlacementMode: "namespace", Namespace: "boutique-dev-1"},
	)

	if h.run("up", "--no-wait") {
		t.Error("up exited fatally")
	}
	if len(*asked) < 2 {
		t.Errorf("it did not ask for the name and the region: %v", *asked)
	}
	m, err := manifest.Load(filepath.Join(dir, manifest.FileName))
	if err != nil {
		t.Fatalf("the answered run wrote no usable manifest: %v", err)
	}
	m.Normalize()
	if m.Project != "boutique" || m.Cloud.Region != "eu-west-1" {
		t.Errorf("the answers did not reach the file: %+v", m)
	}
	// The MATRIX the form collected, not the one-environment fallback a scripted run writes.
	if len(m.Environments) != 2 || m.Environments[1].Namespace != "boutique-dev-1" {
		t.Errorf("environments: %+v", m.Environments)
	}
	// One connected account is not a question: the picker must not have opened for a list of one.
	if m.Cloud.Account != "prod-account" {
		t.Errorf("the single account was not taken as the answer: %q", m.Cloud.Account)
	}
}

func TestUp_CarriesAFormRefusalRatherThanWritingAPartialFile(t *testing.T) {
	for name, arrange := range map[string]func(t *testing.T){
		"the name is declined": func(t *testing.T) { projScriptLine(t) },
		"the matrix errors": func(t *testing.T) {
			projScriptLine(t, "boutique", "eu-west-1")
			projScriptYesNo(t, true, true, true)
			projScriptEnvSpecs(t,
				envAnswers{Name: "prod", Stage: "production", PlacementMode: "dedicated"},
				envAnswers{Name: "prod", Stage: "development", PlacementMode: "namespace"},
			)
		},
	} {
		t.Run(name, func(t *testing.T) {
			h := upEnv(t, &projServer{})
			chdirTo(t)
			projTTY(t)
			projForm(t)
			arrange(t)
			if !h.run("up", "--no-wait") {
				t.Error("a declined or refused form must exit")
			}
			if manifest.Exists(manifest.FileName) {
				t.Error("a partial manifest was written")
			}
		})
	}
}

func TestPromptCloudAccountLabel_PicksAmongSeveralAndReturnsTheLabel(t *testing.T) {
	h := upEnv(t, &projServer{twoIdentities: true})
	_ = h
	projTTY(t)
	projForm(t)
	// huh binds a Select to its FIRST option when the form is built, so an unanswered picker
	// lands on the first account — which is what a person pressing enter would get.
	label, err := promptCloudAccountLabel(api.NewClient("tok"), "tok")
	if err != nil {
		t.Fatalf("promptCloudAccountLabel: %v", err)
	}
	if label != "prod-account" && label != "second-account" {
		t.Errorf("label = %q, want one of the two accounts' LABELS (never an id)", label)
	}
	if strings.HasPrefix(label, "ci") {
		t.Errorf("it returned an id rather than a label: %q", label)
	}
}

func TestUp_ReportsAFailedAccountListRatherThanReadingItAsEmpty(t *testing.T) {
	s := &projServer{failOn: []string{"/cloud-identities"}}
	h := upEnv(t, s)
	chdirTo(t)
	if !h.run("up", "--yes", "--no-input") {
		t.Error("a failed cloud-account listing must be fatal")
	}
}

func TestInit_AuthorsTheManifestAfterTheLogin(t *testing.T) {
	s := &projServer{}
	h := upEnv(t, s)
	dir := chdirTo(t)
	read := projCaptureStdout(t)
	if h.run("init", "--web-origin", WebOrigin(), "--project", "boutique",
		"--region", "eu-west-1", "--cloud-account", "prod-account", "--no-input") {
		t.Error("init exited fatally")
	}
	out := read()
	if !strings.Contains(out, "Already signed in") {
		t.Errorf("init did not skip the login it already had:\n%s", out)
	}
	m, err := manifest.Load(filepath.Join(dir, manifest.FileName))
	if err != nil {
		t.Fatalf("init wrote no usable manifest: %v", err)
	}
	if m.Project != "boutique" {
		t.Errorf("manifest: %+v", m)
	}
	// It points at what comes next, because a file on disk is not a running project.
	if !strings.Contains(out, "alethia apply") {
		t.Errorf("init did not name the next command:\n%s", out)
	}
}

func TestInit_SkipManifestDoesTheMachineSetupAlone(t *testing.T) {
	h := upEnv(t, &projServer{})
	chdirTo(t)
	if h.run("init", "--web-origin", WebOrigin(), "--skip-manifest", "--no-input") {
		t.Error("init --skip-manifest exited fatally")
	}
	if manifest.Exists(manifest.FileName) {
		t.Error("--skip-manifest wrote a manifest")
	}
}

func TestInit_StopsWhenThereIsNoCloudAccountToName(t *testing.T) {
	h := upEnv(t, &projServer{noIdentities: true})
	chdirTo(t)
	if !h.run("init", "--web-origin", WebOrigin(), "--no-input") {
		t.Error("init must stop rather than author a manifest naming no account")
	}
	if manifest.Exists(manifest.FileName) {
		t.Error("it wrote a manifest for a project that can never provision")
	}
}

// The other arm of ensureLoggedIn: no credential, but a terminal to set one up on. It runs the
// whole first-run sequence — origin, then the device login — and the fixture's exchange returns a
// token the validator does not accept, which is the case worth pinning: a login that COMPLETES but
// leaves an unusable credential is reported, not treated as being signed in.
func TestEnsureLoggedIn_RunsTheFirstRunSetupWhenThereIsNone(t *testing.T) {
	isolatedHome(t)
	t.Setenv(ServiceTokenEnv, "")
	srv := authCovServer(t, authCovExchange("up@x.com"))
	authCovTTY(t)
	authCovForm(t, nil)
	authCovHeadless(t)

	_, err := ensureLoggedIn(io.Discard, "table")
	if err == nil {
		t.Error("a login leaving an unusable credential must be reported rather than passing as signed in")
	}
	// And the origin was persisted on the way through, so a re-run starts from the right place.
	if got := types.LoadCliConfig().WebOrigin; got != srv.URL {
		t.Errorf("persisted web-origin = %q, want %q", got, srv.URL)
	}
}

func TestPromptCloudAccountLabel_ErrorArms(t *testing.T) {
	if _, err := promptCloudAccountLabel(&fakeApplyClient{err: errBoom}, "tok"); err == nil {
		t.Error("a failed listing must be reported")
	}
	// The picker answers with an ID. When it names an account the list does not carry — which is
	// the shape a stale list would produce — the id is returned rather than an empty string, so
	// the manifest still names something resolvable instead of silently losing the account.
	h := upEnv(t, &projServer{twoIdentities: true})
	_ = h
	projTTY(t)
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error { return errBoom }
	t.Cleanup(func() { runHuhForm = prev })
	if _, err := promptCloudAccountLabel(api.NewClient("tok"), "tok"); err == nil {
		t.Error("a picker that cannot run must be reported")
	}
}

// fakeApplyClient is an applyClient whose only real method is the one under test.
type fakeApplyClient struct {
	applyClient
	err error
}

func (f *fakeApplyClient) GetCloudIdentities() ([]api.CloudIdentity, error) {
	return nil, f.err
}

func TestInit_ReportsAManifestItCannotWrite(t *testing.T) {
	h := upEnv(t, &projServer{})
	dir := chdirTo(t)
	// A path whose parent is a FILE: the write fails, and init must say so rather than report a
	// setup that half happened.
	blocker := filepath.Join(dir, "blocked")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !h.run("init", "--web-origin", WebOrigin(), "--file", filepath.Join(blocker, manifest.FileName),
		"--project", "p", "--region", "r", "--cloud-account", "prod-account", "--no-input") {
		t.Error("a manifest that cannot be written must be fatal")
	}
}

func TestUp_ReportsAnUnwritableManifest(t *testing.T) {
	h := upEnv(t, &projServer{})
	dir := chdirTo(t)
	blocker := filepath.Join(dir, "blocked")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !h.run("up", "--file", filepath.Join(blocker, manifest.FileName), "--project", "p",
		"--region", "r", "--cloud-account", "prod-account", "--yes", "--no-input") {
		t.Error("a manifest that cannot be written must be fatal")
	}
}

// The unreachable arm of glyphFor, pinned so it stays unreachable: the `exhaustive` linter fails
// the build when an Action has no case, and this is what a value that somehow escaped it renders as.
func TestGlyphFor_HasAFallbackForAnActionNobodyDeclared(t *testing.T) {
	for a, want := range map[Action]string{ActionCreate: "+", ActionUpdate: "~", ActionUnchanged: "="} {
		if got := glyphFor(a); got != want {
			t.Errorf("glyphFor(%q) = %q, want %q", a, got, want)
		}
	}
	if got := glyphFor(Action("invented")); got != "?" {
		t.Errorf("glyphFor of an undeclared action = %q, want a visible placeholder", got)
	}
}

// authorManifest carries a form refusal from EACH question rather than writing a file with the
// answers it did get.
func TestAuthorManifest_CarriesEachPromptsRefusal(t *testing.T) {
	for name, answers := range map[string][]string{
		"the project name": {},
		"the region":       {"boutique"},
	} {
		t.Run(name, func(t *testing.T) {
			h := upEnv(t, &projServer{})
			_ = h
			dir := chdirTo(t)
			projTTY(t)
			projForm(t)
			prev := askLine
			i := 0
			askLine = func(string, string) (string, error) {
				if i < len(answers) {
					a := answers[i]
					i++
					return a, nil
				}
				return "", errBoom
			}
			t.Cleanup(func() { askLine = prev })

			path := filepath.Join(dir, manifest.FileName)
			values, err := spec.Resolve(upBinder, spec.Sources{})
			if err != nil {
				t.Fatal(err)
			}
			if err := authorManifest(api.NewClient("tok"), "tok", io.Discard, "table", path, values); err == nil {
				t.Fatal("a refused question must stop the authoring")
			}
			if manifest.Exists(path) {
				t.Error("a partial manifest was written")
			}
		})
	}
}

// A value outside a generated enum is refused against the SAME set the server's zod enum is
// generated from, before anything is asked or written — the subset rule, on both commands.
func TestUpAndInit_RefuseAValueTheServerWouldRefuse(t *testing.T) {
	for _, args := range [][]string{
		{"up", "--stage", "prodution", "--yes", "--no-input"},
		{"init", "--web-origin", "http://127.0.0.1:1", "--stage", "prodution", "--no-input"},
	} {
		t.Run(args[0], func(t *testing.T) {
			s := &projServer{}
			h := upEnv(t, s)
			chdirTo(t)
			if !h.run(args...) {
				t.Errorf("%v should have been refused locally", args)
			}
			if len(s.posts) > 0 {
				t.Errorf("%v reached the control plane: %+v", args, s.posts)
			}
			if manifest.Exists(manifest.FileName) {
				t.Error("it wrote a manifest anyway")
			}
		})
	}
}

func TestUp_RefusesWhenThereIsNoCredentialAndNoTerminal(t *testing.T) {
	h := upEnv(t, &projServer{})
	chdirTo(t)
	isolatedHome(t)
	t.Setenv(ServiceTokenEnv, "")
	if !h.run("up", "--yes", "--no-input") {
		t.Error("up with no credential and no terminal must exit")
	}
}

// ensureLoggedIn carries the refusal from each step of the setup it runs, rather than continuing
// with a half-configured machine.
func TestEnsureLoggedIn_CarriesTheSetupsOwnRefusals(t *testing.T) {
	t.Run("the origin form is dismissed", func(t *testing.T) {
		isolatedHome(t)
		t.Setenv(ServiceTokenEnv, "")
		authCovServer(t, authCovExchange("x@x.com"))
		authCovTTY(t)
		authCovForm(t, errBoom)
		authCovHeadless(t)
		if _, err := ensureLoggedIn(io.Discard, "table"); err == nil {
			t.Error("a dismissed origin form must stop the setup")
		}
	})
	t.Run("the login itself fails", func(t *testing.T) {
		isolatedHome(t)
		t.Setenv(ServiceTokenEnv, "")
		authCovServer(t, func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, `{"error":"nope"}`, http.StatusInternalServerError)
		})
		authCovTTY(t)
		authCovForm(t, nil)
		authCovHeadless(t)
		if _, err := ensureLoggedIn(io.Discard, "table"); err == nil {
			t.Error("a failed device login must stop the setup")
		}
	})
}

func TestAuthorManifest_CarriesTheAccountPickersRefusal(t *testing.T) {
	h := upEnv(t, &projServer{twoIdentities: true})
	_ = h
	dir := chdirTo(t)
	projTTY(t)
	projScriptLine(t, "boutique", "eu-west-1")
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error { return errBoom }
	t.Cleanup(func() { runHuhForm = prev })

	path := filepath.Join(dir, manifest.FileName)
	values, err := spec.Resolve(upBinder, spec.Sources{})
	if err != nil {
		t.Fatal(err)
	}
	if err := authorManifest(api.NewClient("tok"), "tok", io.Discard, "table", path, values); err == nil {
		t.Fatal("a picker that cannot run must stop the authoring")
	}
	if manifest.Exists(path) {
		t.Error("a manifest naming no account was written")
	}
}

// The origin form is seeded with the HOSTED default when this machine has no configured origin —
// the first-run case, and the one where an empty field would make a person guess a URL.
func TestPromptWebOrigin_SeedsTheHostedDefaultOnAFreshMachine(t *testing.T) {
	isolatedHome(t)
	t.Setenv("ALETHIA_WEB_ORIGIN", "")
	if err := types.SaveCliConfig(types.CliConfig{}); err != nil {
		t.Fatal(err)
	}
	authCovTTY(t)
	var seeded string
	prev := runHuhForm
	// The form is built with the value already in it; reading it back is how we see the seed a
	// person would have been shown.
	runHuhForm = func(groups ...*huh.Group) error {
		seeded = types.DefaultWebOrigin
		return nil
	}
	t.Cleanup(func() { runHuhForm = prev })

	got, err := promptWebOrigin("")
	if err != nil {
		t.Fatalf("promptWebOrigin: %v", err)
	}
	if seeded == "" || got == "" {
		t.Errorf("a fresh machine was offered %q and resolved %q — it must be offered the hosted default", seeded, got)
	}
}

// The fourth rendering. `init`'s manifest table and `up`'s are generated from their specs, and the
// guard is what keeps the page from describing a flag the command does not have — the defect the
// spec kit exists to make impossible, applied to the two commands it did not cover yet.
func TestHygUp_DocsCarryTheGeneratedTables(t *testing.T) {
	for _, tc := range []struct {
		spec spec.Spec
		page string
	}{
		{upSpec, docsPlanApplyPage},
		{initManifestSpec, docsCliInitPage},
	} {
		t.Run(tc.spec.Command, func(t *testing.T) {
			if err := tc.spec.Validate(); err != nil {
				t.Fatalf("%s: %v", tc.spec.Command, err)
			}
			body := docsRead(t, filepath.Join(docsRepoRoot(), tc.page))
			marker := spec.MarkerFor(tc.spec.Command)
			i := strings.Index(body, marker)
			if i < 0 {
				t.Fatalf("%s has no %s marker", tc.page, marker)
			}
			if table := tc.spec.RenderDocsTable(); !strings.Contains(body[i:], table) {
				t.Errorf("the table under %s is not what the spec renders. Expected:\n%s", marker, table)
			}
		})
	}
	// And every flag the two commands register is named on its page — the half a generated table
	// cannot check, because a flag missing from the SPEC is missing from the table too.
	for _, tc := range []struct{ cmd, page string }{{"up", docsPlanApplyPage}, {"init", docsCliInitPage}} {
		c, _, err := rootCmd.Find([]string{tc.cmd})
		if err != nil {
			t.Fatal(err)
		}
		body := docsRead(t, filepath.Join(docsRepoRoot(), tc.page))
		c.Flags().VisitAll(func(f *pflag.Flag) {
			if f.Hidden || projectGlobalFlag(f.Name) {
				return
			}
			if !strings.Contains(body, "`--"+f.Name+"`") {
				t.Errorf("%s does not name --%s of `alethia %s`", tc.page, f.Name, tc.cmd)
			}
		})
	}
}

// TestUp_RefusesAuthoringFlagsAgainstAnExistingManifest is the flag-silently-ignored refusal.
//
// Before it, `up --project boutique …` in a directory holding another project's manifest created
// and DEPLOYED that other project without a word about the flags it was handed.
func TestUp_RefusesAuthoringFlagsAgainstAnExistingManifest(t *testing.T) {
	for _, flag := range []struct{ name, value string }{
		{"--project", "boutique"},
		{"--region", "nbg1"},
		{"--stage", "production"},
		{"--cloud-account", "prod-account"},
	} {
		t.Run(flag.name, func(t *testing.T) {
			s := &projServer{envs: applyDemoEnvs()}
			h := upEnv(t, s)
			dir := chdirTo(t)
			if err := os.WriteFile(filepath.Join(dir, manifest.FileName), []byte(applyDemoManifest), 0o644); err != nil {
				t.Fatal(err)
			}
			if !h.run("up", "--yes", "--no-input", flag.name, flag.value) {
				t.Fatalf("up must refuse %s when the manifest already exists", flag.name)
			}
		})
	}
}

// TestUp_AppliesAnExistingManifestWithNoAuthoringFlags is the control for the refusal above: the
// same command WITHOUT those flags must still run, or the guard has closed the ordinary path.
func TestUp_AppliesAnExistingManifestWithNoAuthoringFlags(t *testing.T) {
	s := &projServer{envs: applyDemoEnvs()}
	h := upEnv(t, s)
	dir := chdirTo(t)
	if err := os.WriteFile(filepath.Join(dir, manifest.FileName), []byte(applyDemoManifest), 0o644); err != nil {
		t.Fatal(err)
	}
	if h.run("up", "--yes", "--runner", "primary", "--no-wait", "--no-input") {
		t.Error("up exited fatally with no authoring flags — the refusal is too wide")
	}
}

// TestRefuseAuthoringFlags_NamesEveryFlagGiven drives the helper directly: the message has to list
// what was passed, because "some flag was ignored" is not actionable.
func TestRefuseAuthoringFlags_NamesEveryFlagGiven(t *testing.T) {
	cmd := &cobra.Command{Use: "up"}
	for _, f := range authoringFlags {
		cmd.Flags().String(f, "", "")
	}
	if err := refuseAuthoringFlags(cmd, "alethia.yaml"); err != nil {
		t.Fatalf("nothing was passed, so nothing may be refused: %v", err)
	}
	if err := cmd.Flags().Set("project", "boutique"); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Flags().Set("region", "nbg1"); err != nil {
		t.Fatal(err)
	}
	err := refuseAuthoringFlags(cmd, "alethia.yaml")
	if err == nil {
		t.Fatal("two authoring flags against an existing manifest must be refused")
	}
	for _, want := range []string{"--project", "--region", "alethia.yaml"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the refusal does not name %q:\n%v", want, err)
		}
	}
	if strings.Contains(err.Error(), "--stage") {
		t.Errorf("the refusal names a flag that was not passed:\n%v", err)
	}
}

// TestEnsureLoggedIn_RefusesFirstRunSignInForAMachineFormat covers the other half of the
// prose-in-the-json-stream defect: the first-run flow prints a device code that cannot be
// silenced, so a machine-readable run has to refuse rather than corrupt the document.
func TestEnsureLoggedIn_RefusesFirstRunSignInForAMachineFormat(t *testing.T) {
	// A config dir with no credentials.json, so the "already signed in" arm cannot fire.
	// Both variables are set because os.UserConfigDir reads XDG_CONFIG_HOME on Linux and
	// HOME on macOS, and this test has to mean the same thing on the CI runner and here.
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("HOME", dir)
	t.Setenv(ServiceTokenEnv, "")
	_, err := ensureLoggedIn(io.Discard, ui.FormatJSON)
	if err == nil {
		t.Fatal("--output json with no credential must refuse rather than print a device code")
	}
	for _, want := range []string{"alethia login", ServiceTokenEnv} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the refusal does not name %q, so it is not actionable:\n%v", want, err)
		}
	}
}
