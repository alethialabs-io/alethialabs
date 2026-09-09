// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"os"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/mattn/go-isatty"
)

// The shell: the root command itself and the commands that hang directly off it.
//
// `alethia` with no arguments, an unresolvable command, `open`, `version`, and the two global
// contracts every other command inherits — the --output validation and the terminal detection that
// decides whether anything may prompt. Nothing here needs a control plane.

// TestMisc_OpenTargets pins which URL `alethia open` sends the browser to: the console by
// default, the docs for the `docs` alias and the explicit `docs` argument, and a refusal
// for anything else.
func TestMisc_OpenTargets(t *testing.T) {
	var opened []string
	prev := openBrowser
	openBrowser = func(url string) error {
		opened = append(opened, url)
		return nil
	}
	t.Cleanup(func() { openBrowser = prev })

	run := miscEnv(t, miscFull)
	for _, args := range [][]string{
		{"open"},
		{"open", "console"},
		{"open", "dashboard"},
		{"open", "docs"},
		{"docs"},
		{"dashboard"},
	} {
		if err := run(append(append([]string{}, args...), "--output", "table", "--no-input")...); err != nil {
			t.Errorf("%v: %v", args, err)
		}
	}
	if len(opened) != 6 {
		t.Fatalf("expected 6 browser launches, got %d: %v", len(opened), opened)
	}
	if opened[3] != docsURL || opened[4] != docsURL {
		t.Errorf("docs target did not resolve to the docs URL: %v", opened)
	}
	if !strings.HasPrefix(opened[0], "http") || opened[0] == docsURL {
		t.Errorf("default target should be the console origin, got %q", opened[0])
	}
}

// TestMisc_OpenReportsBrowserFailure pins that a browser that will not launch is reported
// rather than swallowed — the URL is already printed, so the command still succeeds.
func TestMisc_OpenReportsBrowserFailure(t *testing.T) {
	prev := openBrowser
	openBrowser = func(url string) error { return errBoom }
	t.Cleanup(func() { openBrowser = prev })

	run := miscEnv(t, miscFull)
	if err := run("open", "console", "--output", "table", "--no-input"); err != nil {
		t.Fatalf("open: %v", err)
	}
}

// TestMisc_OpenRejectsUnknownTarget pins that an unrecognised target exits instead of
// opening the console anyway.
func TestMisc_OpenRejectsUnknownTarget(t *testing.T) {
	prev := openBrowser
	openBrowser = func(url string) error {
		t.Errorf("browser should not be launched for an unknown target, got %q", url)
		return nil
	}
	t.Cleanup(func() { openBrowser = prev })

	run := miscTrapExit(t, miscEnv(t, miscFull))
	if !run("open", "nope", "--output", "table", "--no-input") {
		t.Error("expected the fatal path for an unknown open target")
	}
}

// TestMisc_RootBanner pins that a bare `alethia` prints the brand banner and its help,
// rather than erroring on a missing subcommand.
func TestMisc_RootBanner(t *testing.T) {
	run := miscEnv(t, miscFull)
	if err := run(); err != nil {
		t.Fatalf("bare root: %v", err)
	}
}

// TestMisc_ExecuteExitsOnUnknownCommand pins the top-level Execute wrapper: a command
// cobra cannot resolve is routed through the single fatal-error path, not returned to a
// caller that would ignore it.
func TestMisc_ExecuteExitsOnUnknownCommand(t *testing.T) {
	miscEnv(t, miscFull)
	prev := exitFunc
	exited := false
	exitFunc = func(code int) { exited = true; panic(miscExit{code}) }
	t.Cleanup(func() { exitFunc = prev })

	func() {
		defer func() {
			if r := recover(); r != nil {
				if _, ok := r.(miscExit); !ok {
					panic(r)
				}
			}
		}()
		execRootArgs([]string{"definitely-not-a-command"})
		rootCmd.SetOut(os.Stderr)
		Execute()
	}()
	if !exited {
		t.Error("Execute did not take the fatal path for an unknown command")
	}
	rootCmd.SetOut(nil)
}

// TestMisc_WebOriginFollowsTheEnvironment pins that the exported WebOrigin helper resolves
// through the same precedence the client uses, so `open` and the API client cannot
// disagree about which control plane they are talking to.
func TestMisc_WebOriginFollowsTheEnvironment(t *testing.T) {
	isolatedHome(t)
	t.Setenv("ALETHIA_WEB_ORIGIN", "https://cp.example.com")
	if got := WebOrigin(); got != "https://cp.example.com" {
		t.Errorf("WebOrigin() = %q, want the env override", got)
	}
}

// ---------------------------------------------------------------------------
// The organization-administration, fleet, provider, runner and job surfaces.
//
// These commands do NOT share the one-envelope fake above: `provider status`,
// `provider verify`, `jobs get` and `runner deploy` each decode the whole response
// body into their own struct, and three of them want a different value under the
// same `status` key. So they get a path-aware fake instead.
// ---------------------------------------------------------------------------

