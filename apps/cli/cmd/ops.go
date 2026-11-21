// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/signal"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

// opsCmd groups the break-glass (privileged incident recovery) verbs. Every verb hits the SAME
// audited /api/breakglass/* endpoints as the operator UI, with the same append-only audit —
// terminal-first operators during an incident. The bearer must be an interactive `alethia login`
// session: the server refuses a service token (ALETHIA_TOKEN / --token) with 403, because a service
// token is pinned to one org and break-glass is platform-wide (#5496). The entire surface is gated
// behind ALETHIA_BREAKGLASS_ENABLED + the BREAKGLASS_OPERATORS allowlist server-side; a
// non-operator (or a disabled deployment) is refused with 403/404.
//
// The group is NOT LISTED unless the ops capability is on (capabilities.go, ALETHIA_OPS=1); that is
// meta_ops.go's entry, applied by the registry. It still runs when named: the switch decides what
// this CLI shows a customer, and the server decides who may break glass.
var opsCmd = &cobra.Command{
	Use:   "ops",
	Short: "Break-glass incident recovery (privileged, audited, gated)",
	Long: "Break-glass incident-recovery actions for on-call operators.\n\n" +
		"Every action is audited (append-only, written before the act), requires a --reason, and\n" +
		"typed-confirms the resource id server-side. Every MUTATING action also asks you to confirm\n" +
		"it at the terminal, naming the resource and the consequence; --yes is how a runbook opts\n" +
		"in ahead of time. force-release-lock additionally requires a two-person --approval token\n" +
		"minted by a DIFFERENT operator via `alethia ops approve`.\n\n" +
		"Break-glass needs a session from `alethia login`. A service token is refused with 403,\n" +
		"however it is supplied. A session token is accepted from ALETHIA_TOKEN or --token too,\n" +
		"so never put an operator's session credentials in CI.\n\n" +
		"This group is not listed in `alethia --help` unless " + OpsEnv + "=1 is set. The switch\n" +
		"changes only what the CLI lists; the server's operator allowlist decides who may act.",
	Run: func(cmd *cobra.Command, args []string) {
		_ = cmd.Help()
	},
}

func init() {
	rootCmd.AddCommand(opsCmd)
}

// mustOpsAction returns the catalog entry for a command path.
//
// It panics on a miss for the reason mustOpsField does: the path is the cobra tree's own, so a miss
// is a programming error, and the alternative — a zero opsAction — is a MUTATING break-glass verb
// silently classified read-only and shipped with no confirmation at all. ops_form_test.go resolves
// every leaf, so an unmapped one cannot ship.
func mustOpsAction(path string) opsAction {
	if a, ok := opsActionFor(path); ok {
		return a
	}
	panic(fmt.Sprintf("no opsAction for %q — see opsActions in ops_fields.go", path))
}

// opsRequest is one break-glass invocation, assembled by a verb and executed by runOpsAction.
//
// The action name and whether it mutates are NOT fields: both are read from the catalog by the
// command's own path, so a verb cannot dispatch one action while confirming as another, and a
// mutating verb cannot be wired as read-only by forgetting an argument. That was previously two
// bare positional parameters — `runOpsAction("cancel_job", …, false)` — and the last one, the one
// that decides whether the typed-confirm is sent at all, was a bare boolean at every call site.
type opsRequest struct {
	// Cmd is the verb being run. Its CommandPath resolves the catalog entry and the output format.
	Cmd *cobra.Command
	// ResourceID is the audited target. Mutating actions echo it back as the typed confirmation.
	ResourceID string
	// Reason is the audit reason, already resolved and validated.
	Reason string
	// ApprovalID is the two-person token, empty for the actions that need none.
	ApprovalID string
	// Input is the action's typed input block.
	Input *api.BreakglassActionInput
	// Resource names the target in the confirmation prompt: "job 8f3c1d2e", "runner ci-eu-1".
	Resource string
	// Consequence is what the confirmation promises will happen, in one clause.
	Consequence string
}

// opsActionClient is what one break-glass action asks the control plane: a session, the action,
// and — when the action queued a job and --wait was given — that job's status. *api.Client
// satisfies it, and so does a test double.
type opsActionClient interface {
	OpenBreakglassSession(reason string) (*api.BreakglassSession, error)
	ExecuteBreakglass(params api.BreakglassExecuteParams) (*api.BreakglassResult, error)
	jobPoller
}

// opsOutcome is what one executed action produced: the server's result always, and the mutation
// result when the action changes something. A read-only action has no mutation result, and its
// json form is the server's result as it came.
type opsOutcome struct {
	// Result is the control plane's answer.
	Result *api.BreakglassResult
	// Mutation is the result shape of a mutating action, or nil for a read-only one.
	Mutation *MutationResult
	// JobStatus is the status the queued job ended in when the command waited for it, or empty.
	JobStatus string
}

