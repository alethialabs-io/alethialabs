package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"

	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/worker"
	"github.com/spf13/cobra"
)

var (
	workerMode  string
	workerToken string
	workerID    string
)

var workerCmd = &cobra.Command{
	Use:   "worker",
	Short: "Run Grape as a provisioning worker",
	Long: `Worker mode turns Grape into a headless provisioning daemon.
It polls Trellis for queued jobs and executes them autonomously.

  Self-hosted:   Worker runs in the customer's AWS account with native permissions.
  Cloud-hosted:  Worker runs in Grape's account and assumes a role into the customer's account.`,
}

var workerStartCmd = &cobra.Command{
	Use:   "start",
	Short: "Start the worker poll loop",
	Run: func(cmd *cobra.Command, args []string) {
		cfg := worker.Config{
			Mode:        envOrFlag(workerMode, "GRAPE_WORKER_MODE", "self-hosted"),
			TrellisURL:  envOrFlag("", "GRAPE_WEB_ORIGIN", "https://adp.prod.itgix.eu"),
			WorkerID:    envOrFlag(workerID, "GRAPE_WORKER_ID", ""),
			WorkerToken: envOrFlag(workerToken, "GRAPE_WORKER_TOKEN", ""),
		}

		if cfg.WorkerID == "" || cfg.WorkerToken == "" {
			fmt.Println("Error: worker-id and worker-token are required.")
			fmt.Println("Set via flags (--worker-id, --worker-token) or env vars (GRAPE_WORKER_ID, GRAPE_WORKER_TOKEN)")
			os.Exit(1)
		}

		w := worker.New(cfg)
		if err := w.Run(context.Background()); err != nil {
			fmt.Printf("Worker error: %v\n", err)
			os.Exit(1)
		}
	},
}

var workerRegisterCmd = &cobra.Command{
	Use:   "register",
	Short: "Register a new worker with Trellis",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

		webOrigin := os.Getenv("GRAPE_WEB_ORIGIN")
		if webOrigin == "" {
			webOrigin = "https://adp.prod.itgix.eu"
		}

		name, _ := cmd.Flags().GetString("name")
		mode, _ := cmd.Flags().GetString("mode")

		if name == "" {
			hostname, _ := os.Hostname()
			name = fmt.Sprintf("worker-%s", hostname)
		}

		payload, _ := json.Marshal(map[string]string{"name": name, "mode": mode})
		req, err := http.NewRequest("POST", fmt.Sprintf("%s/api/workers/register", webOrigin), bytes.NewBuffer(payload))
		if err != nil {
			fmt.Printf("Error: %v\n", err)
			os.Exit(1)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", token))

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			fmt.Printf("Error registering worker: %v\n", err)
			os.Exit(1)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusCreated {
			var errResp struct {
				Error string `json:"error"`
			}
			json.NewDecoder(resp.Body).Decode(&errResp)
			fmt.Printf("Error registering worker: %s\n", errResp.Error)
			os.Exit(1)
		}

		var result struct {
			Worker struct {
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"worker"`
			WorkerToken string `json:"worker_token"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
			fmt.Printf("Error decoding response: %v\n", err)
			os.Exit(1)
		}

		fmt.Println("Worker registered successfully!")
		fmt.Printf("  Worker ID:    %s\n", result.Worker.ID)
		fmt.Printf("  Worker Token: %s\n", result.WorkerToken)
		fmt.Println()
		fmt.Println("Save these values - the token cannot be recovered.")
		fmt.Println()
		fmt.Println("Start the worker with:")
		fmt.Printf("  grape worker start --worker-id=%s --worker-token=%s\n", result.Worker.ID, result.WorkerToken)
		fmt.Println()
		fmt.Println("Or set environment variables:")
		fmt.Printf("  export GRAPE_WORKER_ID=%s\n", result.Worker.ID)
		fmt.Printf("  export GRAPE_WORKER_TOKEN=%s\n", result.WorkerToken)
		fmt.Println("  grape worker start")
	},
}

func init() {
	rootCmd.AddCommand(workerCmd)
	workerCmd.AddCommand(workerStartCmd)
	workerCmd.AddCommand(workerRegisterCmd)

	workerStartCmd.Flags().StringVar(&workerMode, "mode", "", "Worker mode: self-hosted or cloud-hosted (env: GRAPE_WORKER_MODE)")
	workerStartCmd.Flags().StringVar(&workerID, "worker-id", "", "Worker ID from registration (env: GRAPE_WORKER_ID)")
	workerStartCmd.Flags().StringVar(&workerToken, "worker-token", "", "Worker token from registration (env: GRAPE_WORKER_TOKEN)")

	workerRegisterCmd.Flags().String("name", "", "Human-readable worker name")
	workerRegisterCmd.Flags().String("mode", "self-hosted", "Worker mode: self-hosted or cloud-hosted")
}

func envOrFlag(flag, envKey, defaultVal string) string {
	if flag != "" {
		return flag
	}
	if v := os.Getenv(envKey); v != "" {
		return v
	}
	return defaultVal
}
