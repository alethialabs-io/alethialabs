// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

// A machine-readable run's stdout is the document, and nothing else.
//
// This is a guard on the PROPERTY rather than on any function. The defect that prompted it was
// ui.RunSpinner writing its frames to os.Stdout — `alethia jobs list -o json > jobs.json` produced a
// file beginning with eight ANSI sequences and "⣽  Fetching jobs..." ahead of the "[", and jq
// answered "Invalid numeric literal at line 1, column 2" — but the spinner is not the only thing
// that can write there. A `fmt.Println` of a progress note, a lipgloss-styled warning, a stray
// ui.Info before the payload: each is the same defect wearing a different function's name, and a
// guard aimed at the spinner would catch none of them.
//
// It can genuinely FAIL, which is the part worth stating because it is not obvious. Under `go test`
// most bubbletea widgets refuse to start — ShowTable and huh's forms return "could not open a new
// TTY" — so a naive stream assertion would pass on a broken tree and be worthless. The SPINNER does
// not: it passes tea.WithInput(nil), so nothing ever tries to open /dev/tty and it renders happily
// into a plain pipe. Measured: 75 bytes into stdout, 8 of them escapes, from a headless process.
// So this guard was red before the fix and is green after it, in-process, with no terminal.
//
// What it does NOT cover, stated so nobody reads more into a green: the widgets that DO need a TTY
// are inert here, so it says nothing about what `ui.ShowTable` would write, and lipgloss disables
// colour on a non-terminal, so a styled string that would carry escapes on a real terminal carries
// none here. Those need the pty harness, not this.

// stdoutCapture runs fn with os.Stdout replaced by a pipe and returns what was written.
//
// A pipe rather than a buffer, because the thing being caught writes to the FILE os.Stdout names
// rather than through any writer the command was handed — which is exactly why it was invisible to
// every test in this package that renders through an io.Writer parameter.
func stdoutCapture(t *testing.T, fn func()) []byte {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	orig := os.Stdout
	os.Stdout = w

	// A pipe holds 64KB; a large json document would block the writer before fn returns. Draining
	// concurrently is not optional here — without it this guard would deadlock on exactly the
	// commands with the most to say.
	done := make(chan []byte, 1)
	go func() {
		b, _ := io.ReadAll(r)
		done <- b
	}()

	fn()
	os.Stdout = orig
	if err := w.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	return <-done
}

// TestHygCliStdout_CaptureActuallyCaptures is the control.
//
// "Nothing was written to stdout" and "the capture is broken" are the same result, and every
// assertion below is of that shape. This proves the machinery sees both a plain write and an
// escape byte.
func TestHygCliStdout_CaptureActuallyCaptures(t *testing.T) {
	got := stdoutCapture(t, func() { _, _ = os.Stdout.WriteString("\x1b[2K{\"ok\":true}") })
	if !bytes.Contains(got, []byte(`{"ok":true}`)) {
		t.Fatalf("the capture missed a write it was pointed at, got %q", got)
	}
	if !bytes.ContainsRune(got, 0x1b) {
		t.Fatal("the capture dropped the escape byte, so no assertion below could ever see one")
	}
}

// TestHygCliStdout_JSONRunsEmitOnlyTheirDocument drives every read-only command with `-o json` and
// requires its stdout to be exactly a JSON document.
func TestHygCliStdout_JSONRunsEmitOnlyTheirDocument(t *testing.T) {
	run := miscEnv(t, miscFull)

	nonEmpty := 0
	for _, args := range miscReadCommands() {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			var runErr error
			got := stdoutCapture(t, func() {
				runErr = run(append(append([]string{}, args...), "--output", "json", "--no-input")...)
			})
			if runErr != nil {
				t.Fatalf("%v: %v", args, runErr)
			}
			if i := bytes.IndexRune(got, 0x1b); i >= 0 {
				t.Fatalf("stdout carries an ANSI escape at byte %d — a redirect of this command "+
					"produces a file no parser can read:\n%q", i, got[:min(len(got), 240)])
			}
			if len(bytes.TrimSpace(got)) == 0 {
				return // a command with nothing to report is allowed to say nothing
			}
			nonEmpty++
			var doc any
			if err := json.Unmarshal(got, &doc); err != nil {
				t.Fatalf("stdout is not a JSON document: %v\n%q", err, got[:min(len(got), 240)])
			}
		})
	}
	if nonEmpty == 0 {
		t.Fatal("no command produced any stdout at all — the parse assertion above ran against " +
			"nothing, so it proved nothing")
	}
}

