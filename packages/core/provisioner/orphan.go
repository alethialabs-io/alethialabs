// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"regexp"
	"strings"
)

// Orphan detection for a FAILED apply (issue #526).
//
// Until now `orphan_risk` fired ONLY when an apply was INTERRUPTED (cancel / timeout / drain). A
// plain apply *failure* was assumed clean — apps/runner/internal/agent/runner.go said so outright:
//
//	"A plain apply failure leaves the context live (ctxErr == nil) and is NOT a cancel, so it
//	 stays unflagged — normal failures do not over-alert."
//
// That assumption is FALSE. Clouds routinely ACCEPT a create and then fail it ASYNCHRONOUSLY: the
// resource really is created, tofu's create call errors, and the resource therefore NEVER ENTERS
// TOFU STATE. Nothing else in the system can see it — packages/core/drift is blind by construction
// (`Unmanaged=0, UnmanagedKnown=false`: a refresh-only plan cannot see what is not in state).
//
// The consequence is not a cosmetic missing alert — the environment is PERMANENTLY WEDGED. Every
// subsequent apply dies with:
//
//	Error: a resource with the ID "…" already exists - to be managed via Terraform this resource
//	needs to be imported into the State.
//
// …and we report orphan_risk=false on exactly the failure that bricked the customer.
//
// Reproduced on real Azure: azurerm_managed_redis → Azure allocated it, then failed it
// (AllocationFailed: insufficient capacity) → resource EXISTS (provisioningState: Failed), absent
// from tofu state → next apply refused forever.
//
// The original authors were RIGHT to fear over-alerting: most apply failures (validation, a quota
// rejection BEFORE create) leave nothing behind, and flagging those would cry wolf. So this does not
// guess — it classifies on POSITIVE EVIDENCE only, and returns OrphanNone otherwise.

// OrphanEvidence grades how confident we are that a failed apply left a real cloud resource behind,
// outside tofu state.
type OrphanEvidence int

const (
	// OrphanNone — no evidence of a leftover resource. Do NOT flag: this is the case that keeps
	// us from over-alerting on ordinary failures (validation errors, pre-create quota rejections).
	OrphanNone OrphanEvidence = iota

	// OrphanLikely — the cloud ACCEPTED the create and then failed it asynchronously, so a resource
	// very probably exists outside state. The give-away is a *polling* failure: tofu only polls
	// AFTER the API accepted the create.
	OrphanLikely

	// OrphanCertain — the provider told us outright that the resource exists and is not in state.
	// This IS the wedge: every future apply fails identically until it is imported or removed.
	OrphanCertain
)

// String renders the grade for logs/metadata.
func (e OrphanEvidence) String() string {
	switch e {
	case OrphanCertain:
		return "certain"
	case OrphanLikely:
		return "likely"
	case OrphanNone:
		return "none"
	default:
		return "none"
	}
}

// OrphanFinding is what a failed apply tells us about resources left outside tofu state.
type OrphanFinding struct {
	Evidence OrphanEvidence
	// Address is the tofu resource address (e.g. module.azure_cache[0].azurerm_managed_redis.this).
	// It is what a `tofu import <address> <id>` repair needs. Empty when tofu did not name it.
	Address string
	// CloudID is the provider's resource ID, present only when the provider printed it (the
	// OrphanCertain "already exists" message does). It is the second half of the import pair.
	CloudID string
	// Reason is an operator-facing sentence: what happened, and what it means. It goes into
	// execution_metadata.orphan_risk_reason, replacing an inscrutable failure with a diagnosis.
	Reason string
}

// Orphaned reports whether the finding warrants raising orphan_risk.
func (f OrphanFinding) Orphaned() bool { return f.Evidence != OrphanNone }

var (
	// The provider's own words when a resource exists but is not in state. This is TF/provider
	// core language, not cloud-specific, so it holds across azurerm/aws/google/alicloud.
	reAlreadyExists = regexp.MustCompile(`a resource with the ID "([^"]+)" already exists`)
	needsImport     = "needs to be imported into the State"

	// tofu prints the failing resource's address as `  with <address>,` beneath the error.
	reWithAddress = regexp.MustCompile(`(?m)^\s*with\s+([^,\n]+),`)
)

