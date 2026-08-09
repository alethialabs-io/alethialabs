// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/charmbracelet/huh"
)

// exitFunc is the process-exit hook the fatal-error path calls. It is os.Exit in
// production — behaviour is unchanged — and exists only so tests can observe a
// fatal path without the test binary being killed by a real exit.
var exitFunc = os.Exit

// fail prints err in the standard grayscale error style and exits non-zero.
// This is the single fatal-error path for the CLI.
func fail(err error) {
	ui.Error(err.Error())
	exitFunc(1)
}

// failf formats a message, prints it in the error style, and exits non-zero.
func failf(format string, args ...any) {
	ui.Error(fmt.Sprintf(format, args...))
	exitFunc(1)
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
