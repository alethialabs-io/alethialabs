// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"fmt"

	"github.com/alethialabs-io/alethialabs/packages/core/provisioner"
)

// executeProbeCluster handles a PROBE_CLUSTER job — "is the customer's cluster actually
// reachable RIGHT NOW?", the live half of day-2 alongside drift.
//
// Everything this needs already existed and nothing called it: `provisioner.RunProbe`
// (packages/core/provisioner/probe.go) was fully implemented, the console dispatched
// PROBE_CLUSTER jobs on a schedule AND from the canvas Run menu, and the status route ingested
// `execution_metadata.probe_result` into `environment_probes` (raising a critical outage alert on
// a true→false liveness transition). The one missing link was this function, so EVERY probe job
// ever queued failed with "not yet implemented on this runner" — which meant `environment_probes`
// was never written, and a cluster whose API server had died still read **Live** on the canvas.
//
// It mutates nothing: it reads the environment's tofu outputs in-process from the state proxy,
// acquires the cluster kubeconfig via the provider, and dials the API server's `/readyz`.
//
// NO byoManagedGate (unlike DETECT_DRIFT): a probe never executes the customer's module. Reading
// state outputs runs tofu against a workspace holding ONLY an http-backend block (no providers, no
// resources — see provisioner.ReadStateOutputs), and the reachability dial is Alethia's own code.
// There is no untrusted plugin execution here to contain, so the gate would refuse a safe,
// read-only job on a managed runner for no reason.
//
// FAIL-CLOSED-TO-HONEST-DOWN: an unreachable cluster is a SUCCESSFUL probe carrying
// reachable=false — that IS the signal. A returned error is reserved for the probe being unable to
// RUN (an unreadable state proxy, an unknown provider), which is an operational failure and a
// genuinely different thing from "the customer's cluster is down".
func (w *Runner) executeProbeCluster(ctx context.Context, job *Job, provider string, identity *CloudIdentity, stdout, stderr *JobLogger) error {
	vc, err := snapshotToProjectConfig(job.ConfigSnapshot)
	if err != nil {
		return fmt.Errorf("failed to parse config snapshot: %w", err)
	}
	if provider == "" {
		provider = string(vc.Provider)
	}
	if provider == "" {
		provider = "aws"
	}
	if identity != nil {
		vc.CloudAccountID = resolveAccountID(identity)
	}

	_ = w.api.UpdateJobStatus(job.ID, "PROCESSING", "", map[string]any{
		"phase": "probe", "progress": "Checking whether the cluster's API server answers...",
	})

	stateBackend, err := w.stateBackend(job.ID)
	if err != nil {
		return err
	}

	result, err := provisioner.RunProbe(ctx, provisioner.ProbeParams{
		ProjectConfig: vc,
		Provider:      provider,
		IacVersion:    vc.IacVersion,
		StateBackend:  stateBackend,
		Stdout:        stdout,
		Stderr:        stderr,
	})
	if err != nil {
		// The probe could not RUN. Distinct from an honest "the cluster is down" (above).
		return err
	}

	if result.Reachable {
		fmt.Fprintf(stdout, "Cluster is reachable: %s\n", result.Message)
	} else {
		// Not an error — this is the whole point of the job, and the console turns it into the
		// canvas's `unreachable` state plus a one-shot outage alert.
		fmt.Fprintf(stdout, "Cluster is UNREACHABLE: %s\n", result.Message)
	}

	// The console's status route reads this on SUCCESS → recordProbeResult → environment_probes.
	_ = w.api.UpdateJobStatus(job.ID, "PROCESSING", "", map[string]any{"probe_result": result})
	return nil
}
