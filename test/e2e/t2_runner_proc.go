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
// default Cancel, i.e. SIGKILL to the runner process alone. tofu never got an interrupt, so it
// never sent the UNLOCK, and the in-process teardown's `tofu destroy` then asked the harness's
// state backend for the lock and got "Error acquiring the state lock". The lock info printed with
// it was the DESTROY's own (same host, Created one second earlier), because the backend answered
// with an empty 409 body tofu could not parse — see handleStateLock.
//
// How the real pair can be stopped — each point is what decides the design below:
//
//   - tofu is NOT reachable through the runner's process group. The runner runs it through
//     terraform-exec, which on Linux (tfexec/cmd_linux.go, the nightly's platform) starts it with
//     Setpgid — its own group — and Pdeathsig: SIGKILL. A group SIGINT reaches the runner only.
//   - The runner answers SIGINT/SIGTERM by DRAINING (Runner.Run): it stops claiming and waits for
//     the job, cancelling the job only after shutdownGracePeriod — 10 minutes, longer than any
//     teardown can spend on it. SIGINT alone is therefore a slow stop, not a graceful one.
//   - The one prompt interrupt tofu gets is a JOB CANCEL: the runner cancels the job's context and
//     terraform-exec turns that into SIGINT to tofu, then SIGKILL after its wait delay
//     (tofu.DefaultCancelGracePeriod, 120s). The runner takes a cancel from its heartbeat
//     (applyHeartbeatCancels), and the harness serves that heartbeat.
//
// So the stop, in t2QuiesceRunner:
//
//  1. SIGINT to the runner's process group, so it drains and claims nothing new; then report the
//     job cancelled on the heartbeat (ControlPlane.CancelJobOnHeartbeat). Within one heartbeat
//     (30s) the runner cancels the job and tofu gets its SIGINT: it stops starting resources,
//     returns from the in-flight one — or is stopped by its provider — writes state and RELEASES
//     THE LOCK. The job returns, and the draining runner exits. This is the product's own cancel
//     path, the one a user's cancel takes, rather than a signal the harness aims at tofu itself.
//  2. The stop is BOUNDED by t2RunnerStopGrace. After it the runner's group is SIGKILLed (tofu dies
//     with it: Pdeathsig on Linux, the shared group elsewhere), and only then — with no process
//     left that could hold it — a lock still standing is released and NAMED in the log. A bounded
//     wait on the destroy side alone (`-lock-timeout`) could not fix this: a killed holder never
//     releases, so it would wait out its bound and fail anyway.
//
// What this does NOT guarantee: a resource tofu was creating when it was interrupted and that did
// not reach state (tofu killed after the wait delay or the grace, or a provider that cannot record
// a half-created resource) is invisible to the destroy that follows. The teardown then succeeds
// against state and the resource is ORPHANED — for #3855's gcp floor, the GKE node pool — and the
// workflow's always() sweeper is what removes it. The force-release in step 2 makes the destroy
// RUN; it cannot make the destroy see what state never recorded.

// t2RunnerStopGraceCap bounds how long the teardown lets the runner (and the tofu it runs) stop
// gracefully. It must cover the whole real cancel path — up to one runner heartbeat before the
// cancel is seen, then terraform-exec's wait delay before tofu is killed — or the harness kills a
// tofu that was still inside its own graceful stop (TestT2RunnerStopGrace_CoversTheRealCancelPath).
// It is spent INSIDE the teardown window (see t2RunnerStopGrace) rather than added to the budget
// ladder, which is already within minutes of the job cap on its widest leg.
const t2RunnerStopGraceCap = 3 * time.Minute

// t2RunnerHeartbeatInterval is the runner's heartbeatInterval (apps/runner/internal/agent), the
// longest the runner can take to see a cancel the heartbeat reports. Restated here because the
// runner's package is internal to its module.
const t2RunnerHeartbeatInterval = 30 * time.Second

// t2RunnerStopGrace is the graceful-stop share of a teardown window: a quarter of it, capped at
// t2RunnerStopGraceCap, so a short window (hetzner's 15m) still leaves the destroy the bulk of it.
// Below a 10m window the quarter is shorter than the real cancel path, and a tofu still stopping
// when it runs out is killed — the stop then relies on step 2's force-release.
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

// Stop interrupts the runner's process group, calls interrupted (may be nil) — the hook through
// which the caller cancels the job, since the group signal does not reach tofu — waits up to grace
// for the runner to exit, then SIGKILLs the group regardless and reaps the runner. Idempotent: a
// second call returns the first call's result and does not call interrupted again.
func (p *t2RunnerProc) Stop(grace time.Duration, interrupted func()) t2RunnerStop {
	p.stopOnce.Do(func() {
		start := time.Now()
		pgid := p.cmd.Process.Pid
		_ = syscall.Kill(-pgid, syscall.SIGINT)
		if interrupted != nil {
			interrupted()
		}
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

// t2QuiesceRunner stops the runner (nil when it never started) by the product's cancel path —
// drain the runner, cancel jobID so the runner interrupts its tofu — and releases any state lock
// left behind on jobID's slot, returning the lines the teardown logs. After it returns no process
// the runner started is alive and jobID's slot is unlocked, so the destroy that follows cannot be
// refused the lock by the deploy it is cleaning up after. It does not guarantee the interrupted
// deploy's in-flight resource reached state (see the section header).
func t2QuiesceRunner(proc *t2RunnerProc, grace time.Duration, cp *ControlPlane, jobID string) []string {
	var lines []string
	if proc != nil {
		st := proc.Stop(grace, func() { cp.CancelJobOnHeartbeat(jobID) })
		if st.Graceful {
			lines = append(lines, fmt.Sprintf("teardown: runner stopped gracefully in %s (SIGINT to drain it, job %s cancelled on its heartbeat so it interrupted its tofu)", st.Took.Round(time.Second), jobID))
		} else {
			lines = append(lines, fmt.Sprintf("teardown: runner did not stop within the %s grace — its process group was SIGKILLed; the in-flight tofu may not have written state or released its lock, and a resource it was creating may be orphaned outside state", grace))
		}
	}
	if info, held := cp.ReleaseStrandedStateLock(jobID); held {
		lines = append(lines, fmt.Sprintf(
			"teardown: RELEASED a stranded tofu state lock on job %s before the destroy — its holder is dead (the runner and the tofu it ran are gone), so it could never be released by its owner and the destroy would have failed with \"Error acquiring the state lock\" (#3855). Holder: %s",
			jobID, lockHolderBody(info)))
	}
	return lines
}
