package worker

import (
	"strings"
	"sync"
	"testing"
	"time"
)

type mockLogSender struct {
	mu     sync.Mutex
	chunks []string
}

func (m *mockLogSender) SendLog(jobID, chunk, streamType string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.chunks = append(m.chunks, chunk)
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

func TestJobLogger_TimerFlush(t *testing.T) {
	sender := &mockLogSender{}
	logger := NewJobLogger(sender, "job-3", "STDOUT")

	logger.Write([]byte("small data"))
	time.Sleep(2500 * time.Millisecond)

	chunks := sender.getChunks()
	if len(chunks) == 0 {
		t.Error("expected timer-triggered flush after 2s")
	}

	logger.Close()
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
