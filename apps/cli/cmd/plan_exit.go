// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"

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

// hasChanges reports whether apply would write anything: a project or environment to create, or a
// component or add-on to create or update. Unmanaged environments and add-ons are left alone, so
// they are not changes.
func (p *ApplyPlan) hasChanges() bool {
	if p.ProjectID == "" {
		return true
	}
	for _, e := range p.Environments {
		if e.Action != ActionUnchanged {
			return true
		}
		for _, c := range e.Components {
			if c.Action != ActionUnchanged {
				return true
			}
		}
		for _, a := range e.Addons {
			if a.Action != ActionUnchanged {
				return true
			}
		}
	}
	return false
}

// planExitCode is the code `plan` exits with for a plan it computed. Errors before the plan exists
// exit 1 through fail and never reach this.
func planExitCode(p *ApplyPlan, detailed bool) int {
	refused := p.refusal() != nil
	switch {
	case refused && detailed:
		return exitPlanProblems
	case refused:
		return exitPlanRefused
	case detailed && p.hasChanges():
		return exitPlanChanges
	}
	return 0
}

// reportRefusal prints why the plan cannot be applied. In table form it is the usual error line on
// stdout, under the plan. With `--output json|yaml` stdout carries the document and nothing else, so
// the sentence goes to stderr for the person reading the CI log.
func reportRefusal(err error, format string) {
	if format == ui.FormatTable {
		ui.Error(err.Error())
		return
	}
	fmt.Fprintf(os.Stderr, "%s %s\n", ui.SymbolError, err.Error())
}

// finishPlan ends `plan` once the plan has been printed: it reports any refusal and exits with the
// code planExitCode chooses. A zero code returns normally.
func finishPlan(p *ApplyPlan, detailed bool, format string) {
	if err := p.refusal(); err != nil {
		reportRefusal(err, format)
	}
	if code := planExitCode(p, detailed); code != 0 {
		exitFunc(code)
	}
}
