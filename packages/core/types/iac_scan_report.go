// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package types

// IacScanReport is the result of an IAC_SCAN job over a bring-your-own IaC root module:
// the runner clones the repo at a ref, pins the exact commit it checked out, runs the
// fail-closed static iacsafety gate (providers + module sources, parse-only — never
// evaluates HCL), and runs `tofu init -backend=false` + `tofu validate` in the module.
//
// The JSON keys MUST match the console TS interface `IacScanReport`
// (apps/console/types/jsonb.types.ts): the runner posts this on
// `execution_metadata.iac_scan_result` and console `finalizeIacScan` reads it back onto
// the project_iac_sources row (pinning CommitSHA only when OK). `OK=false` blocks
// provisioning. Keep the two definitions in lockstep.
type IacScanReport struct {
	// OK is true iff the static gate produced no error-severity finding AND `tofu
	// validate` ran clean (false blocks provisioning).
	OK bool `json:"ok"`
	// Validated reports whether `tofu validate` ran clean on the root module.
	Validated bool `json:"validated"`
	// Findings are the static-gate + validate issues. Never null (serialize as []).
	Findings []IacScanFinding `json:"findings"`
	// Providers are the provider source addresses the module requires (e.g.
	// "hashicorp/aws"). Never null.
	Providers []string `json:"providers"`
	// Modules are the module sources referenced (registry / git / local paths). Never null.
	Modules []string `json:"modules"`
	// CommitSHA is the exact commit the scan checked out — the deploy pins to it so it
	// applies precisely the bytes the gate vetted (TOCTOU protection). Omitted when unknown.
	CommitSHA string `json:"commit_sha,omitempty"`
}

// IacScanFinding is one issue raised by an IAC_SCAN (static iacsafety check or `tofu
// validate` diagnostic). JSON keys mirror the console `IacScanFinding` interface.
type IacScanFinding struct {
	Severity string `json:"severity"`
	Rule     string `json:"rule"`
	File     string `json:"file"`
	Line     int    `json:"line,omitempty"`
	Detail   string `json:"detail"`
}
