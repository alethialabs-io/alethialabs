// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// brokerPodsJSON is a `kubectl get pod -o json` listing for one queue's release.
func brokerPodsJSON(name, phase string, ready bool) string {
	return `{"items":[{"metadata":{"name":"` + name + `"},"status":{"phase":"` + phase +
		`","containerStatuses":[{"name":"rabbitmq","ready":` + map[bool]string{true: "true", false: "false"}[ready] + `}]}}]}`
}

// THE reason this exists: the reconciliation runs the other way round from everything else here.
// The Secret cannot be made to match the broker — the password the broker accepts was overwritten
// by ArgoCD reconciles long ago — so the broker is made to match the Secret.
func TestConvergeQueuePasswordExecsAgainstAReadyBroker(t *testing.T) {
	stub := newKubectlStub(t, 0,
		stubRule{Match: "get pod", Stdout: brokerPodsJSON("addon-queue-jobs-rabbitmq-0", "Running", true)},
	)
	var out strings.Builder
	if err := ConvergeQueuePassword(oneQueue(t, "jobs"), &out, io.Discard); err != nil {
		t.Fatalf("ConvergeQueuePassword: %v", err)
	}
	var exec string
	for _, c := range stub.calls() {
		if strings.HasPrefix(c, "exec ") {
			exec = c
		}
	}
	if exec == "" {
		t.Fatalf("never exec'd into the broker; calls = %v", stub.calls())
	}
	for _, want := range []string{
		"addon-queue-jobs-rabbitmq-0",
		"-n queues",
		// The container is named, not left to kubectl's first-container default: the release also
		// runs an init container, and an autoReload sidecar is one values flag away.
		"-c rabbitmq",
		"rabbitmqctl change_password",
	} {
		if !strings.Contains(exec, want) {
			t.Errorf("exec is missing %q: %q", want, exec)
		}
	}
	// THE SUBTLE ONE. The variables must reach the container UNEXPANDED — they are resolved there,
	// from the environment the chart populated out of the Secret. Expanding them in the runner (a
	// double-quoted command string) would send two EMPTY strings and blank the broker's password
	// while reporting success.
	for _, want := range []string{"$RABBITMQ_DEFAULT_USER", "$RABBITMQ_DEFAULT_PASS"} {
		if !strings.Contains(exec, want) {
			t.Errorf("%s was expanded before it reached the container: %q", want, exec)
		}
	}
	if !strings.Contains(out.String(), "Reconciling") {
		t.Errorf("did not report the reconciliation: %q", out.String())
	}
}

// No broker to talk to is the ORDINARY state on the deploy that creates a queue — the broker takes
// the Secret's password on its first boot, so there is nothing to reconcile. It must not be an
// error, and it must not be silent either: "no broker yet" and "converged" cannot look alike.
func TestConvergeQueuePasswordSkipsWhenNoBrokerIsReady(t *testing.T) {
	for _, tc := range []struct {
		name string
		json string
	}{
		{"no pods at all", `{"items":[]}`},
		{"running but not ready", brokerPodsJSON("addon-queue-jobs-rabbitmq-0", "Running", false)},
		{"ready but still pending", brokerPodsJSON("addon-queue-jobs-rabbitmq-0", "Pending", true)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stub := newKubectlStub(t, 0, stubRule{Match: "get pod", Stdout: tc.json})
			var errOut strings.Builder
			if err := ConvergeQueuePassword(oneQueue(t, "jobs"), io.Discard, &errOut); err != nil {
				t.Fatalf("ConvergeQueuePassword: %v", err)
			}
			for _, c := range stub.calls() {
				if strings.HasPrefix(c, "exec ") {
					t.Fatalf("exec'd into a broker that was not Ready: %q", c)
				}
			}
			if !strings.Contains(errOut.String(), "NOT reconciled") {
				t.Errorf("said nothing about skipping: %q", errOut.String())
			}
		})
	}
}

// A FAILED LISTING IS NOT AN ABSENT BROKER. `kubectl get` exits non-zero for an unreachable
// apiserver or an RBAC blip, and reporting that as "no pod" is how a deploy stops reconciling and
// says only that there was no broker — the same defect class the credential read carries a flag for.
func TestConvergeQueuePasswordRefusesToReadAFailedListingAsNoBroker(t *testing.T) {
	stub := newKubectlStub(t, 0, stubRule{Match: "get pod", Exit: 1})
	var errOut strings.Builder
	err := ConvergeQueuePassword(oneQueue(t, "jobs"), io.Discard, &errOut)
	if err == nil {
		t.Fatal("a failed pod listing was reported as no broker")
	}
	if strings.Contains(errOut.String(), "NOT reconciled") {
		t.Errorf("reported a read failure as an ordinary skip: %q", errOut.String())
	}
	for _, c := range stub.calls() {
		if strings.HasPrefix(c, "exec ") {
			t.Fatalf("exec'd despite failing to list: %q", c)
		}
	}
}

func TestConvergeQueuePasswordSurfacesAnExecFailure(t *testing.T) {
	newKubectlStub(t, 0,
		stubRule{Match: "get pod", Stdout: brokerPodsJSON("addon-queue-jobs-rabbitmq-0", "Running", true)},
		stubRule{Match: "exec", Exit: 1},
	)
	if err := ConvergeQueuePassword(oneQueue(t, "jobs"), io.Discard, io.Discard); err == nil {
		t.Fatal("a failed change_password was reported as success")
	}
}

