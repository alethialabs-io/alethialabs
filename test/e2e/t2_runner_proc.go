// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"errors"
	"fmt"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

// ── Stopping the T2 runner so the destroy is not locked out by it (#3855, cause C) ──────────────
//
// What happened on gcp run 35705203097: the deploy wait expired at 50m with the job still
// PROCESSING — the runner's `tofu apply` was eleven minutes into a GKE node pool. The test then
// returned, and the runner was stopped the way it had always been stopped: exec.CommandContext's
// default Cancel, i.e. SIGKILL to the runner process alone. The runner runs tofu IN-PROCESS on the
// passthrough sandbox, so tofu is the runner's child and was never signalled: it lost its parent
// (and, at its next write, its stdout pipe) and never sent the UNLOCK. The in-process teardown's
// `tofu destroy` then asked the harness's state backend for the lock and got
// "Error acquiring the state lock". The lock info printed with it was the DESTROY's own (same
// host, Created one second earlier), because the backend answered with an empty 409 body tofu
// could not parse — see handleStateLock.
//
// Two defects, two fixes, both here:
//
//  1. The runner is started in its OWN process group and stopped with SIGINT to the GROUP. tofu
//     traps its first SIGINT: it finishes the in-flight resource, writes state and RELEASES THE
//     LOCK. The runner traps it too and drains (waits for that job to return). This is the same
//     stop the product's container sandbox gives a cancelled job (packages/core/sandbox,
//     interruptThenKill) — the harness was the one caller that still hard-killed.
//  2. The stop is BOUNDED. After the grace the group is SIGKILLed, and only then — with no process
//     left that could hold it — a lock still standing is released and NAMED in the log. A bounded
//     wait on the destroy side alone (`-lock-timeout`) could not fix this: a SIGKILLed holder never
//     releases, so it would wait out its bound and fail anyway.

// t2RunnerStopGraceCap bounds how long the teardown lets the runner (and the tofu it spawned) stop
// gracefully. tofu's graceful stop waits for the resource in flight, and a GKE node pool can take
// several minutes, so this is not seconds; it is spent INSIDE the teardown window (see
// t2RunnerStopGrace) rather than added to the budget ladder, which is already within minutes of
// the job cap on its widest leg.
const t2RunnerStopGraceCap = 3 * time.Minute

// t2RunnerStopGrace is the graceful-stop share of a teardown window: a quarter of it, capped at
// t2RunnerStopGraceCap, so a short window (hetzner's 15m) still leaves the destroy the bulk of it.
func t2RunnerStopGrace(window time.Duration) time.Duration {
	g := window / 4
	if g > t2RunnerStopGraceCap {
		return t2RunnerStopGraceCap
	}
	return g
}

// t2RunnerProc is the runner child process the T2 harness launched, in its own process group.
type t2RunnerProc struct {
	cmd     *exec.Cmd
	done    chan struct{}
	waitErr error

	stopOnce sync.Once
	stopped  t2RunnerStop
}

// t2RunnerStop is what a Stop established. Graceful means the runner exited on its own within the
// grace after the group SIGINT; either way the group has been SIGKILLed afterwards, so no process
// of it is left to hold a state lock.
type t2RunnerStop struct {
	Graceful bool
	Took     time.Duration
	WaitErr  error
}

// startT2RunnerProc starts cmd as the leader of a new process group and reaps it in the
// background. cmd must not carry a context: a context's default Cancel is the SIGKILL this type
// exists to replace.
func startT2RunnerProc(cmd *exec.Cmd) (*t2RunnerProc, error) {
	if cmd.Cancel != nil {
		return nil, errors.New("startT2RunnerProc: cmd has a context Cancel — build it with exec.Command, the stop is Stop()")
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if cmd.WaitDelay == 0 {
		// Bound Wait's I/O drain: a grandchild still holding the output pipe must not block the reap.
		cmd.WaitDelay = 10 * time.Second
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	p := &t2RunnerProc{cmd: cmd, done: make(chan struct{})}
	go func() {
		p.waitErr = cmd.Wait()
		close(p.done)
	}()
	return p, nil
}

// Stop interrupts the runner's whole process group, waits up to grace for the runner to exit,
// then SIGKILLs the group regardless (a straggler left alive could still hold the lock) and reaps
// the runner. Idempotent: a second call returns the first call's result.
func (p *t2RunnerProc) Stop(grace time.Duration) t2RunnerStop {
	p.stopOnce.Do(func() {
		start := time.Now()
		pgid := p.cmd.Process.Pid
		_ = syscall.Kill(-pgid, syscall.SIGINT)
		timer := time.NewTimer(grace)
		defer timer.Stop()
		select {
		case <-p.done:
			p.stopped.Graceful = true
		case <-timer.C:
		}
		// ESRCH when the group is already empty, which is the graceful case — nothing to report.
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
		<-p.done
		p.stopped.Took = time.Since(start)
		p.stopped.WaitErr = p.waitErr
	})
	return p.stopped
}

// t2QuiesceRunner stops the runner (nil when it never started) and releases any state lock it
// left behind on jobID's slot, returning the lines the teardown logs. After it returns no process
// the runner started is alive and jobID's slot is unlocked, so the destroy that follows cannot be
// refused the lock by the deploy it is cleaning up after.
func t2QuiesceRunner(proc *t2RunnerProc, grace time.Duration, cp *ControlPlane, jobID string) []string {
	var lines []string
	if proc != nil {
		st := proc.Stop(grace)
		if st.Graceful {
			lines = append(lines, fmt.Sprintf("teardown: runner stopped gracefully (SIGINT to its process group) in %s", st.Took.Round(time.Second)))
		} else {
			lines = append(lines, fmt.Sprintf("teardown: runner did not stop within the %s grace — its process group was SIGKILLed; the in-flight tofu may not have written state or released its lock", grace))
		}
	}
	if info, held := cp.ReleaseStrandedStateLock(jobID); held {
		lines = append(lines, fmt.Sprintf(
			"teardown: RELEASED a stranded tofu state lock on job %s before the destroy — its holder is dead (the runner's process group is gone), so it could never be released by its owner and the destroy would have failed with \"Error acquiring the state lock\" (#3855). Holder: %s",
			jobID, lockHolderBody(info)))
	}
	return lines
}
