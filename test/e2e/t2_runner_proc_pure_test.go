// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/tofu"
)

// These tests reproduce #3855's cause C offline: a "runner" process that runs a "tofu" CHILD, the
// child holding the harness's real state lock (handleStateLock, over HTTP), and the teardown then
// asking for the same lock the way `tofu destroy` does. The processes are this test binary
// re-executed in a helper mode — see TestT2RunnerProcHelper.
//
// The pair models the two properties of the REAL runner/tofu pair that decide the outcome, because
// a fixture without them passes on behaviour the real pair lacks (the review of #4973):
//
//   - The helper tofu is started in its OWN process group (plus Pdeathsig: SIGKILL on Linux) —
//     what terraform-exec does on Linux (tfexec/cmd_linux.go), which is where the nightly runs. A
//     signal to the runner's process group therefore never reaches it. It is modelled on every
//     OS, not only Linux, so a laptop run proves the CI behaviour; terraform-exec's non-Linux
//     path leaves tofu in the runner's group.
//   - The helper runner, like Runner.Run, answers SIGINT only by DRAINING: it stops taking work and
//     waits for the job, and cancels the job itself only after its drain grace (10m, the real
//     shutdownGracePeriod). The one prompt interrupt tofu gets is the job CANCEL, which the runner
//     acts on when a heartbeat reports the job cancelled (applyHeartbeatCancels) and delivers as
//     terraform-exec does: SIGINT to tofu's pid, then SIGKILL after a wait delay.

const (
	envT2ProcHelper    = "ALETHIA_T2_PROC_HELPER" // runner | tofu | tofu-stubborn
	envT2ProcLock      = "ALETHIA_T2_PROC_LOCK_URL"
	envT2ProcChild     = "ALETHIA_T2_PROC_CHILD"     // the tofu mode the runner helper spawns
	envT2ProcHeartbeat = "ALETHIA_T2_PROC_HEARTBEAT" // the heartbeat URL the runner helper polls
	envT2ProcJob       = "ALETHIA_T2_PROC_JOB"       // the job the runner helper is running
	envT2ProcPidFile   = "ALETHIA_T2_PROC_PIDFILE"   // where the runner helper writes tofu's pid
)

// The helper runner's timings. The drain grace is the real runner's shutdownGracePeriod; the
// heartbeat is shortened from the real 30s so the test is fast (the harness grace budgets for the
// real one — see TestT2RunnerStopGrace_CoversTheRealCancelPath); the wait delay is terraform-exec's
// kill-after-interrupt, tofu.DefaultCancelGracePeriod in the product.
const (
	helperRunnerDrainGrace   = 10 * time.Minute
	helperRunnerHeartbeat    = 100 * time.Millisecond
	helperTofuCancelWaitTime = 2 * time.Minute
)

// TestT2RunnerProcHelper is not a test: it is the body of the helper processes. It skips unless
// the helper env is set.
func TestT2RunnerProcHelper(t *testing.T) {
	mode := os.Getenv(envT2ProcHelper)
	if mode == "" {
		t.Skip("helper process body — runs only when re-executed by the T2 runner-stop tests")
	}
	switch mode {
	case "runner":
		os.Exit(helperRunnerMain())
	case "tofu", "tofu-stubborn":
		os.Exit(helperTofuMain(mode))
	}
	os.Exit(2)
}

