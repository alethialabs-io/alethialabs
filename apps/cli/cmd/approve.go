// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
	"github.com/google/uuid"
	"github.com/spf13/cobra"
)

// Apply approvals (agent surface §4.2–4.3, §4.7). A deploy or a destroy queued from the CLI — a
// device login or a service token — needs a person's approval of the reviewed plan. The control
// plane answers such a job 403 `approval_required`. The CLI then requests an approval for the plan,
// prints the console page where a person decides it, waits for the decision, and queues the same
// job again with the approved id.
//
// THE CLI NEVER DECIDES AN APPROVAL. The decision is a console server action that only a person's
// browser session reaches; the approvals API this file calls only requests and reads. `alethia
// approve` therefore opens the page and sends nothing with the stored token.

// approvalClient is what the approval flow asks the control plane.
type approvalClient interface {
	RequestApproval(planJobID, operation, reason string) (*api.ApprovalResponse, error)
	GetApproval(id string) (*api.ApprovalResponse, error)
}

// approvalPollInterval is how often a waiting command reads the approval's status. A variable so a
// test can shorten it.
var approvalPollInterval = 3 * time.Second

// approvalWait is how a command behaves when its deploy or destroy needs an approval.
type approvalWait struct {
	// NoWait returns at once, exit 9, with the page to approve at. Agent mode implies it.
	NoWait bool
	// Timeout bounds the wait for the decision. Zero waits until the approval is decided or expires.
	Timeout time.Duration
	// Rerun is the command line that picks the approval up once it is decided, for the hint of a
	// command that did not wait. Empty says "run this command again".
	Rerun string
}

// approvalRequired reports whether err is the control plane refusing a deploy or a destroy until a
// person approves it.
func approvalRequired(err error) bool {
	var apiErr *api.APIError
	return errors.As(err, &apiErr) && apiErr.StatusCode == http.StatusForbidden &&
		apiErr.Code == clierr.CodeApprovalRequired
}

