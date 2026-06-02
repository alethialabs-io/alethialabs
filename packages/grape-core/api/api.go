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

	"github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/types"
)

// Client represents the API client.
type Client struct {
	baseURL    string
	authToken  string
	httpClient *http.Client
}

// NewClient creates a new API client.
func NewClient(authToken string) *Client {
	webOrigin := os.Getenv("GRAPE_WEB_ORIGIN")
	if webOrigin == "" {
		webOrigin = "https://adp.prod.itgix.eu" // Default to localhost for development
	}
	return &Client{
		baseURL:    fmt.Sprintf("%s/api", webOrigin),
		authToken:  authToken,
		httpClient: &http.Client{},
	}
}

// Repository represents the structure of a repository for the API.
type Repository struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	FullName      string `json:"full_name"`
	URL           string `json:"url"`
	Private       bool   `json:"private"`
	DefaultBranch string `json:"default_branch"`
	Provider      string `json:"provider"`
}

// Deployment represents the structure of a deployment for the API.
type Deployment struct {
	ID               string    `json:"id"`
	ConfigurationID  string    `json:"configuration_id"`
	Name             string    `json:"name"`
	Status           string    `json:"status"`
	IacTool          string    `json:"iac_tool"`
	TerraformVersion string    `json:"terraform_version,omitempty"`
	CreatedAt        time.Time `json:"created_at"`
}

// LogEntry represents the structure of a log entry for the API.
type LogEntry struct {
	Message string `json:"message"`
	Level   string `json:"level"`
	Step    string `json:"step,omitempty"`
}

type ConfigurationExport struct {
	Content  string `json:"content"`
	Filename string `json:"filename"`
	Format   string `json:"format"`
}

// CreateRepository creates a new repository.
func (c *Client) CreateRepository(provider, name, workspace, projectKey string) (*Repository, error) {
	if provider != "github" && provider != "gitlab" && provider != "bitbucket" {
		return nil, fmt.Errorf("unsupported git provider: %s", provider)
	}

	endpoint := fmt.Sprintf("%s/repositories/%s", c.baseURL, provider)
	payload := map[string]string{
		"name": name,
	}

	if provider == "bitbucket" {
		payload["workspace"] = workspace
		payload["projectKey"] = projectKey
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request body: %w", err)
	}

	req, err := http.NewRequest("POST", endpoint, bytes.NewBuffer(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		var errorResp struct {
			Error string `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&errorResp); err != nil {
			return nil, fmt.Errorf("failed to create repository: status code %d", resp.StatusCode)
		}
		return nil, fmt.Errorf("failed to create repository: %s", errorResp.Error)
	}

	var successResp struct {
		Repository *Repository `json:"repository"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&successResp); err != nil {
		return nil, fmt.Errorf("failed to decode successful response: %w", err)
	}

	return successResp.Repository, nil
}

// GetRepositories fetches repositories for a given provider.
func (c *Client) GetRepositories(provider string) ([]Repository, error) {
	endpoint := fmt.Sprintf("%s/cli/repositories/%s", c.baseURL, provider)
	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))

	// Attempt to get provider token if available
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
		return nil, fmt.Errorf("failed to decode successful response: %w", err)
	}

	return successResp.Repositories, nil
}