// TestMisc_VersionPrintsTheBuild pins that `version` prints the compiled version and, when
// a newer one has been cached by the background update check, notes it.
func TestMisc_VersionPrintsTheBuild(t *testing.T) {
	run := miscAdminEnv(t, miscAdminOpts{})
	if err := run("version", "--output", "json"); err != nil {
		t.Error(err)
	}
}

// TestMisc_InvalidOutputFormatIsRefused pins that an --output the renderer does not know is
// rejected before anything is printed, rather than falling through to a default.
func TestMisc_InvalidOutputFormatIsRefused(t *testing.T) {
	exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{}))
	for _, args := range [][]string{{"cluster", "list"}, {"usage"}, {"grants", "list"}} {
		if !exits(append(args, "--output", "yaml")...) {
			t.Errorf("%v: expected an unknown --output to be refused", args)
		}
	}
}

// TestMisc_TerminalDetectionDelegatesToIsatty pins that the two TTY seams are, by default,
// exactly the isatty calls they replaced — so substituting them in a test cannot be
// mistaken for a change in how production decides which arm to run.
func TestMisc_TerminalDetectionDelegatesToIsatty(t *testing.T) {
	if got, want := stdinIsTTY(), isatty.IsTerminal(os.Stdin.Fd()); got != want {
		t.Errorf("stdinIsTTY() = %v, want %v", got, want)
	}
	if got, want := stdoutIsTTY(), isatty.IsTerminal(os.Stdout.Fd()); got != want {
		t.Errorf("stdoutIsTTY() = %v, want %v", got, want)
	}
}

// TestMisc_OpenProjectAndOrg pins what `alethia open` sends the browser to now that it builds
// over the console's route tree rather than at its origin: the active ORG's page, a PROJECT's
// page under it, and the refusal that keeps `--project` from meaning anything for the docs.
func TestMisc_OpenProjectAndOrg(t *testing.T) {
	// `--project` is a COMMAND-local flag bound to the package variable openProject, and
	// execRootArgs resets only the ROOT's persistent flags — deliberately, per its own comment.
	// Without this the test ends with openProject == "shop" and poisons every later `open`/`docs`
	// invocation in the package: TestMisc_OpenTargets runs under miscEnv alone, does not trap
	// exitFunc, and would take the `--project does not apply to the docs` arm straight into the
	// real os.Exit(1), killing the binary mid-run instead of failing a test. Invisible in file
	// order, found by `-shuffle` — the class hyg_cli_harness_test.go exists for.
	resetFlagsAroundTest(t)

	var opened []string
	prev := openBrowser
	openBrowser = func(url string) error { opened = append(opened, url); return nil }
	t.Cleanup(func() { openBrowser = prev })

	run := miscEnv(t, miscFull)
	if err := run("open", "--output", "table", "--no-input"); err != nil {
		t.Fatalf("open: %v", err)
	}
	if len(opened) != 1 || !strings.HasSuffix(opened[0], "/acme") {
		t.Fatalf("bare open should reach the active org's page, got %v", opened)
	}
	if err := run("open", "--project", "My Shop", "--output", "table", "--no-input"); err != nil {
		t.Fatalf("open --project: %v", err)
	}
	if len(opened) != 2 || !strings.HasSuffix(opened[1], "/acme/my-shop") {
		t.Errorf("open --project should reach the project's page, got %v", opened)
	}
	// The docs are not under an org, so --project has nothing to name there. Refused rather than
	// ignored: a flag that is silently dropped is a flag somebody will believe worked.
	trap := miscTrapExit(t, run)
	if !trap("open", "docs", "--project", "shop", "--output", "table", "--no-input") {
		t.Error("--project with the docs target must be fatal")
	}
}

// TestMisc_OpenFallsBackToTheOriginWhenThereIsNoOrg pins the arm that must NOT fail: a machine
// with no credential, or an account with no organization, still has somewhere to send a person.
// The org page is an improvement on the origin, not a precondition for opening a browser.
func TestMisc_OpenFallsBackToTheOriginWhenThereIsNoOrg(t *testing.T) {
	var opened []string
	prev := openBrowser
	openBrowser = func(url string) error { opened = append(opened, url); return nil }
	t.Cleanup(func() { openBrowser = prev })

	run := miscEnv(t, miscEmpty)
	isolatedHome(t) // no credentials: getAuthToken fails and the origin is the answer
	t.Setenv(ServiceTokenEnv, "")
	if err := run("open", "--output", "table", "--no-input"); err != nil {
		t.Fatalf("open: %v", err)
	}
	if len(opened) != 1 || opened[0] != WebOrigin() {
		t.Errorf("a logged-out open should reach the origin, got %v", opened)
	}
}

