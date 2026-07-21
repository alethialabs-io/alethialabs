// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

func resetK8sSeams(t *testing.T) {
	t.Helper()
	origExecuteCommand := executeCommand
	origExecuteCommandWithOutput := executeCommandWithOutput
	t.Cleanup(func() {
		executeCommand = origExecuteCommand
		executeCommandWithOutput = origExecuteCommandWithOutput
	})
}

func TestProbeImageOverride(t *testing.T) {
	t.Setenv("ALETHIA_CLUSTER_PROBE_IMAGE", "registry.local/busybox:mirror")
	if got := probeImage(); got != "registry.local/busybox:mirror" {
		t.Fatalf("probeImage = %q", got)
	}
	t.Setenv("ALETHIA_CLUSTER_PROBE_IMAGE", " ")
	if got := probeImage(); got != "busybox:1.36" {
		t.Fatalf("probeImage default = %q", got)
	}
}

func TestPollUntilSuccessTimeoutAndCancel(t *testing.T) {
	calls := 0
	if err := pollUntil(context.Background(), time.Now().Add(time.Second), time.Millisecond, func() bool {
		calls++
		return calls == 2
	}); err != nil {
		t.Fatalf("pollUntil success: %v", err)
	}
	if calls != 2 {
		t.Fatalf("pollUntil calls = %d, want 2", calls)
	}

	if err := pollUntil(context.Background(), time.Now(), time.Millisecond, func() bool { return false }); err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("pollUntil timeout error = %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := pollUntil(ctx, time.Now().Add(time.Second), time.Millisecond, func() bool { return false }); !errors.Is(err, context.Canceled) {
		t.Fatalf("pollUntil cancel error = %v", err)
	}
}

func TestWaitClusterReadyCommandFlows(t *testing.T) {
	resetK8sSeams(t)

	t.Run("api only succeeds without node requirement", func(t *testing.T) {
		var commands []string
		executeCommandWithOutput = func(command, _ string, _ []string) (string, error) {
			commands = append(commands, command)
			if command != "kubectl get --raw=/readyz" {
				t.Fatalf("unexpected command: %q", command)
			}
			return "ok", nil
		}
		if err := WaitClusterReady(context.Background(), time.Second, false, io.Discard); err != nil {
			t.Fatalf("WaitClusterReady: %v", err)
		}
		if len(commands) != 1 {
			t.Fatalf("commands = %#v, want readyz only", commands)
		}
	})

	t.Run("node requirement counts ready nodes", func(t *testing.T) {
		executeCommandWithOutput = func(command, _ string, _ []string) (string, error) {
			switch command {
			case "kubectl get --raw=/readyz":
				return "ok", nil
			case "kubectl get nodes -o json":
				return `{"items":[{"status":{"conditions":[{"type":"Ready","status":"True"}]}}]}`, nil
			default:
				t.Fatalf("unexpected command: %q", command)
				return "", nil
			}
		}
		if err := WaitClusterReady(context.Background(), time.Second, true, io.Discard); err != nil {
			t.Fatalf("WaitClusterReady: %v", err)
		}
	})

	t.Run("auth rejection is classified", func(t *testing.T) {
		executeCommandWithOutput = func(string, string, []string) (string, error) {
			return "Unauthorized", errors.New("you must be logged in")
		}
		err := WaitClusterReady(context.Background(), 0, false, io.Discard)
		if err == nil || !strings.Contains(err.Error(), "AUTH REJECTED") {
			t.Fatalf("WaitClusterReady error = %v", err)
		}
	})

	t.Run("not ready node timeout includes reasons", func(t *testing.T) {
		executeCommandWithOutput = func(command, _ string, _ []string) (string, error) {
			switch command {
			case "kubectl get --raw=/readyz":
				return "ok", nil
			case "kubectl get nodes -o json":
				return `{"items":[{"status":{"conditions":[{"type":"Ready","status":"False","reason":"KubeletNotReady","message":"network plugin missing"}]}}]}`, nil
			default:
				return "", nil
			}
		}
		err := WaitClusterReady(context.Background(), 0, true, io.Discard)
		if err == nil || !strings.Contains(err.Error(), "KubeletNotReady: network plugin missing") {
			t.Fatalf("WaitClusterReady error = %v", err)
		}
	})
}

