// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/spf13/cobra"
)

// What every command of the governance family shares: how a list is printed, how a change is
// reported, how a refusal is classed, and how a destructive command asks first.
//
// The family is org, members, teams, roles, grants, sso, alerts, channels, classification and
// token. Each command file holds what is particular to its noun; the four rules below are written
// once so that no two of them can come to disagree:
//
//   - a list is one document on stdout, and an empty list says so on stderr;
//   - a change returns one MutationResult, and with --dry-run sends nothing;
//   - a failure leaves through fail with a class from pkg/clierr and a next step;
//   - a destructive command asks, and with nobody to ask it needs --yes.

// The `kind` of each subject a governance command changes.
const (
	govKindOrganization   = "organization"
	govKindInvitation     = "invitation"
	govKindMember         = "member"
	govKindTeam           = "team"
	govKindRole           = "role"
	govKindGrant          = "grant"
	govKindAlertRule      = "alert_rule"
	govKindChannel        = "channel"
	govKindClassification = "classification"
	govKindServiceToken   = "service_token"
)

// --- Lists ---

// listView is how one list command is drawn: the words around the table and the table itself.
type listView[T any] struct {
	// Spinner is the line shown while the list is fetched on a terminal.
	Spinner string
	// Title names the rows in the interactive table's footer, in the plural.
	Title string
	// Empty is what an empty list says, with the command that adds the first entry where one exists.
	Empty string
	// Columns are the table's headers.
	Columns []string
	// Rows projects the records into cells for one output format.
	Rows func(items []T, format string) [][]string
}

// renderList writes a fetched list on out in one format. An empty list has no table to print: for
// a person the empty state is said on stderr, and a program gets an empty array or a bare header.
func renderList[T any](out io.Writer, format string, v listView[T], items []T) error {
	if len(items) == 0 && emptyListNote(printer, format, v.Empty) {
		return nil
	}
	if items == nil {
		items = []T{}
	}
	return ui.Render(out, format, ui.TableSpec{Columns: v.Columns, Rows: v.Rows(items, format)}, items)
}

// runListCommand is the body of a list command: the browsable table on a terminal, the static
// table, json or csv everywhere else.
func runListCommand[T any](cmd *cobra.Command, v listView[T], fetch func() ([]T, error)) error {
	format := outputFormat(cmd)
	if !interactiveTable(cmd) {
		items, err := fetch()
		if err != nil {
			return governanceError(err)
		}
		return renderList(printer.Out, format, v, items)
	}
	var items []T
	var err error
	runSpinner(v.Spinner, func() { items, err = fetch() })
	if err != nil {
		return governanceError(err)
	}
	if len(items) == 0 {
		printer.Note(v.Empty)
		return nil
	}
	if err := ui.ShowTable(v.Columns, v.Rows(items, ui.FormatTable), v.Title); err != nil {
		return fmt.Errorf("show the %s table: %w", v.Title, err)
	}
	return nil
}

// --- Changes ---

// plannedRequest is the `object` of a dry-run result: the request the command would have sent.
type plannedRequest struct {
	Request any `json:"request"`
}

// printChange writes a change's result: the sentence for a person, the result for a program.
func printChange(p *Printer, result MutationResult, sentence string) error {
	return p.Result(result, func(w io.Writer) {
		fmt.Fprintln(w, ui.FormatSuccess(sentence))
	})
}

// printDryRun writes what a change would have done. would is the sentence without its ending,
// for example "Would delete team platform".
func printDryRun(p *Printer, result MutationResult, would string) error {
	result.DryRun = true
	return p.Result(result, func(w io.Writer) {
		fmt.Fprintln(w, ui.MutedStyle.Render(would+". Nothing was sent."))
	})
}

// --- Refusals ---

// governanceHints is the next step for a control-plane refusal that named none, by error code.
var governanceHints = map[string]string{
	clierr.CodePlanLimit:          "`alethia billing` shows the organization's plan and what it includes",
	clierr.CodeQuotaExceeded:      "`alethia usage` shows what the organization has used",
	clierr.CodeForbidden:          "`alethia whoami` shows the organization you are acting in and your role there",
	clierr.CodeAuthRequired:       "alethia login",
	clierr.CodeTokenExpired:       "alethia login",
	clierr.CodeServiceUnavailable: "try again shortly; --debug shows the request that failed",
	clierr.CodeNetworkUnreachable: "check the connection and `alethia config get web-origin`, then try again",
}

// governanceError returns err as the classified error the fatal path renders, with a next step
// when the error brought none. The message is the control plane's own sentence: nothing here
// rewrites what it said.
func governanceError(err error) error {
	if err == nil {
		return nil
	}
	e := *clierr.From(err)
	if e.Hint == "" {
		e.Hint = governanceHints[e.Code]
	}
	if e.Hint == "" && e.HTTPStatus == http.StatusPaymentRequired {
		// A 402 under a code the registry does not carry: still a plan limit, with a newer name.
		e.Hint = governanceHints[clierr.CodePlanLimit]
	}
	return &e
}

// notFoundHint returns err with listCmd as its next step when the control plane answered that the
// thing does not exist and suggested nothing itself. Any other error is returned unchanged.
func notFoundHint(err error, listCmd string) error {
	if err == nil {
		return nil
	}
	e := *clierr.From(err)
	if e.Class != clierr.ClassNotFound || e.Hint != "" {
		return err
	}
	e.Hint = listCmd
	return &e
}

// errNoRecord is the answer to a success that carried no record of what it did.
func errNoRecord(what string) error {
	return clierr.New(clierr.CodeInternal,
		"the control plane accepted the "+what+" but returned no record of it")
}

// needsYes is the refusal for a destructive command with nobody to ask, naming the command line
// that confirms it.
func needsYes(command string) error {
	e := *errConfirmRequiresYes
	e.Hint = command + " --yes"
	return &e
}

// --- Confirmations ---

// confirmChange reports whether a destructive change may go ahead, by a yes or no. yes is the
// command's --yes flag; command is the command line the refusal names when nobody can be asked.
func confirmChange(yes bool, command, title, description string) (bool, error) {
	if yes {
		return true, nil
	}
	if !canPromptForm() {
		return false, needsYes(command)
	}
	return confirm(title, description), nil
}

// confirmChangeByName reports whether a destructive change may go ahead, by typing the name of
// the thing that is about to go. name is a function because finding the name can cost a request,
// and it is only made when somebody is about to type it.
func confirmChangeByName(yes bool, command, title, description string, name func() string) (bool, error) {
	if yes {
		return true, nil
	}
	if !canPromptForm() {
		return false, needsYes(command)
	}
	return confirmTypedName(title, description, name()), nil
}

// --- Secrets on stdin ---

// readSecretLine reads one secret from stdin: everything up to the end of input, with the
// surrounding whitespace removed. flag is the flag that asked for it, for the refusal.
func readSecretLine(stdin io.Reader, flag string) (string, error) {
	raw, err := io.ReadAll(stdin)
	if err != nil {
		return "", invalidInputError("read --%s from stdin: %v", flag, err)
	}
	secret := strings.TrimSpace(string(raw))
	if secret == "" {
		return "", refusal(clierr.CodeInputRequired, "printf %s \"$SECRET\" | alethia channels create --"+flag,
			"--%s was given and stdin was empty", flag)
	}
	return secret, nil
}