// TestHygCliStdout_TheSpinnerIsNotInTheDocument is the same property aimed at the exact path, so a
// failure names the cause instead of only the symptom.
//
// It drives runSpinner in the posture the fix is about — a terminal is present, so the spinner
// really does draw — and requires the drawing to land somewhere other than stdout.
func TestHygCliStdout_TheSpinnerIsNotInTheDocument(t *testing.T) {
	prev := interactiveOutIsTTY
	interactiveOutIsTTY = func() bool { return true }
	t.Cleanup(func() { interactiveOutIsTTY = prev })

	ran := false
	got := stdoutCapture(t, func() {
		runSpinner("Fetching jobs...", func() { ran = true })
		_, _ = os.Stdout.WriteString(`{"jobs":[]}`)
	})

	if !ran {
		t.Fatal("the action did not run")
	}
	if !bytes.Equal(got, []byte(`{"jobs":[]}`)) {
		t.Errorf("stdout is not exactly the document — the spinner is in it:\n%q", got)
	}
}

// --- the fatal path: an error is never part of the document ------------------
//
// The same property as above, for the run that FAILS. `x=$(alethia … -o json)` must leave x either
// a document or empty, and the exit code must say which kind of failure it was. Both halves live on
// one path — fail — so both are asserted on it: where the error is written, and the number it exits
// with. The numbers are pkg/clierr's table; one row per exit code is driven through fail here, so
// the table is proven at the exit and not only in the classifier.

// hygCliStdoutExit is what a trapped exitFunc panics with.
type hygCliStdoutExit struct{ code int }

// hygCliStdoutFatal runs fn with exitFunc trapped and both streams captured, and returns what was
// written to each and the exit code. It fails the test when fn returns without exiting.
func hygCliStdoutFatal(t *testing.T, fn func()) (stdout, stderr string, code int) {
	t.Helper()
	prevExit, prevFormat := exitFunc, errorFormat
	exitFunc = func(c int) { panic(hygCliStdoutExit{c}) }
	t.Cleanup(func() { exitFunc, errorFormat = prevExit, prevFormat })

	exited := false
	stdout, stderr = captureStreams(t, func() {
		defer func() {
			r := recover()
			if r == nil {
				return
			}
			e, ok := r.(hygCliStdoutExit)
			if !ok {
				panic(r)
			}
			exited, code = true, e.code
		}()
		fn()
	})
	if !exited {
		t.Fatalf("the fatal path was not taken; stdout=%q stderr=%q", stdout, stderr)
	}
	return stdout, stderr, code
}

// hygCliStdoutEnvelope decodes the LAST line of stderr as the alethia.error/v1 envelope.
func hygCliStdoutEnvelope(t *testing.T, stderr string) (code string, exit int) {
	t.Helper()
	lines := strings.Split(strings.TrimRight(stderr, "\n"), "\n")
	var doc struct {
		Error struct {
			Code     string `json:"code"`
			ExitCode int    `json:"exit_code"`
		} `json:"error"`
		Schema string `json:"schema"`
	}
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &doc); err != nil {
		t.Fatalf("the last line of stderr is not a JSON object: %v\n%q", err, stderr)
	}
	if doc.Schema != clierr.Schema {
		t.Fatalf("schema = %q, want %q", doc.Schema, clierr.Schema)
	}
	return doc.Error.Code, doc.Error.ExitCode
}