// runOpsAction is the shared path for every ops verb: it confirms, opens a fresh time-boxed
// break-glass session (recording the reason), then executes the action against the single audited
// endpoint. The typed-confirm is satisfied by sending confirm == resourceId (the server enforces
// the equality).
//
// The confirmation happens BEFORE the session is opened, and that ordering is the contract: a
// declined or unconfirmed action must leave no trace, and an opened session is an audit row.
func runOpsAction(req opsRequest) {
	action := mustOpsAction(req.Cmd.CommandPath())

	if !action.ReadOnly && !opsConfirm(req.Cmd.CommandPath(), req.Resource, req.Consequence) {
		return
	}

	// The reason is NOT re-validated here. opsReason is the single gate — it checks the supplied
	// flag and validates the prompt's answer against the same bound — and a second copy of the rule
	// on a path nothing can reach with an invalid value is a branch no test can honestly drive.
	token, err := getAuthToken()
	if err != nil {
		fail(err)
		return
	}
	p := printerFor(req.Cmd)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	outcome, err := executeOpsAction(ctx, p, api.NewClient(token), req, action, opsWaitFor(req.Cmd.CommandPath()))
	if err != nil {
		fail(err)
		return
	}
	if err := printOpsOutcome(p, outcome); err != nil {
		fail(err)
	}
}

// executeOpsAction opens the session, executes the action and, for an action that queued a job,
// follows the job when --wait was given. It writes nothing on Out: the caller renders the outcome.
//
// The session is opened first and its failure stops the command there, so an action is never sent
// with an empty session id — which the server would refuse for a second, less legible reason.
func executeOpsAction(ctx context.Context, p *Printer, c opsActionClient, req opsRequest, action opsAction, wait waitFlags) (opsOutcome, error) {
	var session *api.BreakglassSession
	var err error
	runSpinner("Opening break-glass session...", func() {
		session, err = c.OpenBreakglassSession(req.Reason)
	})
	if err != nil {
		return opsOutcome{}, opsRemoteError("could not open a break-glass session", err)
	}
	if session == nil {
		return opsOutcome{}, clierr.New(clierr.CodeInternal, "the control plane opened a break-glass session but returned none")
	}

	params := api.BreakglassExecuteParams{
		SessionID:  session.SessionID,
		Action:     action.Action,
		ResourceID: req.ResourceID,
		Reason:     req.Reason,
		ApprovalID: req.ApprovalID,
		Input:      req.Input,
	}
	// Typed-confirm: mutating actions must echo the exact resource id (server-enforced).
	if !action.ReadOnly && req.ResourceID != "" {
		params.Confirm = req.ResourceID
	}

	var result *api.BreakglassResult
	runSpinner(fmt.Sprintf("Executing %s...", action.Action), func() {
		result, err = c.ExecuteBreakglass(params)
	})
	if err != nil {
		return opsOutcome{}, opsRemoteError(fmt.Sprintf("the %s action was refused", action.Action), err)
	}
	if result == nil {
		return opsOutcome{}, clierr.New(clierr.CodeInternal, fmt.Sprintf("the control plane accepted %s but returned no result", action.Action))
	}

	outcome := opsOutcome{Result: result}
	if action.ReadOnly {
		return outcome, nil
	}

	m := MutationResult{ID: req.ResourceID, Kind: action.Kind, Action: ResultUpdated, Object: result}
	outcome.Mutation = &m
	jobID := opsQueuedJobID(result.Data)
	if !action.Queues || jobID == "" {
		if action.Queues && wait.Wait {
			p.Warn("The control plane named no job to wait for; nothing was waited on.")
		}
		return outcome, nil
	}

	m.Action = ResultQueued
	m.Job = &JobRef{ID: jobID, Type: action.JobType}
	jobLabel := action.JobType
	if jobLabel == "" {
		jobLabel = "fresh"
	}
	p.JobQueued(jobLabel, jobID)
	if !wait.Wait {
		return outcome, nil
	}
	done, err := awaitJob(ctx, c, jobID, wait.options(action.JobType, p))
	if err != nil {
		return outcome, err
	}
	outcome.JobStatus = done.Status
	if m.Job.Type == "" {
		m.Job.Type = done.JobType
	}
	return outcome, nil
}

