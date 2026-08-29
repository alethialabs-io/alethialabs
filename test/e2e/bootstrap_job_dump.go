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

// dumpAddOnBootstrapJobs renders every bootstrap Job and, for any that did not succeed, its pod log.
//
// It says something in ALL THREE states, and the third is the one that matters: NO Jobs at all is
// not "nothing went wrong". Either none was applied — which is itself the finding — or the TTL
// deleted them before this ran, which is what happened on run 33249968471 at the old 600s.
func dumpAddOnBootstrapJobs(ctx context.Context, kubeconfigPath string) string {
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	out, err := exec.CommandContext(cctx, "kubectl", "--kubeconfig", kubeconfigPath,
		"get", "jobs", "--all-namespaces", "-o", "json").Output()
	cancel()
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
		lctx, lcancel := context.WithTimeout(ctx, 20*time.Second)
		logs, lerr := exec.CommandContext(lctx, "kubectl", "--kubeconfig", kubeconfigPath,
			"-n", j.Namespace, "logs", "job/"+j.Name, "--tail=40").Output()
		lcancel()
		switch {
		case lerr != nil:
			fmt.Fprintf(&b, "    (no log: %v — the pod may already have been collected)\n", lerr)
		case len(strings.TrimSpace(string(logs))) == 0:
			fmt.Fprintf(&b, "    (the Job pod produced NO output — it did not get as far as saying anything)\n")
		default:
			for _, ln := range strings.Split(strings.TrimRight(string(logs), "\n"), "\n") {
				fmt.Fprintf(&b, "    | %s\n", ln)
			}
		}
	}
	return b.String()
}
