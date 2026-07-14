// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/runner/internal/version"
)

type RunnerAPIClient struct {
	baseURL     string
	runnerID    string
	runnerToken string
	providers   []string // cloud providers this runner can run; reported via heartbeat
	httpClient  *http.Client
}

type Job struct {
	ID                string         `json:"id"`
	UserID            string         `json:"user_id"`
	CloudIdentityID   *string        `json:"cloud_identity_id"`
	JobType           string         `json:"job_type"`
	ClusterID         *string        `json:"cluster_id"`
	ConfigurationID   *string        `json:"configuration_id"`
	PlanJobID         *string        `json:"plan_job_id"`
	ConfigSnapshot    map[string]any `json:"config_snapshot"`
	ConfigurationHash *string        `json:"configuration_hash"`
	// VerifyOverride, when present, is an authorized waiver of failing verification
	// controls (elench): { controls, reason, by, expiry }. nil = no waiver.
	VerifyOverride    map[string]any `json:"verify_override"`
	Status            string         `json:"status"`
	RunnerID          *string        `json:"runner_id"`
	ClaimedAt         *time.Time     `json:"claimed_at"`
	StartedAt         *time.Time     `json:"started_at"`
	CompletedAt       *time.Time     `json:"completed_at"`
	ErrorMessage      *string        `json:"error_message"`
	ExecutionMetadata map[string]any `json:"execution_metadata"`
	// Traceparent is the W3C traceparent minted at enqueue (`00-<trace-id>-<span-id>-01`).
	// Carried enqueue → claim → runner so the runner's logs/spans join the console trace.
	Traceparent string    `json:"traceparent"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type CloudIdentity struct {
	Provider   string `json:"provider"`
	RoleArn    string `json:"role_arn"`
	ExternalID string `json:"external_id"`
	// Alibaba keyless: the RAM OIDC provider ARN passed to AssumeRoleWithOIDC.
	OidcProviderArn     string `json:"oidc_provider_arn"`
	AccountID           string `json:"account_id"`
	ProjectID           string `json:"project_id"`
	ServiceAccountEmail string `json:"service_account_email"`
	WifConfig           string `json:"wif_config"`
	TenantID            string `json:"tenant_id"`
	ClientID            string `json:"client_id"`
	SubscriptionID      string `json:"subscription_id"`
	// DigitalOcean / Hetzner / Civo — scoped API token (decrypted at claim time).
	APIToken string `json:"api_token"`
	// Hetzner Object Storage (S3-compatible) access/secret key pair — DISTINCT from the
	// Cloud API token, decrypted at claim. Exported as HETZNER_S3_ACCESS_KEY /
	// HETZNER_S3_SECRET_KEY for the aminueza/minio provider. Empty when unused.
	S3AccessKey string `json:"s3_access_key"`
	S3SecretKey string `json:"s3_secret_key"`
	// Self-managed: no token was stored in Alethia; this (self-hosted) runner supplies
	// it from its own environment (HCLOUD_TOKEN / CIVO_TOKEN / DIGITALOCEAN_ACCESS_TOKEN).
	SelfManaged bool `json:"self_managed"`
}

// ConnectorCredential is a decrypted api_key credential for a pluggable
// connector (Cloudflare, Vault, …), attached at claim time only — never in the
// config_snapshot.
type ConnectorCredential struct {
	Category    string            `json:"category"`
	Slug        string            `json:"slug"`
	Credentials map[string]string `json:"credentials"`
}

type ClaimResponse struct {
	Job                  *Job                  `json:"job"`
	CloudIdentity        *CloudIdentity        `json:"cloud_identity"`
	ConnectorCredentials []ConnectorCredential `json:"connector_credentials"`
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

func (c *RunnerAPIClient) Heartbeat() ([]string, error) {
	payload, _ := json.Marshal(map[string]any{
		"version":   version.Version,
		"providers": c.providers, // nil → JSON null → server keeps existing (claims any)
	})
	req, err := http.NewRequest("POST", c.baseURL+"/runners/heartbeat", bytes.NewBuffer(payload))
	if err != nil {
		return nil, err
	}
	c.setRunnerHeaders(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("heartbeat request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("heartbeat returned status %d", resp.StatusCode)
	}
	// The body carries the runner's server-side-cancelled job ids (fallback cancel delivery). An
	// older console omits the field → empty slice → no fallback cancels, which is fine.
	var body struct {
		CancelledJobIDs []string `json:"cancelled_job_ids"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		// A malformed/empty body must not fail liveness — the heartbeat itself succeeded.
		return nil, nil
	}
	return body.CancelledJobIDs, nil
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

