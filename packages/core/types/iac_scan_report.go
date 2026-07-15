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
	// Resources is the DECLARED resource inventory of the module (root + every local
	// child module) — what the console draws as read-only `external` cards so a BYO-IaC
	// environment reads as an architecture before it has ever been planned.
	//
	// Declared, not expanded: a static scan never evaluates HCL, so `count`/`for_each`
	// blocks appear ONCE here where a plan reports one address per instance. The console
	// treats this as a pre-plan skeleton and lets a real plan's `resource_changes`
	// supersede it (lib/canvas/iac-inventory.ts). Never null (serialize as []).
	Resources []IacResource `json:"resources"`
	// CommitSHA is the exact commit the scan checked out — the deploy pins to it so it
	// applies precisely the bytes the gate vetted (TOCTOU protection). Omitted when unknown.
	CommitSHA string `json:"commit_sha,omitempty"`
}

// IacResource is one declared resource in a BYO IaC module. JSON keys mirror the console
// `IacScanResource` interface. Address is the join key: cost (environment_cost.resources),
// drift (environment_drift.details) and verify findings all speak Terraform addresses.
type IacResource struct {
	Address string `json:"address"`
	Type    string `json:"type"`
	Name    string `json:"name"`
	// Module path prefix — "" for the root module, else "module.vpc" / "module.a.module.b".
	Module string `json:"module,omitempty"`
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
