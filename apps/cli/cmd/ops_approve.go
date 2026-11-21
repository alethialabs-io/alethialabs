// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

// opsApproveCmd is run by the SECOND operator to mint a two-person approval token for a high-blast
// action. The acting operator then passes the printed id as `--approval`. The server enforces that
// the approver and the actor are different people.
var opsApproveCmd = &cobra.Command{
	Use:   "approve [action] [resource-id]",
	Short: "Mint a two-person approval for a high-blast action (run by a SECOND operator)",
	Long: "Mint a single-use, TTL'd approval bound to a high-blast action + resource. The acting\n" +
		"operator (a DIFFERENT person) then passes the printed id as --approval.\n\n" +
		"Run with no arguments on a terminal it offers the actions that take an approval, read from\n" +
		"the same catalog the server enforces, so the list cannot offer one the server refuses to\n" +
		"mint.",
	Args: cobra.MaximumNArgs(2),
	Run: func(cmd *cobra.Command, args []string) {
		reason := opsReason(cmd)
		action := opsResolveApprovalAction(cmd, args)
		resourceID := opsResolveArg(cmd, opsKeyResource, opsArgAt(args, 1), nil)

		token, err := getAuthToken()
		if err != nil {
			fail(err)
			return
		}
		result, err := mintOpsApproval(api.NewClient(token), action, resourceID, reason)
		if err != nil {
			fail(err)
			return
		}
		if err := printOpsRecord(printerFor(cmd), result, writeOpsApprovalCard); err != nil {
			fail(err)
		}
	},
}

// opsApprover is the one call `ops approve` makes.
type opsApprover interface {
	MintBreakglassApproval(action, resourceID, reason string, input *api.BreakglassActionInput) (*api.BreakglassApproval, error)
}

// mintOpsApproval mints the approval and returns it as the result of the mutation that created it.
// The approval id is the result's id, so `-o json | jq -r .id` is the value the other operator
// passes as --approval.
func mintOpsApproval(c opsApprover, action, resourceID, reason string) (MutationResult, error) {
	result := MutationResult{Kind: opsKindApproval, Action: ResultCreated}
	var approval *api.BreakglassApproval
	var err error
	runSpinner("Minting approval...", func() {
		approval, err = c.MintBreakglassApproval(action, resourceID, reason, nil)
	})
	if err != nil {
		return result, opsRemoteError("could not mint the approval", err)
	}
	if approval == nil {
		return result, clierr.New(clierr.CodeInternal, "the control plane minted an approval but returned none")
	}
	result.ID = approval.ApprovalID
	result.Object = approval
	return result, nil
}

// writeOpsApprovalCard writes a minted approval as the card a person reads. It is the TABLE form
// only: json and csv render the mutation result, so these humanised cells never reach a parser.
// The object is always the approval mintOpsApproval put there; anything else writes nothing.
func writeOpsApprovalCard(w io.Writer, object any) error {
	approval, ok := object.(*api.BreakglassApproval)
	if !ok {
		return nil
	}
	return ui.RenderCard(w, ui.FormatTable, "approval", [][]string{
		{"approval id", ui.OrDash(approval.ApprovalID)},
		{"action", ui.OrDash(approval.Action)},
		{"resource", ui.OrDash(approval.ResourceID)},
		{"approver", ui.OrDash(approval.Approver)},
		// ui.Stamp, not ui.OrDash: `expiresAt` is a TIMESTAMP, and the string helper echoed the
		// wire's RFC3339 into a row a person reads while dashing correctly. Stamp already
		// returns the dash for an empty value, so the OrDash wrapper had nothing left to add.
		{"expires", ui.Stamp(approval.ExpiresAt)},
		{"note", ui.OrDash(approval.Note)},
	}, approval)
}

// printOpsRecord writes the result of `ops approve` or `ops session` on Out: for a person, one line
// saying what was created and the record as a card; for a program, the mutation result.
func printOpsRecord(p *Printer, result MutationResult, card func(io.Writer, any) error) error {
	var writeErr error
	err := p.Result(result, func(w io.Writer) {
		if _, writeErr = fmt.Fprintln(w, ui.FormatSuccess(opsRecordLine(result))); writeErr != nil {
			return
		}
		if _, writeErr = fmt.Fprintln(w); writeErr != nil {
			return
		}
		writeErr = card(w, result.Object)
	})
	if err != nil {
		return err
	}
	return writeErr
}

// opsRecordLine is the sentence a person reads above a created session or approval.
func opsRecordLine(result MutationResult) string {
	switch object := result.Object.(type) {
	case *api.BreakglassApproval:
		return fmt.Sprintf("Approval minted (expires %s)", ui.Stamp(object.ExpiresAt))
	case *api.BreakglassSession:
		return fmt.Sprintf("Session opened for %s", ui.OrDash(object.Operator))
	}
	return fmt.Sprintf("%s %s %s", result.Kind, result.ID, result.Action)
}

