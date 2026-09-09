// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
)

// TestJobTypeLabels_CoverAllJobTypes is the map-side counterpart to the exhaustive-linted
// switches: `exhaustive` can enforce `switch` statements but not maps, so this asserts
// every provision_job_type value (generated into types.AllJobTypes from the drizzle enum
// SSOT) has a friendly label. Adding a job type without a label fails the build.
func TestJobTypeLabels_CoverAllJobTypes(t *testing.T) {
	for _, jt := range types.AllJobTypes {
		if jobTypeLabels[string(jt)] == "" {
			t.Errorf("provision_job_type %q has no entry in jobTypeLabels — add one in jobs_list.go", jt)
		}
	}
}

// ── The `jobs list` status form (#4450) ──────────────────────────────────────────────────────
//
// `jobs list` took two flags and offered no way to be asked for either, so the only way to filter
// by status was to already know provision_job_status. The form is the same ask-or-default shape
// `members add --role` and `roles create` use: a person at a terminal is asked, a scripted caller
// is SERVED rather than refused, and `--status` still sets everything the picker can choose.

// jobsListForceTerminal makes every TTY question this command asks answer yes — the table's
// (stdout) and the form's (stderr), which are deliberately different file descriptors.
//
// noInputMode is set explicitly rather than left to resolveInputMode: the unit tests below call
// jobsListStatusFor directly and never go through the root's PersistentPreRun, so the package
// global would otherwise carry in whatever the previous test in the package left there.
func jobsListForceTerminal(t *testing.T) {
	t.Helper()
	oldIn, oldOut, oldForm, oldMode := stdinIsTTY, stdoutIsTTY, interactiveOutIsTTY, noInputMode
	stdinIsTTY = func() bool { return true }
	stdoutIsTTY = func() bool { return true }
	interactiveOutIsTTY = func() bool { return true }
	noInputMode = false
	t.Cleanup(func() {
		stdinIsTTY, stdoutIsTTY, interactiveOutIsTTY, noInputMode = oldIn, oldOut, oldForm, oldMode
	})
}

// jobsListStubPrompt replaces the picker with one that answers `answer`, and reports what it was
// seeded with.
//
// The answer is a value the caller could NOT have produced any other way — the flag is empty in
// every test that uses this — so a wiring that quietly ignored the form would read as the empty
// filter and fail, rather than passing because the stub happened to echo its argument.
func jobsListStubPrompt(t *testing.T, answer string) *string {
	t.Helper()
	seen := new(string)
	prev := promptJobsListStatus
	promptJobsListStatus = func(current string) (string, error) {
		*seen = current
		return answer, nil
	}
	t.Cleanup(func() { promptJobsListStatus = prev })
	return seen
}

// jobsListRefusePrompt fails the test if the picker is opened at all.
func jobsListRefusePrompt(t *testing.T) {
	t.Helper()
	prev := promptJobsListStatus
	promptJobsListStatus = func(current string) (string, error) {
		t.Errorf("the status picker was opened; it must not be")
		return current, nil
	}
	t.Cleanup(func() { promptJobsListStatus = prev })
}

// TestJobsListStatusOptions_AreEveryStatusThenTheEnum pins the picker's vocabulary against the
// generated enum, in order and in both directions. A huh.Group answers no question about the
// options it was handed, so this is the only shape of the picker a test can read — which is why
// jobsListStatusOptions is a function rather than an expression inside the form.
func TestJobsListStatusOptions_AreEveryStatusThenTheEnum(t *testing.T) {
	opts := jobsListStatusOptions()
	want := jobStatusValues()
	if len(want) == 0 {
		t.Fatal("provision_job_status generated no values — this test would otherwise be vacuous")
	}
	if len(opts) != len(want)+1 {
		t.Fatalf("picker has %d options, want %d (every status + the enum)", len(opts), len(want)+1)
	}
	if opts[0].Value != "" {
		t.Errorf("first option filters by %q; the unfiltered option must carry the empty value the "+
			"flag carries when nobody set it", opts[0].Value)
	}
	if opts[0].Key != jobsListEveryStatusLabel {
		t.Errorf("first option reads %q, want %q", opts[0].Key, jobsListEveryStatusLabel)
	}
	for i, s := range want {
		if opts[i+1].Value != s || opts[i+1].Key != s {
			t.Errorf("option %d is %q/%q, want %q", i+1, opts[i+1].Key, opts[i+1].Value, s)
		}
	}
}

