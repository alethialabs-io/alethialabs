// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

type LogSender interface {
	SendLog(jobID, logChunk, streamType string) error
}

type JobLogger struct {
	client     LogSender
	jobID      string
	streamType string
	buf        strings.Builder
	mu         sync.Mutex
	notify     chan struct{}
	done       chan struct{}
	finished   chan struct{}
	closeOnce  sync.Once
}

func NewJobLogger(client LogSender, jobID, streamType string) *JobLogger {
	l := &JobLogger{
		client:     client,
		jobID:      jobID,
		streamType: streamType,
		notify:     make(chan struct{}, 1),
		done:       make(chan struct{}),
		finished:   make(chan struct{}),
	}
	go l.flushLoop()
	return l
}

func (l *JobLogger) Write(p []byte) (n int, err error) {
	l.mu.Lock()
	n, err = l.buf.Write(p)
	shouldFlush := l.buf.Len() >= 10*1024
	l.mu.Unlock()

	_, _ = os.Stdout.Write(p)

	if shouldFlush {
		l.Flush()
	} else {
		// Wake the flush loop so the first bytes reach the console within a tick
		// (sub-100ms) instead of waiting for the backstop interval. The single-slot
		// channel coalesces bursts: writes that arrive during an in-flight flush
		// collapse into one pending wake.
		select {
		case l.notify <- struct{}{}:
		default:
		}
	}

	return n, err
}

func (l *JobLogger) Flush() {
	l.mu.Lock()
	if l.buf.Len() == 0 {
		l.mu.Unlock()
		return
	}
	chunk := l.buf.String()
	l.buf.Reset()
	l.mu.Unlock()

	if err := l.client.SendLog(l.jobID, chunk, l.streamType); err != nil {
		fmt.Fprintf(os.Stderr, "warning: failed to send log chunk: %v\n", err)
	}
}

func (l *JobLogger) flushLoop() {
	// Signal Close() that the loop has fully drained + exited, so Close never returns while a
	// notify/ticker-driven Flush → SendLog is still in flight (which would let a reader race a chunk).
	defer close(l.finished)

	// Backstop only — most flushes are notify-driven (sub-100ms after a write). The
	// ticker catches anything that slipped past a coalesced wake.
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-l.notify:
			l.Flush()
		case <-ticker.C:
			l.Flush()
		case <-l.done:
			l.Flush()
			return
		}
	}
}

func (l *JobLogger) Close() {
	l.closeOnce.Do(func() {
		close(l.done)
		// Wait for flushLoop to drain and exit. Because the loop is single-threaded, any in-flight
		// Flush completes before it processes `done` + does its final Flush — so once this returns,
		// every buffered chunk has been sent (no SendLog can still be landing).
		<-l.finished
	})
}
