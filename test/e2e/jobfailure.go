// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// FormatJobFailure renders a failed job's error_message plus the gitops_status recorded in its
// execution_metadata as a short block for a test failure message.
//
// It exists because the T2 failure dump was effectively unreadable in CI: the runner-output buffer
// it printed is truncated by the log renderer long before the actual error, so triaging a red
// nightly meant downloading the t2-runner-log artifact (#1734). The runner already writes both of
// these columns on the failure path — nothing new is recorded, it was just never read.
//
// Defensive by construction: nil, empty, undecodable and gitops_status-free metadata each yield
// their own LABELLED line rather than an error. This runs inside a failure report and must never
// mask the failure it is decorating. Pure/unit-tested.
func FormatJobFailure(errMsg string, metaRaw []byte) string {
	var b strings.Builder
	b.WriteString("──── job failure (DB row) ────\n")

	if strings.TrimSpace(errMsg) == "" {
		b.WriteString("error_message: (empty — the runner recorded no reason)\n")
	} else {
		b.WriteString("error_message: " + strings.TrimSpace(errMsg) + "\n")
	}

	if len(metaRaw) == 0 {
		b.WriteString("execution_metadata: (absent — no status callback carried a post-apply result)\n")
		return b.String()
	}

	var meta struct {
		GitopsStatus *struct {
			Mode       string `json:"mode"`
			FailedStep string `json:"failed_step"`
			Error      string `json:"error"`
		} `json:"gitops_status"`
	}
	if err := json.Unmarshal(metaRaw, &meta); err != nil {
		b.WriteString(fmt.Sprintf("execution_metadata: (undecodable: %v)\n", err))
		return b.String()
	}
	if meta.GitopsStatus == nil {
		b.WriteString("gitops_status: (absent — the deploy did not reach the GitOps wiring)\n")
		return b.String()
	}
	b.WriteString("gitops_status.mode:        " + orNone(meta.GitopsStatus.Mode) + "\n")
	b.WriteString("gitops_status.failed_step: " + orNone(meta.GitopsStatus.FailedStep) + "\n")
	b.WriteString("gitops_status.error:       " + orNone(meta.GitopsStatus.Error) + "\n")
	return b.String()
}

// orNone renders an empty field as an explicit marker, so a blank line is never mistaken for a
// field that was not printed.
func orNone(s string) string {
	if strings.TrimSpace(s) == "" {
		return "(none)"
	}
	return strings.TrimSpace(s)
}

// jobFailureDump reads a job's failure columns and renders them. Never fails: a read error becomes
// a labelled line, because the caller is already reporting a failure and a second one would
// replace the real cause.
//
// It deliberately detaches from the caller's cancellation. One of its two call sites is the
// WaitTerminal timeout, where the test context is frequently ALREADY expired — inheriting it would
// make the dump report "context deadline exceeded" precisely when the diagnosis matters most.
func jobFailureDump(ctx context.Context, cp *ControlPlane, jobID string) string {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()

	errMsg, metaRaw, err := cp.JobFailureDetail(ctx, jobID)
	if err != nil {
		return "──── job failure (DB row) ────\n(could not read the job row: " + err.Error() + ")\n"
	}
	return FormatJobFailure(errMsg, metaRaw)
}