// TestHygCliStdout_FatalPathExitsWithTheTableAndWritesOnlyStderr drives one error per exit code
// through fail, in both renderings.
func TestHygCliStdout_FatalPathExitsWithTheTableAndWritesOnlyStderr(t *testing.T) {
	rows := []struct {
		name string
		err  error
		exit int
		code string
	}{
		{"unclassified", errors.New("boom"), 1, clierr.CodeInternal},
		{"auth", &api.APIError{StatusCode: 401, Message: "sign in"}, 4, clierr.CodeAuthRequired},
		{"forbidden", &api.APIError{StatusCode: 403, Message: "no"}, 5, clierr.CodeForbidden},
		{"not found", fmt.Errorf("failed to get cluster: %w", &api.APIError{StatusCode: 404, Message: "gone"}), 6, clierr.CodeNotFound},
		{"conflict", &api.APIError{StatusCode: 409, Message: "exists"}, 7, clierr.CodeConflict},
		{"usage", clierr.Wrap(clierr.CodeInvalidFlag, errors.New("unknown flag: --nope")), 8, clierr.CodeInvalidFlag},
		{"confirmation required", errConfirmRequiresYes, 9, clierr.CodeConfirmationRequired},
		{"rate limited", &api.APIError{StatusCode: 429, Message: "slow down"}, 10, clierr.CodeRateLimited},
		{"unavailable", &api.TransportError{Err: errors.New("connection refused")}, 11, clierr.CodeNetworkUnreachable},
		{"wait timeout", clierr.New(clierr.CodeWaitTimeout, "still running"), 12, clierr.CodeWaitTimeout},
		{"operation failed", clierr.New(clierr.CodeOperationFailed, "job failed"), 13, clierr.CodeOperationFailed},
		{"cli too old", &api.APIError{StatusCode: 400, Code: clierr.CodeCLITooOld, Message: "update"}, 14, clierr.CodeCLITooOld},
		{"interrupted", clierr.New(clierr.CodeInterrupted, "interrupted"), 130, clierr.CodeInterrupted},
	}

	covered := map[int]bool{}
	for _, row := range rows {
		covered[row.exit] = true
		t.Run(row.name+"/human", func(t *testing.T) {
			stdout, stderr, code := hygCliStdoutFatal(t, func() {
				errorFormat = ui.FormatTable
				fail(row.err)
			})
			if code != row.exit {
				t.Errorf("exit = %d, want %d", code, row.exit)
			}
			if stdout != "" {
				t.Errorf("the error reached stdout, which is the document: %q", stdout)
			}
			if !strings.Contains(stderr, ui.SymbolError+" "+row.err.Error()) {
				t.Errorf("stderr does not carry the error: %q", stderr)
			}
		})
		t.Run(row.name+"/json", func(t *testing.T) {
			stdout, stderr, code := hygCliStdoutFatal(t, func() {
				errorFormat = ui.FormatJSON
				fail(row.err)
			})
			if stdout != "" {
				t.Errorf("the error reached stdout, which is the document: %q", stdout)
			}
			gotCode, gotExit := hygCliStdoutEnvelope(t, stderr)
			if code != row.exit || gotExit != row.exit || gotCode != row.code {
				t.Errorf("exit=%d envelope exit_code=%d code=%q, want %d and %q", code, gotExit, gotCode, row.exit, row.code)
			}
		})
	}
	for _, def := range clierr.Classes() {
		if !covered[def.Exit] {
			t.Errorf("exit %d (%s) is never driven through the fatal path here", def.Exit, def.Class)
		}
	}
}

// TestHygCliStdout_FailfKeepsATypedCause pins that failf wraps: a typed error passed with %w still
// decides the exit code, and the caller's prefix is still what the person reads.
func TestHygCliStdout_FailfKeepsATypedCause(t *testing.T) {
	stdout, stderr, code := hygCliStdoutFatal(t, func() {
		errorFormat = ui.FormatTable
		failf("failed to list runners: %w", &api.APIError{StatusCode: 403, Message: "no"})
	})
	if code != clierr.ExitForbidden {
		t.Errorf("exit = %d, want %d", code, clierr.ExitForbidden)
	}
	if stdout != "" || !strings.Contains(stderr, "failed to list runners: no (status 403)") {
		t.Errorf("stdout=%q stderr=%q", stdout, stderr)
	}
}

// TestHygCliStdout_ARefusalFromCobraIsPrintedOnceOnStderr drives Execute with a command and a flag
// cobra rejects. Each must be reported once — cobra printing it too, and following it with the usage
// text, is the duplication the root's silence flags remove — and each is a usage error.
func TestHygCliStdout_ARefusalFromCobraIsPrintedOnceOnStderr(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
		say  string
		code string
	}{
		{"unknown command", []string{"definitely-not-a-command"}, `unknown command "definitely-not-a-command"`, clierr.CodeInvalidUsage},
		{"unknown flag", []string{"version", "--definitely-not-a-flag"}, "unknown flag: --definitely-not-a-flag", clierr.CodeInvalidFlag},
	} {
		t.Run(tc.name+"/human", func(t *testing.T) {
			resetFlagsAroundTest(t)
			stdout, stderr, code := hygCliStdoutFatal(t, func() {
				execRootArgs(tc.args)
				Execute()
			})
			if code != clierr.ExitUsage {
				t.Errorf("exit = %d, want %d", code, clierr.ExitUsage)
			}
			if stdout != "" {
				t.Errorf("stdout is not empty: %q", stdout)
			}
			if n := strings.Count(stderr, tc.say); n != 1 {
				t.Errorf("the refusal appears %d times on stderr, want once: %q", n, stderr)
			}
			if strings.Contains(stderr, "Usage:") {
				t.Errorf("the usage text was printed after the error: %q", stderr)
			}
		})
	}
}