func TestConvergeQueuePasswordRefusesAnUnsafeQueue(t *testing.T) {
	newKubectlStub(t, 0)
	bad := HetznerQueue{Name: "jobs; rm -rf /", Namespace: hetznerQueueNamespace, AddOnID: "queue-jobs"}
	if err := ConvergeQueuePassword(bad, io.Discard, io.Discard); err == nil {
		t.Fatal("reconciled the password for an unsafe queue name")
	}
}

// The pod name comes back from the API server, which already constrains it — but it interpolates
// into a command this package runs through `bash -c`, and a shell-command builder does not get to
// assume somebody upstream checked.
func TestConvergeQueuePasswordSkipsAnUnsafePodName(t *testing.T) {
	stub := newKubectlStub(t, 0,
		stubRule{Match: "get pod", Stdout: brokerPodsJSON("pod; rm -rf /", "Running", true)},
	)
	var errOut strings.Builder
	if err := ConvergeQueuePassword(oneQueue(t, "jobs"), io.Discard, &errOut); err != nil {
		t.Fatalf("ConvergeQueuePassword: %v", err)
	}
	for _, c := range stub.calls() {
		if strings.Contains(c, "rm -rf") {
			t.Fatalf("an unsafe pod name reached a command line: %q", c)
		}
	}
	if !strings.Contains(errOut.String(), "safely exec into") {
		t.Errorf("skipped the pod without saying why: %q", errOut.String())
	}
}

// ── the script, executed rather than asserted on ────────────────────────────────────────────────
//
// Everything above pins the COMMAND STRING. That is the right test for the kubectl arguments, and
// the wrong one for the script: what matters about the script is how a shell behaves when it runs
// it, and a substring check passes on a script that has stopped behaving that way. So this runs the
// real thing under a real `sh`, with a fake `rabbitmqctl` on PATH that records the arguments it was
// actually given.
//
// It is also the only test here that can see the failure the repository cannot otherwise reach:
// `RABBITMQ_DEFAULT_USER` / `_PASS` are an assumption about an UPSTREAM chart, pinned by nothing in
// this tree, and an upstream rename turns `change_password` into `change_password "" ""`.
func runQueuePasswordScript(t *testing.T, env []string) (exit int, args string) {
	t.Helper()
	dir := t.TempDir()
	// A fake `rabbitmqctl` that writes its argv, one per line, so an EMPTY argument is visible as
	// an empty line rather than vanishing into whitespace.
	record := filepath.Join(dir, "argv")
	fake := filepath.Join(dir, "rabbitmqctl")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\nfor a in \"$@\"; do echo \"$a\" >> "+record+"; done\n"), 0o755); err != nil {
		t.Fatalf("write fake rabbitmqctl: %v", err)
	}
	cmd := exec.Command("sh", "-c", queuePasswordScript)
	cmd.Env = append([]string{"PATH=" + dir}, env...)
	err := cmd.Run()
	if err != nil {
		var ee *exec.ExitError
		if !errors.As(err, &ee) {
			t.Fatalf("run script: %v", err)
		}
		exit = ee.ExitCode()
	}
	raw, readErr := os.ReadFile(record)
	if readErr != nil && !os.IsNotExist(readErr) {
		t.Fatalf("read recorded argv: %v", readErr)
	}
	return exit, string(raw)
}

func TestQueuePasswordScriptPassesBothValuesThrough(t *testing.T) {
	exit, args := runQueuePasswordScript(t, []string{
		"RABBITMQ_DEFAULT_USER=admin",
		// A password with a space and a shell metacharacter, because the whole point of the quoting
		// is that neither of them splits or expands.
		"RABBITMQ_DEFAULT_PASS=p w$USER;x",
	})
	if exit != 0 {
		t.Fatalf("script refused a well-formed container: exit %d", exit)
	}
	if args != "change_password\nadmin\np w$USER;x\n" {
		t.Errorf("rabbitmqctl received the wrong argv:\n%q", args)
	}
}

// THE ONE THAT MATTERS. Neither variable set — an upstream chart that renamed them, or a container
// this reconciliation was never shaped for.
func TestQueuePasswordScriptRefusesWhenTheVariablesAreMissing(t *testing.T) {
	for _, tc := range []struct {
		name string
		env  []string
	}{
		{"neither set", nil},
		{"user only", []string{"RABBITMQ_DEFAULT_USER=admin"}},
		{"password only", []string{"RABBITMQ_DEFAULT_PASS=hunter2"}},
		{"both set but empty", []string{"RABBITMQ_DEFAULT_USER=", "RABBITMQ_DEFAULT_PASS="}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			exit, args := runQueuePasswordScript(t, tc.env)
			// A non-zero exit is what makes ExecuteCommand return an error, so the deploy reports
			// this rather than logging a successful reconciliation that blanked a credential.
			if exit != 78 {
				t.Errorf("exit = %d, want 78 (EX_CONFIG)", exit)
			}
			if args != "" {
				t.Errorf("rabbitmqctl was called with an incomplete environment: %q", args)
			}
		})
	}
}
