// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// ONE WAY TO RUN A KUBECTL READ IN THIS PACKAGE.
//
// There were two, written a day apart for the same reason and differing in ways that matter:
// `kubectlValue` (argo_stuck_sync.go) picked the right stderr LINE but discarded stdout on failure;
// `kubectlRead` (bootstrap_job_dump.go) kept the partial stdout but took stderr's first line. Both
// were correct about one half of a defect the other had. Two helpers over one operation is how that
// happens, so there is one now.
//
// Around them, five more call sites used `exec.Output()` directly and rendered every fault as
// `exit status 1` — a missing CRD, an RBAC refusal and an unreachable API server, three faults with
// three different next steps, printed as one number, in dumps whose only job is to say which.

// kubectlRead runs one kubectl read and returns STDOUT, with kubectl's own words folded into the
// error.
//
// **The stdout is returned even on failure**, because a partial answer is still an answer.
// `kubectl logs -l` reads a Job's or a Deployment's pods in sequence and bails at the first one it
// cannot open — after writing the ones before it. On a cluster unhealthy enough to be in a deadline
// dump, an unopenable pod is likely, and discarding what came back loses exactly the evidence the
// dump exists to show.
//
// **Stderr stays OUT of the value.** These callers parse JSON or jsonpath, and kubectl writes to
// stderr on calls that SUCCEED — so folding the streams would hand a parser a document with a
// deprecation warning glued to the front.
func kubectlRead(ctx context.Context, timeout time.Duration, kubeconfigPath string, args ...string) ([]byte, error) {
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	full := append([]string{"--kubeconfig", kubeconfigPath}, args...)
	var stderr strings.Builder
	cmd := exec.CommandContext(cctx, "kubectl", full...)
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		if msg := kubectlErrorLine(stderr.String()); msg != "" {
			return out, fmt.Errorf("%w: %s", err, msg)
		}
		return out, err
	}
	return out, nil
}
