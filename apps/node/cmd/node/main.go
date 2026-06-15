// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"fmt"
	"os"

	"github.com/bobikenobi12/bb-thesis-2026/apps/node/internal/version"
	"github.com/bobikenobi12/bb-thesis-2026/apps/node/worker"
)

func main() {
	cfg := worker.Config{
		Mode:        envOrDefault("VTX_WORKER_MODE", "self-hosted"),
		TrellisURL:  envOrDefault("VTX_WEB_ORIGIN", "https://adp.prod.itgix.eu"),
		WorkerID:    os.Getenv("VTX_WORKER_ID"),
		WorkerToken: os.Getenv("VTX_WORKER_TOKEN"),

		SupabaseS3Endpoint:  envOrDefault("SUPABASE_S3_ENDPOINT", ""),
		SupabaseS3Region:    envOrDefault("SUPABASE_S3_REGION", ""),
		SupabaseS3AccessKey: os.Getenv("SUPABASE_STORAGE_KEY_ID"),
		SupabaseS3SecretKey: os.Getenv("SUPABASE_STORAGE_SECRET_KEY"),
	}

	fmt.Printf("node-worker %s\n", version.Version)

	if cfg.WorkerID == "" || cfg.WorkerToken == "" {
		fmt.Fprintln(os.Stderr, "Error: VTX_WORKER_ID and VTX_WORKER_TOKEN environment variables are required.")
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
