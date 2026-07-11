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

import (
	"context"
	"encoding/json"
	"io"
)

// Job is the untrusted unit of work to run inside the sandbox. The Passthrough
// backend calls it in-process; isolating backends run the equivalent work in an
// isolated subprocess/container (re-execing the runner binary), so the closure is
// the in-process degenerate case and Spec carries the isolation intent for both.
type Job func(ctx context.Context) error

// StageKind labels the serialized work a container backend reconstructs in the
// re-exec'd child. It mirrors Spec.Kind but is the typed contract both the parent
// (which marshals the payload) and the child (which dispatches on it) share.
type StageKind string

const (
	StageDeploy    StageKind = "deploy"
	StagePlan      StageKind = "plan"
	StageDestroy   StageKind = "destroy"
	StageChartScan StageKind = "chart_scan"
)

// Stage is the serialized, self-contained description of the untrusted work. The
// Passthrough backend IGNORES it (it runs the in-process closure); the Container
// backend IGNORES the closure and reconstructs the work from Stage in a re-exec'd
// child. The single call site builds BOTH from the same params, so the two backends
// converge on identical work. Payload is the JSON of a per-kind struct owned by the
// runner (agent) package — this package keeps it opaque so it stays dependency-light.
// Payload carries NO secrets (git/state tokens cross via the child's allowlisted env).
type Stage struct {
	Kind    StageKind       `json:"kind"`
	Payload json.RawMessage `json:"payload"`
}

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
	// Stage is the serialized work for isolating backends (nil for a closure-only
	// call — Passthrough never needs it). The container backend requires it.
	Stage *Stage
	// WorkDir is the per-job directory the caller created: the container backend
	// writes stage.json into it and RW-mounts it, and the child writes result.json
	// back into it for the parent to read. Required by the container backend.
	WorkDir string
	// Stdout/Stderr receive the child's streamed output (container backend pipes the
	// re-exec'd process here). Optional; nil discards.
	Stdout io.Writer
	Stderr io.Writer
	// NoEgress requests deny-all networking for this stage (e.g. chart_scan renders a
	// local chart and needs no network). Backends that can't enforce it must fail closed
	// rather than silently allow egress.
	NoEgress bool
}

// Sandbox runs one untrusted Job within an isolation context. An implementation MUST
// NOT broaden the caller's blast radius relative to running the Job directly (the
// Passthrough backend is the neutral, no-isolation baseline).
type Sandbox interface {
	Run(ctx context.Context, spec Spec, job Job) error
}
