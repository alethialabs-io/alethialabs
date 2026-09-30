// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"errors"
	"strings"
	"testing"
)

// The shape run 36728219160 left behind for the vcluster tier's emailservice, with the spec fields
// the dump did not read then. Hand-written from the Pod API shape and online-boutique v0.10.5's
// emailservice manifest (grpc liveness on 8080, period 5, 200m/128Mi limits) — the run printed only
// the status line, which is the defect. startedAt/finishedAt are invented; the run did not print them.
const crashLoopPodsJSON = `{"items": [
  {"metadata": {"name": "emailservice-55fdf9bbb9-wltd7-x-boutique-staging-x-b-b7cb9e7f22"},
   "spec": {"nodeName": "gke-n1", "containers": [{"name": "server",
      "resources": {"requests": {"cpu": "100m", "memory": "64Mi"}, "limits": {"cpu": "200m", "memory": "128Mi"}},
      "livenessProbe": {"periodSeconds": 5, "timeoutSeconds": 1, "failureThreshold": 3, "grpc": {"port": 8080}}}]},
   "status": {"phase": "Running", "conditions": [{"type": "Ready", "status": "False"}],
     "containerStatuses": [{"name": "server", "ready": false, "restartCount": 7,
        "state": {"waiting": {"reason": "CrashLoopBackOff", "message": "back-off 5m0s restarting failed container"}},
        "lastState": {"terminated": {"reason": "Error", "exitCode": 137, "startedAt": "2026-09-30T14:50:00Z", "finishedAt": "2026-09-30T14:50:21Z"}}}]}},
  {"metadata": {"name": "exec-probed"},
   "spec": {"containers": [{"name": "app", "livenessProbe": {"exec": {"command": ["cat", "/secret/token"]}}}]},
   "status": {"phase": "Running", "conditions": [{"type": "Ready", "status": "False"}],
     "containerStatuses": [{"name": "app", "ready": false, "restartCount": 1, "state": {"running": {"startedAt": "t"}},
        "lastState": {"terminated": {"reason": "Error", "exitCode": 2}}}]}},
  {"metadata": {"name": "never-restarted"}, "spec": {},
   "status": {"phase": "Running", "conditions": [{"type": "Ready", "status": "False"}],
     "containerStatuses": [{"name": "app", "ready": false, "restartCount": 0, "state": {"running": {"startedAt": "t"}}}]}},
  {"metadata": {"name": "ready-but-restarted"}, "spec": {},
   "status": {"phase": "Running", "conditions": [{"type": "Ready", "status": "True"}],
     "containerStatuses": [{"name": "app", "ready": true, "restartCount": 2, "state": {"running": {"startedAt": "t"}}}]}}
]}`

func TestCrashLoopingContainers(t *testing.T) {
	got := crashLoopingContainers([]byte(crashLoopPodsJSON), 5)
	if len(got) != 2 {
		t.Fatalf("got %d containers (%+v); want 2 — a never-restarted container and a Ready Pod are not findings", len(got), got)
	}
	e := got[0]
	if e.Pod != "emailservice-55fdf9bbb9-wltd7-x-boutique-staging-x-b-b7cb9e7f22" || e.Container != "server" ||
		e.Waiting != "CrashLoopBackOff" || e.Restarts != 7 || !e.HasLast || e.LastReason != "Error" || e.LastExit != 137 {
		t.Errorf("emailservice: %+v", e)
	}
	if e.LastRan != "21s" {
		t.Errorf("last run length %q, want 21s", e.LastRan)
	}
	if !strings.Contains(e.Liveness, "grpc :8080 initialDelay=0s period=5s timeout=1s failureThreshold=3") || !strings.Contains(e.Liveness, "≈15s") {
		t.Errorf("liveness: %q", e.Liveness)
	}
	if e.Limits != "cpu=200m memory=128Mi" {
		t.Errorf("limits: %q", e.Limits)
	}
	x := got[1]
	if x.Pod != "exec-probed" || x.Waiting != "" || x.Restarts != 1 || x.LastRan != "" {
		t.Errorf("exec-probed: %+v", x)
	}
	if strings.Contains(x.Liveness, "/secret/token") || !strings.Contains(x.Liveness, "exec (command not printed)") {
		t.Errorf("an exec probe's command must never be printed: %q", x.Liveness)
	}
	// Defaults are filled in: period 10 × threshold 3.
	if !strings.Contains(x.Liveness, "period=10s timeout=1s failureThreshold=3") || !strings.Contains(x.Liveness, "≈30s") {
		t.Errorf("defaults not applied: %q", x.Liveness)
	}
	if x.Limits != "cpu=none memory=none" {
		t.Errorf("absent limits: %q", x.Limits)
	}
	if n := len(crashLoopingContainers([]byte(crashLoopPodsJSON), 1)); n != 1 {
		t.Errorf("cap not honoured: %d", n)
	}
	if crashLoopingContainers([]byte(stuckInitPodsJSON), 5) != nil {
		t.Errorf("a Pod stuck in init has no crash-looping MAIN container")
	}
	if crashLoopingContainers([]byte("not json"), 5) != nil {
		t.Errorf("an undecodable list must yield nothing")
	}
}

