// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package worker

type JobAPI interface {
	ClaimJob() (*ClaimResponse, error)
	UpdateJobStatus(jobID, status, errorMessage string, executionMetadata map[string]any) error
	SendLog(jobID, logChunk, streamType string) error
	Heartbeat() error
	GetJob(jobID string) (*Job, error)
	FetchGitToken(jobID string) (string, error)
	UploadPlanArtifact(jobID, filePath string) error
	DownloadPlanArtifact(jobID, destPath string) error
	UpdateRunnerMetadata(runnerID string, metadata map[string]any) error
	DeleteRunner(runnerID string) error
}
