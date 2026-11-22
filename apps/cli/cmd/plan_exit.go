// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
)

// The exit codes of `alethia plan` and `alethia apply` (#5600).
//
// A pipeline runs `alethia plan` on a pull request and gates on its exit code. Before #5600 a plan
// with `--output json` exited 0 while it carried problems (a stage, placement or lifecycle the file
// cannot change, an add-on it cannot send), so the check went green and the refusal surfaced only at
// `apply`. The table form already exited non-zero, but with 1 — the same code as "the API could not
// be reached" — so a script could not tell "this file is wrong" from "try again".
//
// The default answers the question a gate asks — "will apply accept this file?":
//
//	0  apply would accept it (changes or not)
//	1  error: the file could not be read or validated, the server could not be reached, …
//	2  the plan has problems; apply would refuse it
//
// Changes alone keep exit 0 on purpose: the ordinary pipeline is `plan` then `apply`, and a plan
// that exited non-zero whenever there was something to apply would stop every one of them.
//
// `--detailed-exitcode` is Terraform's convention for a pipeline that also wants to know whether
// there is anything to apply. Problems win over changes, because a plan with both cannot be applied:
//
//	0  no changes, no problems
//	1  error
//	2  changes, no problems
//	3  problems
//
// `apply` refuses a plan with problems before it writes anything and exits 2, the code the default
// `plan` gives the same file, so a script reads one number for "this file cannot be applied as
// written" from either command.
const (
	// exitPlanRefused is the default `plan`'s and `apply`'s code for a plan with problems.
	exitPlanRefused = 2
	// exitPlanChanges is `plan --detailed-exitcode`'s code for changes and no problems.
	exitPlanChanges = 2
	// exitPlanProblems is `plan --detailed-exitcode`'s code for a plan with problems.
	exitPlanProblems = 3
)

// codePlanRefused is the `code` of a refused plan in the json error object. It is not in the
// global registry on purpose: the registry's classes start at 4, and 2 and 3 are these two
// commands' own (pkg/clierr/registry.go).
const codePlanRefused = "plan_refused"

// planRefusedHint is the next step after a refusal.
const planRefusedHint = "change the file so it matches what the server has, or make the change in the console, then run `alethia plan` again"

// planExitCode is the code `plan` exits with for a plan it computed. Errors before the plan exists
// exit 1 through fail and never reach this.
func planExitCode(p *ApplyPlan, detailed bool) int {
	refused := p.Refusal() != nil
	switch {
	case refused && detailed:
		return exitPlanProblems
	case refused:
		return exitPlanRefused
	case detailed && p.HasChanges():
		return exitPlanChanges
	}
	return 0
}

// reportRefusal prints why the plan cannot be applied, on stderr in every format: stdout carries
// the plan and nothing else, so the sentence is there for the person reading the terminal or the CI
// log and never in a document a program parses. Under `--output json` it is the same error object
// every other failure is, with the code `plan_refused` and the exit code the command is about to
// leave with, which is its own and not a class's.
func reportRefusal(err error, format string, exit int) {
	if format == ui.FormatJSON {
		e := clierr.New(codePlanRefused, err.Error())
		e.Exit = exit
		e.Hint = planRefusedHint
		_ = clierr.WriteJSON(os.Stderr, e)
		return
	}
	ui.ErrorTo(os.Stderr, err.Error())
	fmt.Fprintf(os.Stderr, "  %s\n", ui.MutedStyle.Render("hint     "+planRefusedHint))
}

// finishPlan ends `plan` once the plan has been printed: it reports any refusal and exits with the
// code planExitCode chooses. A zero code returns normally.
func finishPlan(p *ApplyPlan, detailed bool, format string) {
	code := planExitCode(p, detailed)
	if err := p.Refusal(); err != nil {
		reportRefusal(err, format, code)
	}
	if code != 0 {
		exitFunc(code)
	}
}
