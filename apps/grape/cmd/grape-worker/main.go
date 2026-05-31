package main

import (
	"context"
	"fmt"
	"os"

	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/worker"
)

func main() {
	cfg := worker.Config{
		Mode:        envOrDefault("GRAPE_WORKER_MODE", "self-hosted"),
		TrellisURL:  envOrDefault("GRAPE_WEB_ORIGIN", "https://adp.prod.itgix.eu"),
		WorkerID:    os.Getenv("GRAPE_WORKER_ID"),
		WorkerToken: os.Getenv("GRAPE_WORKER_TOKEN"),
	}

	if cfg.WorkerID == "" || cfg.WorkerToken == "" {
		fmt.Fprintln(os.Stderr, "Error: GRAPE_WORKER_ID and GRAPE_WORKER_TOKEN environment variables are required.")
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
