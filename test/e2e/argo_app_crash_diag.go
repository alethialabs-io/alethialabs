// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

// WHY A MAIN CONTAINER THAT STARTED KEEPS DYING — THE CRASH-LOOP HALF.
//
// gcp fabric-demo run 36728219160 failed its vcluster tier with ONE pod not Ready:
//
//	emailservice-…-x-boutique-staging-x-… phase=Running; container server waiting CrashLoopBackOff
//	(restarts=7, last exit Error/137)
//
// The same overlay's emailservice was Ready in both namespace tiers on the same cluster, and the
// vcluster tier passed on aws and hetzner. The dump could not say WHY it died, because it printed the
// last exit and nothing else: not the dead run's log (`kubectl logs --previous` — the current run of
// a crash-looping container has usually logged nothing yet), not the kubelet's events for the Pod
// (`Unhealthy … Liveness probe failed` then `Killing` is the one sequence that distinguishes a probe
// kill from the process dying on its own), not how long the run lasted, and not the probe timing and
// memory limit that run was held to.
//
// Exit 137 with reason "Error" is NOT an OOM kill — containerd reports those as "OOMKilled". It is a
// SIGKILL from outside: most often the kubelet, after a failed liveness probe, sending SIGTERM that a
// PID-1 process with no handler IGNORES and then SIGKILL when terminationGracePeriodSeconds runs out.
// That is a hypothesis the dump used to leave to whoever read it; the events and the run length below
// are what confirm or refute it on the next run, for free.
//
// So for every not-Ready Pod's MAIN container that is waiting in CrashLoopBackOff or has restarted,
// the dump now also prints (renderCrashLoopDiagnosis): what the last exit means, how long the last run
// lasted, the container's liveness-probe timing and CPU/memory limits (timing, type and port only —
// never an exec probe's command), the last crashLogTailLines lines of the PREVIOUS run's log, and the
// Pod's last events. A read that fails says UNKNOWN and why; it is never rendered as "nothing there".
//
// Pure over already-read JSON / text; the kubectl reads live in dumpArgoAppDiagnosis.

const (
	maxCrashContainers = 3
	crashLogTailLines  = 15
	maxCrashEvents     = 8
)

// probeTimingView is the subset of a Probe the crash dump reads: its timing, and its handler's type
// and port. An exec probe's command is deliberately not decoded.
type probeTimingView struct {
	InitialDelaySeconds int `json:"initialDelaySeconds"`
	PeriodSeconds       int `json:"periodSeconds"`
	TimeoutSeconds      int `json:"timeoutSeconds"`
	FailureThreshold    int `json:"failureThreshold"`
	GRPC                *struct {
		Port int `json:"port"`
	} `json:"grpc"`
	HTTPGet *struct {
		Port json.RawMessage `json:"port"`
	} `json:"httpGet"`
	TCPSocket *struct {
		Port json.RawMessage `json:"port"`
	} `json:"tcpSocket"`
	Exec *struct{} `json:"exec"`
}

// describe renders the probe's handler and timing, with the Kubernetes defaults filled in, and the
// window after which a process that never answers is killed.
func (p *probeTimingView) describe() string {
	if p == nil {
		return "none — the kubelet never kills this container for being unresponsive"
	}
	handler := "unknown handler"
	switch {
	case p.GRPC != nil:
		handler = fmt.Sprintf("grpc :%d", p.GRPC.Port)
	case p.HTTPGet != nil:
		handler = "httpGet :" + strings.Trim(string(p.HTTPGet.Port), `"`)
	case p.TCPSocket != nil:
		handler = "tcpSocket :" + strings.Trim(string(p.TCPSocket.Port), `"`)
	case p.Exec != nil:
		handler = "exec (command not printed)"
	}
	// The API server defaults these on write; a zero here means the field was absent in what we read.
	period, timeout, threshold := orDefault(p.PeriodSeconds, 10), orDefault(p.TimeoutSeconds, 1), orDefault(p.FailureThreshold, 3)
	window := p.InitialDelaySeconds + period*threshold
	return fmt.Sprintf("%s initialDelay=%ds period=%ds timeout=%ds failureThreshold=%d — a process that never answers is killed ≈%ds after it starts",
		handler, p.InitialDelaySeconds, period, timeout, threshold, window)
}

