// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// THE ONE-SHOT BOOTSTRAP JOBS, WHICH NOTHING WAS LOOKING AT.
//
// Some add-ons cannot converge on the chart alone. Vault installs sealed and stays Progressing until
// a Job initialises and unseals it; the keyless database bootstrap is the same shape. Those Jobs are
// applied and deliberately NOT waited on — EnsureAddOnBootstraps says why, and it is right: "the
// health wait that follows is what observes the result".
//
// What that wait observes is an Application stuck Progressing. It cannot say WHICH STEP of the
// bootstrap failed, and every diagnostic on the deadline path looks at Applications, their
// resources, and their pods — never at the Job that was supposed to make one of them healthy.
//
// aws/addons run 33249968471 is the case. 24 of 25 Applications Healthy+Synced; addon-vault
// Progressing with its pod Running-but-not-Ready; and the pod log ending at
//
//	core: root token generated
//	core: pre-seal teardown starting
//	core: pre-seal teardown complete
//
// which is Vault initialised and then re-sealed — an init with no unseal after it. RunVaultBootstrap
// does exactly three things there (init, persist the unseal key, unseal), so the failure is one of
// three lines, and which one is a line in the Job log. The dump printed 45 minutes of readiness
// probes and not one word about the Job.
//
// Read by NAME PREFIX rather than by label, because the prefix is what addOnBootstrapName builds and
// is therefore the thing that cannot drift from the manifest: a label could be added to the Job
// without being added here and the dump would silently find nothing.

// bootstrapJobPrefix is addOnBootstrapName's prefix in packages/core/argocd/addon_bootstrap.go.
const bootstrapJobPrefix = "alethia-bootstrap-"

// bootstrapJob is one Job and what it says about itself.
type bootstrapJob struct {
	Namespace  string
	Name       string
	Succeeded  int
	Failed     int
	Active     int
	Conditions []string
}

// Verdict renders the Job's own outcome. A Job with nothing set is still RUNNING, which is a third
// answer and must not read like either of the other two.
func (j bootstrapJob) Verdict() string {
	switch {
	case j.Succeeded > 0:
		return "Complete"
	case j.Failed > 0:
		return fmt.Sprintf("FAILED (%d pod failure(s))", j.Failed)
	case j.Active > 0:
		return "still running"
	default:
		return "no succeeded/failed/active count — the Job exists but has not reported"
	}
}

