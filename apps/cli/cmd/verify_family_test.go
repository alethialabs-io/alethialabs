// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

// The verify group's refusals, each with the exit code its class owns.

// TestVerify_AJobWithNoReceiptSaysWhichKind: a job that will never carry a receipt is not found
// (exit 6); one that has not finished is a conflict (exit 7), because the same command succeeds
// once the job's state has changed. Both are still "no receipt" to errors.Is.
func TestVerify_AJobWithNoReceiptSaysWhichKind(t *testing.T) {
	finished := noReceiptErr(&api.ProvisionJob{ID: "j1", Status: "SUCCESS"})
	if e := clierr.From(finished); e.Exit != clierr.ExitNotFound || e.Hint == "" {
		t.Errorf("finished job: %+v", e)
	}

	for _, status := range []string{"QUEUED", "CLAIMED", "PROCESSING"} {
		err := noReceiptErr(&api.ProvisionJob{ID: "j1", Status: status})
		e := clierr.From(err)
		if e.Exit != clierr.ExitConflict {
			t.Errorf("%s: exit %d, want %d", status, e.Exit, clierr.ExitConflict)
		}
		if !errors.Is(err, errNoReceipt) {
			t.Errorf("%s: the refusal is no longer errNoReceipt", status)
		}
		if e.Hint != "alethia jobs logs j1 --follow" || !strings.Contains(e.Message, status) {
			t.Errorf("%s: hint %q message %q", status, e.Hint, e.Message)
		}
	}
}

// TestVerify_BadKeyFlagsAreUsageErrors: a key that cannot be read is a statement about the command
// line, so it exits 8.
func TestVerify_BadKeyFlagsAreUsageErrors(t *testing.T) {
	cases := map[string][2]string{
		"both":         {"AAAA", "some-file"},
		"not base64":   {"***", ""},
		"wrong size":   {"AAAA", ""},
		"missing file": {"", "/no/such/key/file"},
	}
	for name, kv := range cases {
		_, err := pinnedKey(kv[0], kv[1])
		if e := clierr.From(err); e == nil || e.Exit != clierr.ExitUsage {
			t.Errorf("%s: got %+v, want exit %d", name, e, clierr.ExitUsage)
		}
	}
	if pub, err := pinnedKey("", ""); pub != nil || err != nil {
		t.Errorf("no key given must be no key and no error, got %v %v", pub, err)
	}
}

// TestVerifyShow_RefusalsKeepStdoutEmpty: a job that cannot be read, and one with no receipt, each
// fail with their class and write nothing on stdout, in every format.
func TestVerifyShow_RefusalsKeepStdoutEmpty(t *testing.T) {
	for _, format := range []string{ui.FormatTable, ui.FormatJSON, ui.FormatCSV} {
		var out bytes.Buffer
		missing := &fakeClient{err: &api.APIError{StatusCode: http.StatusNotFound, Message: "Job not found"}}
		err := runVerifyShow(missing, &out, format, "j9")
		if e := clierr.From(err); e.Exit != clierr.ExitNotFound || e.Hint != "alethia jobs list" {
			t.Errorf("%s, missing job: %+v", format, e)
		}
		if out.Len() != 0 {
			t.Errorf("%s: stdout is not empty on a refusal: %q", format, out.String())
		}

		out.Reset()
		running := &fakeClient{job: &api.ProvisionJob{ID: "j1", JobType: "PLAN", Status: "PROCESSING"}}
		err = runVerifyShow(running, &out, format, "j1")
		if e := clierr.From(err); e.Exit != clierr.ExitConflict {
			t.Errorf("%s, running job: %+v", format, e)
		}
		if out.Len() != 0 {
			t.Errorf("%s: stdout is not empty on a refusal: %q", format, out.String())
		}
	}
}