// approvalPageURL is the console page where a person decides approval id. The control plane names
// the path; it is joined to this CLI's own origin, so a self-hosted control plane's approvals are
// never sent to a hosted page.
func approvalPageURL(path, id string) string {
	if path == "" {
		path = "/approvals/" + id
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return strings.TrimRight(WebOrigin(), "/") + path
}

// obtainApproval requests a person's approval to run operation from the plan planJobID and returns
// the approved id. It says on stderr where the approval is decided and which digest the page must
// show, then waits for the decision unless w says not to.
//
// Requesting is idempotent on plan, operation and credential, so a command run again after the
// person approved gets the approved approval back and continues without waiting.
func obtainApproval(ctx context.Context, p *Printer, c approvalClient, planJobID, operation string, w approvalWait) (string, error) {
	resp, err := c.RequestApproval(planJobID, operation, "")
	if err != nil {
		return "", err
	}
	a := resp.Approval
	page := approvalPageURL(resp.ApprovePath, a.ID)
	switch a.Status {
	case api.ApprovalStatusApproved:
		p.Note(fmt.Sprintf("Approval %s of plan %s is approved; queueing the %s.", a.ID, planJobID, operation))
		return a.ID, nil
	case api.ApprovalStatusPending:
	default:
		return "", approvalEnded(a, page)
	}
	p.Warn(fmt.Sprintf(
		"This %s needs a person's approval. Approve it at %s — the page must show plan %s with a digest starting %s.",
		operation, page, planJobID, a.DigestPrefix))
	if w.NoWait || p.Mode.Agent {
		return "", approvalPending(a, page, w.Rerun)
	}
	return awaitApprovalDecision(ctx, p, c, a, page, w.Timeout)
}

// awaitApprovalDecision polls approval a until a person decides it, it stops being usable, the
// deadline passes or ctx ends. It returns the id once the approval is approved.
func awaitApprovalDecision(ctx context.Context, p *Printer, c approvalClient, a api.Approval, page string, timeout time.Duration) (string, error) {
	if timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	p.Progress(fmt.Sprintf("Waiting for approval %s to be decided (expires %s)...", a.ID, a.ExpiresAt))
	failures := 0
	for {
		if err := sleepOrDone(ctx, approvalPollInterval); err != nil {
			return "", approvalWaitEnded(err, a.ID, page, timeout)
		}
		resp, err := c.GetApproval(a.ID)
		if err != nil {
			failures++
			if !clierr.From(err).Retryable || failures >= maxPollFailures {
				return "", err
			}
			continue
		}
		failures = 0
		switch resp.Approval.Status {
		case api.ApprovalStatusPending:
			continue
		case api.ApprovalStatusApproved:
			p.Note(fmt.Sprintf("Approval %s was approved.", a.ID))
			return a.ID, nil
		default:
			return "", approvalEnded(resp.Approval, page)
		}
	}
}

// approvalOp names an approval as the operation an error is about.
func approvalOp(id string) *clierr.Op { return &clierr.Op{ID: id, Type: "APPROVAL"} }

// approvalPending is the result of a command that did not wait: exit 9, the page to approve at,
// and how to continue once it is approved.
func approvalPending(a api.Approval, page, rerun string) error {
	e := clierr.New(clierr.CodeApprovalRequired, fmt.Sprintf(
		"approval %s is waiting for a person to approve it at %s; nothing was queued", a.ID, page))
	if rerun == "" {
		rerun = "run this command again"
	}
	e.Hint = fmt.Sprintf("open %s, check the digest starts %s and approve it, then %s", page, a.DigestPrefix, rerun)
	e.Operation = approvalOp(a.ID)
	return e
}

// approvalEnded is the error for an approval that will never be approved: rejected, expired,
// superseded or already used.
func approvalEnded(a api.Approval, page string) error {
	var e *clierr.Error
	switch a.Status {
	case api.ApprovalStatusRejected:
		e = clierr.New(clierr.CodeApprovalRejected, fmt.Sprintf("approval %s was rejected; nothing was queued", a.ID))
		e.Hint = "see who rejected it and why at " + page
	case api.ApprovalStatusSuperseded:
		e = clierr.New(clierr.CodeApprovalInvalid, fmt.Sprintf(
			"approval %s was superseded by a newer plan or change of the environment; nothing was queued", a.ID))
		e.Hint = "plan again and ask for a new approval"
	default:
		e = clierr.New(clierr.CodeApprovalInvalid, fmt.Sprintf(
			"approval %s is %s and can no longer be used; nothing was queued", a.ID, a.Status))
		e.Hint = "run the command again to ask for a new approval"
	}
	e.Operation = approvalOp(a.ID)
	return e
}

// approvalWaitEnded classifies a wait for a decision that stopped first: a passed deadline exits
// 12 and an interrupt 130. The approval stays pending either way.
func approvalWaitEnded(cause error, id, page string, timeout time.Duration) error {
	var e *clierr.Error
	if errors.Is(cause, context.DeadlineExceeded) {
		e = clierr.New(clierr.CodeWaitTimeout, fmt.Sprintf(
			"timed out after %s waiting for approval %s; it is still pending and nothing was queued", timeout, id))
	} else {
		e = clierr.New(clierr.CodeInterrupted, fmt.Sprintf(
			"interrupted while waiting for approval %s; it is still pending and nothing was queued", id))
	}
	e.Hint = "approve it at " + page + ", then run the command again"
	e.Cause = cause
	e.Operation = approvalOp(id)
	return e
}

// queueWithApproval queues a deploy or a destroy through queue, and when the control plane answers
// that it needs a person's approval, obtains one for planJobID and queues it again with the approved
// id. planJobID is resolved only when it is needed: a caller that can queue without an approval
// never pays for the lookup. A nil approvals client passes the refusal through unchanged.
func queueWithApproval[T any](
	ctx context.Context,
	p *Printer,
	approvals approvalClient,
	operation string,
	planJobID func() (string, error),
	w approvalWait,
	queue func(approvalID string) (T, error),
) (T, error) {
	out, err := queue("")
	if err == nil || approvals == nil || !approvalRequired(err) {
		return out, err
	}
	plan, perr := planJobID()
	if perr != nil {
		return out, perr
	}
	id, aerr := obtainApproval(ctx, p, approvals, plan, operation, w)
	if aerr != nil {
		return out, aerr
	}
	return queue(id)
}

// ── alethia approve ─────────────────────────────────────────────────────────────────────────

var approveNoBrowser bool

var approveCmd = &cobra.Command{
	Use:   "approve [approval-id]",
	Short: "Open the console page where a person approves a deploy or destroy",
	Args:  cobra.MaximumNArgs(1),
	Long: `Open the console page where a person approves (or rejects) a deploy or a destroy that the
CLI, an agent or a service token asked for.

A deploy or destroy started from the CLI waits for a person's approval of its reviewed plan. The
command that asked prints the approval id and its page; this opens that page in your browser.
Check that the page shows the plan digest the asking command printed before you approve.

approve never approves anything itself and sends nothing to the control plane: the decision is
made only in a signed-in console session, so a stored CLI credential, or an agent holding one,
cannot approve its own request. Omit the id on a terminal and you are asked for it. --no-browser
prints the page instead of opening it.`,
	Run: func(cmd *cobra.Command, args []string) {
		if err := runApprove(printerFor(cmd), args, approveNoBrowser); err != nil {
			fail(err)
		}
	},
}

// runApprove resolves the approval id and opens (or prints) its console page. It makes no request.
func runApprove(p *Printer, args []string, noBrowser bool) error {
	id := ""
	if len(args) == 1 {
		id = strings.TrimSpace(args[0])
	}
	if id == "" {
		var err error
		if id, err = promptApprovalID(); err != nil {
			return flagRequired(err, "[approval-id]",
				"pass the approval id the deploy or destroy printed: alethia approve <approval-id>")
		}
	}
	if err := validApprovalID(id); err != nil {
		return refusal(clierr.CodeValidationFailed, "",
			"%q is not an approval id: pass the id the deploy or destroy printed", id)
	}
	page := approvalPageURL("", id)
	if noBrowser || p.Mode.Agent || !canPromptForm() {
		fmt.Fprintln(p.Out, page)
		return nil
	}
	p.Note("Opening " + page)
	if err := openBrowser(page); err != nil {
		p.Warn("Could not open a browser. Open this page yourself: " + page)
	}
	fmt.Fprintln(p.Out, page)
	return nil
}

// validApprovalID refuses what is not an approval id (a UUID), surrounding spaces aside.
func validApprovalID(s string) error {
	if _, err := uuid.Parse(strings.TrimSpace(s)); err != nil {
		return errors.New("an approval id is a UUID")
	}
	return nil
}

// promptApprovalID asks for the approval id on a terminal.
func promptApprovalID() (string, error) {
	if err := requireInteractiveForm(); err != nil {
		return "", err
	}
	var id string
	group := huh.NewGroup(
		huh.NewInput().
			Title("Approval id").
			Description("The id the deploy or destroy printed when it asked for an approval").
			Value(&id).
			Validate(validApprovalID),
	)
	if err := runHuhForm(group); err != nil {
		return "", err
	}
	return strings.TrimSpace(id), nil
}

func init() {
	approveCmd.Flags().BoolVar(&approveNoBrowser, "no-browser", false, "Print the approval page instead of opening it")
	rootCmd.AddCommand(approveCmd)
}

// addApprovalNoWaitFlag registers --no-wait on a project command whose job may need an approval.
// It is the opposite of --wait, so the two are refused together.
func addApprovalNoWaitFlag(cmd *cobra.Command, target *bool) {
	cmd.Flags().BoolVar(target, "no-wait", false,
		"When a person's approval is needed, print where to approve and exit 9 instead of waiting")
	cmd.MarkFlagsMutuallyExclusive("wait", "no-wait")
}