// orDefault returns v, or def when v is zero.
func orDefault(v, def int) int {
	if v == 0 {
		return def
	}
	return v
}

// crashLoopContainer is one main container that is crash-looping or has restarted on a not-Ready Pod,
// with everything the dump says about it that comes from the Pod object itself.
type crashLoopContainer struct {
	Pod, Container string
	Waiting        string // current waiting reason, "" if not waiting
	Restarts       int
	LastReason     string // "" when no previous termination is recorded
	LastExit       int
	HasLast        bool
	LastRan        string // how long the last run lasted, "" when unknown
	Liveness       string
	Limits         string
}

// crashLoopingContainers lists, for every non-terminal not-Ready Pod, each MAIN container that is
// waiting in CrashLoopBackOff or has restarted at least once — the containers whose previous logs
// and events dumpArgoAppDiagnosis reads. Capped at max. An undecodable list yields nil: the
// scheduling half has already said the pod list could not be read.
func crashLoopingContainers(podsJSON []byte, max int) []crashLoopContainer {
	pods, err := decodePodList(podsJSON)
	if err != nil {
		return nil
	}
	var out []crashLoopContainer
	for _, p := range pods {
		if p.terminal() {
			continue
		}
		if ready, _, _ := p.condition("Ready"); ready == "True" {
			continue
		}
		for _, cs := range p.Status.ContainerStatuses {
			waiting := ""
			if cs.State.Waiting != nil {
				waiting = cs.State.Waiting.Reason
			}
			if waiting != "CrashLoopBackOff" && cs.RestartCount == 0 {
				continue
			}
			if len(out) == max {
				return out
			}
			c := crashLoopContainer{Pod: p.Metadata.Name, Container: cs.Name, Waiting: waiting, Restarts: cs.RestartCount,
				Liveness: "UNKNOWN (the container is not in the Pod spec that was read)", Limits: "UNKNOWN"}
			if t := cs.LastState.Terminated; t != nil {
				c.HasLast, c.LastReason, c.LastExit = true, t.Reason, t.ExitCode
				c.LastRan = runLength(t.StartedAt, t.FinishedAt)
			}
			for _, sc := range p.Spec.Containers {
				if sc.Name != cs.Name {
					continue
				}
				c.Liveness = sc.LivenessProbe.describe()
				c.Limits = describeLimits(sc.Resources.Limits)
			}
			out = append(out, c)
		}
	}
	return out
}

// runLength renders finished-started, or "" when either is missing or unparseable.
func runLength(started, finished string) string {
	s, err1 := time.Parse(time.RFC3339, started)
	f, err2 := time.Parse(time.RFC3339, finished)
	if err1 != nil || err2 != nil || f.Before(s) {
		return ""
	}
	return f.Sub(s).String()
}

// describeLimits renders a container's cpu and memory limits, saying "none" for an absent one.
func describeLimits(l map[string]string) string {
	cpu, mem := l["cpu"], l["memory"]
	if cpu == "" {
		cpu = "none"
	}
	if mem == "" {
		mem = "none"
	}
	return "cpu=" + cpu + " memory=" + mem
}

// exitMeaning says what a container's last termination means, in the terms that decide where the
// cause lives: the kernel (OOM), the kubelet (a signal from outside), or the process itself.
func exitMeaning(reason string, code int) string {
	switch {
	case reason == "OOMKilled":
		return "OOM-KILLED — it reached its memory limit; the cause is memory, not the log"
	case code == 137:
		return "SIGKILL that is NOT an OOM kill (containerd would say OOMKilled) — killed from outside, most often by the kubelet after a failed liveness probe whose SIGTERM the process ignored for terminationGracePeriodSeconds (a PID-1 process with no handler ignores it); Unhealthy/Killing events below confirm it"
	case code == 143:
		return "SIGTERM — stopped from outside (a failed liveness probe, or an eviction) and it exited on the signal; the events below say which"
	case code == 0:
		return "exited 0 — the process RETURNED; for a server that is a crash all the same"
	default:
		return fmt.Sprintf("the process exited %d on its own — its previous log below is the cause", code)
	}
}

// crashRead is one crash-looping container's reads, as dumpArgoAppDiagnosis performed them.
type crashRead struct {
	crashLoopContainer
	Log       []byte
	LogErr    error
	Events    []byte
	EventsErr error
}