// helperRunnerMain is the helper runner: it starts the tofu child the way terraform-exec does on
// Linux, drains on SIGINT/SIGTERM like Runner.Run, and cancels the job only on a heartbeat-reported
// cancel or when its drain grace expires. It exits once the job has returned and it is draining.
func helperRunnerMain() int {
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)

	child := exec.Command(os.Args[0], "-test.run=^TestT2RunnerProcHelper$")
	child.Env = append(os.Environ(), envT2ProcHelper+"="+os.Getenv(envT2ProcChild))
	child.SysProcAttr = helperTofuSysProcAttr()
	if err := child.Start(); err != nil {
		return 3
	}
	if f := os.Getenv(envT2ProcPidFile); f != "" {
		_ = os.WriteFile(f, []byte(strconv.Itoa(child.Process.Pid)), 0o600)
	}
	jobDone := make(chan struct{})
	go func() {
		_ = child.Wait()
		close(jobDone)
	}()

	var cancelOnce sync.Once
	cancelJob := func() {
		cancelOnce.Do(func() {
			// terraform-exec's cmd.Cancel: SIGINT to tofu's PID, then its WaitDelay, then SIGKILL.
			_ = child.Process.Signal(syscall.SIGINT)
			time.AfterFunc(helperTofuCancelWaitTime, func() { _ = child.Process.Kill() })
		})
	}

	hb := time.NewTicker(helperRunnerHeartbeat)
	defer hb.Stop()
	draining, finished := false, false
	for {
		if draining && finished {
			return 0
		}
		select {
		case <-sig:
			if !draining {
				draining = true
				// Runner.Run: the root context — and so the job — is cancelled only after the grace.
				time.AfterFunc(helperRunnerDrainGrace, cancelJob)
			}
		case <-jobDone:
			finished = true
			jobDone = nil
		case <-hb.C:
			if helperHeartbeatCancels(os.Getenv(envT2ProcHeartbeat), os.Getenv(envT2ProcJob)) {
				cancelJob()
			}
		}
	}
}

// helperHeartbeatCancels posts one runner heartbeat and reports whether the answer lists jobID
// among cancelled_job_ids — the runner's applyHeartbeatCancels.
func helperHeartbeatCancels(url, jobID string) bool {
	req, err := http.NewRequest(http.MethodPost, url, nil)
	if err != nil {
		return false
	}
	req.Header.Set("X-Runner-ID", "helper-runner")
	req.Header.Set("X-Runner-Token", "helper-token")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var body struct {
		CancelledJobIDs []string `json:"cancelled_job_ids"`
	}
	if json.NewDecoder(resp.Body).Decode(&body) != nil {
		return false
	}
	for _, id := range body.CancelledJobIDs {
		if id == jobID {
			return true
		}
	}
	return false
}

// helperTofuMain is the helper tofu: it takes the state lock, then on SIGINT finishes its
// "in-flight resource" and releases the lock itself (tofu's graceful stop). tofu-stubborn ignores
// SIGINT — a resource that outlasts every grace — and waits to be killed.
func helperTofuMain(mode string) int {
	sig := make(chan os.Signal, 1)
	if mode == "tofu" {
		signal.Notify(sig, syscall.SIGINT)
	} else {
		signal.Ignore(syscall.SIGINT)
	}
	lockURL := os.Getenv(envT2ProcLock)
	body := `{"ID":"apply-lock","Operation":"OperationTypeApply","Who":"runner@deploy"}`
	resp, err := http.Post(lockURL, "application/json", strings.NewReader(body))
	if err != nil || resp.StatusCode != http.StatusOK {
		return 4
	}
	_ = resp.Body.Close()
	<-sig                              // never fires for tofu-stubborn
	time.Sleep(200 * time.Millisecond) // the in-flight resource finishing
	req, _ := http.NewRequest(http.MethodDelete, lockURL, nil)
	if r, err := http.DefaultClient.Do(req); err == nil {
		_ = r.Body.Close()
	}
	return 0
}

// newLockOnlyControlPlane is a ControlPlane with just the in-memory state backend and the runner
// heartbeat served — no Postgres — which is all the lock contention and the job cancel need.
func newLockOnlyControlPlane(t *testing.T) (*ControlPlane, string) {
	t.Helper()
	cp := &ControlPlane{
		states:            map[string]*stateEntry{},
		stateAlias:        map[string]string{},
		stateReadNonEmpty: map[string]int{},
		stateClearedBy:    map[string]string{},
	}
	m := http.NewServeMux()
	m.HandleFunc("/api/jobs/{id}/state/lock", cp.handleStateLock)
	m.HandleFunc("POST /api/runners/heartbeat", cp.handleHeartbeat)
	srv := httptest.NewServer(m)
	t.Cleanup(srv.Close)
	return cp, srv.URL
}

