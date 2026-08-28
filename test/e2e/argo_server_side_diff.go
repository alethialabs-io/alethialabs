// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The one comparison nothing was running: argo-cd's OWN Server-Side Diff.
//
// # Why this exists, and what it is NOT
//
// After the chart pin moved to 9.5.11 → argo-cd v3.3.9 (#3128), hetzner/addons run 33162842830 left
// exactly four StatefulSets OutOfSync — addon-harbor-{database,redis,trivy} and addon-tempo — while
// three diagnostics all said the cluster was fine:
//
//	argocd app diff            prints nothing
//	hard refresh               still OutOfSync, so it is not a stale cache
//	reconciledAt               1m9s / 1m47s ago, so the status is FRESH
//	predicted-live dry-run     "predicts the LIVE object EXACTLY" for all four
//
// The last of those is the important one and it is also the LIMIT of what it can say. It is a
// `kubectl apply --server-side --dry-run=server --field-manager=argocd-controller` run by THIS
// harness. It reproduces the shape of argo-cd's Server-Side Diff, but it is not argo-cd's:
// argo-cd's own path additionally applies its normalizers, honours `ignoreDifferences` under
// `RespectIgnoreDifferences=true`, and post-processes the predicted object to drop fields no
// manager owns (removeWebhookMutation). So "kubectl's dry-run matches live" leaves open whether
// ARGO-CD's server-side diff would also match — and that is precisely the question, because
// `compare-options: ServerSideDiff=true` is the switch that would make the controller use it.
//
// Since v3.2.0 the CLI can run that exact comparison on demand: `argocd app diff --server-side-diff`.
// The controller is still on structured-merge diff (no ServerSideDiff compare-option is set), so
// asking the CLI for the server-side answer costs one exec on an already-failing path and settles a
// question that otherwise costs a paid run:
//
//	prints nothing   argo-cd's own server-side comparison agrees with the cluster. The OutOfSync is
//	                 an artefact of the structured-merge strategy, and flipping the compare-option is
//	                 a MEASURED fix rather than a guess.
//	prints a diff    it NAMES THE FIELD. That is the evidence #2717 has been missing, and the thing
//	                 no ignoreDifferences entry may be written without.
//
// # Every failure to ask renders as COULD NOT ASK
//
// The same rule as the rest of this probe, with two extra traps that are specific to this flag:
//
//	`argocd app diff` exits 1 BOTH when it found a difference and when it rejected the command
//	  line. An `unknown flag: --server-side-diff` on an older CLI would render as "a diff was
//	  found" — the single most misleading thing this file could say. It is detected explicitly.
//	Passing the flag on an Application that does NOT carry the annotation makes the CLI print
//	  `Warning: Application does not have ServerSideDiff=true annotation.` (cmd/argocd/commands/
//	  app.go at v3.3.9) — on stderr, on the success path. That is our exact situation, so a
//	  combined stream would have made every clean run print a "diff". Only stdout is ever read as
//	  a comparison.
package e2e

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

// argoServerSideDiff runs argo-cd's own Server-Side Diff for one Application and reports what it
// found. Best-effort on an already-failing path; bounded by the caller's context.
func argoServerSideDiff(ctx context.Context, kubeconfigPath, workload, app string) string {
	cmd := exec.CommandContext(ctx, "kubectl", "--kubeconfig", kubeconfigPath,
		"-n", "argocd", "exec", workload, "--",
		"argocd", "app", "diff", app, "--core", "--server-side-diff")
	// STDOUT AND STDERR ARE KEPT APART, and that is the whole safety property — see
	// describeArgoServerSideDiff. Combining them made `kubectl exec` into a missing pod render as
	// "NAMES A DIFFERENCE: Error from server (NotFound)", i.e. a fabricated field on the one issue
	// where a fabricated field is the failure mode.
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return describeArgoServerSideDiff(app, stdout.String(), stderr.String(), err)
}

// argoServerSideDiffUnsupported are the strings a CLI that does not know `--server-side-diff` puts
// on stderr. Matched case-insensitively.
//
// This list exists because the failure it catches EXITS 1, exactly like a found difference, and the
// two render as opposite findings.
var argoServerSideDiffUnsupported = []string{
	"unknown flag",
	"unknown shorthand flag",
	"flag provided but not defined",
}

