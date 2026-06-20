// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/runner/internal/version"
)

type RunnerAPIClient struct {
	baseURL     string
	runnerID    string
	runnerToken string
	httpClient  *http.Client
}

type Job struct {
	ID                string         `json:"id"`
	UserID            string         `json:"user_id"`
	ZoneID            string         `json:"zone_id"`
	CloudIdentityID   *string        `json:"cloud_identity_id"`
	JobType           string         `json:"job_type"`
	ClusterID         *string        `json:"cluster_id"`
	ConfigurationID   *string        `json:"configuration_id"`
	PlanJobID         *string        `json:"plan_job_id"`
	ConfigSnapshot    map[string]any `json:"config_snapshot"`
	ConfigurationHash *string        `json:"configuration_hash"`
	Status            string         `json:"status"`
	RunnerID          *string        `json:"runner_id"`
	ClaimedAt         *time.Time     `json:"claimed_at"`
	StartedAt         *time.Time     `json:"started_at"`
	CompletedAt       *time.Time     `json:"completed_at"`
	ErrorMessage      *string        `json:"error_message"`
	ExecutionMetadata map[string]any `json:"execution_metadata"`
	CreatedAt         time.Time      `json:"created_at"`
	UpdatedAt         time.Time      `json:"updated_at"`
}

type CloudIdentity struct {
	Provider            string `json:"provider"`
	RoleArn             string `json:"role_arn"`
	ExternalID          string `json:"external_id"`
	AccountID           string `json:"account_id"`
	ProjectID           string `json:"project_id"`
	ServiceAccountEmail string `json:"service_account_email"`
	WifConfig           string `json:"wif_config"`
	TenantID            string `json:"tenant_id"`
	ClientID            string `json:"client_id"`
	SubscriptionID      string `json:"subscription_id"`
}

// IntegrationCredential is a decrypted api_key credential for a pluggable
// provider (Cloudflare, Vault, …), attached at claim time only — never in the
// config_snapshot.
type IntegrationCredential struct {
	Category    string            `json:"category"`
	Slug        string            `json:"slug"`
	Credentials map[string]string `json:"credentials"`
}

type ClaimResponse struct {
	Job                    *Job                    `json:"job"`
	CloudIdentity          *CloudIdentity          `json:"cloud_identity"`
	IntegrationCredentials []IntegrationCredential `json:"integration_credentials"`
}

func NewRunnerAPIClient(baseURL, runnerID, runnerToken string) *RunnerAPIClient {
	return &RunnerAPIClient{
		baseURL:     fmt.Sprintf("%s/api", baseURL),
		runnerID:    runnerID,
		runnerToken: runnerToken,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

func (c *RunnerAPIClient) setRunnerHeaders(req *http.Request) {
	req.Header.Set("X-Runner-ID", c.runnerID)
	req.Header.Set("X-Runner-Token", c.runnerToken)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", fmt.Sprintf("runner/%s", version.Version))
}

func (c *RunnerAPIClient) Heartbeat() error {
	payload, _ := json.Marshal(map[string]string{"version": version.Version})
	req, err := http.NewRequest("POST", c.baseURL+"/runners/heartbeat", bytes.NewBuffer(payload))
	if err != nil {
		return err
	}
	c.setRunnerHeaders(req)

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

func (c *RunnerAPIClient) ClaimJob() (*ClaimResponse, error) {
	req, err := http.NewRequest("POST", c.baseURL+"/jobs/claim", nil)
	if err != nil {
		return nil, err
	}
	c.setRunnerHeaders(req)

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

func (c *RunnerAPIClient) UpdateJobStatus(jobID, status, errorMessage string, executionMetadata map[string]any) error {
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
	c.setRunnerHeaders(req)

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

func (c *RunnerAPIClient) SendLog(jobID, logChunk, streamType string) error {
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
	c.setRunnerHeaders(req)

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

func (c *RunnerAPIClient) UploadPlanArtifact(jobID, filePath string) error {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return fmt.Errorf("failed to read plan file: %w", err)
	}

	req, err := http.NewRequest("POST", fmt.Sprintf("%s/jobs/%s/plan-artifact", c.baseURL, jobID), bytes.NewReader(data))
	if err != nil {
		return err
	}
	c.setRunnerHeaders(req)
	req.Header.Set("Content-Type", "application/octet-stream")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("upload plan artifact failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		return fmt.Errorf("upload plan artifact returned status %d", resp.StatusCode)
	}
	return nil
}

func (c *RunnerAPIClient) DownloadPlanArtifact(jobID, destPath string) error {
	req, err := http.NewRequest("GET", fmt.Sprintf("%s/jobs/%s/plan-artifact", c.baseURL, jobID), nil)
	if err != nil {
		return err
	}
	c.setRunnerHeaders(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("download plan artifact failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return fmt.Errorf("plan artifact not found (expired or missing)")
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download plan artifact returned status %d", resp.StatusCode)
	}

	out, err := os.Create(destPath)
	if err != nil {
		return fmt.Errorf("failed to create dest file: %w", err)
	}
	defer out.Close()

	if _, err := io.Copy(out, resp.Body); err != nil {
		return fmt.Errorf("failed to write plan artifact: %w", err)
	}
	return nil
}

func (c *RunnerAPIClient) FetchGitToken(jobID string) (string, error) {
	req, err := http.NewRequest("POST", fmt.Sprintf("%s/jobs/%s/git-token", c.baseURL, jobID), nil)
	if err != nil {
		return "", err
	}
	c.setRunnerHeaders(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("fetch git token request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("fetch git token returned status %d", resp.StatusCode)
	}

	var result struct {
		Token *string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("failed to decode git token response: %w", err)
	}

	if result.Token == nil {
		return "", nil
	}
	return *result.Token, nil
}

func (c *RunnerAPIClient) UpdateRunnerMetadata(runnerID string, metadata map[string]any) error {
	body, err := json.Marshal(metadata)
	if err != nil {
		return err
	}

	req, err := http.NewRequest("PATCH", fmt.Sprintf("%s/runners/%s/metadata", c.baseURL, runnerID), bytes.NewBuffer(body))
	if err != nil {
		return err
	}
	c.setRunnerHeaders(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("update runner metadata failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("update runner metadata returned status %d", resp.StatusCode)
	}
	return nil
}

func (c *RunnerAPIClient) DeleteRunner(runnerID string) error {
	req, err := http.NewRequest("DELETE", fmt.Sprintf("%s/runners/%s", c.baseURL, runnerID), nil)
	if err != nil {
		return err
	}
	c.setRunnerHeaders(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("delete runner failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("delete runner returned status %d", resp.StatusCode)
	}
	return nil
}

func (c *RunnerAPIClient) GetJob(jobID string) (*Job, error) {
	req, err := http.NewRequest("GET", fmt.Sprintf("%s/jobs/%s", c.baseURL, jobID), nil)
	if err != nil {
		return nil, err
	}
	c.setRunnerHeaders(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("get job request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("get job returned status %d", resp.StatusCode)
	}

	var job Job
	if err := json.NewDecoder(resp.Body).Decode(&job); err != nil {
		return nil, fmt.Errorf("failed to decode job response: %w", err)
	}

	return &job, nil
}