// opsQueuedJobID reads the id of the job an action queued from its result payload, which carries it
// as `jobId` (retry_job and state_surgery in apps/console/lib/breakglass/actions.ts). Any other
// payload names no job.
func opsQueuedJobID(raw json.RawMessage) string {
	var payload struct {
		JobID string `json:"jobId"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return ""
	}
	return strings.TrimSpace(payload.JobID)
}

// opsRemoteHints are the next steps for the answers break-glass most often gets, by class. The
// control plane's own hint wins when it sent one.
//
// A map rather than a switch over clierr.Class: the class is an enum and a switch over it must list
// every member, and only these two have a step specific to break-glass.
var opsRemoteHints = map[clierr.Class]string{
	clierr.ClassForbidden: "Break-glass takes an operator's session from `alethia login`, and a service token is refused. " +
		"Unset ALETHIA_TOKEN, sign in, and check that you are on the operator allowlist.",
	clierr.ClassNotFound: "Either this deployment has break-glass turned off, or the id given does not exist.",
}

// opsRemoteError classifies a refused break-glass call, keeping what was being done in the message
// and the control plane's own class, request id and hint. The cause stays reachable.
func opsRemoteError(what string, err error) error {
	e := clierr.From(fmt.Errorf("%s: %w", what, err))
	if e.Hint == "" {
		e.Hint = opsRemoteHints[e.Class]
	}
	return e
}

// opsReport is a read-only action's result, which is the control plane's answer as it came: `ok`,
// `detail` and `data`. Its csv form is the card's Field/Value rows.
type opsReport api.BreakglassResult

// Table returns the result's payload as Field/Value rows, for csv.
func (r opsReport) Table() ui.TableSpec {
	return ui.TableSpec{Columns: []string{"Field", "Value"}, Rows: opsDataRows(r.Data)}
}

// printOpsOutcome writes an executed action's result on Out: for a person, the server's sentence and
// the payload as a card; for a program, the mutation result of a mutating action and the server's
// answer of a read-only one.
func printOpsOutcome(p *Printer, o opsOutcome) error {
	if o.Mutation == nil {
		return printOpsReport(p, o.Result)
	}
	var writeErr error
	err := p.Result(*o.Mutation, func(w io.Writer) {
		writeErr = writeOpsResult(w, o.Result, o.Mutation, o.JobStatus)
	})
	if err != nil {
		return err
	}
	return writeErr
}

// printOpsReport writes a read-only action's result on Out, in the Printer's format.
//
// The success line is TABLE-ONLY. It used to be printed unconditionally, ahead of a raw
// json.MarshalIndent of the payload, so `alethia ops inspect-job … -o json` emitted a styled
// sentence and then a document — which is not JSON, and is the one output an operator is most
// likely to be piping into `jq` during an incident.
func printOpsReport(p *Printer, result *api.BreakglassResult) error {
	var writeErr error
	err := p.Result(opsReport(*result), func(w io.Writer) {
		writeErr = writeOpsResult(w, result, nil, "")
	})
	if err != nil {
		return err
	}
	return writeErr
}

// writeOpsResult writes a result for a person: the server's sentence, the job's end when the
// command waited for it, and the payload as a card when there is one.
func writeOpsResult(w io.Writer, result *api.BreakglassResult, m *MutationResult, jobStatus string) error {
	if _, err := fmt.Fprintln(w, ui.FormatSuccess(ui.OrDash(result.Detail))); err != nil {
		return err
	}
	if m != nil && m.Job != nil && jobStatus != "" {
		if _, err := fmt.Fprintln(w, ui.FormatSuccess(fmt.Sprintf("Job %s finished: %s", m.Job.ID, jobStatus))); err != nil {
			return err
		}
	}
	rows := opsDataRows(result.Data)
	if len(rows) == 0 {
		return nil
	}
	if _, err := fmt.Fprintln(w); err != nil {
		return err
	}
	return ui.RenderCard(w, ui.FormatTable, "result", rows, result)
}

// opsDataRows renders a break-glass result payload as ordered Field/Value rows.
//
// The payload's shape is the ACTION's, not one this CLI can name in advance — a job row, a list of
// orphan candidates, a rotated fencing token — so it is read as JSON and flattened one level, keys
// sorted so two runs of the same action read the same way. A non-object payload (a list, a bare
// value) becomes a single row rather than being dropped: a reader who cannot see it has no way to
// know it was there.
func opsDataRows(raw json.RawMessage) [][]string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return [][]string{{"data", trimmed}}
	}
	keys := make([]string, 0, len(fields))
	for k := range fields {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	rows := make([][]string, 0, len(keys))
	for _, k := range keys {
		rows = append(rows, []string{k, opsScalar(fields[k])})
	}
	return rows
}

// opsScalar renders one JSON value for a card cell: a string without its quotes, anything else as
// the compact JSON it is.
func opsScalar(raw json.RawMessage) string {
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return ui.OrDash(s)
	}
	return strings.TrimSpace(string(raw))
}
