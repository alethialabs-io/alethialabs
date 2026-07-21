// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package utils

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

// Logger provides logging to both the console and the API.
type Logger struct {
	apiClient    *api.Client
	deploymentID string
}

// NewLogger creates a new Logger.
func NewLogger(apiClient *api.Client, deploymentID string) *Logger {
	return &Logger{
		apiClient:    apiClient,
		deploymentID: deploymentID,
	}
}

// Info logs an informational message.
func (l *Logger) Info(message, step string) {
	fmt.Println(message)
	if l.apiClient != nil {
		_ = l.apiClient.SendLog(l.deploymentID, api.LogEntry{Message: message, Level: "info", Step: step})
	}
}

// Warn logs a warning message.
func (l *Logger) Warn(message, step string) {
	fmt.Printf("Warning: %s\n", message)
	if l.apiClient != nil {
		_ = l.apiClient.SendLog(l.deploymentID, api.LogEntry{Message: message, Level: "warn", Step: step})
	}
}

// Error logs an error message.
func (l *Logger) Error(message, step string) {
	fmt.Printf("Error: %s\n", message)
	if l.apiClient != nil {
		_ = l.apiClient.SendLog(l.deploymentID, api.LogEntry{Message: message, Level: "error", Step: step})
	}
}

func CheckDependencies(commands ...string) error {
	var missing []string

	for _, command := range commands {
		if _, err := exec.LookPath(command); err != nil {
			missing = append(missing, command)
		}
	}

	if len(missing) == 0 {
		return nil
	}

	return fmt.Errorf(
		"missing required command(s): %s\nInstall the missing tools and make sure they are available in your PATH before retrying",
		strings.Join(missing, ", "),
	)
}

// ShellQuote wraps s in single quotes so it can be interpolated into a command string built
// for ExecuteCommand / ExecuteCommandWithOutput (which run it via `bash -c`) without any shell
// metacharacter in s being interpreted — closing the command-injection surface. Embedded single
// quotes are escaped with the standard `'\”` idiom. Prefer passing values as discrete argv
// elements where a shell isn't actually needed; use this only when the shell string is unavoidable.
func ShellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func ExecuteCommand(command string, dir string, env []string, outWriter, errWriter io.Writer) error {
	cmd := exec.Command("bash", "-c", command)
	cmd.Dir = dir
	cmd.Env = os.Environ()            // Start with current environment
	cmd.Env = append(cmd.Env, env...) // Add custom environment variables

	if outWriter == nil {
		outWriter = os.Stdout
	}
	if errWriter == nil {
		errWriter = os.Stderr
	}

	cmd.Stdout = outWriter
	cmd.Stderr = errWriter

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("error starting command: %w", err)
	}

	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("command returned non-zero exit code: %w", err)
	}

	return nil
}

func ExecuteCommandWithOutput(command string, dir string, env []string) (string, error) {
	cmd := exec.Command("bash", "-c", command)
	cmd.Dir = dir
	cmd.Env = os.Environ()            // Start with current environment
	cmd.Env = append(cmd.Env, env...) // Add custom environment variables

	var stdoutBuf, stderrBuf bytes.Buffer
	cmd.Stdout = &stdoutBuf
	cmd.Stderr = &stderrBuf

	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("command failed: %w, stderr: %s", err, stderrBuf.String())
	}

	return stdoutBuf.String(), nil
}
