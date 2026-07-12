// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"io"
	"os"
	"strings"
	"sync"
	"time"
)

// LogSender ships a buffered log chunk to the console job-log endpoint. traceparent
// (the job's W3C trace, empty when unknown) rides along so a log line carries its
// trace without a jobs join. insert_job_log falls back to the job's own traceparent
// when this is empty — the only change to that RPC's contract.
type LogSender interface {
	SendLog(jobID, logChunk, streamType, traceparent string) error
}

// logSink is the single buffer→flush→POST engine behind BOTH the per-job
// STDOUT/STDERR loggers and the SYSTEM operational stream — the two shippers unified.
// `ship` is the only thing that varies (which stream + trace the chunk is POSTed
// under); the buffering, coalescing wake, backstop ticker and drain-on-Close are
// shared. An optional `mirror` echoes writes locally (os.Stdout for the customer job
// streams; nil for SYSTEM, where slog already writes to stderr).
type logSink struct {
	ship   func(chunk string) error
	mirror io.Writer

	buf       strings.Builder
	mu        sync.Mutex
	notify    chan struct{}
	done      chan struct{}
	finished  chan struct{}
	closeOnce sync.Once
}

// newLogSink starts a sink whose flush loop ships buffered chunks via `ship`.
func newLogSink(ship func(chunk string) error, mirror io.Writer) *logSink {
	s := &logSink{
		ship:     ship,
		mirror:   mirror,
		notify:   make(chan struct{}, 1),
		done:     make(chan struct{}),
		finished: make(chan struct{}),
	}
	go s.flushLoop()
	return s
}

func (s *logSink) Write(p []byte) (n int, err error) {
	s.mu.Lock()
	n, err = s.buf.Write(p)
	shouldFlush := s.buf.Len() >= 10*1024
	s.mu.Unlock()

	if s.mirror != nil {
		_, _ = s.mirror.Write(p)
	}

	if shouldFlush {
		s.Flush()
	} else {
		// Wake the flush loop so the first bytes reach the console within a tick
		// (sub-100ms) instead of waiting for the backstop interval. The single-slot
		// channel coalesces bursts: writes that arrive during an in-flight flush
		// collapse into one pending wake.
		select {
		case s.notify <- struct{}{}:
		default:
		}
	}

	return n, err
}

func (s *logSink) Flush() {
	s.mu.Lock()
	if s.buf.Len() == 0 {
		s.mu.Unlock()
		return
	}
	chunk := s.buf.String()
	s.buf.Reset()
	s.mu.Unlock()

	if err := s.ship(chunk); err != nil {
		Log().Warn("failed to send log chunk", "err", err.Error())
	}
}

func (s *logSink) flushLoop() {
	// Signal Close() that the loop has fully drained + exited, so Close never returns while a
	// notify/ticker-driven Flush → ship is still in flight (which would let a reader race a chunk).
	defer close(s.finished)

	// Backstop only — most flushes are notify-driven (sub-100ms after a write). The
	// ticker catches anything that slipped past a coalesced wake.
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-s.notify:
			s.Flush()
		case <-ticker.C:
			s.Flush()
		case <-s.done:
			s.Flush()
			return
		}
	}
}

func (s *logSink) Close() {
	s.closeOnce.Do(func() {
		close(s.done)
		// Wait for flushLoop to drain and exit. Because the loop is single-threaded, any in-flight
		// Flush completes before it processes `done` + does its final Flush — so once this returns,
		// every buffered chunk has been sent (no ship can still be landing).
		<-s.finished
	})
}

// JobLogger streams a job's STDOUT or STDERR to the console job-log endpoint (the
// customer-facing job log). An io.Writer over the shared sink; echoes to os.Stdout.
type JobLogger struct {
	*logSink
}

// NewJobLogger builds a STDOUT/STDERR job logger with no trace (back-compat).
func NewJobLogger(client LogSender, jobID, streamType string) *JobLogger {
	return NewJobLoggerWithTrace(client, jobID, streamType, "")
}

// NewJobLoggerWithTrace builds a job logger that stamps `traceparent` on every
// shipped chunk so the customer log line correlates to the job's trace.
func NewJobLoggerWithTrace(client LogSender, jobID, streamType, traceparent string) *JobLogger {
	ship := func(chunk string) error {
		return client.SendLog(jobID, chunk, streamType, traceparent)
	}
	return &JobLogger{newLogSink(ship, os.Stdout)}
}

// SystemLogger ships runner OPERATIONAL logs (credential activation, status-update
// failures, drain/complete) to the job's SYSTEM stream on the console — the same
// buffered path as JobLogger, differing only in the stream. This is the surviving,
// unified form of the legacy core/utils RemoteLogger SYSTEM shipper. No stdout
// mirror: slog already writes the structured line to stderr.
type SystemLogger struct {
	*logSink
}

// NewSystemLogger builds a SYSTEM-stream shipper for a job, stamping its traceparent.
func NewSystemLogger(client LogSender, jobID, traceparent string) *SystemLogger {
	ship := func(chunk string) error {
		return client.SendLog(jobID, chunk, "SYSTEM", traceparent)
	}
	return &SystemLogger{newLogSink(ship, nil)}
}