// TestJobsListStatusFor_TheFlagWins pins that a --status the operator typed is never re-asked.
func TestJobsListStatusFor_TheFlagWins(t *testing.T) {
	jobsListForceTerminal(t)
	jobsListRefusePrompt(t)
	got, err := jobsListStatusFor(testCmd("table", false), "FAILED")
	if err != nil {
		t.Fatalf("jobsListStatusFor: %v", err)
	}
	if got != "FAILED" {
		t.Errorf("status = %q, want FAILED", got)
	}
}

// TestJobsListStatusFor_HeadlessIsServedNotRefused is the --no-input arm. `jobs list` takes no
// required input, so a caller that cannot be asked gets the unfiltered list and a nil error —
// refusing here would break every pipeline that runs `alethia jobs list -o json`.
func TestJobsListStatusFor_HeadlessIsServedNotRefused(t *testing.T) {
	jobsListForceTerminal(t)
	noInputMode = true
	jobsListRefusePrompt(t)
	got, err := jobsListStatusFor(testCmd("table", true), "")
	if err != nil {
		t.Fatalf("headless jobs list must be served, not refused: %v", err)
	}
	if got != "" {
		t.Errorf("status = %q, want the empty (unfiltered) value", got)
	}
}

// TestJobsListStatusFor_ADocumentIsNeverBlockedOnAQuestion pins the second condition: `-o json`
// is a document, and a document that will not appear until someone answers a picker is the
// `jobs list -o json > jobs.json` spinner defect one level up.
func TestJobsListStatusFor_ADocumentIsNeverBlockedOnAQuestion(t *testing.T) {
	jobsListForceTerminal(t)
	jobsListRefusePrompt(t)
	got, err := jobsListStatusFor(testCmd("json", false), "")
	if err != nil {
		t.Fatalf("jobsListStatusFor: %v", err)
	}
	if got != "" {
		t.Errorf("status = %q, want the empty (unfiltered) value", got)
	}
}

// TestJobsListStatusFor_AsksAReaderWhoIsBrowsing is the answered arm: a terminal, a table, and no
// --status of the reader's own.
func TestJobsListStatusFor_AsksAReaderWhoIsBrowsing(t *testing.T) {
	jobsListForceTerminal(t)
	seeded := jobsListStubPrompt(t, string(types.JobStatusProcessing))
	got, err := jobsListStatusFor(testCmd("table", false), "")
	if err != nil {
		t.Fatalf("jobsListStatusFor: %v", err)
	}
	if got != string(types.JobStatusProcessing) {
		t.Errorf("status = %q, want the form's answer %q", got, types.JobStatusProcessing)
	}
	if *seeded != "" {
		t.Errorf("the form was seeded with %q, want the flag's empty value", *seeded)
	}
}

// TestPromptJobsListStatus_KeepsTheSeedAndPropagatesTheError drives the form itself. No stub can
// answer THROUGH the pointer the huh group owns, so what is provable here is the other half: a
// form that was not completed leaves the caller's value alone, and a form that failed says so.
func TestPromptJobsListStatus_KeepsTheSeedAndPropagatesTheError(t *testing.T) {
	prev := runHuhForm
	t.Cleanup(func() { runHuhForm = prev })

	runHuhForm = func(...*huh.Group) error { return nil }
	got, err := promptJobsListStatus("QUEUED")
	if err != nil || got != "QUEUED" {
		t.Errorf("unanswered form returned (%q, %v), want (QUEUED, nil)", got, err)
	}

	boom := errors.New("form is unhappy")
	runHuhForm = func(...*huh.Group) error { return boom }
	got, err = promptJobsListStatus("QUEUED")
	if !errors.Is(err, boom) {
		t.Errorf("error = %v, want %v", err, boom)
	}
	if got != "QUEUED" {
		t.Errorf("status = %q, want the seed back", got)
	}
}

