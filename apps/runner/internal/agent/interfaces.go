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
	SendLog(jobID, logChunk, streamType, traceparent string) error
	Heartbeat() error
	GetJob(jobID string) (*Job, error)
	FetchGitToken(jobID string) (string, error)
	// FetchStateToken mints the per-job tofu-state token for the http state backend;
	// PurgeProjectState removes the state object after a successful destroy.
	FetchStateToken(jobID string) (string, error)
	PurgeProjectState(jobID, stateToken string) error
	// The cloud-token mints are bound to the job they provision for (the console
	// authorizes ownership + live + provider), so each carries the jobID.
	FetchAzureToken(jobID string) (string, error)
	FetchAwsToken(jobID string) (*AwsFederation, error)
	FetchAlibabaToken(jobID string) (string, error)
	FetchGcpToken(jobID string) (string, error)
	UploadPlanArtifact(jobID, filePath string) error
	DownloadPlanArtifact(jobID, destPath string) error
	UpdateRunnerMetadata(runnerID string, metadata map[string]any) error
	DeleteRunner(runnerID string) error
}