func TestExitMeaning(t *testing.T) {
	for _, c := range []struct {
		reason string
		code   int
		want   string
	}{
		{"OOMKilled", 137, "OOM-KILLED"},
		{"Error", 137, "NOT an OOM kill"},
		{"Error", 143, "SIGTERM"},
		{"Completed", 0, "RETURNED"},
		{"Error", 1, "exited 1 on its own"},
	} {
		if got := exitMeaning(c.reason, c.code); !strings.Contains(got, c.want) {
			t.Errorf("exitMeaning(%q, %d) = %q, want it to contain %q", c.reason, c.code, got, c.want)
		}
	}
}

const emailEventsJSON = `{"items": [
  {"type": "Warning", "reason": "BackOff", "message": "Back-off restarting failed container server", "count": 30, "lastTimestamp": "2026-09-30T15:04:00Z"},
  {"type": "Normal", "reason": "Pulled", "message": "Container image already present on machine", "count": 8, "lastTimestamp": "2026-09-30T14:59:00Z"},
  {"type": "Warning", "reason": "Unhealthy", "message": "Liveness probe failed: timeout: failed to connect service \":8080\" within 1s", "count": 21, "lastTimestamp": "2026-09-30T14:59:20Z"},
  {"type": "Normal", "reason": "Killing", "message": "Container server failed liveness probe, will be restarted", "count": 7, "eventTime": "2026-09-30T14:59:21Z"}
]}`

func TestRenderCrashLoopDiagnosis(t *testing.T) {
	crashing := crashLoopingContainers([]byte(crashLoopPodsJSON), 5)
	got := renderCrashLoopDiagnosis([]crashRead{
		{crashLoopContainer: crashing[0],
			Log:    []byte("{\"message\": \"starting the email service in dummy mode.\"}\n{\"message\": \"Profiler disabled.\"}\n"),
			Events: []byte(emailEventsJSON)},
		{crashLoopContainer: crashing[1], LogErr: errors.New("exit status 1"), EventsErr: errors.New("signal: killed")},
		{crashLoopContainer: crashLoopContainer{Pod: "p3", Container: "c", Restarts: 1}, Events: []byte(`{"items": []}`)},
	})
	for _, want := range []string{
		"emailservice-55fdf9bbb9-wltd7-x-boutique-staging-x-b-b7cb9e7f22 / server (waiting=CrashLoopBackOff, restarts=7):",
		"last exit Error/137: SIGKILL that is NOT an OOM kill",
		"last run lasted: 21s",
		"liveness probe: grpc :8080",
		"limits: cpu=200m memory=128Mi",
		"| {\"message\": \"Profiler disabled.\"}",
		// Oldest first, so the probe failure reads before the kill it caused.
		"2026-09-30T14:59:20Z Warning Unhealthy (x21): Liveness probe failed",
		"2026-09-30T14:59:21Z Normal Killing (x7): Container server failed liveness probe",
		"exec-probed / app (waiting=(none), restarts=1):",
		"exited 2 on its own",
		"last run lasted: UNKNOWN",
		"UNKNOWN — could not read the log (exit status 1)",
		"UNKNOWN — could not list events (signal: killed)",
		"p3 / c",
		"last exit: UNKNOWN (no previous termination recorded)",
		"returned NOTHING",
		"none (events expire",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q\n--- got ---\n%s", want, got)
		}
	}
	if strings.Index(got, "Unhealthy") > strings.Index(got, "BackOff (x30)") {
		t.Errorf("events must be ordered oldest first:\n%s", got)
	}
	if renderCrashLoopDiagnosis(nil) != "" {
		t.Error("no crash-looping container must add nothing to the dump")
	}
}

func TestRenderPodEventsCapsAndRejectsGarbage(t *testing.T) {
	var items []string
	for i := 0; i < maxCrashEvents+3; i++ {
		items = append(items, `{"type": "Normal", "reason": "R`+string(rune('a'+i))+`", "lastTimestamp": "2026-09-30T15:00:`+string(rune('1'+i/10))+string(rune('0'+i%10))+`Z"}`)
	}
	got := renderPodEvents([]byte(`{"items": [`+strings.Join(items, ",")+`]}`), nil)
	if strings.Contains(got, " Ra") || !strings.Contains(got, " R"+string(rune('a'+maxCrashEvents+2))) {
		t.Errorf("must keep the LAST %d events:\n%s", maxCrashEvents, got)
	}
	if n := strings.Count(got, "Normal R"); n != maxCrashEvents {
		t.Errorf("rendered %d events, want %d:\n%s", n, maxCrashEvents, got)
	}
	if got := renderPodEvents([]byte("nope"), nil); !strings.Contains(got, "UNKNOWN — could not decode") {
		t.Errorf("garbage must be UNKNOWN, not none:\n%s", got)
	}
}
