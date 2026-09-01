// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/spf13/cobra"
)

// noInputMode is set once per invocation from the --no-input flag (or a non-TTY
// stdin) and read by the interactive selectors so scripting/CI fails fast
// instead of blocking on a prompt that can never be answered.
var noInputMode bool

// errNoInput is returned by selectors when interactive prompts are disabled.
var errNoInput = errors.New("interactive input required but --no-input is set (pass the id/name as a flag/argument)")

// resolveInputMode computes noInputMode from the command's --no-input flag and
// whether stdin is a terminal. Wired as the root PersistentPreRun.
func resolveInputMode(cmd *cobra.Command) {
	if v, _ := cmd.Flags().GetBool("no-input"); v {
		noInputMode = true
		return
	}
	noInputMode = !stdinIsTTY()
}

// outputFormat returns the validated --output value, exiting on an invalid one.
func outputFormat(cmd *cobra.Command) string {
	f, _ := cmd.Flags().GetString("output")
	if !ui.ValidFormat(f) {
		failf("invalid --output %q (want table, json, or csv)", f)
	}
	return f
}

// interactiveTable reports whether a list command should render the rich,
// navigable Bubble Tea table rather than a static one — true only for the table
// format on a TTY with prompts enabled. json/csv/--no-input/pipes get Render.
func interactiveTable(cmd *cobra.Command) bool {
	if outputFormat(cmd) != ui.FormatTable {
		return false
	}
	if noInputMode {
		return false
	}
	return stdoutIsTTY()
}

// requireInteractive returns errNoInput when prompts are disabled, for selectors
// to short-circuit before opening a huh form.
func requireInteractive() error {
	if noInputMode {
		return errNoInput
	}
	return nil
}

// errNoTTY is the answer when prompts are enabled but stdout has nowhere to draw them.
//
// It is a different statement from errNoInput — nobody passed --no-input and stdin may well be a
// terminal — and it has a different next step, so it is a different error.
var errNoTTY = errors.New("interactive input required but stdout is not a terminal (pass the id/name as a flag/argument)")

// requireInteractiveForm is requireInteractive plus the condition a huh form needs to be visible:
// a terminal on STDOUT, which is where the form draws.
//
// noInputMode is derived from stdin alone, so `alethia … -o json > out.json` from an interactive
// shell left prompts "enabled": the form's ANSI frames went into the redirected file ahead of the
// payload, the terminal showed nothing, and the command looked hung. interactiveTable already
// reads stdout for exactly this reason; a picker in the same group must agree with it.
func requireInteractiveForm() error {
	if err := requireInteractive(); err != nil {
		return err
	}
	if !stdoutIsTTY() {
		return errNoTTY
	}
	return nil
}
