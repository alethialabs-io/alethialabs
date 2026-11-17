// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

// exitFunc is the process-exit hook the fatal-error path calls. It is os.Exit in
// production — behaviour is unchanged — and exists only so tests can observe a
// fatal path without the test binary being killed by a real exit.
var exitFunc = os.Exit

// errorFormat is the --output value the running command was given, recorded by the root
// PersistentPreRun so the fatal path can render an error in the form the caller asked for. It is
// the ROOT's persistent flag and nothing else: a subcommand that reuses the name for a file path
// leaves it at its default, so a path is never mistaken for a format.
//
// It is a recorded value rather than a read of rootCmd for a compile-time reason: fail is reachable
// from rootCmd's own initializer, so naming rootCmd here is an initialization cycle.
var errorFormat = ui.FormatTable

// fail renders err on stderr and exits with the code its class owns. It is the single fatal-error
// path for the CLI: clierr.From decides the class, pkg/clierr/registry.go decides the number, and
// nothing is written to stdout — that stream is the command's document.
//
// Under `--output json` the error is one alethia.error/v1 object on stderr; otherwise it is the
// message in the standard grayscale error style, followed by a hint, a docs link and a request id
// when the error carries them.
func fail(err error) {
	e := clierr.From(err)
	if errorFormat == ui.FormatJSON {
		_ = clierr.WriteJSON(os.Stderr, e)
	} else {
		clierr.WriteHuman(os.Stderr, e, ui.SymbolError, clierr.Styles{
			Headline: func(s string) string { return ui.ErrorStyle.Render(s) },
			Detail:   func(s string) string { return ui.MutedStyle.Render(s) },
		})
	}
	exitFunc(e.Exit)
}

// failf formats an error and dies on the fatal path. A %w verb keeps the wrapped error reachable,
// so a typed cause still decides the exit code.
func failf(format string, args ...any) {
	fail(fmt.Errorf(format, args...))
}

// usageError classifies an error cobra returned from Execute. No command in the tree returns an
// error from its run function, so what arrives here is cobra's own refusal — an unknown command or
// a rejected argument — and nothing has been sent anywhere. An error that already carries a class
// keeps it.
func usageError(err error) error {
	if clierr.From(err).Class != clierr.ClassUnclassified {
		return err
	}
	return clierr.Wrap(clierr.CodeInvalidUsage, err)
}

// flagError classifies a flag cobra could not parse. It is the root's FlagErrorFunc, which every
// subcommand inherits.
func flagError(_ *cobra.Command, err error) error {
	return clierr.Wrap(clierr.CodeInvalidFlag, err)
}

// confirm shows a yes/no dialog and reports whether the user confirmed. It
// returns false on a negative answer or an aborted/errored prompt, printing a
// short "Cancelled." note so callers can simply `return` on false.
//
// It is a variable for the reason seams.go records, with one addition specific to
// it: stubbing runHuhForm keeps the prompt from blocking, but no stub can answer
// "yes" on the caller's behalf — the answer is written through a pointer the huh
// group owns and never exposes — so the *confirmed* branch of every destructive
// command is unreachable otherwise. The default below is the real prompt, so
// production behaviour is unchanged.
var confirm = func(title, description string) bool {
	// Prompting is off, or the form has nowhere visible to draw: it can never be
	// answered, so decline without opening it. Callers for which a silent decline
	// would be wrong go through confirmDestructive instead.
	//
	// canPromptForm and not noInputMode: a confirm IS a huh form, so it draws on the
	// stream ui.InteractiveOutput names and needs a terminal there. Reading noInputMode let
	// `alethia alerts delete r1 2> log` open a Yes/No into the log file and wait for a
	// keystroke against a blank terminal.
	if !canPromptForm() {
		ui.Muted("Cancelled.")
		return false
	}
	var ok bool
	err := runHuhForm(
		huh.NewGroup(
			huh.NewConfirm().
				Title(title).
				Description(description).
				Value(&ok),
		),
	)
	if err != nil || !ok {
		ui.Muted("Cancelled.")
		return false
	}
	return true
}

// errConfirmRequiresYes is the fatal error a destructive command reports when
// prompting is disabled and the caller did not opt in with --yes.
//
// Failing is the only safe answer here. Proceeding unprompted would make every
// scripted invocation destructive; exiting 0 having done nothing — the behaviour
// this replaced — let a scripted teardown silently no-op while the cloud
// resources it was meant to destroy kept billing.
var errConfirmRequiresYes = clierr.New(
	clierr.CodeConfirmationRequired,
	"this command is destructive and interactive prompts are unavailable "+
		"(--no-input, or stdin is not a terminal, or the stream the prompt draws on is redirected): "+
		"pass --yes to confirm",
)

// confirmDestructive reports whether a destructive action may proceed. yes is the
// command's --yes flag: when set the action runs unprompted. Otherwise, with
// prompting disabled the command dies on the standard fatal path rather than
// silently cancelling, and on an interactive terminal it asks through confirm.
func confirmDestructive(yes bool, title, description string) bool {
	if yes {
		return true
	}
	if !canPromptForm() {
		fail(errConfirmRequiresYes)
		return false
	}
	return confirm(title, description)
}

// addYesFlag registers the standard --yes/-y opt-in on a destructive command, so
// every one of them spells the flag and its help text the same way.
func addYesFlag(cmd *cobra.Command, target *bool) {
	cmd.Flags().BoolVarP(target, "yes", "y", false, "Skip the confirmation prompt (required with --no-input)")
}
