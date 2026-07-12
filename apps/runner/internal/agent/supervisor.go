// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// Concurrent slots run as N worker subprocesses under one supervisor. A subprocess
// per worker is what makes concurrency safe: each gets its own process env (cloud
// credentials never collide) and its own private HOME (~/.kube, ~/.config/{gcloud,
// helm}, ~/.aws are per-worker). All workers share one ALETHIA_RUNNER_ID — one
// logical runner with N slots — and claims are atomic (SKIP LOCKED), so they never
// double-claim. See dataroom/spec/mvp/21 §5.

// WorkerProc is a spawned worker the supervisor can signal and wait on.
type WorkerProc interface {
	Signal(sig os.Signal) error
	Wait() error
}

// SpawnFunc starts worker `index` and returns a handle. Injectable for tests.
type SpawnFunc func(ctx context.Context, index int) (WorkerProc, error)

type supervisor struct {
	slots        int
	spawn        SpawnFunc
	shuttingDown atomic.Bool

	mu    sync.Mutex
	procs map[int]WorkerProc
}

// SuperviseWorkers runs `slots` worker subprocesses, restarting any that exit
// unexpectedly and forwarding SIGINT/SIGTERM so each worker drains its current job.
// Returns once all workers have exited following a shutdown signal.
func SuperviseWorkers(ctx context.Context, slots int, spawn SpawnFunc) error {
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(sigCh)

	shutdown := make(chan struct{})
	go func() {
		select {
		case <-sigCh:
			close(shutdown)
		case <-ctx.Done():
		}
	}()

	s := &supervisor{slots: slots, spawn: spawn, procs: make(map[int]WorkerProc)}
	return s.run(ctx, shutdown)
}

// run drives the worker pool until shutdown closes; signal-source-agnostic for tests.
func (s *supervisor) run(ctx context.Context, shutdown <-chan struct{}) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	go func() {
		select {
		case <-shutdown:
			fmt.Println("\n[supervisor] shutdown — draining workers...")
			s.shuttingDown.Store(true)
			s.forwardSignal(syscall.SIGTERM)
			// Hard stop just past each worker's 10-min drain grace.
			time.AfterFunc(11*time.Minute, cancel)
		case <-ctx.Done():
		}
	}()

	var wg sync.WaitGroup
	for i := 0; i < s.slots; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			s.superviseSlot(ctx, index)
		}(i)
	}
	wg.Wait()
	return nil
}

// superviseSlot keeps one slot filled: (re)spawn its worker until shutdown.
func (s *supervisor) superviseSlot(ctx context.Context, index int) {
	for {
		if ctx.Err() != nil || s.shuttingDown.Load() {
			return
		}
		proc, err := s.spawn(ctx, index)
		if err != nil {
			if s.shuttingDown.Load() || ctx.Err() != nil {
				return
			}
			fmt.Fprintf(os.Stderr, "[supervisor] worker %d spawn failed: %v; retrying in 2s\n", index, err)
			captureError(err, map[string]string{"op": "worker_spawn", "worker": fmt.Sprintf("%d", index)})
			select {
			case <-time.After(2 * time.Second):
			case <-ctx.Done():
				return
			}
			continue
		}
		s.setProc(index, proc)
		// If shutdown landed between spawn and registration, forward it now so the
		// fresh worker drains immediately rather than after a full job.
		if s.shuttingDown.Load() {
			_ = proc.Signal(syscall.SIGTERM)
		}
		waitErr := proc.Wait()
		s.clearProc(index)

		if s.shuttingDown.Load() || ctx.Err() != nil {
			return
		}
		fmt.Fprintf(os.Stderr, "[supervisor] worker %d exited (%v); restarting\n", index, waitErr)
		// Only a non-clean exit is an error worth capturing (a clean drain returns nil).
		if waitErr != nil {
			captureError(waitErr, map[string]string{"op": "worker_exit", "worker": fmt.Sprintf("%d", index)})
		}
	}
}

func (s *supervisor) setProc(index int, p WorkerProc) {
	s.mu.Lock()
	s.procs[index] = p
	s.mu.Unlock()
}

func (s *supervisor) clearProc(index int) {
	s.mu.Lock()
	delete(s.procs, index)
	s.mu.Unlock()
}

func (s *supervisor) forwardSignal(sig os.Signal) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.procs {
		_ = p.Signal(sig)
	}
}

// RealWorkerSpawn re-execs this binary as a worker: ALETHIA_RUNNER_WORKER=1 plus a
// private HOME so the worker's cloud-CLI/kube config never collides with its peers.
// TF_PLUGIN_CACHE_DIR and the baked project-templates stay absolute (shared, read-only).
func RealWorkerSpawn(ctx context.Context, index int) (WorkerProc, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("resolve runner binary: %w", err)
	}
	home, err := workerHome(index)
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, exe)
	cmd.Env = append(os.Environ(), "ALETHIA_RUNNER_WORKER=1", "HOME="+home)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start worker %d: %w", index, err)
	}
	return &execWorker{cmd: cmd}, nil
}

// workerHome creates and returns a private HOME dir for worker `index`.
func workerHome(index int) (string, error) {
	base := os.Getenv("ALETHIA_WORKER_HOME_BASE")
	if base == "" {
		base = os.TempDir()
	}
	home := filepath.Join(base, fmt.Sprintf("alethia-worker-%d", index))
	if err := os.MkdirAll(home, 0o700); err != nil {
		return "", fmt.Errorf("create worker %d home: %w", index, err)
	}
	return home, nil
}

type execWorker struct{ cmd *exec.Cmd }

func (e *execWorker) Signal(sig os.Signal) error {
	if e.cmd.Process == nil {
		return nil
	}
	return e.cmd.Process.Signal(sig)
}

func (e *execWorker) Wait() error { return e.cmd.Wait() }
