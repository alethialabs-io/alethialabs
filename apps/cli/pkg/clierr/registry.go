// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package clierr

// This file is the whole registry: every exit code the CLI's fatal path can produce, the class each
// one names, and every error `code` the CLI itself assigns. It is one file on purpose — the exit
// table in the docs and the per-code errors page are generated from Classes() and Codes(), so a
// number or a code that is not written here does not exist.
//
// THE NUMBERS NEVER CHANGE MEANING. A script that branches on 6 must be able to keep doing so
// across every release. Add a class at a new number; never renumber and never reuse.
//
// 2 AND 3 ARE NOT IN THIS TABLE, AND THAT IS THE CONTRACT. `alethia plan` and `alethia apply` own
// them (cmd/plan_exit.go: 2 = refused, or changes under --detailed-exitcode; 3 = problems) and
// pipelines already gate on them. The global classes therefore start at 4, and
// TestRegistry_CommandDefinedCodesStayFree fails if a class is ever given 2 or 3.

// Exit codes of the global classes.
const (
	// ExitOK is success. It is never the exit of an Error.
	ExitOK = 0
	// ExitUnclassified is any failure the classifier could not place.
	ExitUnclassified = 1
	// ExitAuth is "authentication is required, or the credential has expired".
	ExitAuth = 4
	// ExitForbidden is "authenticated, and not permitted".
	ExitForbidden = 5
	// ExitNotFound is "the thing named does not exist".
	ExitNotFound = 6
	// ExitConflict is a conflict or a failed precondition.
	ExitConflict = 7
	// ExitUsage is a usage or validation error.
	ExitUsage = 8
	// ExitInputRequired is "a confirmation or a value is needed and nothing can ask for it".
	ExitInputRequired = 9
	// ExitLimited is a rate limit, a quota or a plan limit.
	ExitLimited = 10
	// ExitUnavailable is "the control plane could not be reached or could not answer".
	ExitUnavailable = 11
	// ExitWaitTimeout is "the wait deadline passed and the operation is still running".
	ExitWaitTimeout = 12
	// ExitOperationFailed is "the remote operation finished, and it failed".
	ExitOperationFailed = 13
	// ExitCLITooOld is "this CLI is older than the control plane accepts".
	ExitCLITooOld = 14
	// ExitInterrupted is an interrupt: 128 + SIGINT.
	ExitInterrupted = 130
)

// FirstGlobalExit is the lowest exit code a global class may use. Everything between
// ExitUnclassified and it is reserved for command-defined results.
const FirstGlobalExit = 4

// Class is the coarse kind of a failure. A class has exactly one exit code.
type Class string

// The classes, one per row of the exit table.
const (
	ClassUnclassified    Class = "unclassified"
	ClassAuth            Class = "auth"
	ClassForbidden       Class = "forbidden"
	ClassNotFound        Class = "not_found"
	ClassConflict        Class = "conflict"
	ClassUsage           Class = "usage"
	ClassInputRequired   Class = "input_required"
	ClassLimited         Class = "limited"
	ClassUnavailable     Class = "unavailable"
	ClassWaitTimeout     Class = "wait_timeout"
	ClassOperationFailed Class = "operation_failed"
	ClassCLITooOld       Class = "cli_too_old"
	ClassInterrupted     Class = "interrupted"
)

// ClassDef is one row of the exit table.
type ClassDef struct {
	Class Class
	Exit  int
	// Retryable reports whether repeating the same command unchanged can succeed.
	Retryable bool
	// Retry says, for a person, when a retry makes sense. Empty means it does not.
	Retry string
	// Summary is the row's description in the docs table.
	Summary string
}

// classDefs is the exit table, in exit-code order.
var classDefs = []ClassDef{
	{ClassUnclassified, ExitUnclassified, false, "", "Unclassified failure"},
	{ClassAuth, ExitAuth, false, "after `alethia login`", "Authentication required or expired"},
	{ClassForbidden, ExitForbidden, false, "", "Permission denied"},
	{ClassNotFound, ExitNotFound, false, "", "Not found"},
	{ClassConflict, ExitConflict, false, "after a state change", "Conflict or failed precondition"},
	{ClassUsage, ExitUsage, false, "after fixing the input", "Usage or validation error"},
	{ClassInputRequired, ExitInputRequired, false, "with `--yes` or the missing flag", "Confirmation or input required, and prompting is unavailable"},
	{ClassLimited, ExitLimited, true, "after the wait the error names", "Rate limit, quota or plan limit"},
	{ClassUnavailable, ExitUnavailable, true, "yes, with backoff", "Unavailable: network, TLS or a server fault"},
	{ClassWaitTimeout, ExitWaitTimeout, false, "resume with the operation id", "The wait deadline passed; the operation is still running"},
	{ClassOperationFailed, ExitOperationFailed, false, "", "The remote operation finished and failed"},
	{ClassCLITooOld, ExitCLITooOld, false, "after `alethia update`", "This CLI is too old for the control plane"},
	{ClassInterrupted, ExitInterrupted, false, "", "Interrupted"},
}

