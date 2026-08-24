// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/runner/internal/agent"
	"github.com/alethialabs-io/alethialabs/apps/runner/internal/obs"
	"github.com/alethialabs-io/alethialabs/apps/runner/internal/version"
)

// subcommands are the one-shot and sidecar modes the runner binary also serves, dispatched BEFORE
// the normal boot.
//
// Every one of them must be handled before `ALETHIA_RUNNER_EXEC_STAGE` and before bootstrap
// registration: kube-token is re-entered from inside the sandbox child (where that env var is set,
// so falling through would recurse); the token refreshers loop until SIGTERM; and the one-shot Jobs
// run with an allowlisted env that carries no runner token to register with.
//
// A TABLE rather than a chain of `if os.Args[1] == …` blocks, because a chain of eight
// near-identical branches inside main() is untestable — a subcommand renamed or dropped compiles
// cleanly and is only discovered when a Job silently boots the agent instead of doing its work.
var subcommands = map[string]func(context.Context, []string) error{
	// Kubernetes exec-credential-plugin: kubectl/helm invoke `<runner> kube-token …` from the
	// kubeconfig the runner writes, to mint a short-lived cluster token in-process, CLI-free.
	"kube-token": agent.RunKubeToken,
	// Keyless DB-auth refresher (#722): a sidecar minting a short-lived DB token from the pod's
	// Workload Identity onto a shared file the local proxy reads. Long-running.
	"db-token": agent.RunDBToken,
	// Keyless DB-auth PROXY (#722, epic #1500): a sidecar serving a password-free endpoint on
	// 127.0.0.1, minting per upstream connection so nothing is ever at rest. Long-running.
	"db-authproxy": agent.RunDBAuthProxy,
	// Keyless DB least-privilege bootstrap (#722): a one-shot Job creating the scoped app role, the
	// alternative to handing the app superuser/AAD-admin.
	"db-bootstrap": agent.RunDBBootstrap,
	// In-cluster Harbor bootstrap (#2431): a one-shot Job minting the project-scoped PULL robot for
	// a Hetzner `registry` node and writing the dockerconfigjson. It runs IN the cluster because
	// Harbor's API answers only on the cluster network — which also keeps the credential out of the
	// runner process entirely.
	"harbor-bootstrap": agent.RunHarborBootstrap,
	// Keyless cross-account registry-pull refresher: a standalone in-cluster Deployment keeping the
	// <slug>-pull dockerconfigjson fresh from the pod's Workload Identity. Long-running.
	"registry-token": agent.RunRegistryToken,
	// The helm_registry analogue of registry-token, for OCI chart repos (#1185). Long-running.
	"helm-repo-token": agent.RunHelmRepoToken,
}

// dispatchSubcommand runs the subcommand named by args[0], if there is one.
//
// Returns handled=false when args name no subcommand, so main() falls through to the normal boot.
// The error is returned rather than exited on, so the decision is testable.
func dispatchSubcommand(ctx context.Context, args []string) (handled bool, err error) {
	if len(args) == 0 {
		return false, nil
	}
	run, ok := subcommands[args[0]]
	if !ok {
		return false, nil
	}
	return true, run(ctx, args[1:])
}

