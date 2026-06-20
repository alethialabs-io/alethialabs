// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"fmt"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/runner/internal/version"
	"github.com/alethialabs-io/alethialabs/apps/runner/internal/agent"
)

func main() {
	cfg := agent.Config{
		Mode:        envOrDefault("ALETHIA_RUNNER_MODE", "self-hosted"),
		AlethiaURL:  os.Getenv("ALETHIA_WEB_ORIGIN"),
		RunnerID:    os.Getenv("ALETHIA_RUNNER_ID"),
		RunnerToken: os.Getenv("ALETHIA_RUNNER_TOKEN"),

		S3Endpoint:  envOrDefault("ALETHIA_STORAGE_ENDPOINT", ""),
		S3Region:    envOrDefault("ALETHIA_STORAGE_REGION", ""),
		S3AccessKey: os.Getenv("ALETHIA_STORAGE_ACCESS_KEY_ID"),
		S3SecretKey: os.Getenv("ALETHIA_STORAGE_SECRET_ACCESS_KEY"),
	}

	fmt.Printf("runner %s\n", version.Version)

	if cfg.AlethiaURL == "" {
		fmt.Fprintln(os.Stderr, "Error: ALETHIA_WEB_ORIGIN is required (set it to your Alethia control-plane URL).")
		os.Exit(1)
	}
	if cfg.RunnerID == "" || cfg.RunnerToken == "" {
		fmt.Fprintln(os.Stderr, "Error: ALETHIA_RUNNER_ID and ALETHIA_RUNNER_TOKEN environment variables are required.")
		os.Exit(1)
	}

	w := agent.New(cfg)
	if err := w.Run(context.Background()); err != nil {
		fmt.Fprintf(os.Stderr, "Runner error: %v\n", err)
		os.Exit(1)
	}
}

func envOrDefault(key, defaultVal string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultVal
}
