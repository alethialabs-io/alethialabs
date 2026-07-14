// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import "context"

type JobAPI interface {
	ClaimJob() (*ClaimResponse, error)
	// StreamWake holds the push-dispatch SSE connection, calling onEvent per typed
	// event (wake / cancel); blocks until the stream ends or ctx is cancelled.
	StreamWake(ctx context.Context, onEvent func(WakeEvent)) error
	UpdateJobStatus(jobID, status, errorMessage string, executionMetadata map[string]any) error
	SendLog(jobID, logChunk, streamType, traceparent string) error
	// Heartbeat reports liveness and returns this runner's server-side-cancelled job ids, so a
	// cancel missed on the wake stream (SSE disconnected at notify time) is still delivered.
	Heartbeat() ([]string, error)
	GetJob(jobID string) (*Job, error)
	FetchGitToken(jobID, repoURL string) (string, error)
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
