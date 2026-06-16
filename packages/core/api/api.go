// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

type Client struct {
	baseURL    string
	authToken  string
	httpClient *http.Client
}

func NewClient(authToken string) *Client {
	webOrigin := os.Getenv("ALETHIA_WEB_ORIGIN")
	if webOrigin == "" {
		webOrigin = "https://adp.prod.itgix.eu"
	}
	return &Client{
		baseURL:    fmt.Sprintf("%s/api", webOrigin),
		authToken:  authToken,
		httpClient: &http.Client{},
	}
}

// --- Types ---

type Repository struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	FullName      string `json:"full_name"`
	URL           string `json:"url"`
	Private       bool   `json:"private"`
	DefaultBranch string `json:"default_branch"`
	Provider      string `json:"provider"`
}

type ConfigurationExport struct {
	Content  string `json:"content"`
	Filename string `json:"filename"`
	Format   string `json:"format"`
}

type ProvisionJob struct {
	ID                string                  `json:"id"`
	JobType           string                  `json:"job_type"`
	VineyardID        string                  `json:"vineyard_id"`
	ConfigurationID   string                  `json:"configuration_id,omitempty"`
	VineID            string                  `json:"vine_id,omitempty"`
	CloudIdentityID   string                  `json:"cloud_identity_id,omitempty"`
	WorkerID          string                  `json:"worker_id,omitempty"`
	AssignedWorkerID  string                  `json:"assigned_worker_id,omitempty"`
	PlanJobID         string                  `json:"plan_job_id,omitempty"`
	Status            string                  `json:"status"`
	ErrorMessage      *string                 `json:"error_message,omitempty"`
	ExecutionMetadata *map[string]interface{} `json:"execution_metadata,omitempty"`
	ConfigSnapshot    map[string]interface{}  `json:"config_snapshot,omitempty"`
	CreatedAt         time.Time               `json:"created_at"`
	StartedAt         *time.Time              `json:"started_at,omitempty"`
	CompletedAt       *time.Time              `json:"completed_at,omitempty"`
	VineName          string                  `json:"vine_name,omitempty"`
	WorkerName        string                  `json:"worker_name,omitempty"`
}

type JobsPage struct {
	Jobs   []ProvisionJob `json:"jobs"`
	Total  int            `json:"total"`
	Limit  int            `json:"limit"`
	Offset int            `json:"offset"`
}

type JobLog struct {
	ID         int       `json:"id"`
	JobID      string    `json:"job_id"`
	LogChunk   string    `json:"log_chunk"`
	StreamType string    `json:"stream_type"`
	CreatedAt  time.Time `json:"created_at"`
}

type Worker struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	Mode          string    `json:"mode"`
	Status        string    `json:"status"`
	LastHeartbeat string    `json:"last_heartbeat"`
	Version       string    `json:"version"`
	IsDefault     bool      `json:"is_default"`
	CreatedAt     time.Time `json:"created_at"`
}

type VineCluster struct {
	ID                 string   `json:"id"`
	ClusterName        string   `json:"cluster_name"`
	ClusterVersion     string   `json:"cluster_version"`
	InstanceTypes      []string `json:"instance_types"`
	NodeMinSize        int      `json:"node_min_size"`
	NodeMaxSize        int      `json:"node_max_size"`
	NodeDesiredSize    int      `json:"node_desired_size"`
	Status             string   `json:"status"`
	StatusMessage      string   `json:"status_message"`
	ArgocdURL          string   `json:"argocd_url"`
	EstimatedMonthlyCost *float64 `json:"estimated_monthly_cost"`
	CreatedAt          string   `json:"created_at"`
	UpdatedAt          string   `json:"updated_at"`
	VineProjectName    string   `json:"vine_project_name"`
	VineEnvironment    string   `json:"vine_environment"`
	VineRegion         string   `json:"vine_region"`
}

type CloudIdentity struct {
	ID        string `json:"id"`
	Provider  string `json:"provider"`
	Label     string `json:"label"`
	CreatedAt string `json:"created_at"`
}