func (c *Client) getProviderToken() string {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	credsPath := filepath.Join(configDir, "grape", "credentials.json")
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

// GetConfiguration fetches a configuration by project name.
func (c *Client) GetConfiguration(projectName string) (*types.Configuration, error) {
	endpoint := fmt.Sprintf("%s/cli/configurations/by-project-name/%s", c.baseURL, projectName)
	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))

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
			return nil, fmt.Errorf("failed to get configuration: status code %d", resp.StatusCode)
		}
		return nil, fmt.Errorf("failed to get configuration: %s", errorResp.Error)
	}

	var successResp struct {
		Configuration *types.Configuration `json:"configuration"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&successResp); err != nil {
		return nil, fmt.Errorf("failed to decode successful response: %w", err)
	}

	return successResp.Configuration, nil
}

func (c *Client) ExportConfiguration(projectName, format string) (*ConfigurationExport, error) {
	if format == "" {
		format = "legacy-yaml"
	}

	endpoint := fmt.Sprintf(
		"%s/cli/configurations/by-project-name/%s/export?format=%s",
		c.baseURL,
		url.PathEscape(projectName),
		url.QueryEscape(format),
	)
	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))

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
			return nil, fmt.Errorf("failed to export configuration: status code %d", resp.StatusCode)
		}
		return nil, fmt.Errorf("failed to export configuration: %s", errorResp.Error)
	}

	var export ConfigurationExport
	if err := json.NewDecoder(resp.Body).Decode(&export); err != nil {
		return nil, fmt.Errorf("failed to decode export response: %w", err)
	}

	return &export, nil
}

// CreateConfiguration creates a new configuration.
func (c *Client) CreateConfiguration(config types.Configuration) (*types.Configuration, error) {
	endpoint := fmt.Sprintf("%s/configurations", c.baseURL)
	body, err := json.Marshal(config)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request body: %w", err)
	}

	req, err := http.NewRequest("POST", endpoint, bytes.NewBuffer(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		var errorResp struct {
			Error string `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&errorResp); err != nil {
			return nil, fmt.Errorf("failed to create configuration: status code %d", resp.StatusCode)
		}
		return nil, fmt.Errorf("failed to create configuration: %s", errorResp.Error)
	}

	var successResp struct {
		Configuration *types.Configuration `json:"configuration"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&successResp); err != nil {
		return nil, fmt.Errorf("failed to decode successful response: %w", err)
	}

	return successResp.Configuration, nil
}

// CreateDeployment creates a new deployment record.
func (c *Client) CreateDeployment(configID, name, iacTool, tfVersion string) (*Deployment, error) {
	endpoint := fmt.Sprintf("%s/deployments", c.baseURL)
	payload := map[string]string{
		"configuration_id":  configID,
		"name":              name,
		"iac_tool":          iacTool,
		"terraform_version": tfVersion,
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request body: %w", err)
	}

	req, err := http.NewRequest("POST", endpoint, bytes.NewBuffer(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		var errorResp struct {
			Error string `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&errorResp); err != nil {
			return nil, fmt.Errorf("failed to create deployment: status code %d", resp.StatusCode)
		}
		return nil, fmt.Errorf("failed to create deployment: %s", errorResp.Error)
	}

	var successResp struct {
		Deployment *Deployment `json:"deployment"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&successResp); err != nil {
		return nil, fmt.Errorf("failed to decode successful response: %w", err)
	}

	return successResp.Deployment, nil
}

// UpdateDeploymentStatus updates the status of a deployment.
func (c *Client) UpdateDeploymentStatus(deploymentID, status, errorMessage string) error {
	endpoint := fmt.Sprintf("%s/deployments/%s", c.baseURL, deploymentID)
	payload := map[string]string{
		"status": status,
	}
	if errorMessage != "" {
		payload["error_message"] = errorMessage
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal request body: %w", err)
	}

	req, err := http.NewRequest("PUT", endpoint, bytes.NewBuffer(body))
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

	if resp.StatusCode != http.StatusOK {
		var errorResp struct {
			Error string `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&errorResp); err != nil {
			return fmt.Errorf("failed to update deployment status: status code %d", resp.StatusCode)
		}
		return fmt.Errorf("failed to update deployment status: %s", errorResp.Error)
	}

	return nil
}

// Cluster represents a cluster.
type Cluster struct {
	ID            string                 `json:"id"`
	Name          string                 `json:"name"`
	Status        string                 `json:"status"`
	LastHeartbeat time.Time              `json:"last_heartbeat"`
	CreatedAt     time.Time              `json:"created_at"`
	Metadata      map[string]interface{} `json:"metadata"`
}