// TestJobsList_TheFormsAnswerReachesTheRequest is the production path, end to end through the real
// cobra tree: no --status on the command line, a terminal, and the status the picker chose is the
// one the control plane is asked for.
//
// The command exits 1 because the bubbletea table cannot open a TTY under `go test` — the same
// expectation cov_lists_test.go records for `jobs list` — and that is AFTER the fetch, which is
// the thing under test.
func TestJobsList_TheFormsAnswerReachesTheRequest(t *testing.T) {
	srv, run := jobsCmdEnv(t)
	jobsListForceTerminal(t)
	jobsListStubPrompt(t, string(types.JobStatusProcessing))

	_ = run("jobs", "list")

	srv.mu.Lock()
	query := srv.listQuery
	srv.mu.Unlock()
	if !strings.Contains(query, "status="+string(types.JobStatusProcessing)) {
		t.Errorf("GET /api/jobs query = %q, want it to carry the status the form chose (%s)",
			query, types.JobStatusProcessing)
	}
}

// TestJobsList_NoFormMeansNoFilter is the control for the test above: same command, same terminal,
// with the picker unavailable. Without it, a wiring that always sent PROCESSING would pass.
func TestJobsList_NoFormMeansNoFilter(t *testing.T) {
	srv, run := jobsCmdEnv(t)
	jobsListForceTerminal(t)
	interactiveOutIsTTY = func() bool { return false }
	jobsListRefusePrompt(t)

	_ = run("jobs", "list")

	srv.mu.Lock()
	query := srv.listQuery
	srv.mu.Unlock()
	if strings.Contains(query, "status=") {
		t.Errorf("GET /api/jobs query = %q, want no status filter when nothing chose one", query)
	}
}

// jobsListFailPrompt replaces the picker with one that fails with err.
func jobsListFailPrompt(t *testing.T, err error) {
	t.Helper()
	prev := promptJobsListStatus
	promptJobsListStatus = func(current string) (string, error) { return current, err }
	t.Cleanup(func() { promptJobsListStatus = prev })
}

// TestJobsListStatusFor_AnAbortStopsTheCommand pins the half of the failure case that is an
// INSTRUCTION. Esc at the picker means the reader changed their mind, and a command that answered
// it by listing everything would be doing the one thing they just declined.
func TestJobsListStatusFor_AnAbortStopsTheCommand(t *testing.T) {
	jobsListForceTerminal(t)
	jobsListFailPrompt(t, huh.ErrUserAborted)
	if _, err := jobsListStatusFor(testCmd("table", false), ""); !errors.Is(err, huh.ErrUserAborted) {
		t.Errorf("error = %v, want huh.ErrUserAborted back", err)
	}
}

// TestJobsListStatusFor_APickerThatCannotBeShownStillLists pins the other half. canPromptForm is a
// TTY question and huh additionally needs a /dev/tty it can open, so the gate can say yes to a form
// that then cannot draw — under `go test`, exactly that happens. A filter that could not be offered
// must not take the list away.
func TestJobsListStatusFor_APickerThatCannotBeShownStillLists(t *testing.T) {
	jobsListForceTerminal(t)
	jobsListFailPrompt(t, errors.New("huh: could not open a new TTY"))
	got, err := jobsListStatusFor(testCmd("table", false), "")
	if err != nil {
		t.Fatalf("a picker that cannot be shown must not fail the list: %v", err)
	}
	if got != "" {
		t.Errorf("status = %q, want the empty (unfiltered) value", got)
	}
}

// TestJobsList_AnAbortedPickerNeverFetches is the abort arm end to end. The reader declined to
// choose, so the command stops — and it stops BEFORE the round trip, because a list nobody asked
// for is not worth a request.
func TestJobsList_AnAbortedPickerNeverFetches(t *testing.T) {
	srv, run := jobsCmdEnv(t)
	jobsListForceTerminal(t)
	jobsListFailPrompt(t, huh.ErrUserAborted)

	if code := run("jobs", "list"); code == 0 {
		t.Errorf("exit code = 0; an aborted picker must not report success")
	}
	if srv.count() != 0 {
		t.Errorf("the control plane was called %d time(s) after the picker was aborted", srv.count())
	}
}
