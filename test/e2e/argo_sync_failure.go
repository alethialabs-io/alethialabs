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

// THE APPLICATION'S OWN ACCOUNT OF WHY ITS LAST SYNC DID NOT TAKE.
//
// Every other diagnostic on the failing path assumes the resources EXIST. `describeArgoApps` prints
// the Application, `dumpOutOfSyncResources` fetches the objects, the ownership probe reads their
// managedFields, and `dumpArgoAppDiffs` renders desired-vs-live. None of them says anything useful
// about a loser whose resources were never created at all.
//
// azure/addons run 33249209041: `addon-kube-prometheus-stack: health=Missing sync=OutOfSync` from
// the ten-minute add-on wait through to the 35-minute deadline. What the dump could offer was
//
//	──── pods for addon-kube-prometheus-stack: NONE match … nor any workload's OWN selector ────
//	  ArgoCD says it manages 4 workload(s): …
//	  (could not describe Deployment/addon-kube-prometheus-stack-grafana in monitoring : exit status 1)
//	  - configmap/addon-kube-prometheus-stac-alertmanager-overview: could not fetch (exit status 1)
//
// — 130 lines establishing that absent things are absent, and not one word about WHY the sync that
// should have created them did not. The Application records exactly that, in
// `status.operationState`, and nothing was asking for it.
//
// IT IS NOT IN THE DESCRIBE EITHER, and that is not an accident of this run. `kubectl describe
// application` puts `Status:` last, and describeArgoApps truncates to 2500 characters from the TOP
// to fit twenty losers into one dump — so the operation state is exactly the part that gets cut.
// The azure log shows the cut mid-word: `Rev…(truncated)`.
//
// So this reads the two fields directly, which are small, always present, and cannot be truncated
// away by a cap sized for something else.

// argoAppFailure is what an Application says about its own last sync attempt.
type argoAppFailure struct {
	Phase   string
	Message string
	// SyncErrors are per-resource messages from the sync result — the line that names WHICH object
	// the API server refused and why, which the top-level Message usually only summarises.
	SyncErrors []string
	// Conditions carry the errors that never became an operation at all: an invalid spec, an
	// unknown repo, a comparison error. A sync that was never ATTEMPTED has no operationState, and
	// reading that as "nothing wrong" is the mistake this whole file exists to stop.
	Conditions []string
}

// Empty reports whether the Application said nothing about a failure — which is a DIFFERENT fact
// from "we could not read it", and is rendered differently.
func (f argoAppFailure) Empty() bool {
	return f.Phase == "" && f.Message == "" && len(f.SyncErrors) == 0 && len(f.Conditions) == 0
}

// parseArgoAppFailure extracts the failure account from an Application's JSON. Pure, so the shape
// this depends on is pinned by a test rather than by a run that costs money to repeat.
func parseArgoAppFailure(appJSON []byte) (argoAppFailure, error) {
	var app struct {
		Status struct {
			OperationState struct {
				Phase      string `json:"phase"`
				Message    string `json:"message"`
				SyncResult struct {
					Resources []struct {
						Kind      string `json:"kind"`
						Namespace string `json:"namespace"`
						Name      string `json:"name"`
						Status    string `json:"status"`
						Message   string `json:"message"`
					} `json:"resources"`
				} `json:"syncResult"`
			} `json:"operationState"`
			Conditions []struct {
				Type    string `json:"type"`
				Message string `json:"message"`
			} `json:"conditions"`
		} `json:"status"`
	}
	if err := json.Unmarshal(appJSON, &app); err != nil {
		return argoAppFailure{}, err
	}
	f := argoAppFailure{
		Phase:   app.Status.OperationState.Phase,
		Message: app.Status.OperationState.Message,
	}
	for _, r := range app.Status.OperationState.SyncResult.Resources {
		// Only the ones that did NOT go in. A sync result lists every resource, and printing the
		// hundreds that synced fine would bury the handful that did not — kube-prometheus-stack
		// alone renders over a hundred.
		if r.Status == "Synced" || (r.Status == "" && r.Message == "") {
			continue
		}
		ns := r.Namespace
		if ns == "" {
			ns = "(cluster)"
		}
		f.SyncErrors = append(f.SyncErrors, fmt.Sprintf("%s/%s in %s: %s %s", r.Kind, r.Name, ns, r.Status, r.Message))
	}
	for _, c := range app.Status.Conditions {
		// Info conditions are not failures; everything else is worth reading on a failing path.
		if strings.EqualFold(c.Type, "Info") || c.Message == "" {
			continue
		}
		f.Conditions = append(f.Conditions, fmt.Sprintf("%s: %s", c.Type, c.Message))
	}
	return f, nil
}

// renderArgoAppFailure formats one Application's account. `readErr` and an EMPTY account render
// differently on purpose: "the Application recorded no failure" is a finding — it means the sync
// was never attempted, which points at the app-of-apps rather than at this chart.
func renderArgoAppFailure(name string, f argoAppFailure, readErr error) string {
	var b strings.Builder
	fmt.Fprintf(&b, "\n  ──── %s: its own account of the last sync ────\n", name)
	if readErr != nil {
		fmt.Fprintf(&b, "    could not be read (%v) — this says nothing about the sync\n", readErr)
		return b.String()
	}
	if f.Empty() {
		fmt.Fprintf(&b, "    NO operationState and NO conditions: this Application has never been "+
			"synced at all, successfully or otherwise. Look at whatever should have synced it "+
			"(the app-of-apps, the sync wave) rather than at this chart.\n")
		return b.String()
	}
	if f.Phase != "" || f.Message != "" {
		fmt.Fprintf(&b, "    phase=%s %s\n", orNone(f.Phase), f.Message)
	}
	for _, c := range f.Conditions {
		fmt.Fprintf(&b, "    condition %s\n", c)
	}
	const maxResourceErrors = 12
	for i, e := range f.SyncErrors {
		if i == maxResourceErrors {
			fmt.Fprintf(&b, "    … %d more resource(s) with a sync error\n", len(f.SyncErrors)-i)
			break
		}
		fmt.Fprintf(&b, "    %s\n", e)
	}
	return b.String()
}

// dumpArgoSyncFailures asks every loser why its last sync did not take.
//
// Run for EVERY loser, not only the Missing ones: a Degraded app whose sync partially failed has
// the same story to tell, and the read is one small `kubectl get` rather than a chart render.
func dumpArgoSyncFailures(ctx context.Context, kubeconfigPath string, losers []string) string {
	if len(losers) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n──── Why the last sync did not take, per failing Application ────\n")
	for _, name := range losers {
		cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		out, err := exec.CommandContext(cctx, "kubectl", "--kubeconfig", kubeconfigPath,
			"get", "applications.argoproj.io", "-n", "argocd", name, "-o", "json").Output()
		cancel()
		if err != nil {
			b.WriteString(renderArgoAppFailure(name, argoAppFailure{}, err))
			continue
		}
		f, perr := parseArgoAppFailure(out)
		b.WriteString(renderArgoAppFailure(name, f, perr))
	}
	return b.String()
}