// GetClusters fetches the list of clusters.
func (c *Client) GetClusters() ([]Cluster, error) {
	endpoint := fmt.Sprintf("%s/cli/clusters", c.baseURL)
	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))

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
			return nil, fmt.Errorf("failed to get clusters: status code %d", resp.StatusCode)
		}
		return nil, fmt.Errorf("failed to get clusters: %s", errorResp.Error)
	}

	var successResp struct {
		Clusters []Cluster `json:"clusters"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&successResp); err != nil {
		return nil, fmt.Errorf("failed to decode successful response: %w", err)
	}

	return successResp.Clusters, nil
}

// ClusterRegistrationResponse represents the response from registering a cluster.
type ClusterRegistrationResponse struct {
	ClusterID  string `json:"cluster_id"`
	AgentToken string `json:"agent_token"`
}

// RegisterCluster registers a new cluster.
func (c *Client) RegisterCluster(name, vpcID, vpcCidr, region, vineyardID string) (*ClusterRegistrationResponse, error) {
	endpoint := fmt.Sprintf("%s/cli/clusters", c.baseURL)
	payload := map[string]string{
		"name":        name,
		"vpc_id":      vpcID,
		"vpc_cidr":    vpcCidr,
		"region":      region,
		"vineyard_id": vineyardID,
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request body: %w", err)
	}

	req, err := http.NewRequest("POST", endpoint, bytes.NewBuffer(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		var errorResp struct {
			Error string `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&errorResp); err != nil {
			return nil, fmt.Errorf("failed to register cluster: status code %d", resp.StatusCode)
		}
		return nil, fmt.Errorf("failed to register cluster: %s", errorResp.Error)
	}

	var successResp ClusterRegistrationResponse
	if err := json.NewDecoder(resp.Body).Decode(&successResp); err != nil {
		return nil, fmt.Errorf("failed to decode successful response: %w", err)
	}

	return &successResp, nil
}

