// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"io"
	"testing"
)

// testPrinter is a Printer over one buffer: the result goes to out in the given format, and what
// is said about the run is dropped. It is what a test hands a run* function to read the bytes the
// command would have written on stdout.
func testPrinter(out io.Writer, format string) *Printer {
	return &Printer{Out: out, Err: io.Discard, Format: format}
}

// splitPrinter is a Printer over two buffers, for a test that asserts which stream a line is on.
func splitPrinter(format string) (*Printer, *bytes.Buffer, *bytes.Buffer) {
	var out, errOut bytes.Buffer
	return &Printer{Out: &out, Err: &errOut, Format: format}, &out, &errOut
}

// withPrinter swaps the process Printer for the test's own and puts the old one back afterwards.
func withPrinter(t *testing.T, p *Printer) {
	t.Helper()
	prev := printer
	printer = p
	t.Cleanup(func() { printer = prev })
}