type DeployTendrilResponse struct {
	Tendril struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"tendril"`
	Job struct {
		ID        string `json:"id"`
		Status    string `json:"status"`
		CreatedAt string `json:"created_at"`
	} `json:"job"`
}

type QueueJobParams struct {
	JobType          string
	VineyardID       string
	ConfigurationID  string
	CloudIdentityID  string
	AssignedWorkerID string
	PlanJobID        string
	ConfigSnapshot   map[string]interface{}
}

// --- Helpers ---

func (c *Client) getProviderToken() string {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	credsPath := filepath.Join(configDir, "alethia", "credentials.json")
	file, err := os.ReadFile(credsPath)
	if err != nil {
		return ""
	}
	var creds types.ExchangeResponse
	if err := json.Unmarshal(file, &creds); err != nil {
		return ""
	}
	return creds.ProviderToken
}

func (c *Client) doGet(endpoint string, result interface{}) error {
	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var errorResp struct {
			Error string `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&errorResp); err != nil {
			return fmt.Errorf("request failed: status code %d", resp.StatusCode)
		}
		return fmt.Errorf("%s", errorResp.Error)
	}

	return json.NewDecoder(resp.Body).Decode(result)
}

func (c *Client) doPost(endpoint string, payload interface{}, result interface{}) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal request body: %w", err)
	}

	req, err := http.NewRequest("POST", endpoint, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		var errorResp struct {
			Error string `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&errorResp); err != nil {
			return fmt.Errorf("request failed: status code %d", resp.StatusCode)
		}
		return fmt.Errorf("%s", errorResp.Error)
	}

	if result != nil {
		return json.NewDecoder(resp.Body).Decode(result)
	}
	return nil
}

func (c *Client) doDelete(endpoint string) error {
	req, err := http.NewRequest("DELETE", endpoint, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var errorResp struct {
			Error string `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&errorResp); err != nil {
			return fmt.Errorf("request failed: status code %d", resp.StatusCode)
		}
		return fmt.Errorf("%s", errorResp.Error)
	}
	return nil
}

// --- Repositories ---

func (c *Client) GetRepositories(provider string) ([]Repository, error) {
	endpoint := fmt.Sprintf("%s/cli/repositories/%s", c.baseURL, provider)

	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))
	if providerToken := c.getProviderToken(); providerToken != "" {
		req.Header.Set("X-Provider-Token", providerToken)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var errorResp struct {
			Error string `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&errorResp); err != nil {
			return nil, fmt.Errorf("failed to get repositories: status code %d", resp.StatusCode)
		}
		return nil, fmt.Errorf("failed to get repositories: %s", errorResp.Error)
	}

	var successResp struct {
		Repositories []Repository `json:"repositories"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&successResp); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return successResp.Repositories, nil
}

// --- Configurations (Vines) ---

func (c *Client) GetConfiguration(projectName string) (*types.Configuration, error) {
	var successResp struct {
		Configuration *types.Configuration `json:"configuration"`
	}
	endpoint := fmt.Sprintf("%s/cli/configurations/by-project-name/%s", c.baseURL, projectName)
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to get configuration: %w", err)
	}
	return successResp.Configuration, nil
}

func (c *Client) ExportConfiguration(projectName, format string) (*ConfigurationExport, error) {
	if format == "" {
		format = "legacy-yaml"
	}
	endpoint := fmt.Sprintf(
		"%s/cli/configurations/by-project-name/%s/export?format=%s",
		c.baseURL, url.PathEscape(projectName), url.QueryEscape(format),
	)
	var export ConfigurationExport
	if err := c.doGet(endpoint, &export); err != nil {
		return nil, fmt.Errorf("failed to export configuration: %w", err)
	}
	return &export, nil
}

// --- Jobs ---

