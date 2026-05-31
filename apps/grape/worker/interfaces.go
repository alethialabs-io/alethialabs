package worker

type JobAPI interface {
	ClaimJob() (*ClaimResponse, error)
	UpdateJobStatus(jobID, status, errorMessage string, executionMetadata map[string]any) error
	SendLog(jobID, logChunk, streamType string) error
	Heartbeat() error
	GetJob(jobID string) (*Job, error)
}
