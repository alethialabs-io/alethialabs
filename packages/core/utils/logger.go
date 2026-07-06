// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package utils

import (
	"bytes"
	"fmt"
	"sync"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

type RemoteLogger struct {
	apiClient *api.Client
	jobID     string
	mu        sync.Mutex
	buffer    bytes.Buffer
	lastFlush time.Time
	done      chan bool
}

func NewRemoteLogger(apiClient *api.Client, jobID string) *RemoteLogger {
	rl := &RemoteLogger{
		apiClient: apiClient,
		jobID:     jobID,
		lastFlush: time.Now(),
		done:      make(chan bool),
	}

	go rl.flushLoop()
	return rl
}

func (rl *RemoteLogger) Write(p []byte) (n int, err error) {
	fmt.Print(string(p)) // Always print locally

	if rl.apiClient == nil || rl.jobID == "" {
		return len(p), nil
	}

	rl.mu.Lock()
	defer rl.mu.Unlock()

	n, err = rl.buffer.Write(p)
	if err != nil {
		return n, err
	}

	if time.Since(rl.lastFlush) > 2*time.Second || rl.buffer.Len() > 1024*10 {
		rl.flushLocked()
	}

	return n, nil
}

func (rl *RemoteLogger) flushLoop() {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			rl.mu.Lock()
			rl.flushLocked()
			rl.mu.Unlock()
		case <-rl.done:
			return
		}
	}
}

func (rl *RemoteLogger) flushLocked() {
	if rl.buffer.Len() == 0 {
		return
	}

	chunk := rl.buffer.String()
	rl.buffer.Reset()
	rl.lastFlush = time.Now()

	go func(c string) {
		err := rl.apiClient.SendBootstrapLog(rl.jobID, c, "SYSTEM")
		if err != nil {
			fmt.Printf("Warning: Failed to send bootstrap log to API: %v\n", err)
		}
	}(chunk)
}

func (rl *RemoteLogger) Close() error {
	if rl.apiClient == nil || rl.jobID == "" {
		return nil
	}
	close(rl.done)
	rl.mu.Lock()
	rl.flushLocked()
	rl.mu.Unlock()
	return nil
}