func main() {
	if handled, err := dispatchSubcommand(context.Background(), os.Args[1:]); handled {
		if err != nil {
			fmt.Fprintf(os.Stderr, "%s error: %v\n", os.Args[1], err)
			os.Exit(1)
		}
		return
	}

	// Container-sandbox child mode: this process was re-exec'd INSIDE a per-job sandbox
	// container to run one untrusted stage. It has an allowlisted env only (no runner
	// token / storage keys / bootstrap token), so it must run the stage and exit BEFORE
	// the normal boot (which would try to bootstrap-register). See sandbox.Container.
	if os.Getenv("ALETHIA_RUNNER_EXEC_STAGE") == "1" {
		if err := agent.RunExecStage(context.Background()); err != nil {
			fmt.Fprintf(os.Stderr, "exec-stage error: %v\n", err)
			os.Exit(1)
		}
		return
	}

	cfg := agent.Config{
		Operator:    runnerOperator(),
		Providers:   runnerProviders(),
		AlethiaURL:  os.Getenv("ALETHIA_WEB_ORIGIN"),
		RunnerID:    os.Getenv("ALETHIA_RUNNER_ID"),
		RunnerToken: os.Getenv("ALETHIA_RUNNER_TOKEN"),
	}

	fmt.Printf("runner %s\n", version.Version)

	if cfg.AlethiaURL == "" {
		fmt.Fprintln(os.Stderr, "Error: ALETHIA_WEB_ORIGIN is required (set it to your Alethia control-plane URL).")
		os.Exit(1)
	}

	// A scaler-provisioned VM boots without credentials: self-register via the
	// bootstrap token, then persist the result into the env so any worker subprocesses
	// (ALETHIA_RUNNER_SLOTS > 1) inherit it rather than each re-bootstrapping.
	if cfg.RunnerID == "" || cfg.RunnerToken == "" {
		if bt := os.Getenv("ALETHIA_RUNNER_BOOTSTRAP_TOKEN"); bt != "" {
			id, token, err := agent.BootstrapRunner(cfg.AlethiaURL, bt, cfg.Providers)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: runner bootstrap failed: %v\n", err)
				os.Exit(1)
			}
			cfg.RunnerID = id
			cfg.RunnerToken = token
			_ = os.Setenv("ALETHIA_RUNNER_ID", id)
			_ = os.Setenv("ALETHIA_RUNNER_TOKEN", token)
			fmt.Println("runner self-registered via bootstrap token")
		}
	}

	if cfg.RunnerID == "" || cfg.RunnerToken == "" {
		fmt.Fprintln(os.Stderr, "Error: ALETHIA_RUNNER_ID and ALETHIA_RUNNER_TOKEN environment variables are required.")
		os.Exit(1)
	}

	// OpenTelemetry traces + metrics (endpoint-gated: a complete no-op unless
	// OTEL_EXPORTER_OTLP_ENDPOINT is set). Never fatal — a telemetry setup error is logged
	// and the runner provisions on without it. The deferred shutdown flushes buffered spans
	// on a clean drain (SIGTERM → the agent returns nil → this defer runs).
	otelShutdown, otelErr := obs.Setup(context.Background(), version.Version)
	if otelErr != nil {
		fmt.Fprintf(os.Stderr, "Warning: OpenTelemetry setup failed; continuing without telemetry: %v\n", otelErr)
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = otelShutdown(shutdownCtx)
	}()

	// Sentry error tracking (DSN-gated: a complete no-op unless SENTRY_DSN is set). Never fatal —
	// an init error is logged and the runner provisions on without it. The deferred flush ships any
	// buffered events on a clean drain (SIGTERM → the agent returns → this defer runs).
	sentryFlush, sentryErr := agent.InitSentry(version.Version)
	if sentryErr != nil {
		fmt.Fprintf(os.Stderr, "Warning: Sentry setup failed; continuing without error tracking: %v\n", sentryErr)
	}
	defer sentryFlush()

	// Concurrency: a single logical runner can run N jobs as N worker subprocesses.
	// A worker child (or the default single-slot runner) runs the agent loop in-process;
	// otherwise this process supervises the worker pool. Default slots=1 → exactly the
	// previous behavior (no subprocess).
	slots := runnerSlots()
	if os.Getenv("ALETHIA_RUNNER_WORKER") == "1" || slots <= 1 {
		w := agent.New(cfg)
		if err := w.Run(context.Background()); err != nil {
			fmt.Fprintf(os.Stderr, "Runner error: %v\n", err)
			os.Exit(1)
		}
		return
	}

	fmt.Printf("supervisor: running %d concurrent worker slots\n", slots)
	if err := agent.SuperviseWorkers(context.Background(), slots, agent.RealWorkerSpawn); err != nil {
		fmt.Fprintf(os.Stderr, "Supervisor error: %v\n", err)
		os.Exit(1)
	}
}

// runnerSlots reads ALETHIA_RUNNER_SLOTS (concurrent jobs per runner). Defaults to 1
// (and clamps invalid/low values to 1).
func runnerSlots() int {
	if n, err := strconv.Atoi(strings.TrimSpace(os.Getenv("ALETHIA_RUNNER_SLOTS"))); err == nil && n >= 1 {
		return n
	}
	return 1
}

// runnerOperator resolves who operates this runner ("managed" | "self"), defaulting
// to "self". Falls back to the legacy ALETHIA_RUNNER_MODE env var (cloud-hosted →
// managed, self-hosted → self) so already-deployed task definitions keep working
// until their next update rolls the new var.
func runnerOperator() string {
	if v := os.Getenv("ALETHIA_RUNNER_OPERATOR"); v != "" {
		return v
	}
	switch os.Getenv("ALETHIA_RUNNER_MODE") {
	case "cloud-hosted":
		return "managed"
	case "self-hosted":
		return "self"
	}
	return "self"
}

// runnerProviders parses ALETHIA_RUNNER_PROVIDERS (comma-separated cloud providers,
// e.g. "aws" on a lean per-cloud image). Empty/unset → nil → the runner claims any
// provider (the full/self-host image).
func runnerProviders() []string {
	raw := os.Getenv("ALETHIA_RUNNER_PROVIDERS")
	if raw == "" {
		return nil
	}
	var out []string
	for _, p := range strings.Split(raw, ",") {
		if trimmed := strings.TrimSpace(p); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