// describeArgoServerSideDiff turns the command's output and exit status into a report block. Pure.
//
// Outcomes, and three of them are one sentence away from each other:
//
//	exit 1 + diff on STDOUT   a difference was found, and the output NAMES IT. The goal.
//	exit 1 + unknown flag     the CLI is too old to run this. Says NOTHING about a difference.
//	exit 0 + no stdout        argo-cd's own server-side comparison found nothing. A finding, and the
//	                          one that makes `ServerSideDiff=true` a measured fix rather than a guess.
//	anything else             could not ask.
//
// THE DIFF IS TAKEN FROM STDOUT ALONE, and nothing on stderr can produce a verdict. `kubectl exec`
// exits 1 for its OWN failures too — a missing pod, an unreadable kubeconfig — and it writes those
// to stderr while `argocd app diff` writes the diff to stdout. Reading a combined stream made
// `Error from server (NotFound): pods "x" not found` render as the field the controller is
// reacting to. That is not a cosmetic bug on this issue: a fabricated field is exactly what an
// ignoreDifferences entry would then be written from.
func describeArgoServerSideDiff(app, stdout, stderr string, err error) string {
	const lead = "  argo-cd's OWN server-side diff (`argocd app diff --server-side-diff`, the comparison `compare-options: ServerSideDiff=true` would make the controller run): "
	diff := strings.TrimSpace(stdout)
	problem := strings.TrimSpace(stderr)
	lower := strings.ToLower(diff + "\n" + problem)
	for _, marker := range argoServerSideDiffUnsupported {
		if strings.Contains(lower, marker) {
			// No version in this sentence, deliberately: it would be a literal claim about the
			// running CLI that nothing re-checks, which is the exact defect the diff-strategy
			// message had. The flag's introduction is recorded in this file's doc comment, where
			// it is provenance rather than a report about a live cluster.
			return lead + fmt.Sprintf("COULD NOT ASK — this argo-cd CLI does not accept --server-side-diff: %s. Nothing here says whether a field differs.", truncateDiff(argoServerSideDiffContext(diff, problem)))
		}
	}

	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() == argoDiffExitCodeMeansDiff && diff != "" {
			return lead + fmt.Sprintf("NAMES A DIFFERENCE for %s — this is the field the controller is reacting to, and the only evidence an ignoreDifferences entry may be written from:\n%s", app, truncateDiff(diff))
		}
		return lead + fmt.Sprintf("COULD NOT ASK (%v): %s", err, truncateDiff(argoServerSideDiffContext(diff, problem)))
	}

	if diff == "" {
		// The finding this probe was added for. Deliberately spelled out rather than left as an
		// absence, because "argo-cd's server-side diff found nothing" and "we did not run it" are
		// opposite answers that both print zero diff lines.
		return lead + fmt.Sprintf("finds NO difference for %s. Combined with the dry-run above, argo-cd's own server-side comparison agrees with the cluster while the controller — which is on STRUCTURED-MERGE diff, because no ServerSideDiff compare-option is set — does not. The remaining difference between the two verdicts is the diff STRATEGY, not the cluster.", app)
	}

	// Exit 0 WITH output. Not a shape argo-cd is documented to produce; report it rather than
	// forcing it into either verdict.
	return lead + fmt.Sprintf("exited 0 but printed output, which is neither of its documented outcomes — reporting it verbatim rather than reading it as a verdict:\n%s", truncateDiff(diff))
}

// argoServerSideDiffContext renders whatever the command left behind on a could-not-ask path, so
// the reason is never blank. Pure.
//
// "(no output)" is deliberate rather than an empty string: a report that just stops reads as though
// the probe had nothing to say, and this branch's whole job is to say it could not look.
func argoServerSideDiffContext(diff, problem string) string {
	parts := make([]string, 0, 2)
	if problem != "" {
		parts = append(parts, problem)
	}
	if diff != "" {
		parts = append(parts, diff)
	}
	if len(parts) == 0 {
		return "(no output)"
	}
	return strings.Join(parts, "\n")
}
