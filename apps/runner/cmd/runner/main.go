// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/runner/internal/agent"
	"github.com/alethialabs-io/alethialabs/apps/runner/internal/version"
)

func main() {
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
