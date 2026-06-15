// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
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
	UpdateWorkerMetadata(workerID string, metadata map[string]any) error
	DeleteWorker(workerID string) error
}