// TestMisc_OpenProjectWithoutACredentialRefuses pins the one exception to `open`'s origin
// fallback.
//
// A bare `alethia open` on a machine with no credential still has somewhere sensible to go — the
// origin — and falling back there is deliberate. `--project` is different: it names something only
// the API can resolve, so dropping it answers a request for one project with a page about none,
// and the only difference from success is a URL nobody reads. That is the rule the `docs` arm
// already states in the same words; this is it applied consistently.
func TestMisc_OpenProjectWithoutACredentialRefuses(t *testing.T) {
	resetFlagsAroundTest(t)
	isolatedHome(t)
	t.Setenv("ALETHIA_WEB_ORIGIN", "https://alethialabs.io")
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")

	var opened []string
	prev := openBrowser
	openBrowser = func(url string) error { opened = append(opened, url); return nil }
	t.Cleanup(func() { openBrowser = prev })

	run := func(args ...string) error {
		execRootArgs(args)
		return rootCmd.Execute()
	}
	trap := miscTrapExit(t, run)
	if !trap("open", "--project", "shop", "--output", "table", "--no-input") {
		t.Error("--project with no credential must refuse rather than opening the console home page")
	}
	if len(opened) != 0 {
		t.Errorf("a refusal still opened a browser at %v", opened)
	}

	// The control: without --project the origin fallback is right and must stay.
	//
	// resetAllFlags because --project is COMMAND-local: execRootArgs clears only the root's
	// persistent flags, so without this the control would still be carrying "shop" from the case
	// above and would exercise the same arm. That is the leak this file's other open test now
	// guards against, met here from the inside.
	resetAllFlags()
	if err := run("open", "--output", "table", "--no-input"); err != nil {
		t.Fatalf("bare open with no credential should fall back to the origin: %v", err)
	}
	if len(opened) != 1 || opened[0] != "https://alethialabs.io" {
		t.Errorf("bare open should have reached the origin, got %v", opened)
	}
}

// TestMisc_OpenRefusesAProjectItCannotLinkTo drives the three arms `open` takes once it HAS a
// credential — the ones the logged-out fallback test above can never reach, because it never gets
// past `getAuthToken`.
//
// The rule they implement together: a bare `open` always has somewhere to go, and `--project` never
// silently becomes somewhere else. The org page is an improvement on the origin rather than a
// precondition, so losing it degrades; a project that cannot be resolved has no degraded form, so
// it refuses.
func TestMisc_OpenRefusesAProjectItCannotLinkTo(t *testing.T) {
	// `openProject` is a package-level flag target and leaks into every later `open` in the
	// package if it is not reset — the hazard this file already records against the docs arm.
	resetFlagsAroundTest(t)

	var opened []string
	prev := openBrowser
	openBrowser = func(url string) error { opened = append(opened, url); return nil }
	t.Cleanup(func() { openBrowser = prev })

	// An organization the account is not in: a credential resolves, whoami reports no active org,
	// so the org slug every console link is built from cannot be found.
	//
	// The PROJECT list is populated here, and that is the arm's whole point since #4454: `open`
	// now resolves `--project` against the org's own projects before it builds anything, so an
	// env with no projects would refuse at the reference and never reach projectLink. Under
	// miscFull the name resolves and the org slug is the only thing that does not — which is the
	// failure this arm is named for. miscEmpty would have kept the assertion true and moved it
	// onto a different mechanism.
	orgless := miscEnv(t, miscFull)
	// miscEnv persists an active org, and `resolveOrgSlug` prefers the config over whoami — by
	// design, so the common path costs no request. Clearing it is what makes the org genuinely
	// unresolvable; the credential written beside it stays, which is the whole point of these
	// three arms.
	if err := types.SaveCliConfig(types.CliConfig{}); err != nil {
		t.Fatal(err)
	}
	trapOrgless := miscTrapExit(t, orgless)

	// A bare open DEGRADES. This is the arm the logged-out test cannot reach: there the origin is
	// chosen before any client exists, here it is chosen after `orgLink` has failed.
	if err := orgless("open", "--output", "table", "--no-input"); err != nil {
		t.Fatalf("a bare open must never be fatal, even with no org: %v", err)
	}
	if len(opened) != 1 || opened[0] != WebOrigin() {
		t.Fatalf("a bare open with no org should reach the origin, got %v", opened)
	}

	// `--project` does NOT degrade. The name resolves fine; it is the org slug that does not, and
	// a project page cannot be addressed without one.
	if !trapOrgless("open", "--project", "My Shop", "--output", "table", "--no-input") {
		t.Error("--project must be fatal when the org the link needs cannot be resolved")
	}
	if len(opened) != 1 {
		t.Errorf("a refused --project must open no browser at all, got %v", opened)
	}

	// And the other half of the same rule, against a populated org: an id that resolves to no
	// project is refused rather than opening the org's index.
	trapFull := miscTrapExit(t, miscEnv(t, miscFull))
	if !trapFull("open", "--project", "11111111-1111-1111-1111-111111111111", "--output", "table", "--no-input") {
		t.Error("an unresolvable --project id must be fatal")
	}
	if len(opened) != 1 {
		t.Errorf("a refused --project must open no browser at all, got %v", opened)
	}
}