// parseBootstrapJobs pulls the bootstrap Jobs out of a `kubectl get jobs -A -o json` document. Pure,
// so the field paths are pinned by a fixture rather than by a run that costs money to repeat.
func parseBootstrapJobs(listJSON []byte) ([]bootstrapJob, error) {
	var list struct {
		Items []struct {
			Metadata struct {
				Name      string `json:"name"`
				Namespace string `json:"namespace"`
			} `json:"metadata"`
			Status struct {
				Succeeded  int `json:"succeeded"`
				Failed     int `json:"failed"`
				Active     int `json:"active"`
				Conditions []struct {
					Type    string `json:"type"`
					Status  string `json:"status"`
					Reason  string `json:"reason"`
					Message string `json:"message"`
				} `json:"conditions"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(listJSON, &list); err != nil {
		return nil, err
	}
	var out []bootstrapJob
	for _, it := range list.Items {
		if !strings.HasPrefix(it.Metadata.Name, bootstrapJobPrefix) {
			continue
		}
		j := bootstrapJob{
			Namespace: it.Metadata.Namespace,
			Name:      it.Metadata.Name,
			Succeeded: it.Status.Succeeded,
			Failed:    it.Status.Failed,
			Active:    it.Status.Active,
		}
		for _, c := range it.Status.Conditions {
			j.Conditions = append(j.Conditions, strings.TrimSpace(fmt.Sprintf("%s=%s %s %s", c.Type, c.Status, c.Reason, c.Message)))
		}
		out = append(out, j)
	}
	return out, nil
}

// kubectlRead runs one kubectl read and returns STDOUT, with stderr folded into the ERROR.
//
// `exec.Output()` alone renders a missing CRD, an RBAC refusal and an unreachable API server all
// as `exit status 1` — three faults with three different next steps, printed as one number, in a
// dump whose only job is to say which. Stderr stays OUT of the returned value: this stdout is
// parsed as JSON, and kubectl writes to stderr on calls that succeed.
func kubectlRead(ctx context.Context, timeout time.Duration, kubeconfigPath string, args ...string) ([]byte, error) {
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	full := append([]string{"--kubeconfig", kubeconfigPath}, args...)
	var stderr strings.Builder
	cmd := exec.CommandContext(cctx, "kubectl", full...)
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if i := strings.IndexByte(msg, '\n'); i >= 0 {
			msg = msg[:i]
		}
		if msg != "" {
			// Appended only when there IS something: an error ending in a bare colon reads like a
			// message that got cut off.
			return nil, fmt.Errorf("%w: %s", err, msg)
		}
		return nil, err
	}
	return out, nil
}

// jobPodSelectors are the label selectors that find a Job's pods, current first.
//
// TWO of them because Kubernetes renamed the label: `batch.kubernetes.io/job-name` is the current
// one, `job-name` the legacy one. Both are set on a modern cluster (measured), and the fallback is
// what keeps this working on an older control plane — a selector that quietly matches nothing would
// print "no log" for a Job whose pods are sitting right there, which is the failure this whole file
// exists to stop.
var jobPodSelectors = []string{"batch.kubernetes.io/job-name=", "job-name="}

// bootstrapJobLog prints the log of EVERY attempt the Job made, not one of them.
//
// `kubectl logs job/<name>` picks one pod arbitrarily. Measured against a Job with backoffLimit 2:
//
//	$ kubectl logs job/failjob
//	Found 3 pods, using pod/failjob-g4mkd
//
// For this Job that is close to useless. The bootstrap's `backoffLimit` means a failure produces up
// to five pods, and they do not fail the same way: attempt 1 carries the ORIGINAL error, and every
// attempt after it can only report the state attempt 1 left behind. Reading a later attempt's
// "Vault is INITIALISED but this cluster holds no unseal key" and stopping there is reading the
// consequence and calling it the cause — and which pod kubectl picks is not something to leave to
// luck on a run that costs money.
//
// So: select the pods, print them all with `--prefix`, and `--timestamps` so the attempts can be
// put in order. Pod names carry no sequence; the timestamps do, and with retries the sequence IS
// the question.
func bootstrapJobLog(ctx context.Context, kubeconfigPath string, j bootstrapJob) string {
	var b strings.Builder
	for _, sel := range jobPodSelectors {
		logs, err := kubectlRead(ctx, 20*time.Second, kubeconfigPath,
			"-n", j.Namespace, "logs", "-l", sel+j.Name,
			"--tail=40", "--prefix", "--timestamps", "--all-containers",
			// backoffLimit 4 makes five pods, and kubectl's default ceiling is five. One over is
			// not enough margin for a Job whose limit someone raises later.
			"--max-log-requests=10")
		if err != nil {
			fmt.Fprintf(&b, "    (no log via %s: %v — the pods may already have been collected)\n", sel+j.Name, err)
			continue
		}
		if len(strings.TrimSpace(string(logs))) == 0 {
			// Not yet a finding: the OTHER selector may be the one this cluster labels with.
			continue
		}
		for _, ln := range strings.Split(strings.TrimRight(string(logs), "\n"), "\n") {
			fmt.Fprintf(&b, "    | %s\n", ln)
		}
		return b.String()
	}
	// Every selector tried and none produced a line. Said in full, because "the Job produced no
	// output" and "we could not find its pods" send a reader to completely different places.
	fmt.Fprintf(&b, "    (NO OUTPUT from any pod of this Job, under either %s or %s. Either it did "+
		"not get as far as saying anything, or its pods are labelled with neither selector — check "+
		"`kubectl get pods -n %s` before concluding the first.)\n",
		jobPodSelectors[0], jobPodSelectors[1], j.Namespace)
	return b.String()
}

// dumpAddOnBootstrapJobs renders every bootstrap Job and, for any that did not succeed, its pod log.
//
// It says something in ALL THREE states, and the third is the one that matters: NO Jobs at all is
// not "nothing went wrong". Either none was applied — which is itself the finding — or the TTL
// deleted them before this ran, which is what happened on run 33249968471 at the old 600s.
func dumpAddOnBootstrapJobs(ctx context.Context, kubeconfigPath string) string {
	out, err := kubectlRead(ctx, 20*time.Second, kubeconfigPath,
		"get", "jobs", "--all-namespaces", "-o", "json")
	var b strings.Builder
	b.WriteString("\n──── one-shot bootstrap Jobs (Vault unseal, DB bootstrap) ────\n")
	if err != nil {
		fmt.Fprintf(&b, "  could not list Jobs (%v) — this says nothing about whether a bootstrap ran\n", err)
		return b.String()
	}
	jobs, perr := parseBootstrapJobs(out)
	if perr != nil {
		fmt.Fprintf(&b, "  could not parse the Job list (%v)\n", perr)
		return b.String()
	}
	if len(jobs) == 0 {
		fmt.Fprintf(&b, "  NONE found with the %q prefix. That is not the same as \"no bootstrap was needed\": "+
			"either none was applied, or ttlSecondsAfterFinished deleted them before this ran. An add-on "+
			"that installs sealed (vault) cannot converge without one.\n", bootstrapJobPrefix)
		return b.String()
	}
	for _, j := range jobs {
		fmt.Fprintf(&b, "  %s/%s: %s\n", j.Namespace, j.Name, j.Verdict())
		for _, c := range j.Conditions {
			fmt.Fprintf(&b, "    condition %s\n", c)
		}
		if j.Succeeded > 0 {
			continue
		}
		// The log is the whole point: RunVaultBootstrap's failures are one line each, and which of
		// init / persist / unseal it was is only ever visible here.
		b.WriteString(bootstrapJobLog(ctx, kubeconfigPath, j))
	}
	return b.String()
}