// eventView is the subset of a core/v1 Event the dump reads.
type eventView struct {
	Type           string `json:"type"`
	Reason         string `json:"reason"`
	Message        string `json:"message"`
	Count          int    `json:"count"`
	LastTimestamp  string `json:"lastTimestamp"`
	EventTime      string `json:"eventTime"`
	FirstTimestamp string `json:"firstTimestamp"`
}

// when is the event's most recent timestamp, for ordering.
func (e eventView) when() string {
	for _, t := range []string{e.LastTimestamp, e.EventTime, e.FirstTimestamp} {
		if t != "" {
			return t
		}
	}
	return ""
}

// renderCrashLoopDiagnosis prints, per crash-looping container, what its last exit means, how long
// it ran, the probe and limits it was held to, the previous run's last log lines, and the Pod's last
// events. Every failed read is UNKNOWN with its error.
func renderCrashLoopDiagnosis(reads []crashRead) string {
	if len(reads) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("    main containers that are crash-looping or have restarted — why the last run ended:\n")
	for _, r := range reads {
		fmt.Fprintf(&b, "      %s / %s (waiting=%s, restarts=%d):\n", r.Pod, r.Container, orNone(r.Waiting), r.Restarts)
		if r.HasLast {
			fmt.Fprintf(&b, "        last exit %s/%d: %s\n", orNone(r.LastReason), r.LastExit, exitMeaning(r.LastReason, r.LastExit))
			ran := r.LastRan
			if ran == "" {
				ran = "UNKNOWN (no start/finish time recorded)"
			}
			fmt.Fprintf(&b, "        last run lasted: %s\n", ran)
		} else {
			b.WriteString("        last exit: UNKNOWN (no previous termination recorded)\n")
		}
		fmt.Fprintf(&b, "        liveness probe: %s\n", r.Liveness)
		fmt.Fprintf(&b, "        limits: %s\n", r.Limits)

		fmt.Fprintf(&b, "        last %d log line(s) of the PREVIOUS run (--previous):\n", crashLogTailLines)
		text := strings.TrimRight(string(r.Log), "\n")
		switch {
		case strings.TrimSpace(text) != "":
			for _, ln := range strings.Split(text, "\n") {
				fmt.Fprintf(&b, "          | %s\n", capDiag(ln))
			}
			if r.LogErr != nil {
				fmt.Fprintf(&b, "          (PARTIAL — the read stopped: %v)\n", r.LogErr)
			}
		case r.LogErr != nil:
			fmt.Fprintf(&b, "          UNKNOWN — could not read the log (%v); this says nothing about what it logged\n", r.LogErr)
		default:
			b.WriteString("          (the read succeeded and returned NOTHING — the previous run wrote no line before it ended)\n")
		}

		b.WriteString(renderPodEvents(r.Events, r.EventsErr))
	}
	return b.String()
}

// renderPodEvents renders the Pod's last maxCrashEvents events, oldest first.
func renderPodEvents(raw []byte, readErr error) string {
	var b strings.Builder
	fmt.Fprintf(&b, "        last %d event(s) for the Pod:\n", maxCrashEvents)
	if readErr != nil {
		fmt.Fprintf(&b, "          UNKNOWN — could not list events (%v)\n", readErr)
		return b.String()
	}
	var list struct {
		Items []eventView `json:"items"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		fmt.Fprintf(&b, "          UNKNOWN — could not decode the event list (%v)\n", err)
		return b.String()
	}
	if len(list.Items) == 0 {
		b.WriteString("          none (events expire after an hour by default, so an old crash may have none left)\n")
		return b.String()
	}
	evs := list.Items
	sort.SliceStable(evs, func(i, j int) bool { return evs[i].when() < evs[j].when() })
	if len(evs) > maxCrashEvents {
		evs = evs[len(evs)-maxCrashEvents:]
	}
	for _, e := range evs {
		count := ""
		if e.Count > 1 {
			count = fmt.Sprintf(" (x%d)", e.Count)
		}
		fmt.Fprintf(&b, "          %s %s %s%s: %s\n", orNone(e.when()), orNone(e.Type), orNone(e.Reason), count, capDiag(e.Message))
	}
	return b.String()
}
