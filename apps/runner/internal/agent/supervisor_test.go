// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"os"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// fakeWorker is a controllable WorkerProc: Wait blocks until exit() is called (or ctx
// ends), and it records signals it received.
type fakeWorker struct {
	ctx      context.Context
	exitCh   chan struct{}
	mu       sync.Mutex
	signals  []os.Signal
	exitOnce sync.Once
}

func (f *fakeWorker) Signal(sig os.Signal) error {
	f.mu.Lock()
	f.signals = append(f.signals, sig)
	f.mu.Unlock()
	return nil
}

func (f *fakeWorker) Wait() error {
	select {
	case <-f.exitCh:
	case <-f.ctx.Done():
	}
	return nil
}

func (f *fakeWorker) exit() { f.exitOnce.Do(func() { close(f.exitCh) }) }

func (f *fakeWorker) gotSignal(sig os.Signal) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, s := range f.signals {
		if s == sig {
			return true
		}
	}
	return false
}

// waitFor polls cond up to ~2s; fails the test otherwise.
func waitFor(t *testing.T, msg string, cond func() bool) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for: %s", msg)
}

func TestSupervisor_SpawnsNAndShutsDown(t *testing.T) {
	const slots = 3
	var spawnCount atomic.Int32
	var mu sync.Mutex
	live := map[int]*fakeWorker{}

	spawn := func(ctx context.Context, index int) (WorkerProc, error) {
		spawnCount.Add(1)
		w := &fakeWorker{ctx: ctx, exitCh: make(chan struct{})}
		mu.Lock()
		live[index] = w
		mu.Unlock()
		return w, nil
	}

	shutdown := make(chan struct{})
	s := &supervisor{slots: slots, spawn: spawn, procs: make(map[int]WorkerProc)}
	done := make(chan struct{})
	go func() { _ = s.run(context.Background(), shutdown); close(done) }()

	waitFor(t, "all slots spawned", func() bool { return spawnCount.Load() == slots })

	// Trigger graceful shutdown → every live worker should get SIGTERM forwarded.
	close(shutdown)
	waitFor(t, "SIGTERM forwarded to all workers", func() bool {
		mu.Lock()
		defer mu.Unlock()
		for _, w := range live {
			if !w.gotSignal(syscall.SIGTERM) {
				return false
			}
		}
		return len(live) == slots
	})

	// Workers drain and exit; the supervisor must NOT restart them.
	mu.Lock()
	for _, w := range live {
		w.exit()
	}
	mu.Unlock()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("supervisor did not return after workers drained")
	}
	if got := spawnCount.Load(); got != slots {
		t.Fatalf("expected no restarts during shutdown: spawnCount=%d, want %d", got, slots)
	}
}

func TestSupervisor_RestartsCrashedWorker(t *testing.T) {
	var spawnCount atomic.Int32
	var mu sync.Mutex
	var lastWorker *fakeWorker

	spawn := func(ctx context.Context, index int) (WorkerProc, error) {
		spawnCount.Add(1)
		w := &fakeWorker{ctx: ctx, exitCh: make(chan struct{})}
		mu.Lock()
		lastWorker = w
		mu.Unlock()
		return w, nil
	}

	shutdown := make(chan struct{})
	s := &supervisor{slots: 1, spawn: spawn, procs: make(map[int]WorkerProc)}
	done := make(chan struct{})
	go func() { _ = s.run(context.Background(), shutdown); close(done) }()

	waitFor(t, "first worker spawned", func() bool { return spawnCount.Load() == 1 })

	// Simulate an unexpected crash → supervisor should respawn the slot.
	mu.Lock()
	first := lastWorker
	mu.Unlock()
	first.exit()
	waitFor(t, "worker restarted after crash", func() bool { return spawnCount.Load() >= 2 })

	// Clean shutdown.
	close(shutdown)
	waitFor(t, "current worker got SIGTERM", func() bool {
		mu.Lock()
		w := lastWorker
		mu.Unlock()
		return w.gotSignal(syscall.SIGTERM)
	})
	mu.Lock()
	cur := lastWorker
	mu.Unlock()
	cur.exit()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("supervisor did not return after shutdown")
	}
}