func TestWaitPodToAPIServerCommandFlows(t *testing.T) {
	resetK8sSeams(t)
	t.Setenv("ALETHIA_CLUSTER_PROBE_IMAGE", "busybox:test")

	t.Run("cluster ip lookup failure is fatal", func(t *testing.T) {
		executeCommandWithOutput = func(string, string, []string) (string, error) {
			return "", errors.New("no kubeconfig")
		}
		err := WaitPodToAPIServer(context.Background(), time.Second, io.Discard)
		if err == nil || !strings.Contains(err.Error(), "could not resolve") {
			t.Fatalf("WaitPodToAPIServer error = %v", err)
		}
	})

	t.Run("successful job applies manifest and cleans up", func(t *testing.T) {
		var commands []string
		executeCommandWithOutput = func(command, _ string, _ []string) (string, error) {
			commands = append(commands, command)
			switch {
			case strings.Contains(command, "jsonpath={.spec.clusterIP}"):
				return "10.96.0.1\n", nil
			case strings.HasPrefix(command, "kubectl delete job alethia-apiserver-probe"):
				return "", nil
			case strings.HasPrefix(command, "kubectl apply -f "):
				path := strings.TrimPrefix(command, "kubectl apply -f ")
				data, err := os.ReadFile(path)
				if err != nil {
					t.Fatalf("read probe manifest: %v", err)
				}
				for _, want := range []string{"10.96.0.1 443", "image: busybox:test", "name: alethia-apiserver-probe"} {
					if !strings.Contains(string(data), want) {
						t.Fatalf("probe manifest missing %q:\n%s", want, data)
					}
				}
				return "", nil
			case strings.Contains(command, "jsonpath={.status.succeeded}"):
				return "1", nil
			default:
				return "", nil
			}
		}
		if err := WaitPodToAPIServer(context.Background(), time.Second, io.Discard); err != nil {
			t.Fatalf("WaitPodToAPIServer: %v", err)
		}
		if len(commands) < 4 {
			t.Fatalf("commands = %#v", commands)
		}
		if !strings.Contains(commands[len(commands)-1], "--wait=false") {
			t.Fatalf("final command = %q, want deferred cleanup", commands[len(commands)-1])
		}
	})

	t.Run("timeout distinguishes pod scheduling from network verdict", func(t *testing.T) {
		executeCommandWithOutput = func(command, _ string, _ []string) (string, error) {
			switch {
			case strings.Contains(command, "jsonpath={.spec.clusterIP}"):
				return "10.96.0.1", nil
			case strings.HasPrefix(command, "kubectl delete job"), strings.HasPrefix(command, "kubectl apply -f "):
				return "", nil
			case strings.Contains(command, "jsonpath={.status.succeeded}"):
				return "", nil
			case strings.Contains(command, "status.phase"):
				return "Pending", nil
			case strings.Contains(command, "waiting.reason"):
				return "ImagePullBackOff", nil
			default:
				return "", nil
			}
		}
		err := WaitPodToAPIServer(context.Background(), 0, io.Discard)
		if err == nil || !strings.Contains(err.Error(), "Pending/ImagePullBackOff") || strings.Contains(err.Error(), "pod network is broken") {
			t.Fatalf("WaitPodToAPIServer error = %v", err)
		}
	})
}

func TestK8sCLIApplyCommandSequencing(t *testing.T) {
	resetK8sSeams(t)

	t.Run("dry run tolerates server dry-run failure", func(t *testing.T) {
		var commands []string
		executeCommand = func(command, dir string, env []string, _, _ io.Writer) error {
			commands = append(commands, command)
			if dir != "." {
				t.Fatalf("dir = %q, want .", dir)
			}
			assertEnvContains(t, env, "TOKEN=abc")
			return errors.New("server dry-run unsupported")
		}
		err := (&K8sCLI{DryRun: true}).Apply("default", "app.yaml", map[string]string{"token": "abc"}, utils.NewLogger(nil, ""))
		if err != nil {
			t.Fatalf("dry-run Apply should tolerate server dry-run failure: %v", err)
		}
		if len(commands) != 1 || !strings.Contains(commands[0], "--dry-run=server") {
			t.Fatalf("commands = %#v", commands)
		}
	})

	t.Run("real apply requires dry-run then applies", func(t *testing.T) {
		var commands []string
		executeCommand = func(command, _ string, env []string, _, _ io.Writer) error {
			commands = append(commands, command)
			assertEnvContains(t, env, "TOKEN=abc")
			return nil
		}
		err := (&K8sCLI{DryRun: false}).Apply("prod", "app.yaml", map[string]string{"token": "abc"}, utils.NewLogger(nil, ""))
		if err != nil {
			t.Fatalf("Apply: %v", err)
		}
		want := []string{
			"kubectl apply -n prod -f 'app.yaml' --dry-run=server",
			"kubectl apply -n prod -f 'app.yaml'",
		}
		if strings.Join(commands, "\n") != strings.Join(want, "\n") {
			t.Fatalf("commands = %#v, want %#v", commands, want)
		}
	})

	t.Run("injectable namespace is rejected before any command runs", func(t *testing.T) {
		var commands []string
		executeCommand = func(command, _ string, _ []string, _, _ io.Writer) error {
			commands = append(commands, command)
			return nil
		}
		err := (&K8sCLI{}).Apply("default; touch /tmp/pwned", "app.yaml", nil, utils.NewLogger(nil, ""))
		if err == nil || !strings.Contains(err.Error(), "not a valid RFC-1123 DNS label") {
			t.Fatalf("Apply with injectable namespace error = %v, want rejection", err)
		}
		if len(commands) != 0 {
			t.Fatalf("commands = %#v, want none (must fail closed before executing)", commands)
		}
	})

	t.Run("injectable manifest path is shell-quoted", func(t *testing.T) {
		var commands []string
		executeCommand = func(command, _ string, _ []string, _, _ io.Writer) error {
			commands = append(commands, command)
			return nil
		}
		evil := "app.yaml; touch /tmp/pwned"
		err := (&K8sCLI{DryRun: true}).Apply("default", evil, nil, utils.NewLogger(nil, ""))
		if err != nil {
			t.Fatalf("Apply: %v", err)
		}
		if len(commands) != 1 || !strings.Contains(commands[0], utils.ShellQuote(evil)) {
			t.Fatalf("commands = %#v, want manifest shell-quoted", commands)
		}
	})

	t.Run("real apply stops when server dry-run fails", func(t *testing.T) {
		var commands []string
		executeCommand = func(command, _ string, _ []string, _, _ io.Writer) error {
			commands = append(commands, command)
			return errors.New("schema rejected")
		}
		err := (&K8sCLI{}).Apply("prod", "app.yaml", nil, utils.NewLogger(nil, ""))
		if err == nil || !strings.Contains(err.Error(), "server-side dry-run failed") {
			t.Fatalf("Apply error = %v", err)
		}
		if len(commands) != 1 {
			t.Fatalf("commands = %#v, want only dry-run", commands)
		}
	})
}

func assertEnvContains(t *testing.T, env []string, want string) {
	t.Helper()
	for _, got := range env {
		if got == want {
			return
		}
	}
	t.Fatalf("env %#v missing %q", env, want)
}
