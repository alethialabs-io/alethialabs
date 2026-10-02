// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The client half of the short-lived kubeconfig mint channel (#5250, routes #5306): request a mint,
// then poll it. The shapes are the wire-locked mirrors in packages/core/types/kubeconfig_mint.go.
//
// These two do not go through doPost/doGet, for two reasons the generic helpers cannot express. The
// request route answers 202 Accepted, which doPost treats as a failure; and its 429 carries a
// Retry-After the caller must be able to read, which responseError drops. Nothing else differs: the
// same auth headers, org scope, timeout and redirect policy, because the request is built on c.

// kubeconfigMintBodyLimit bounds a mint answer. The largest legitimate one is a ready poll, whose
// ciphertext is capped at types.KubeconfigMintSealedMaxLength; this leaves generous room for the
// envelope while refusing to buffer an unbounded body from a misbehaving proxy.
const kubeconfigMintBodyLimit = 4 * types.KubeconfigMintSealedMaxLength

// RequestKubeconfigMint asks the control plane to mint a short-lived kubeconfig for one cluster
// (POST /api/cli/clusters/:id/kubeconfig). It answers 202 with the queued mint, which the caller
// then polls with PollKubeconfigMint. Any other answer is an *APIError; a 429 carries RetryAfter.
//
// The body carries only the client's PUBLIC key. The cluster's identity comes from the path and is
// resolved server-side.
func (c *Client) RequestKubeconfigMint(clusterID string, req types.KubeconfigMintRequest) (*types.KubeconfigMintResponse, error) {
	endpoint := fmt.Sprintf("%s/cli/clusters/%s/kubeconfig", c.baseURL, url.PathEscape(clusterID))
	// A struct of strings and an int cannot fail to marshal; the blank is that fact, not a shortcut.
	body, _ := json.Marshal(req)
	var out types.KubeconfigMintResponse
	if err := c.doMint(http.MethodPost, endpoint, body, http.StatusAccepted, &out); err != nil {
		return nil, fmt.Errorf("failed to request a kubeconfig: %w", err)
	}
	return &out, nil
}

// PollKubeconfigMint reads one mint's state (GET /api/cli/clusters/:id/kubeconfig/:mintId):
// pending, ready (with the sealed credential, served exactly once), failed or expired. The answer
// is checked against its own status before it is returned, so a ready poll without ciphertext is an
// error here rather than an empty credential later.
func (c *Client) PollKubeconfigMint(clusterID, mintID string) (*types.KubeconfigMintPollResponse, error) {
	endpoint := fmt.Sprintf("%s/cli/clusters/%s/kubeconfig/%s", c.baseURL, url.PathEscape(clusterID), url.PathEscape(mintID))
	var out types.KubeconfigMintPollResponse
	if err := c.doMint(http.MethodGet, endpoint, nil, http.StatusOK, &out); err != nil {
		return nil, fmt.Errorf("failed to poll the kubeconfig mint: %w", err)
	}
	if err := out.Validate(); err != nil {
		return nil, fmt.Errorf("failed to poll the kubeconfig mint: %w", err)
	}
	return &out, nil
}

// doMint sends one mint-channel request and decodes the answer when its status is want. A body is
// sent (as JSON) only when one is given.
func (c *Client) doMint(method, endpoint string, body []byte, want int, result any) error {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, endpoint, reader)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	c.setAuthHeaders(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != want {
		apiErr := responseError(resp)
		if resp.StatusCode == http.StatusTooManyRequests {
			apiErr.RetryAfter = parseRetryAfter(resp.Header.Get("Retry-After"), time.Now())
		}
		return apiErr
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, kubeconfigMintBodyLimit)).Decode(result); err != nil {
		return fmt.Errorf("failed to decode the response: %w", err)
	}
	return nil
}

// parseRetryAfter reads a Retry-After header in either of its RFC 9110 forms — delay-seconds or an
// HTTP-date — and returns the wait, or zero when the header is absent, malformed or in the past.
func parseRetryAfter(h string, now time.Time) time.Duration {
	h = strings.TrimSpace(h)
	if h == "" {
		return 0
	}
	if secs, err := strconv.Atoi(h); err == nil {
		if secs <= 0 {
			return 0
		}
		return time.Duration(secs) * time.Second
	}
	if at, err := http.ParseTime(h); err == nil && at.After(now) {
		return at.Sub(now)
	}
	return 0
}