// The error codes the CLI assigns. A control plane may send others; From keeps a code it does not
// know and classifies that error by its HTTP status instead.
const (
	CodeInternal             = "internal"
	CodeAuthRequired         = "auth_required"
	CodeTokenExpired         = "token_expired"
	CodeForbidden            = "forbidden"
	CodeNotFound             = "not_found"
	CodeConflict             = "conflict"
	CodeAlreadyExists        = "already_exists"
	CodeOperationInProgress  = "operation_in_progress"
	CodeInvalidFlag          = "invalid_flag"
	CodeInvalidUsage         = "invalid_usage"
	CodeMissingArgument      = "missing_argument"
	CodeValidationFailed     = "validation_failed"
	CodeConfirmationRequired = "confirmation_required"
	CodeInputRequired        = "input_required"
	CodeRateLimited          = "rate_limited"
	CodeQuotaExceeded        = "quota_exceeded"
	CodePlanLimit            = "plan_limit"
	CodeServiceUnavailable   = "service_unavailable"
	CodeNetworkUnreachable   = "network_unreachable"
	CodeWaitTimeout          = "wait_timeout"
	CodeOperationFailed      = "operation_failed"
	CodeCLITooOld            = "cli_too_old"
	CodeInterrupted          = "interrupted"
	// CodeApprovalRequired is the control plane's own code for a deploy or destroy that needs a
	// person's approval (apps/console/lib/approvals/refusal.ts). Registered so the CLI exits 9 on it:
	// like a confirmation, it is something only a person can give.
	CodeApprovalRequired = "approval_required"
	// CodeApprovalRejected is an approval a person rejected in the console.
	CodeApprovalRejected = "approval_rejected"
	// CodeApprovalInvalid is an approval that can no longer be used: expired, superseded by a newer
	// plan or change, or already used. The control plane sends the same code.
	CodeApprovalInvalid = "approval_invalid"
)

// CodeDef is one registered error code.
type CodeDef struct {
	Code  string
	Class Class
	// Summary is what the code means, for the generated errors page.
	Summary string
}

// codeDefs is every registered code, grouped by class in exit-code order.
var codeDefs = []CodeDef{
	{CodeInternal, ClassUnclassified, "The CLI could not classify the failure."},
	{CodeAuthRequired, ClassAuth, "The command needs a signed-in session or a service token."},
	{CodeTokenExpired, ClassAuth, "The stored credential has expired and could not be refreshed."},
	{CodeForbidden, ClassForbidden, "The signed-in identity is not permitted to do this."},
	{CodeApprovalRejected, ClassForbidden, "A person rejected the approval this deploy or destroy asked for."},
	{CodeNotFound, ClassNotFound, "The resource named does not exist in the active organization."},
	{CodeConflict, ClassConflict, "The resource is not in a state that allows this."},
	{CodeAlreadyExists, ClassConflict, "A resource with this name already exists."},
	{CodeOperationInProgress, ClassConflict, "Another operation on this resource is still running."},
	{CodeApprovalInvalid, ClassConflict, "The approval expired, was superseded by a newer plan, or was already used."},
	{CodeInvalidFlag, ClassUsage, "A flag is unknown, or its value could not be read."},
	{CodeInvalidUsage, ClassUsage, "The command or its arguments are not valid."},
	{CodeMissingArgument, ClassUsage, "A required argument was not given."},
	{CodeValidationFailed, ClassUsage, "The input was read and is not valid."},
	{CodeConfirmationRequired, ClassInputRequired, "The command needs a confirmation and prompting is unavailable."},
	{CodeInputRequired, ClassInputRequired, "The command needs a value and prompting is unavailable."},
	{CodeApprovalRequired, ClassInputRequired, "A person has to approve this deploy or destroy in the console before it runs."},
	{CodeRateLimited, ClassLimited, "Too many requests; wait and retry."},
	{CodeQuotaExceeded, ClassLimited, "A quota of the organization is used up."},
	{CodePlanLimit, ClassLimited, "The organization's plan does not include this."},
	{CodeServiceUnavailable, ClassUnavailable, "The control plane answered with a server fault."},
	{CodeNetworkUnreachable, ClassUnavailable, "The control plane could not be reached."},
	{CodeWaitTimeout, ClassWaitTimeout, "The wait deadline passed while the operation was still running."},
	{CodeOperationFailed, ClassOperationFailed, "The remote operation finished and reported a failure."},
	{CodeCLITooOld, ClassCLITooOld, "The control plane requires a newer CLI."},
	{CodeInterrupted, ClassInterrupted, "The command was interrupted before it finished."},
}

// Classes returns the exit table, in exit-code order. The slice is a copy.
func Classes() []ClassDef {
	return append([]ClassDef(nil), classDefs...)
}

// Codes returns every registered error code, grouped by class. The slice is a copy.
func Codes() []CodeDef {
	return append([]CodeDef(nil), codeDefs...)
}

// classDef returns the table row for a class, and the unclassified row for a class the table does
// not carry, so an Error can never leave with an exit code nobody documented.
func classDef(c Class) ClassDef {
	for _, d := range classDefs {
		if d.Class == c {
			return d
		}
	}
	return classDefs[0]
}

// classOfCode returns the class a registered code belongs to, and false for an unregistered one.
func classOfCode(code string) (Class, bool) {
	for _, d := range codeDefs {
		if d.Code == code {
			return d.Class, true
		}
	}
	return ClassUnclassified, false
}
