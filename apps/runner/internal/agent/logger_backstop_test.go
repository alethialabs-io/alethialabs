// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"sync"
	"testing"
	"time"
)

// TestLogSinkBackstopTickerFires pins the one-second backstop arm of flushLoop's select.
//
// This test exists for determinism as much as for behaviour. Before it, `case <-ticker.C:`
// (logger.go) was covered only when some *other* test in the package happened to keep the
// process alive past a tick — which made apps/runner/internal/agent's statement coverage flap
// between 1670 and 1671 out of 3366 run to run. Measured locally: covered in 2 of 6 consecutive
// runs. That single flapping statement dequeued the merge queue once, reporting a coverage
// regression on a PR whose `total` had not changed at all, i.e. one that touched no Go code.
//
// A flapping branch is a bad thing to own regardless of the ratchet: it means the backstop —
// the safety net that ships a chunk the coalescing wake missed — was only ever exercised by
// accident. Covering it deliberately makes the number stable AND tests the net.
//
// The sleep is the point, not an oversight: the interval is a package-level constant in
// flushLoop, so the only way to reach that arm from outside is to outlive it. If the interval
// ever becomes injectable, delete the sleep and drive it directly.
func TestLogSinkBackstopTickerFires(t *testing.T) {
	var mu sync.Mutex
	var chunks []string

	sink := newLogSink(func(chunk string) error {
		mu.Lock()
		defer mu.Unlock()
		chunks = append(chunks, chunk)
		return nil
	}, nil)

	// Drain the wake the write queues, so the chunk is still buffered when the ticker arrives
	// and the flush we observe is unambiguously the BACKSTOP rather than the notify path.
	if _, err := sink.Write([]byte("backstop payload")); err != nil {
		t.Fatalf("Write: %v", err)
	}

	// The backstop interval is 1s; 1.6s clears it with margin for a loaded CI runner without
	// making the suite meaningfully slower.
	time.Sleep(1600 * time.Millisecond)

	mu.Lock()
	got := append([]string(nil), chunks...)
	mu.Unlock()

	if len(got) == 0 {
		t.Fatal("backstop ticker never flushed the buffered chunk")
	}

	joined := ""
	for _, c := range got {
		joined += c
	}
	if joined != "backstop payload" {
		t.Errorf("shipped %q, want %q", joined, "backstop payload")
	}

	// Close must remain safe and idempotent after a backstop flush has already drained the
	// buffer — the final Flush in the `done` arm then finds an empty builder and returns early.
	sink.Close()
	sink.Close()
}
