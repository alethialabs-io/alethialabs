// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import "context"

type JobAPI interface {
	ClaimJob() (*ClaimResponse, error)
	// StreamWake holds the push-dispatch SSE connection, calling onWake per wake
	// event; blocks until the stream ends or ctx is cancelled.
	StreamWake(ctx context.Context, onWake func()) error
	UpdateJobStatus(jobID, status, errorMessage string, executionMetadata map[string]any) error
	SendLog(jobID, logChunk, streamType string) error
	Heartbeat() error
	GetJob(jobID string) (*Job, error)
	FetchGitToken(jobID string) (string, error)
	FetchAzureToken() (string, error)
	UploadPlanArtifact(jobID, filePath string) error
	DownloadPlanArtifact(jobID, destPath string) error
	UpdateRunnerMetadata(runnerID string, metadata map[string]any) error
	DeleteRunner(runnerID string) error
}