// UnregisterCluster deletes a cluster by name or ID.
func (c *Client) UnregisterCluster(id, name string) error {
	endpoint := fmt.Sprintf("%s/cli/clusters", c.baseURL)

	req, err := http.NewRequest("DELETE", endpoint, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
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
		return fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var errorResp struct {
			Error string `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&errorResp); err != nil {
			return fmt.Errorf("failed to unregister cluster: status code %d", resp.StatusCode)
		}
		return fmt.Errorf("failed to unregister cluster: %s", errorResp.Error)
	}

	return nil
}

// SendLog sends a log entry to the server.
func (c *Client) SendLog(deploymentID string, log LogEntry) error {
	endpoint := fmt.Sprintf("%s/deployments/%s/logs", c.baseURL, deploymentID)
	body, err := json.Marshal(log)
	if err != nil {
		return fmt.Errorf("failed to marshal log entry: %w", err)
	}

	req, err := http.NewRequest("POST", endpoint, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send log: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		return fmt.Errorf("failed to send log: status code %d", resp.StatusCode)
	}

	return nil
}

// BootstrapJob represents the structure of a bootstrap job for the API.
type BootstrapJob struct {
	ID           string    `json:"id"`
	VineyardID   string    `json:"vineyard_id"`
	Status       string    `json:"status"`
	ErrorMessage *string   `json:"error_message,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
}

// CreateBootstrapJob creates a new bootstrap job record.
func (c *Client) CreateBootstrapJob(vineyardID string) (*BootstrapJob, error) {
	endpoint := fmt.Sprintf("%s/cli/bootstrap-jobs", c.baseURL)
	payload := map[string]string{
		"vineyard_id": vineyardID,
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request body: %w", err)
	}

	req, err := http.NewRequest("POST", endpoint, bytes.NewBuffer(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		var errorResp struct {
			Error string `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&errorResp); err != nil {
			return nil, fmt.Errorf("failed to create bootstrap job: status code %d", resp.StatusCode)
		}
		return nil, fmt.Errorf("failed to create bootstrap job: %s", errorResp.Error)
	}

	var successResp struct {
		Job *BootstrapJob `json:"job"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&successResp); err != nil {
		return nil, fmt.Errorf("failed to decode successful response: %w", err)
	}

	return successResp.Job, nil
}

// UpdateBootstrapJobStatus updates the status of a bootstrap job.
func (c *Client) UpdateBootstrapJobStatus(jobID, status, errorMessage string) error {
	endpoint := fmt.Sprintf("%s/cli/bootstrap-jobs/%s", c.baseURL, jobID)
	payload := map[string]string{
		"status": status,
	}
	if errorMessage != "" {
		payload["error_message"] = errorMessage
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal request body: %w", err)
	}

	req, err := http.NewRequest("PUT", endpoint, bytes.NewBuffer(body))
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

	if resp.StatusCode != http.StatusOK {
		var errorResp struct {
			Error string `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&errorResp); err != nil {
			return fmt.Errorf("failed to update bootstrap job status: status code %d", resp.StatusCode)
		}
		return fmt.Errorf("failed to update bootstrap job status: %s", errorResp.Error)
	}

	return nil
}

// ProvisionJob represents a queued provisioning job.
type ProvisionJob struct {
	ID                string                  `json:"id"`
	JobType           string                  `json:"job_type"`
	VineyardID        string                  `json:"vineyard_id"`
	ConfigurationID   string                  `json:"configuration_id,omitempty"`
	VineID            string                  `json:"vine_id,omitempty"`
	ClusterID         string                  `json:"cluster_id,omitempty"`
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
}

// JobLog represents a log entry for a provisioning job.
type JobLog struct {
	ID         int       `json:"id"`
	JobID      string    `json:"job_id"`
	LogChunk   string    `json:"log_chunk"`
	StreamType string    `json:"stream_type"`
	CreatedAt  time.Time `json:"created_at"`
}

// Worker represents a registered provisioning worker.
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

// QueueJobParams holds optional parameters for QueueJob.
type QueueJobParams struct {
	JobType          string
	VineyardID       string
	ConfigurationID  string
	ClusterID        string
	CloudIdentityID  string
	AssignedWorkerID string
	PlanJobID        string
	ConfigSnapshot   map[string]interface{}
}

// QueueJob creates a new provisioning job on the broker queue.
func (c *Client) QueueJob(jobType, vineyardID, configurationID, clusterID, cloudIdentityID string, configSnapshot map[string]interface{}) (*ProvisionJob, error) {
	return c.QueueJobWithParams(QueueJobParams{
		JobType:         jobType,
		VineyardID:      vineyardID,
		ConfigurationID: configurationID,
		ClusterID:       clusterID,
		CloudIdentityID: cloudIdentityID,
		ConfigSnapshot:  configSnapshot,
	})
}

// QueueJobWithParams creates a new provisioning job with full parameter control.
func (c *Client) QueueJobWithParams(params QueueJobParams) (*ProvisionJob, error) {
	endpoint := fmt.Sprintf("%s/jobs", c.baseURL)
	payload := map[string]interface{}{
		"job_type":    params.JobType,
		"vineyard_id": params.VineyardID,
	}
	if params.ConfigurationID != "" {
		payload["configuration_id"] = params.ConfigurationID
	}
	if params.ClusterID != "" {
		payload["cluster_id"] = params.ClusterID
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

	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request body: %w", err)
	}

	req, err := http.NewRequest("POST", endpoint, bytes.NewBuffer(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		var errorResp struct {
			Error string `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&errorResp); err != nil {
			return nil, fmt.Errorf("failed to queue job: status code %d", resp.StatusCode)
		}
		return nil, fmt.Errorf("failed to queue job: %s", errorResp.Error)
	}

	var successResp struct {
		Job *ProvisionJob `json:"job"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&successResp); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return successResp.Job, nil
}

// SendBootstrapLog sends a log chunk for a bootstrap job to the server.
func (c *Client) SendBootstrapLog(jobID string, logChunk string, streamType string) error {
	endpoint := fmt.Sprintf("%s/cli/bootstrap-jobs/%s/logs", c.baseURL, jobID)

	payload := map[string]string{
		"log_chunk":   logChunk,
		"stream_type": streamType,
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal log entry: %w", err)
	}

	req, err := http.NewRequest("POST", endpoint, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send bootstrap log: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("failed to send bootstrap log: status code %d", resp.StatusCode)
	}

	return nil
}

// GetJob fetches a single job by ID.
func (c *Client) GetJob(jobID string) (*ProvisionJob, error) {
	endpoint := fmt.Sprintf("%s/cli/jobs/%s", c.baseURL, jobID)
	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))

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
			return nil, fmt.Errorf("failed to get job: status code %d", resp.StatusCode)
		}
		return nil, fmt.Errorf("failed to get job: %s", errorResp.Error)
	}

	var job ProvisionJob
	if err := json.NewDecoder(resp.Body).Decode(&job); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &job, nil
}

// GetJobLogs fetches logs for a job, optionally after a specific log entry ID.
func (c *Client) GetJobLogs(jobID string, afterID int) ([]JobLog, error) {
	endpoint := fmt.Sprintf("%s/cli/jobs/%s/logs", c.baseURL, jobID)
	if afterID > 0 {
		endpoint = fmt.Sprintf("%s?after=%d", endpoint, afterID)
	}

	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))

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
			return nil, fmt.Errorf("failed to get job logs: status code %d", resp.StatusCode)
		}
		return nil, fmt.Errorf("failed to get job logs: %s", errorResp.Error)
	}

	var successResp struct {
		Logs []JobLog `json:"logs"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&successResp); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return successResp.Logs, nil
}

// CancelJob cancels a queued or processing job.
func (c *Client) CancelJob(jobID string) error {
	endpoint := fmt.Sprintf("%s/cli/jobs/%s/cancel", c.baseURL, jobID)
	req, err := http.NewRequest("POST", endpoint, nil)
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
			return fmt.Errorf("failed to cancel job: status code %d", resp.StatusCode)
		}
		return fmt.Errorf("failed to cancel job: %s", errorResp.Error)
	}

	return nil
}

// GetWorkers lists all workers for the authenticated user.
func (c *Client) GetWorkers() ([]Worker, error) {
	endpoint := fmt.Sprintf("%s/cli/workers", c.baseURL)
	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))

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
			return nil, fmt.Errorf("failed to get workers: status code %d", resp.StatusCode)
		}
		return nil, fmt.Errorf("failed to get workers: %s", errorResp.Error)
	}

	var successResp struct {
		Workers []Worker `json:"workers"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&successResp); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return successResp.Workers, nil
}

// RemoveWorker deletes a worker record (no cloud teardown).
func (c *Client) RemoveWorker(workerID string) error {
	endpoint := fmt.Sprintf("%s/cli/workers/%s", c.baseURL, workerID)
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
			return fmt.Errorf("failed to remove worker: status code %d", resp.StatusCode)
		}
		return fmt.Errorf("failed to remove worker: %s", errorResp.Error)
	}

	return nil
}

// GetJobs fetches jobs with optional filters.
func (c *Client) GetJobs(status, vineyardID string) ([]ProvisionJob, error) {
	endpoint := fmt.Sprintf("%s/jobs", c.baseURL)

	params := url.Values{}
	if status != "" {
		params.Set("status", status)
	}
	if vineyardID != "" {
		params.Set("vineyard_id", vineyardID)
	}
	if len(params) > 0 {
		endpoint = fmt.Sprintf("%s?%s", endpoint, params.Encode())
	}

	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))

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
			return nil, fmt.Errorf("failed to get jobs: status code %d", resp.StatusCode)
		}
		return nil, fmt.Errorf("failed to get jobs: %s", errorResp.Error)
	}

	var successResp struct {
		Jobs []ProvisionJob `json:"jobs"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&successResp); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return successResp.Jobs, nil
}