// TestHygCliStdout_ARejectedFlagHonoursTheFormatAlreadyParsed pins how far `--output json` reaches
// into cobra's own refusals, in both directions, because the boundary is not where one would guess.
//
// Flags are parsed left to right and parsing stops at the one cobra rejects, so a format given
// BEFORE it is known and the refusal is an envelope. A command cobra cannot resolve is refused
// before any flag is parsed at all, so that refusal is always the human form — with the same exit
// code, which is the half a script reads.
func TestHygCliStdout_ARejectedFlagHonoursTheFormatAlreadyParsed(t *testing.T) {
	t.Run("a rejected flag after --output json is an envelope", func(t *testing.T) {
		resetFlagsAroundTest(t)
		stdout, stderr, code := hygCliStdoutFatal(t, func() {
			execRootArgs([]string{"version", "--output", "json", "--definitely-not-a-flag"})
			Execute()
		})
		if stdout != "" {
			t.Errorf("stdout is not empty: %q", stdout)
		}
		gotCode, gotExit := hygCliStdoutEnvelope(t, stderr)
		if code != clierr.ExitUsage || gotExit != clierr.ExitUsage || gotCode != clierr.CodeInvalidFlag {
			t.Errorf("exit=%d envelope exit_code=%d code=%q", code, gotExit, gotCode)
		}
	})
	t.Run("an unknown command is refused before --output is read", func(t *testing.T) {
		resetFlagsAroundTest(t)
		stdout, stderr, code := hygCliStdoutFatal(t, func() {
			execRootArgs([]string{"--output", "json", "definitely-not-a-command"})
			Execute()
		})
		if code != clierr.ExitUsage || stdout != "" {
			t.Errorf("exit=%d stdout=%q", code, stdout)
		}
		if !strings.Contains(stderr, ui.SymbolError+` unknown command "definitely-not-a-command"`) {
			t.Errorf("stderr = %q", stderr)
		}
	})
}

// TestHygCliStdout_TheHumanFormCarriesTheHintAndTheRequestID pins the lines under the message: what
// the control plane sent to help — a next step, a docs link, the id of the failed request — reaches
// the person, on stderr.
func TestHygCliStdout_TheHumanFormCarriesTheHintAndTheRequestID(t *testing.T) {
	stdout, stderr, code := hygCliStdoutFatal(t, func() {
		errorFormat = ui.FormatTable
		fail(&api.APIError{
			StatusCode: 404, Message: "No such cluster",
			Hint: "alethia cluster list", DocsURL: "https://example.test/e", RequestID: "req_01",
		})
	})
	if code != clierr.ExitNotFound || stdout != "" {
		t.Errorf("exit=%d stdout=%q", code, stdout)
	}
	for _, want := range []string{"hint     alethia cluster list", "docs     https://example.test/e", "request  req_01"} {
		if !strings.Contains(stderr, want) {
			t.Errorf("stderr is missing %q:\n%s", want, stderr)
		}
	}
}

// TestHygCliStdout_UsageErrorKeepsAnExistingClass pins the one branch Execute cannot reach today:
// an error that already carries a class is not re-labelled as a usage error.
func TestHygCliStdout_UsageErrorKeepsAnExistingClass(t *testing.T) {
	typed := error(&api.APIError{StatusCode: 404, Message: "gone"})
	if got := usageError(typed); got != typed {
		t.Errorf("a classified error was re-wrapped: %v", got)
	}
	if got := clierr.From(usageError(errors.New("accepts 1 arg(s), received 0"))); got.Code != clierr.CodeInvalidUsage {
		t.Errorf("an unclassified error from cobra got code %q, want %q", got.Code, clierr.CodeInvalidUsage)
	}
}

// TestHygCliStdout_ASuccessfulRunRecordsItsFormat pins the wiring between --output and the fatal
// path: the root PersistentPreRun records the format of the run in progress, so an error raised
// inside a `-o json` command is an envelope and one raised inside the next plain command is not.
func TestHygCliStdout_ASuccessfulRunRecordsItsFormat(t *testing.T) {
	run := miscEnv(t, miscFull)
	prev := errorFormat
	t.Cleanup(func() { errorFormat = prev })

	for _, want := range []string{ui.FormatJSON, ui.FormatTable} {
		_, _ = captureStreams(t, func() {
			if err := run("version", "--output", want); err != nil {
				t.Errorf("version --output %s: %v", want, err)
			}
		})
		if errorFormat != want {
			t.Errorf("after a --output %s run the fatal path would render %q", want, errorFormat)
		}
	}
}

// TestHygCliStdout_ASubcommandsOwnOutputFlagIsNotAFormat covers `cluster kubeconfig --output FILE`,
// which reuses the flag's name for a path. The fatal path reads the ROOT's flag, so a file that
// happens to be called "json" does not turn that command's errors into envelopes.
func TestHygCliStdout_ASubcommandsOwnOutputFlagIsNotAFormat(t *testing.T) {
	resetFlagsAroundTest(t)
	kubeconfig, _, err := rootCmd.Find([]string{"cluster", "kubeconfig"})
	if err != nil {
		t.Fatalf("find cluster kubeconfig: %v", err)
	}
	if err := kubeconfig.Flags().Set("output", ui.FormatJSON); err != nil {
		t.Fatalf("set the local --output: %v", err)
	}
	if got := rootOutputFormat(kubeconfig); got != ui.FormatTable {
		t.Errorf("the fatal path read the subcommand's file path as a format: %q", got)
	}
}
