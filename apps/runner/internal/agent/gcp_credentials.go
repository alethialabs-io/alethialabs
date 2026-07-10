// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"
)

// gcpJWTSubjectTokenType marks a DIRECT-OIDC WIF config (a minted Alethia JWT, no AWS hop) vs the legacy
// AWS-hub config (aws4_request). Must match GCP_JWT_SUBJECT_TOKEN_TYPE (console session/gcp.ts).
const gcpJWTSubjectTokenType = "urn:ietf:params:oauth:token-type:jwt"

// gcpTokenRefreshInterval re-mints the ≤10-min assertion into the token file every 5 min so google-auth
// always re-reads a live token when it re-exchanges for a fresh GCP access token — a long apply survives.
const gcpTokenRefreshInterval = 5 * time.Minute

// gcpTokenFetcher mints a keyless GCP OIDC assertion. Satisfied by *RunnerAPIClient (FetchGcpToken).
type gcpTokenFetcher interface {
	FetchGcpToken(jobID string) (string, error)
}

// isOidcWifJSON reports whether a stored WIF config federates DIRECTLY from the Alethia issuer (a minted
// JWT) rather than through the legacy AWS hub. Malformed JSON → false (falls back to the legacy path).
func isOidcWifJSON(wifConfigJSON string) bool {
	var m struct {
		SubjectTokenType string `json:"subject_token_type"`
	}
	if json.Unmarshal([]byte(wifConfigJSON), &m) != nil {
		return false
	}
	return m.SubjectTokenType == gcpJWTSubjectTokenType
}

// ActivateGcpOIDC authenticates a MANAGED runner to GCP KEYLESSLY via DIRECT OIDC — no AWS hop. It mints a
// short-lived assertion from the console, writes it to a token file, points the WIF config's
// credential_source at that file, and hands the config to OpenTofu's google provider. google-auth re-reads
// the file to re-exchange for a fresh GCP token, so a background refresher re-minting every few minutes
// keeps a long apply alive (parity with Azure/Alibaba). cleanup stops the refresher and removes the files.
func ActivateGcpOIDC(ctx context.Context, fetcher gcpTokenFetcher, wifConfigJSON, projectID, jobID string) (func(), error) {
	if fetcher == nil {
		return nil, fmt.Errorf("no token fetcher for GCP OIDC federation")
	}
	if wifConfigJSON == "" {
		return nil, fmt.Errorf("empty WIF config")
	}

	token, err := fetcher.FetchGcpToken(jobID)
	if err != nil {
		return nil, fmt.Errorf("failed to mint GCP token: %w", err)
	}

	dir, err := os.MkdirTemp("", "alethia-gcp-*")
	if err != nil {
		return nil, fmt.Errorf("failed to create GCP creds dir: %w", err)
	}
	tokenPath := dir + "/oidc-token"
	if err := writeTokenFileAtomic(tokenPath, token); err != nil {
		os.RemoveAll(dir)
		return nil, fmt.Errorf("failed to write GCP token file: %w", err)
	}

	// Point the WIF config's credential_source at our runtime token file (the stored config carries a
	// placeholder path from the customer setup) and hand it to the existing ActivateGcpWIF plumbing.
	modified, err := injectGcpTokenFile(wifConfigJSON, tokenPath)
	if err != nil {
		os.RemoveAll(dir)
		return nil, fmt.Errorf("failed to set GCP credential source: %w", err)
	}
	wifCleanup, err := ActivateGcpWIF(modified, projectID)
	if err != nil {
		os.RemoveAll(dir)
		return nil, err
	}

	refreshCtx, cancel := context.WithCancel(ctx)
	go refreshGcpToken(refreshCtx, fetcher, tokenPath, gcpTokenRefreshInterval, jobID)

	cleanup := func() {
		cancel()
		wifCleanup()
		os.RemoveAll(dir)
	}
	return cleanup, nil
}

// injectGcpTokenFile rewrites the WIF config's credential_source to read the subject token from tokenPath.
func injectGcpTokenFile(wifConfigJSON, tokenPath string) (string, error) {
	var m map[string]any
	if err := json.Unmarshal([]byte(wifConfigJSON), &m); err != nil {
		return "", err
	}
	cs, _ := m["credential_source"].(map[string]any)
	if cs == nil {
		cs = map[string]any{}
	}
	cs["file"] = tokenPath
	if _, ok := cs["format"]; !ok {
		cs["format"] = map[string]any{"type": "text"}
	}
	m["credential_source"] = cs
	b, err := json.Marshal(m)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// refreshGcpToken re-mints the OIDC assertion into tokenPath every interval until ctx is cancelled. A
// transient mint failure is left to the next tick — the existing file stays valid until then.
func refreshGcpToken(ctx context.Context, fetcher gcpTokenFetcher, tokenPath string, interval time.Duration, jobID string) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			token, err := fetcher.FetchGcpToken(jobID)
			if err != nil || token == "" {
				continue
			}
			_ = writeTokenFileAtomic(tokenPath, token)
		}
	}
}

// ActivateGcpWIF points OpenTofu's google provider at a Workload-Identity-Federation config — a *recipe*
// file google-auth uses to exchange a subject token for a short-lived GCP access token. No service-account
// JSON key is ever written. Managed runners call it via ActivateGcpOIDC (which fills in the token file);
// self-hosted runners rely on their own ambient GCP credentials.
func ActivateGcpWIF(wifConfigJSON string, projectID string) (func(), error) {
	if wifConfigJSON == "" {
		return nil, fmt.Errorf("empty WIF config")
	}

	tmpFile, err := os.CreateTemp("", "alethia-wif-*.json")
	if err != nil {
		return nil, fmt.Errorf("failed to create temp file: %w", err)
	}

	if _, err := tmpFile.Write([]byte(wifConfigJSON)); err != nil {
		tmpFile.Close()
		os.Remove(tmpFile.Name())
		return nil, fmt.Errorf("failed to write WIF config: %w", err)
	}
	tmpFile.Close()

	os.Setenv("GOOGLE_APPLICATION_CREDENTIALS", tmpFile.Name())
	if projectID != "" {
		os.Setenv("GOOGLE_PROJECT", projectID)
		os.Setenv("GCLOUD_PROJECT", projectID)
		os.Setenv("CLOUDSDK_CORE_PROJECT", projectID)
	}

	cleanup := func() {
		os.Unsetenv("GOOGLE_APPLICATION_CREDENTIALS")
		os.Unsetenv("GOOGLE_PROJECT")
		os.Unsetenv("GCLOUD_PROJECT")
		os.Unsetenv("CLOUDSDK_CORE_PROJECT")
		os.Remove(tmpFile.Name())
	}

	return cleanup, nil
}
