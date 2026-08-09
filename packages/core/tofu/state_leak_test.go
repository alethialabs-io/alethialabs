// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package tofu

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

// TestStateResources_DoesNotLeakStateIntoLogWriter is #2026's regression test.
//
// StateResources wants only the resource ADDRESSES, but tf.Show goes through the same
// runTerraformCmdJSON tee that Output() (#457) and ShowPlanJSON (#2025) were hardened against, so
// the whole `tofu show -json` state document was written to the configured lifecycle writer.
//
// state_import.go builds the TofuCLI with the STATE_SURGERY job's stdout and calls this to verify an
// import read-back — so the least redacted artifact in the system went to that job's log.
//
// Reuses applyOutputOnlyModule from output_leak_test.go: applying it produces real state whose
// output value is the marker, which is exactly what `tofu show -json` renders.
func TestStateResources_DoesNotLeakStateIntoLogWriter(t *testing.T) {
	requireTofuOrSkip(t)

	const secret = "SECRET-STATE-MARKER-def456"
	dir := t.TempDir()
	applyOutputOnlyModule(t, dir, secret)

	// logBuf stands in for the STATE_SURGERY job-log writer.
	var logBuf bytes.Buffer
	tf, err := NewTofuCLI(context.Background(), "", dir, &logBuf, &logBuf)
	if err != nil {
		t.Fatalf("NewTofuCLI: %v", err)
	}

	// Behaviour preserved: the call still answers the "what do we manage?" question it exists for.
	// The module is provider-less so the address list is empty; nil error and no panic is the
	// contract being pinned here, and the leak assertion below is the point of the test.
	if _, err := tf.StateResources(context.Background()); err != nil {
		t.Fatalf("StateResources: %v\nlog:%s", err, logBuf.String())
	}

	if strings.Contains(logBuf.String(), secret) {
		t.Fatalf("SECURITY REGRESSION: state JSON leaked into the job-log writer:\n%s", logBuf.String())
	}
}

// TestStateResources_RestoresLogWriter guards the seam mechanic, matching the Output and
// ShowPlanJSON pairs. A leaked io.Discard would blind the STATE_SURGERY job's log from this call on.
func TestStateResources_RestoresLogWriter(t *testing.T) {
	requireTofuOrSkip(t)

	const secret = "SECRET-STATE-MARKER-restore"
	dir := t.TempDir()
	applyOutputOnlyModule(t, dir, secret)

	var logBuf bytes.Buffer
	tf, err := NewTofuCLI(context.Background(), "", dir, &logBuf, &logBuf)
	if err != nil {
		t.Fatalf("NewTofuCLI: %v", err)
	}
	if _, err := tf.StateResources(context.Background()); err != nil {
		t.Fatalf("StateResources: %v", err)
	}

	if _, err := tf.Validate(context.Background()); err != nil {
		t.Fatalf("Validate after StateResources: %v", err)
	}
	if logBuf.Len() == 0 {
		t.Fatal("lifecycle log writer received nothing after StateResources() — io.Discard was not restored")
	}
	if strings.Contains(logBuf.String(), secret) {
		t.Fatalf("SECURITY REGRESSION: secret present in log writer:\n%s", logBuf.String())
	}
}
