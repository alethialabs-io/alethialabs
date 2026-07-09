// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package sandbox is the seam through which the runner executes a job's untrusted
// portion (customer OpenTofu HCL run via `tofu`, customer Helm charts applied via
// `helm`/`kubectl`). Today the runner runs this work in-process with the host's full
// environment — which is safe ONLY because it currently runs Alethia's own trusted
// templates. Bringing-your-own IaC/Helm makes that unsafe (untrusted code would
// inherit platform creds + the receipt-signing key + the storage master key).
//
// This package introduces the isolation boundary without yet changing behavior: the
// runner calls Sandbox.Run instead of invoking the provisioner directly, and the
// default Passthrough backend runs the work in-process exactly as before. Isolating
// backends (env-scrubbed subprocess → container → microVM) implement the same
// interface and are swapped in behind a flag once proven — see the E0 plan.
package sandbox

import "context"

// Job is the untrusted unit of work to run inside the sandbox. The Passthrough
// backend calls it in-process; isolating backends run the equivalent work in an
// isolated subprocess/container (re-execing the runner binary), so the closure is
// the in-process degenerate case and Spec carries the isolation intent for both.
type Job func(ctx context.Context) error

// Spec describes one sandboxed execution. It starts intentionally minimal — env
// allowlist, network policy, and resource limits are added to Spec as the isolating
// backends that enforce them land, so callers adopt the seam now and the fields grow
// underneath without a churn of call sites.
type Spec struct {
	// Kind labels the work for logs/metrics: "deploy" | "plan" | "destroy" | "byo-*".
	Kind string
	// JobID / Provider annotate the sandbox for observability and cleanup.
	JobID    string
	Provider string
	// Warn is an optional per-job sink for a single human-readable warning (wire it
	// to the job's log stream). Backends use it to surface, e.g., "isolation disabled".
	Warn func(string)
}

// Sandbox runs one untrusted Job within an isolation context. An implementation MUST
// NOT broaden the caller's blast radius relative to running the Job directly (the
// Passthrough backend is the neutral, no-isolation baseline).
type Sandbox interface {
	Run(ctx context.Context, spec Spec, job Job) error
}
