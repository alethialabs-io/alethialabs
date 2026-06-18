// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"fmt"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/runner/internal/version"
	"github.com/alethialabs-io/alethialabs/apps/runner/worker"
)

func main() {
	cfg := worker.Config{
		Mode:        envOrDefault("ALETHIA_WORKER_MODE", "self-hosted"),
		TrellisURL:  envOrDefault("ALETHIA_WEB_ORIGIN", "https://adp.prod.itgix.eu"),
		WorkerID:    os.Getenv("ALETHIA_WORKER_ID"),
		WorkerToken: os.Getenv("ALETHIA_WORKER_TOKEN"),

		S3Endpoint:  envOrDefault("ALETHIA_STORAGE_ENDPOINT", ""),
		S3Region:    envOrDefault("ALETHIA_STORAGE_REGION", ""),
		S3AccessKey: os.Getenv("ALETHIA_STORAGE_ACCESS_KEY_ID"),
		S3SecretKey: os.Getenv("ALETHIA_STORAGE_SECRET_ACCESS_KEY"),
	}

	fmt.Printf("runner-worker %s\n", version.Version)

	if cfg.WorkerID == "" || cfg.WorkerToken == "" {
		fmt.Fprintln(os.Stderr, "Error: ALETHIA_WORKER_ID and ALETHIA_WORKER_TOKEN environment variables are required.")
		os.Exit(1)
	}

	w := worker.New(cfg)
	if err := w.Run(context.Background()); err != nil {
		fmt.Fprintf(os.Stderr, "Worker error: %v\n", err)
		os.Exit(1)
	}
}

func envOrDefault(key, defaultVal string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultVal
}
