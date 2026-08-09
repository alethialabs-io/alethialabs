// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"os"

	"github.com/mattn/go-isatty"
)

// Test seams for the CLI's terminal surface.
//
// Each variable holds the exact call it replaced, so production behaviour is byte-identical.
// They exist because a third of this package is otherwise unreachable from a test — not
// because the code is untestable, but because a TTY check decides which branch runs.
//
// Every seam here was justified by MEASUREMENT, not by assumption. Three candidates were
// probed headlessly and then deliberately NOT added, because they turned out not to need one:
//
//   - ui.RunSpinner returns nil with its action executed. (Seaming it would also have
//     defeated the errcheck exclusion in .golangci.yml that names it by symbol.)
//   - ui.ShowTable returns `could not open a new TTY: open /dev/tty: device not configured`.
//   - huh's Form.Run() returns the same TTY error.
//
// None of them block, so a test may call straight through them and simply get the error arm.
// If you are tempted to add a seam "because it would hang", probe it first — that belief was
// wrong for all three.
//
// What genuinely does need a seam is below: os.Exit terminates the test binary, and isatty
// decides the branch before any of the above is ever reached.
var (
	// stdinIsTTY reports whether stdin is a terminal. Drives resolveInputMode, and through it
	// every requireInteractive and interactiveTable decision. In a test process stdin is never
	// a terminal, so without this the interactive arms cannot be reached at all.
	stdinIsTTY = func() bool { return isatty.IsTerminal(os.Stdin.Fd()) }

	// stdoutIsTTY reports whether stdout is a terminal. Drives interactiveTable's final arm.
	stdoutIsTTY = func() bool { return isatty.IsTerminal(os.Stdout.Fd()) }
)