func (c *Client) QueueJobWithParams(params QueueJobParams) (*ProvisionJob, error) {
	endpoint := fmt.Sprintf("%s/jobs", c.baseURL)
	payload := map[string]interface{}{
		"job_type":    params.JobType,
		"vineyard_id": params.VineyardID,
	}
	if params.ConfigurationID != "" {
		payload["configuration_id"] = params.ConfigurationID
	}
	if params.CloudIdentityID != "" {
		payload["cloud_identity_id"] = params.CloudIdentityID
	}
	if params.AssignedWorkerID != "" {
		payload["assigned_worker_id"] = params.AssignedWorkerID
	}
	if params.PlanJobID != "" {
		payload["plan_job_id"] = params.PlanJobID
	}
	if params.ConfigSnapshot != nil {
		payload["config_snapshot"] = params.ConfigSnapshot
	}

	var successResp struct {
		Job *ProvisionJob `json:"job"`
	}
	if err := c.doPost(endpoint, payload, &successResp); err != nil {
		return nil, fmt.Errorf("failed to queue job: %w", err)
	}
	return successResp.Job, nil
}

func (c *Client) GetJobs(status, vineyardID string, limit, offset int) (*JobsPage, error) {
	endpoint := fmt.Sprintf("%s/jobs", c.baseURL)
	params := url.Values{}
	if status != "" {
		params.Set("status", status)
	}
	if vineyardID != "" {
		params.Set("vineyard_id", vineyardID)
	}
	if limit > 0 {
		params.Set("limit", fmt.Sprintf("%d", limit))
	}
	if offset > 0 {
		params.Set("offset", fmt.Sprintf("%d", offset))
	}
	if len(params) > 0 {
		endpoint = fmt.Sprintf("%s?%s", endpoint, params.Encode())
	}

	var page JobsPage
	if err := c.doGet(endpoint, &page); err != nil {
		return nil, fmt.Errorf("failed to get jobs: %w", err)
	}
	return &page, nil
}

func (c *Client) GetJob(jobID string) (*ProvisionJob, error) {
	endpoint := fmt.Sprintf("%s/cli/jobs/%s", c.baseURL, jobID)
	var job ProvisionJob
	if err := c.doGet(endpoint, &job); err != nil {
		return nil, fmt.Errorf("failed to get job: %w", err)
	}
	return &job, nil
}

func (c *Client) GetJobLogs(jobID string, afterID int) ([]JobLog, error) {
	endpoint := fmt.Sprintf("%s/cli/jobs/%s/logs", c.baseURL, jobID)
	if afterID > 0 {
		endpoint = fmt.Sprintf("%s?after=%d", endpoint, afterID)
	}

	var successResp struct {
		Logs []JobLog `json:"logs"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to get job logs: %w", err)
	}
	return successResp.Logs, nil
}

func (c *Client) CancelJob(jobID string) error {
	endpoint := fmt.Sprintf("%s/cli/jobs/%s/cancel", c.baseURL, jobID)
	return c.doPost(endpoint, nil, nil)
}

// --- Workers (Tendrils) ---

func (c *Client) GetWorkers() ([]Worker, error) {
	endpoint := fmt.Sprintf("%s/cli/workers", c.baseURL)
	var successResp struct {
		Workers []Worker `json:"workers"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to get tendrils: %w", err)
	}
	return successResp.Workers, nil
}

func (c *Client) RemoveWorker(workerID string) error {
	endpoint := fmt.Sprintf("%s/cli/workers/%s", c.baseURL, workerID)
	if err := c.doDelete(endpoint); err != nil {
		return fmt.Errorf("failed to remove tendril: %w", err)
	}
	return nil
}

func (c *Client) DeployTendril(name, cloudIdentityID, region, assignedWorkerID string) (*DeployTendrilResponse, error) {
	endpoint := fmt.Sprintf("%s/cli/tendrils/deploy", c.baseURL)
	payload := map[string]string{
		"name":              name,
		"cloud_identity_id": cloudIdentityID,
		"region":            region,
	}
	if assignedWorkerID != "" {
		payload["assigned_worker_id"] = assignedWorkerID
	}

	var resp DeployTendrilResponse
	if err := c.doPost(endpoint, payload, &resp); err != nil {
		return nil, fmt.Errorf("failed to deploy tendril: %w", err)
	}
	return &resp, nil
}

