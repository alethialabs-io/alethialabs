// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"os"
	"strings"
	"testing"

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