// WakeEvent is a typed push-dispatch event carried on the wake SSE stream. Type "wake"
// means "a job became claimable" (the runner attempts a claim); type "cancel" targets a
// specific in-flight job by JobID (the runner tears it down mid-flight). The console emits
// these as `data: {"type":"…","job_id":"…"}`; a bare legacy `data: wake` line (no JSON) is
// parsed as a wake for back-compat.
type WakeEvent struct {
	Type  string `json:"type"`
	JobID string `json:"job_id"`
}

// parseWakeLine parses one SSE line into a WakeEvent. It returns (event, true) only for a
// "data:" line; comment/blank lines return (_, false). A data payload that isn't the typed
// JSON object (e.g. the legacy `data: wake`) is treated as a plain wake so an older console
// still drives claims.
func parseWakeLine(line string) (WakeEvent, bool) {
	if !strings.HasPrefix(line, "data:") {
		return WakeEvent{}, false
	}
	payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
	var ev WakeEvent
	if err := json.Unmarshal([]byte(payload), &ev); err != nil || ev.Type == "" {
		return WakeEvent{Type: "wake"}, true // legacy `data: wake` (or any non-typed payload)
	}
	return ev, true
}

// StreamWake holds an SSE connection to the push-dispatch endpoint and invokes onEvent for
// every typed event (a wake, or a cancel targeting one of this runner's jobs). It blocks
// until the stream ends or ctx is cancelled, then returns — the caller reconnects with
// backoff. Uses a no-timeout client (the connection is long-lived); ctx governs its lifetime.
func (c *RunnerAPIClient) StreamWake(ctx context.Context, onEvent func(WakeEvent)) error {
	req, err := http.NewRequestWithContext(ctx, "GET", c.baseURL+"/runners/wake", nil)
	if err != nil {
		return err
	}
	c.setRunnerHeaders(req)
	req.Header.Set("Accept", "text/event-stream")

	resp, err := (&http.Client{Timeout: 0}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("wake stream returned status %d", resp.StatusCode)
	}

	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		// SSE: "data: …" lines carry events; ":" comments are heartbeats (ignored).
		if ev, ok := parseWakeLine(scanner.Text()); ok {
			onEvent(ev)
		}
	}
	return scanner.Err()
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