// asyncCreateFailedMarkers indicate the cloud ACCEPTED the create and then failed it — i.e. the
// window in which a resource is left behind outside state.
//
// The strongest signal is a POLLING failure: a provider only polls after the create call was
// accepted, so "polling after Create" means the resource was very likely materialised before it
// failed. The capacity/allocation codes are the concrete forms we have observed on real infra.
var asyncCreateFailedMarkers = []string{
	"polling after create",  // azurerm: create accepted, long-running op then failed
	"polling failed",        // ditto
	"allocationfailed",      // Azure: allocated, then failed for capacity
	"insufficient capacity", // the human form of the above
}

// ClassifyApplyError inspects a failed `tofu apply` and decides whether it left a resource behind
// outside tofu state. It is PURE (no cloud calls) — the evidence is entirely in what the provider
// already told us, so this adds no new cloud API surface to the runner.
//
// combined should be the apply error plus whatever stderr tofu produced (the error text and the
// `with <address>` line often arrive on different streams).
func ClassifyApplyError(applyErr error, stderr string) OrphanFinding {
	if applyErr == nil {
		return OrphanFinding{Evidence: OrphanNone}
	}

	combined := applyErr.Error()
	if stderr != "" {
		combined += "\n" + stderr
	}
	lower := strings.ToLower(combined)

	addr := firstSubmatch(reWithAddress, combined)

	// CERTAIN — the provider says the resource exists and is not in state. This is the wedge.
	if m := reAlreadyExists.FindStringSubmatch(combined); m != nil && strings.Contains(combined, needsImport) {
		id := m[1]
		return OrphanFinding{
			Evidence: OrphanCertain,
			Address:  addr,
			CloudID:  id,
			Reason: "apply failed because a resource already exists in the cloud but is NOT in tofu state" +
				describeTarget(addr, id) +
				". The environment is wedged: every apply will fail identically until this resource is imported into state (or removed). Run a STATE_SURGERY import to reconcile.",
		}
	}

	// LIKELY — the cloud accepted the create and then failed it asynchronously, so the resource may
	// well exist outside state even though tofu never recorded it.
	for _, marker := range asyncCreateFailedMarkers {
		if strings.Contains(lower, marker) {
			return OrphanFinding{
				Evidence: OrphanLikely,
				Address:  addr,
				Reason: "apply failed AFTER the cloud accepted the create (an asynchronous create/allocation failure)" +
					describeTarget(addr, "") +
					". The resource may exist outside tofu state; if it does, the next apply will fail with \"already exists\". Reconcile before retrying.",
			}
		}
	}

	// No evidence — an ordinary failure (validation, a quota rejection BEFORE create). Do not flag:
	// over-alerting here is exactly what the original design was right to avoid.
	return OrphanFinding{Evidence: OrphanNone}
}

// describeTarget appends whatever tofu told us about which resource is at fault.
func describeTarget(addr, id string) string {
	var b strings.Builder
	if addr != "" {
		b.WriteString(" (" + addr)
		if id != "" {
			b.WriteString(", cloud id " + id)
		}
		b.WriteString(")")
		return b.String()
	}
	if id != "" {
		return " (cloud id " + id + ")"
	}
	return ""
}

func firstSubmatch(re *regexp.Regexp, s string) string {
	if m := re.FindStringSubmatch(s); m != nil {
		return strings.TrimSpace(m[1])
	}
	return ""
}

// ApplyOrphanError wraps a failed apply that we have POSITIVE evidence left a cloud resource behind
// outside tofu state (issue #526).
//
// It exists so the runner can lift the finding into execution_metadata.orphan_risk /
// orphan_risk_reason via errors.As, instead of re-parsing the error text at another layer. The
// wrapped error is preserved, so every existing `%w`/errors.Is caller keeps working and the job
// still fails exactly as before — this ADDS a diagnosis, it does not change control flow.
type ApplyOrphanError struct {
	Err     error
	Finding OrphanFinding
}

func (e *ApplyOrphanError) Error() string {
	return "tofu apply failed (orphan risk: " + e.Finding.Evidence.String() + "): " + e.Err.Error()
}

// Unwrap keeps errors.Is/As transparent to the underlying apply failure.
func (e *ApplyOrphanError) Unwrap() error { return e.Err }
