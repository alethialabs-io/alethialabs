// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/charmbracelet/huh"
)

// fail prints err in the standard grayscale error style and exits non-zero.
// This is the single fatal-error path for the CLI.
func fail(err error) {
	ui.Error(err.Error())
	os.Exit(1)
}

// failf formats a message, prints it in the error style, and exits non-zero.
func failf(format string, args ...any) {
	ui.Error(fmt.Sprintf(format, args...))
	os.Exit(1)
}

// confirm shows a yes/no dialog and reports whether the user confirmed. It
// returns false on a negative answer or an aborted/errored prompt, printing a
// short "Cancelled." note so callers can simply `return` on false.
func confirm(title, description string) bool {
	var ok bool
	err := huh.NewForm(
		huh.NewGroup(
			huh.NewConfirm().
				Title(title).
				Description(description).
				Value(&ok),
		),
	).Run()
	if err != nil || !ok {
		ui.Muted("Cancelled.")
		return false
	}
	return true
}
