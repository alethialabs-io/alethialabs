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
	"strings"
	"syscall"
	"testing"
	"time"
)

// These tests reproduce #3855's cause C offline: a "runner" process that runs a "tofu" CHILD, the
// child holding the harness's real state lock (handleStateLock, over HTTP), and the teardown then
// asking for the same lock the way `tofu destroy` does. The processes are this test binary
// re-executed in a helper mode — see TestT2RunnerProcHelper.

const (
	envT2ProcHelper = "ALETHIA_T2_PROC_HELPER" // runner | tofu | tofu-stubborn
	envT2ProcLock   = "ALETHIA_T2_PROC_LOCK_URL"
	envT2ProcChild  = "ALETHIA_T2_PROC_CHILD" // the tofu mode the runner helper spawns
)

// TestT2RunnerProcHelper is not a test: it is the body of the helper processes. It skips unless
// the helper env is set.
func TestT2RunnerProcHelper(t *testing.T) {
	mode := os.Getenv(envT2ProcHelper)
	if mode == "" {
		t.Skip("helper process body — runs only when re-executed by the T2 runner-stop tests")
	}
	lockURL := os.Getenv(envT2ProcLock)
	switch mode {
	case "runner":
		// Like the real runner: trap SIGINT/SIGTERM and DRAIN — wait for the job (the tofu child)
		// to return, then exit. The child is in our process group, as tfexec's tofu is.
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		child := exec.Command(os.Args[0], "-test.run=^TestT2RunnerProcHelper$")
		child.Env = append(os.Environ(), envT2ProcHelper+"="+os.Getenv(envT2ProcChild))
		if err := child.Start(); err != nil {
			os.Exit(3)
		}
		<-sig
		_ = child.Wait()
		os.Exit(0)
	case "tofu", "tofu-stubborn":
		sig := make(chan os.Signal, 1)
		if mode == "tofu" {
			signal.Notify(sig, syscall.SIGINT)
		} else {
			signal.Ignore(syscall.SIGINT) // an in-flight resource that outlasts the grace
		}
		body := `{"ID":"apply-lock","Operation":"OperationTypeApply","Who":"runner@deploy"}`
		resp, err := http.Post(lockURL, "application/json", strings.NewReader(body))
		if err != nil || resp.StatusCode != http.StatusOK {
			os.Exit(4)
		}
		_ = resp.Body.Close()
		<-sig // never fires for tofu-stubborn: it waits to be SIGKILLed
		req, _ := http.NewRequest(http.MethodDelete, lockURL, nil)
		if r, err := http.DefaultClient.Do(req); err == nil {
			_ = r.Body.Close()
		}
		os.Exit(0)
	}
	os.Exit(2)
}

// newLockOnlyControlPlane is a ControlPlane with just the in-memory state backend served — no
// Postgres — which is all the lock contention needs.
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
	srv := httptest.NewServer(m)
	t.Cleanup(srv.Close)
	return cp, srv.URL
}

// startHelperRunner launches the runner helper (with the given tofu mode) through
// startT2RunnerProc and waits until its tofu child holds the lock.
func startHelperRunner(t *testing.T, cp *ControlPlane, base, jobID, tofuMode string) *t2RunnerProc {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestT2RunnerProcHelper$")
	cmd.Env = append(os.Environ(),
		envT2ProcHelper+"=runner",
		envT2ProcChild+"="+tofuMode,
		envT2ProcLock+"="+base+"/api/jobs/"+jobID+"/state/lock",
	)
	proc, err := startT2RunnerProc(cmd)
	if err != nil {
		t.Fatalf("start runner helper: %v", err)
	}
	pgid := cmd.Process.Pid
	// Never leak a helper past the test, whatever the code under test did.
	t.Cleanup(func() { _ = syscall.Kill(-pgid, syscall.SIGKILL) })
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
// the runner must make tofu release it, so the destroy gets the lock. With the old stop (SIGKILL to
// the runner alone) the tofu child survives holding the lock and this is a 423.
func TestT2QuiesceRunner_GracefulStopReleasesTheDeployLock(t *testing.T) {
	cp, base := newLockOnlyControlPlane(t)
	const job = "job-graceful"
	proc := startHelperRunner(t, cp, base, job, "tofu")

	lines := t2QuiesceRunner(proc, 20*time.Second, cp, job)

	if !proc.Stop(0).Graceful {
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

	if proc.Stop(0).Graceful {
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