// opsResolveApprovalAction resolves which high-blast action the approval is for.
//
// The offered set is DERIVED from the catalog (opsApprovalActions), so it cannot list an action the
// server's approval endpoint refuses to mint — it answers 400 for anything whose spec does not
// require an approval. Validating a value given on the command line against the same set is the
// "provable subset" rule: this is a refusal the server certainly makes, and its version of it is a
// zod issue list.
func opsResolveApprovalAction(cmd *cobra.Command, args []string) string {
	f := mustOpsField(cmd.CommandPath(), opsKeyAction)
	allowed := opsApprovalActions()

	if len(args) > 0 && strings.TrimSpace(args[0]) != "" {
		action := strings.TrimSpace(args[0])
		canonical, ok := opsMatchAction(allowed, action)
		if !ok {
			e := clierr.New(clierr.CodeValidationFailed,
				fmt.Sprintf("%q does not take a two-person approval (want one of: %s)", action, strings.Join(allowed, ", ")))
			e.Hint = "Run `alethia ops approve` at a terminal to pick from the actions that take one."
			fail(e)
			return ""
		}
		// The CANONICAL spelling, not the caller's. The match is case-insensitive so an operator
		// typing STATE_SURGERY at 3am is not refused for it, but `mintApprovalSchema.action` is
		// `z.enum(breakglassAction.enumValues)` — lowercase snake_case — so posting the caller's
		// spelling turns an accepted argument into a 400 and a zod issue list at the server. That
		// is the round trip this command removes for --reason and --from/--to, landing on the only
		// gate `force-release-lock`, `state-surgery` and `orphan-clean` have.
		return canonical
	}
	if err := requireInteractiveForm(); err != nil {
		fail(opsScripted(f, err))
		return ""
	}
	i, err := opsPick(f.Title, f.Description, allowed)
	if err != nil {
		fail(err)
		return ""
	}
	return allowed[i]
}

// opsSessionCmd opens a standalone break-glass session (the action verbs open their own; this is
// for inspecting/warming a session or scripts that reuse one).
var opsSessionCmd = &cobra.Command{
	Use:   "session",
	Short: "Open a standalone time-boxed break-glass session",
	Long: "Open a time-boxed break-glass session and record why. Every action verb opens its own\n" +
		"session, so you need this only to check that break-glass works for you before an incident\n" +
		"needs it: it proves your login is an operator session and the deployment has break-glass\n" +
		"turned on. The session is written to the audit like any action.",
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		reason := opsReason(cmd)
		token, err := getAuthToken()
		if err != nil {
			fail(err)
			return
		}
		result, err := openOpsSession(api.NewClient(token), reason)
		if err != nil {
			fail(err)
			return
		}
		if err := printOpsRecord(printerFor(cmd), result, writeOpsSessionCard); err != nil {
			fail(err)
		}
	},
}

// opsSessionOpener is the one call `ops session` makes.
type opsSessionOpener interface {
	OpenBreakglassSession(reason string) (*api.BreakglassSession, error)
}

// openOpsSession opens a session and returns it as the result of the mutation that created it.
func openOpsSession(c opsSessionOpener, reason string) (MutationResult, error) {
	result := MutationResult{Kind: opsKindSession, Action: ResultCreated}
	var session *api.BreakglassSession
	var err error
	runSpinner("Opening break-glass session...", func() {
		session, err = c.OpenBreakglassSession(reason)
	})
	if err != nil {
		return result, opsRemoteError("could not open a break-glass session", err)
	}
	if session == nil {
		return result, clierr.New(clierr.CodeInternal, "the control plane opened a break-glass session but returned none")
	}
	result.ID = session.SessionID
	result.Object = session
	return result, nil
}

// writeOpsSessionCard writes an opened session as the card a person reads, in the table form only,
// for the reason writeOpsApprovalCard gives.
func writeOpsSessionCard(w io.Writer, object any) error {
	session, ok := object.(*api.BreakglassSession)
	if !ok {
		return nil
	}
	return ui.RenderCard(w, ui.FormatTable, "session", [][]string{
		{"session id", ui.OrDash(session.SessionID)},
		{"operator", ui.OrDash(session.Operator)},
		{"expires", ui.Stamp(session.ExpiresAt)},
	}, session)
}

func init() {
	registerOpsVerb(opsApproveCmd)
	registerOpsVerb(opsSessionCmd)
}

// opsMatchAction resolves a caller-supplied action to the catalog's own spelling, case-insensitively.
//
// Separate from containsFold (jobs_select.go) because the answer needed here is the matched VALUE,
// not whether one exists — a predicate cannot normalise, and the normalisation is the point.
func opsMatchAction(allowed []string, v string) (string, bool) {
	for _, a := range allowed {
		if strings.EqualFold(a, v) {
			return a, true
		}
	}
	return "", false
}