func (c *RunnerAPIClient) SendLog(jobID, logChunk, streamType, traceparent string) error {
	payload := map[string]string{
		"log_chunk":   logChunk,
		"stream_type": streamType,
	}
	// Carry the job's trace so the console stamps job_logs.traceparent (insert_job_log
	// falls back to the job's own traceparent when this is absent).
	if traceparent != "" {
		payload["traceparent"] = traceparent
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

// FetchGitToken mints the job owner's git provider token. When repoURL is non-empty the console
// resolves the provider from THAT repo (validated against the job's repos) rather than the default
// apps-destination precedence — so a BYO chart on a different provider gets the right token.
func (c *RunnerAPIClient) FetchGitToken(jobID, repoURL string) (string, error) {
	endpoint := fmt.Sprintf("%s/jobs/%s/git-token", c.baseURL, jobID)
	if repoURL != "" {
		endpoint += "?repo=" + url.QueryEscape(repoURL)
	}
	req, err := http.NewRequest("POST", endpoint, nil)
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

// FetchStateToken mints a per-job tofu-state token from the console. The runner presents it
// to OpenTofu's http state backend as the HTTP Basic password (TF_HTTP_PASSWORD); the console
// derives the state object key server-side from the job and authorizes on the signed sub=jobID.
func (c *RunnerAPIClient) FetchStateToken(jobID string) (string, error) {
	req, err := http.NewRequest("POST", fmt.Sprintf("%s/jobs/%s/state-token", c.baseURL, jobID), nil)
	if err != nil {
		return "", err
	}
	c.setRunnerHeaders(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("fetch state token request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("fetch state token returned status %d", resp.StatusCode)
	}

	var result struct {
		Token *string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("failed to decode state token response: %w", err)
	}
	if result.Token == nil {
		return "", fmt.Errorf("state token response was empty")
	}
	return *result.Token, nil
}

// PurgeProjectState deletes the project's tofu state object after a successful destroy.
// The state proxy authorizes with the per-job state token (HTTP Basic password), not the
// runner headers — tofu's http backend leaves an empty state object behind on destroy, so
// this is best-effort cleanup.
func (c *RunnerAPIClient) PurgeProjectState(jobID, stateToken string) error {
	req, err := http.NewRequest("DELETE", fmt.Sprintf("%s/jobs/%s/state", c.baseURL, jobID), nil)
	if err != nil {
		return err
	}
	req.SetBasicAuth("alethia", stateToken)
	req.Header.Set("User-Agent", fmt.Sprintf("runner/%s", version.Version))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("purge state request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("purge state returned status %d", resp.StatusCode)
	}
	return nil
}

// jobIDBody encodes the { job_id } payload the cloud-token mint routes require to bind the
// mint to the job being provisioned (the console verifies the runner owns that job).
func jobIDBody(jobID string) *bytes.Buffer {
	b, _ := json.Marshal(map[string]string{"job_id": jobID})
	return bytes.NewBuffer(b)
}

// FetchAzureToken mints a short-lived OIDC assertion for keyless Azure provisioning. The console
// holds the issuer signing key; the runner presents this token to OpenTofu's azurerm provider
// (ARM_OIDC_TOKEN), which exchanges it for an ARM access token — no client secret on the runner.
func (c *RunnerAPIClient) FetchAzureToken(jobID string) (string, error) {
	req, err := http.NewRequest("POST", c.baseURL+"/runners/azure-token", jobIDBody(jobID))
	if err != nil {
		return "", err
	}
	c.setRunnerHeaders(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("fetch azure token request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("fetch azure token returned status %d", resp.StatusCode)
	}

	var result struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("failed to decode azure token response: %w", err)
	}
	if result.Token == "" {
		return "", fmt.Errorf("azure token response was empty")
	}
	return result.Token, nil
}

// FetchAwsToken mints a short-lived OIDC assertion for keyless AWS provisioning. The managed runner has no
// ambient AWS identity, so it exchanges the assertion DIRECTLY for the customer's provisioner role via
// AssumeRoleWithWebIdentity (a web-identity token file the SDK re-reads) — the customer role trusts the
// Alethia issuer, so there is no platform AWS account in the path and no access key on the runner.
func (c *RunnerAPIClient) FetchAwsToken(jobID string) (*AwsFederation, error) {
	req, err := http.NewRequest("POST", c.baseURL+"/runners/aws-token", jobIDBody(jobID))
	if err != nil {
		return nil, err
	}
	c.setRunnerHeaders(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch aws token request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch aws token returned status %d", resp.StatusCode)
	}

	var result struct {
		Token  string `json:"token"`
		Region string `json:"region"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode aws token response: %w", err)
	}
	if result.Token == "" {
		return nil, fmt.Errorf("aws token response was incomplete")
	}
	return &AwsFederation{
		Token:  result.Token,
		Region: result.Region,
	}, nil
}

// FetchAlibabaToken mints a short-lived OIDC assertion for keyless Alibaba provisioning. The console holds
// the issuer signing key; the runner writes this token to a file the alicloud provider reads to run an
// anonymous AssumeRoleWithOIDC — no AccessKey on the runner.
func (c *RunnerAPIClient) FetchAlibabaToken(jobID string) (string, error) {
	req, err := http.NewRequest("POST", c.baseURL+"/runners/alibaba-token", jobIDBody(jobID))
	if err != nil {
		return "", err
	}
	c.setRunnerHeaders(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("fetch alibaba token request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("fetch alibaba token returned status %d", resp.StatusCode)
	}

	var result struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("failed to decode alibaba token response: %w", err)
	}
	if result.Token == "" {
		return "", fmt.Errorf("alibaba token response was empty")
	}
	return result.Token, nil
}

// FetchGcpToken mints a short-lived OIDC assertion for keyless (DIRECT-OIDC) GCP provisioning. The runner
// writes this token to a file the google WIF config's credential_source points at; google-auth re-reads it
// to exchange for a GCP access token — no AWS hop, no service-account key.
func (c *RunnerAPIClient) FetchGcpToken(jobID string) (string, error) {
	req, err := http.NewRequest("POST", c.baseURL+"/runners/gcp-token", jobIDBody(jobID))
	if err != nil {
		return "", err
	}
	c.setRunnerHeaders(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("fetch gcp token request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("fetch gcp token returned status %d", resp.StatusCode)
	}

	var result struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("failed to decode gcp token response: %w", err)
	}
	if result.Token == "" {
		return "", fmt.Errorf("gcp token response was empty")
	}
	return result.Token, nil
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