// startHelperRunner launches the runner helper (with the given tofu mode) through
// startT2RunnerProc and waits until its tofu child holds the lock.
func startHelperRunner(t *testing.T, cp *ControlPlane, base, jobID, tofuMode string) *t2RunnerProc {
	t.Helper()
	pidFile := filepath.Join(t.TempDir(), "tofu.pid")
	cmd := exec.Command(os.Args[0], "-test.run=^TestT2RunnerProcHelper$")
	cmd.Env = append(os.Environ(),
		envT2ProcHelper+"=runner",
		envT2ProcChild+"="+tofuMode,
		envT2ProcLock+"="+base+"/api/jobs/"+jobID+"/state/lock",
		envT2ProcHeartbeat+"="+base+"/api/runners/heartbeat",
		envT2ProcJob+"="+jobID,
		envT2ProcPidFile+"="+pidFile,
	)
	proc, err := startT2RunnerProc(cmd)
	if err != nil {
		t.Fatalf("start runner helper: %v", err)
	}
	pgid := cmd.Process.Pid
	// Never leak a helper past the test, whatever the code under test did. The tofu helper is in
	// its own group, and off Linux there is no Pdeathsig to take it down with the runner.
	t.Cleanup(func() {
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
		if b, err := os.ReadFile(pidFile); err == nil {
			if pid, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil && pid > 0 {
				_ = syscall.Kill(-pid, syscall.SIGKILL)
			}
		}
	})
	deadline := time.Now().Add(20 * time.Second)
	for {
		if _, held := cp.StateLockHolder(jobID); held {
			return proc
		}
		if time.Now().After(deadline) {
			t.Fatal("the helper tofu never took the state lock")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// destroyLock takes the lock the way `tofu destroy` does and reports the status and body.
func destroyLock(t *testing.T, base, jobID string) (int, []byte) {
	t.Helper()
	body := `{"ID":"destroy-lock","Operation":"OperationTypeApply","Who":"runner@teardown"}`
	resp, err := http.Post(base+"/api/jobs/"+jobID+"/state/lock", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("destroy lock request: %v", err)
	}
	defer resp.Body.Close()
	var buf bytes.Buffer
	_, _ = buf.ReadFrom(resp.Body)
	return resp.StatusCode, buf.Bytes()
}

// The #3855 contention itself: the deploy's tofu holds the lock when the teardown starts. Stopping
// the runner must make TOFU release it — no force-release — so the destroy gets the lock. A stop
// that only signals the runner's process group fails here: the helper tofu is in its own group and
// the draining runner does not cancel its job for 10 minutes, so the grace runs out and the lock
// has to be force-released (this is the red the #4973 review predicted, and was run to confirm).
func TestT2QuiesceRunner_GracefulStopReleasesTheDeployLock(t *testing.T) {
	cp, base := newLockOnlyControlPlane(t)
	const job = "job-graceful"
	proc := startHelperRunner(t, cp, base, job, "tofu")

	lines := t2QuiesceRunner(proc, 20*time.Second, cp, job)

	if !proc.Stop(0, nil).Graceful {
		t.Fatalf("runner did not stop gracefully; lines: %q", lines)
	}
	for _, l := range lines {
		if strings.Contains(l, "RELEASED a stranded") {
			t.Fatalf("a graceful stop must leave nothing to force-release — tofu released its own lock; got %q", l)
		}
	}
	if code, body := destroyLock(t, base, job); code != http.StatusOK {
		t.Fatalf("destroy could not take the state lock after the runner was stopped: HTTP %d %s", code, body)
	}
}

// When tofu cannot stop within the grace, the group is SIGKILLed and its lock can never be
// released by its owner. The teardown must release it, and SAY so, rather than let the destroy fail.
func TestT2QuiesceRunner_ReleasesAndNamesALockStrandedByAKill(t *testing.T) {
	cp, base := newLockOnlyControlPlane(t)
	const job = "job-stubborn"
	proc := startHelperRunner(t, cp, base, job, "tofu-stubborn")

	lines := t2QuiesceRunner(proc, 500*time.Millisecond, cp, job)

	if proc.Stop(0, nil).Graceful {
		t.Fatal("a tofu ignoring SIGINT cannot have stopped gracefully")
	}
	joined := strings.Join(lines, "\n")
	for _, want := range []string{"SIGKILLed", "RELEASED a stranded tofu state lock", "runner@deploy", "#3855"} {
		if !strings.Contains(joined, want) {
			t.Errorf("teardown lines do not name %q:\n%s", want, joined)
		}
	}
	if code, body := destroyLock(t, base, job); code != http.StatusOK {
		t.Fatalf("destroy could not take the state lock after the stranded one was released: HTTP %d %s", code, body)
	}
}

// A contended LOCK must name the HOLDER in a body tofu can unmarshal. The bare 409 this replaced
// made tofu print "failed to unmarshal body" with the contender's own lock info (#3855).
func TestHandleStateLock_ContentionNamesTheHolder(t *testing.T) {
	_, base := newLockOnlyControlPlane(t)
	const job = "job-contended"
	holder := `{"ID":"apply-lock","Operation":"OperationTypeApply","Who":"runner@deploy"}`
	resp, err := http.Post(base+"/api/jobs/"+job+"/state/lock", "application/json", strings.NewReader(holder))
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("first lock: %v %v", err, resp)
	}
	_ = resp.Body.Close()

	code, body := destroyLock(t, base, job)
	if code != http.StatusLocked {
		t.Fatalf("contended lock: HTTP %d, want 423 (what the console's state proxy returns)", code)
	}
	var got struct{ ID, Who string }
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("contended-lock body is not lock info tofu can parse: %v (%q)", err, body)
	}
	if got.ID != "apply-lock" || got.Who != "runner@deploy" {
		t.Fatalf("contended-lock body names %+v, want the HOLDER (apply-lock, runner@deploy)", got)
	}

	// No holder info sent at all → still a parseable body, never an empty one.
	if string(lockHolderBody(nil)) != "{}" {
		t.Fatalf("lockHolderBody(nil) = %q, want {}", lockHolderBody(nil))
	}
}

// The cap must outlast the real cancel path: one runner heartbeat before the cancel is seen, then
// terraform-exec's wait delay before it kills tofu. A shorter cap SIGKILLs a tofu that was still
// inside its own graceful stop.
func TestT2RunnerStopGrace_CoversTheRealCancelPath(t *testing.T) {
	path := t2RunnerHeartbeatInterval + tofu.DefaultCancelGracePeriod
	if t2RunnerStopGraceCap <= path {
		t.Fatalf("t2RunnerStopGraceCap = %s, but the real cancel path takes up to %s (heartbeat %s + tofu cancel grace %s)",
			t2RunnerStopGraceCap, path, t2RunnerHeartbeatInterval, tofu.DefaultCancelGracePeriod)
	}
	if helperTofuCancelWaitTime != tofu.DefaultCancelGracePeriod {
		t.Fatalf("the helper runner's wait delay %s drifted from tofu.DefaultCancelGracePeriod %s", helperTofuCancelWaitTime, tofu.DefaultCancelGracePeriod)
	}
}

// The graceful share of the teardown window: a quarter, capped.
func TestT2RunnerStopGrace(t *testing.T) {
	for _, c := range []struct{ window, want time.Duration }{
		{45 * time.Minute, t2RunnerStopGraceCap},
		{15 * time.Minute, t2RunnerStopGraceCap},
		{8 * time.Minute, 2 * time.Minute},
	} {
		if got := t2RunnerStopGrace(c.window); got != c.want {
			t.Errorf("t2RunnerStopGrace(%s) = %s, want %s", c.window, got, c.want)
		}
	}
}