// --- Clusters (Vine Clusters) ---

func (c *Client) GetVineClusters() ([]VineCluster, error) {
	endpoint := fmt.Sprintf("%s/cli/clusters", c.baseURL)
	var successResp struct {
		Clusters []VineCluster `json:"clusters"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to get clusters: %w", err)
	}
	return successResp.Clusters, nil
}

// --- Legacy (used by core/utils) ---

type LogEntry struct {
	Message string `json:"message"`
	Level   string `json:"level"`
	Step    string `json:"step,omitempty"`
}

func (c *Client) SendLog(deploymentID string, log LogEntry) error {
	endpoint := fmt.Sprintf("%s/deployments/%s/logs", c.baseURL, deploymentID)
	return c.doPost(endpoint, log, nil)
}

type BootstrapJob struct {
	ID           string    `json:"id"`
	VineyardID   string    `json:"vineyard_id"`
	Status       string    `json:"status"`
	ErrorMessage *string   `json:"error_message,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
}

func (c *Client) CreateBootstrapJob(vineyardID string) (*BootstrapJob, error) {
	endpoint := fmt.Sprintf("%s/cli/bootstrap-jobs", c.baseURL)
	payload := map[string]string{"vineyard_id": vineyardID}
	var successResp struct {
		Job *BootstrapJob `json:"job"`
	}
	if err := c.doPost(endpoint, payload, &successResp); err != nil {
		return nil, fmt.Errorf("failed to create bootstrap job: %w", err)
	}
	return successResp.Job, nil
}

func (c *Client) UpdateBootstrapJobStatus(jobID, status, errorMessage string) error {
	endpoint := fmt.Sprintf("%s/cli/bootstrap-jobs/%s", c.baseURL, jobID)
	payload := map[string]string{"status": status}
	if errorMessage != "" {
		payload["error_message"] = errorMessage
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequest("PUT", endpoint, bytes.NewBuffer(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("failed to update bootstrap job: status %d", resp.StatusCode)
	}
	return nil
}

type ClusterRegistrationResponse struct {
	ClusterID  string `json:"cluster_id"`
	AgentToken string `json:"agent_token"`
}

func (c *Client) RegisterCluster(name, vpcID, vpcCidr, region, vineyardID string) (*ClusterRegistrationResponse, error) {
	endpoint := fmt.Sprintf("%s/cli/clusters", c.baseURL)
	payload := map[string]string{
		"name": name, "vpc_id": vpcID, "vpc_cidr": vpcCidr,
		"region": region, "vineyard_id": vineyardID,
	}
	var resp ClusterRegistrationResponse
	if err := c.doPost(endpoint, payload, &resp); err != nil {
		return nil, fmt.Errorf("failed to register cluster: %w", err)
	}
	return &resp, nil
}

func (c *Client) UnregisterCluster(id, name string) error {
	endpoint := fmt.Sprintf("%s/cli/clusters", c.baseURL)
	req, err := http.NewRequest("DELETE", endpoint, nil)
	if err != nil {
		return err
	}
	q := req.URL.Query()
	if id != "" {
		q.Add("id", id)
	}
	if name != "" {
		q.Add("name", name)
	}
	req.URL.RawQuery = q.Encode()
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("failed to unregister cluster: status %d", resp.StatusCode)
	}
	return nil
}

func (c *Client) SendBootstrapLog(jobID string, logChunk string, streamType string) error {
	endpoint := fmt.Sprintf("%s/cli/bootstrap-jobs/%s/logs", c.baseURL, jobID)
	payload := map[string]string{
		"log_chunk":   logChunk,
		"stream_type": streamType,
	}
	return c.doPost(endpoint, payload, nil)
}

// --- Cloud Identities ---

func (c *Client) GetCloudIdentities() ([]CloudIdentity, error) {
	endpoint := fmt.Sprintf("%s/cli/cloud-identities", c.baseURL)
	var successResp struct {
		CloudIdentities []CloudIdentity `json:"cloud_identities"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to get cloud identities: %w", err)
	}
	return successResp.CloudIdentities, nil
}
