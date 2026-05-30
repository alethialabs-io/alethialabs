package worker

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

type WorkerAPIClient struct {
	baseURL    string
	workerID   string
	workerToken string
	httpClient *http.Client
}

type Job struct {
	ID                string                 `json:"id"`
	UserID            string                 `json:"user_id"`
	VineyardID        string                 `json:"vineyard_id"`
	CloudIdentityID   *string                `json:"cloud_identity_id"`
	JobType           string                 `json:"job_type"`
	ClusterID         *string                `json:"cluster_id"`
	ConfigurationID   *string                `json:"configuration_id"`
	ConfigSnapshot    map[string]any         `json:"config_snapshot"`
	ConfigurationHash *string                `json:"configuration_hash"`
	Status            string                 `json:"status"`
	WorkerID          *string                `json:"worker_id"`
	ClaimedAt         *time.Time             `json:"claimed_at"`
	StartedAt         *time.Time             `json:"started_at"`
	CompletedAt       *time.Time             `json:"completed_at"`
	ErrorMessage      *string                `json:"error_message"`
	ExecutionMetadata map[string]any         `json:"execution_metadata"`
	CreatedAt         time.Time              `json:"created_at"`
	UpdatedAt         time.Time              `json:"updated_at"`
}

type CloudIdentity struct {
	Provider            string `json:"provider"`
	RoleArn             string `json:"role_arn"`
	ExternalID          string `json:"external_id"`
	AccountID           string `json:"account_id"`
	ProjectID           string `json:"project_id"`
	ServiceAccountEmail string `json:"service_account_email"`
	WifConfig           string `json:"wif_config"`
}

type ClaimResponse struct {
	Job           *Job           `json:"job"`
	CloudIdentity *CloudIdentity `json:"cloud_identity"`
}

func NewWorkerAPIClient(baseURL, workerID, workerToken string) *WorkerAPIClient {
	return &WorkerAPIClient{
		baseURL:     fmt.Sprintf("%s/api", baseURL),
		workerID:    workerID,
		workerToken: workerToken,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

func (c *WorkerAPIClient) setWorkerHeaders(req *http.Request) {
	req.Header.Set("X-Worker-ID", c.workerID)
	req.Header.Set("X-Worker-Token", c.workerToken)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "grape-worker/1.0")
	req.Header.Set("ngrok-skip-browser-warning", "true")
}

func (c *WorkerAPIClient) Heartbeat() error {
	req, err := http.NewRequest("POST", c.baseURL+"/workers/heartbeat", nil)
	if err != nil {
		return err
	}
	c.setWorkerHeaders(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("heartbeat request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("heartbeat returned status %d", resp.StatusCode)
	}
	return nil
}

func (c *WorkerAPIClient) ClaimJob() (*ClaimResponse, error) {
	req, err := http.NewRequest("POST", c.baseURL+"/jobs/claim", nil)
	if err != nil {
		return nil, err
	}
	c.setWorkerHeaders(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("claim request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("claim returned status %d", resp.StatusCode)
	}

	var result ClaimResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode claim response: %w", err)
	}

	return &result, nil
}

func (c *WorkerAPIClient) UpdateJobStatus(jobID, status, errorMessage string, executionMetadata map[string]any) error {
	payload := map[string]any{
		"status": status,
	}
	if errorMessage != "" {
		payload["error_message"] = errorMessage
	}
	if executionMetadata != nil {
		payload["execution_metadata"] = executionMetadata
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	req, err := http.NewRequest("PUT", fmt.Sprintf("%s/jobs/%s/status", c.baseURL, jobID), bytes.NewBuffer(body))
	if err != nil {
		return err
	}
	c.setWorkerHeaders(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("update status request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("update status returned status %d", resp.StatusCode)
	}
	return nil
}

func (c *WorkerAPIClient) SendLog(jobID, logChunk, streamType string) error {
	payload := map[string]string{
		"log_chunk":   logChunk,
		"stream_type": streamType,
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	req, err := http.NewRequest("POST", fmt.Sprintf("%s/jobs/%s/logs", c.baseURL, jobID), bytes.NewBuffer(body))
	if err != nil {
		return err
	}
	c.setWorkerHeaders(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("send log request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return fmt.Errorf("send log returned status %d", resp.StatusCode)
	}
	return nil
}
