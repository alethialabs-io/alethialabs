// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"os"
	"testing"
	"time"
)

// TestMain replaces the wait between two attempts with nothing, so a test that drives a read into
// a transient failure does not sleep through the client's backoff. The tests that assert the waits
// install their own recorder.
func TestMain(m *testing.M) {
	retrySleep = func(time.Duration) {}
	os.Exit(m.Run())
}
