// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"strings"
	"sync"
	"testing"
	"time"
)

type mockLogSender struct {
	mu           sync.Mutex
	chunks       []string
	streams      []string
	traceparents []string
}

func (m *mockLogSender) SendLog(jobID, chunk, streamType, traceparent string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.chunks = append(m.chunks, chunk)
	m.streams = append(m.streams, streamType)
	m.traceparents = append(m.traceparents, traceparent)
	return nil
}

func (m *mockLogSender) getChunks() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := make([]string, len(m.chunks))
	copy(result, m.chunks)
	return result
}

func TestJobLogger_Write(t *testing.T) {
	sender := &mockLogSender{}
	logger := NewJobLogger(sender, "job-1", "STDOUT")

	n, err := logger.Write([]byte("hello"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 5 {
		t.Errorf("expected 5 bytes written, got %d", n)
	}

	logger.Close()
	chunks := sender.getChunks()
	if len(chunks) == 0 {
		t.Fatal("expected at least one chunk after close")
	}
	combined := strings.Join(chunks, "")
	if combined != "hello" {
		t.Errorf("expected 'hello', got %q", combined)
	}
}

func TestJobLogger_FlushOnThreshold(t *testing.T) {
	sender := &mockLogSender{}
	logger := NewJobLogger(sender, "job-2", "STDOUT")

	bigData := strings.Repeat("x", 11*1024)
	logger.Write([]byte(bigData))

	time.Sleep(50 * time.Millisecond)
	chunks := sender.getChunks()
	if len(chunks) == 0 {
		t.Error("expected flush after exceeding 10KB threshold")
	}

	logger.Close()
}

// TestJobLogger_NotifyFlush asserts the first bytes reach the sender almost
// immediately (notify-driven), not after a multi-second tick — the core of the
// instant-first-log change.
func TestJobLogger_NotifyFlush(t *testing.T) {
	sender := &mockLogSender{}
	logger := NewJobLogger(sender, "job-3", "STDOUT")
	defer logger.Close()

	logger.Write([]byte("first line"))

	deadline := time.Now().Add(300 * time.Millisecond)
	for time.Now().Before(deadline) {
		if len(sender.getChunks()) > 0 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}

	chunks := sender.getChunks()
	if len(chunks) == 0 {
		t.Fatal("expected a notify-triggered flush within 300ms of the first write")
	}
	if strings.Join(chunks, "") != "first line" {
		t.Errorf("expected 'first line', got %q", strings.Join(chunks, ""))
	}
}

// TestJobLogger_Coalesces asserts that a burst of small writes does not produce one
// network send per write (the single-slot notify collapses bursts), while preserving
// content and order.
func TestJobLogger_Coalesces(t *testing.T) {
	sender := &mockLogSender{}
	logger := NewJobLogger(sender, "job-3b", "STDOUT")

	const n = 50
	for i := 0; i < n; i++ {
		logger.Write([]byte("x"))
	}
	logger.Close()

	chunks := sender.getChunks()
	if len(chunks) == 0 {
		t.Fatal("expected at least one chunk")
	}
	if len(chunks) >= n {
		t.Errorf("expected writes to coalesce into far fewer than %d sends, got %d", n, len(chunks))
	}
	if got := strings.Join(chunks, ""); got != strings.Repeat("x", n) {
		t.Errorf("expected %d x's intact, got %d chars", n, len(got))
	}
}

func TestJobLogger_CloseFlushesRemaining(t *testing.T) {
	sender := &mockLogSender{}
	logger := NewJobLogger(sender, "job-4", "STDERR")

	logger.Write([]byte("remaining"))
	logger.Close()

	chunks := sender.getChunks()
	combined := strings.Join(chunks, "")
	if !strings.Contains(combined, "remaining") {
		t.Error("expected remaining data to be flushed on Close")
	}
}

func TestJobLogger_EmptyFlush(t *testing.T) {
	sender := &mockLogSender{}
	logger := NewJobLogger(sender, "job-5", "STDOUT")

	logger.Flush()
	logger.Close()

	chunks := sender.getChunks()
	if len(chunks) != 0 {
		t.Error("expected no chunks for empty logger")
	}
}
