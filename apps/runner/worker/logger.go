// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package worker

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
	done       chan struct{}
	closeOnce  sync.Once
}

func NewJobLogger(client LogSender, jobID, streamType string) *JobLogger {
	l := &JobLogger{
		client:     client,
		jobID:      jobID,
		streamType: streamType,
		done:       make(chan struct{}),
	}
	go l.flushLoop()
	return l
}

func (l *JobLogger) Write(p []byte) (n int, err error) {
	l.mu.Lock()
	n, err = l.buf.Write(p)
	shouldFlush := l.buf.Len() >= 10*1024
	l.mu.Unlock()

	os.Stdout.Write(p)

	if shouldFlush {
		l.Flush()
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
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		select {
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
		l.Flush()
	})
}
