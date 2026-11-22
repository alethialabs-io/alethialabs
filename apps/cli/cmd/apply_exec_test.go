// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
)

// applyExec runs executeApply for a test that reads what it narrated: both of the Printer's
// streams are out, in the table format, with no deadline. The result and the error are
// executeApply's own.
func applyExec(c applyClient, out io.Writer, plan *ApplyPlan, runnerID string, wait bool) (*ApplyResult, error) {
	p := &Printer{Out: out, Err: out, Format: ui.FormatTable, Mode: Mode{Color: true}}
	return executeApply(context.Background(), c, p, plan, runnerID, waitFlags{Wait: wait})
}

// consoleExportTo runs runConsoleExport for a test that reads what it wrote: both of the Printer's
// streams are out. An existing outFile is replaced, as `config export` has always done.
func consoleExportTo(c consoleExporter, out io.Writer, format, project, contentFormat, env, outFile string) error {
	p := &Printer{Out: out, Err: out, Format: format, Mode: Mode{Color: true}}
	return runConsoleExport(c, p, consoleExport{
		project: project, env: env, out: outFile, force: true, contentFormat: contentFormat,
	})
}

// applyCaptureBoth captures stdout AND stderr as one stream until the returned func is called, for
// a test that reads the plan (stdout) together with the progress said about it (stderr).
func applyCaptureBoth(t *testing.T) func() string {
	t.Helper()
	read := projCaptureStdout(t)
	prev := os.Stderr
	os.Stderr = os.Stdout
	t.Cleanup(func() { os.Stderr = prev })
	return func() string {
		os.Stderr = prev
		return read()
	}
}

// applyMutation is `apply --output json` as a reader decodes it: the shared result shape, with the
// apply's own record as its object.
type applyMutation struct {
	ID     string       `json:"id"`
	Kind   string       `json:"kind"`
	Action ResultAction `json:"action"`
	Job    *JobRef      `json:"job"`
	DryRun bool         `json:"dry_run"`
	Object ApplyResult  `json:"object"`
}

// applyResultOf decodes the first JSON value of out as an apply result and returns its object. It
// fails the test when out is not the shared result shape about a project.
func applyResultOf(t *testing.T, out string) ApplyResult {
	t.Helper()
	var got applyMutation
	if err := json.NewDecoder(strings.NewReader(out)).Decode(&got); err != nil {
		t.Fatalf("apply --output json is not the result shape: %v\n%s", err, out)
	}
	if got.Kind != "project" || got.ID != got.Object.ProjectID || got.DryRun {
		t.Fatalf("the result is not about the project it names: %+v", got)
	}
	return got.Object
}
