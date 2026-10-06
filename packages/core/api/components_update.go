// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
)

// UpdateComponent changes the settable fields of an existing NAMED component — a database, cache,
// queue, … — in one environment: PATCH /api/cli/projects/:project/components/:kind/:name?env=.
//
// Only the fields passed are changed; every other column keeps its value. The server validates
// them against the same per-kind definition of "settable" as AddComponent, so a field that cannot
// be `--set` cannot be patched either. A singleton is not updated here: AddComponent upserts it.
func (c *Client) UpdateComponent(project, kind, name, env string, fields map[string]interface{}) (*Component, error) {
	endpoint := withEnvParam(fmt.Sprintf("%s/cli/projects/%s/components/%s/%s",
		c.baseURL, url.PathEscape(project), url.PathEscape(kind), url.PathEscape(name)), env)
	if fields == nil {
		fields = map[string]interface{}{}
	}
	var resp struct {
		Component *Component `json:"component"`
	}
	if err := c.doPatch(endpoint, map[string]interface{}{"fields": fields}, &resp); err != nil {
		return nil, fmt.Errorf("failed to update component: %w", err)
	}
	return resp.Component, nil
}

// doPatch sends a JSON PATCH and decodes a 200 into result (which every caller supplies). Kept here rather than beside doPut in
// api.go so this route's client lives in one file.
func (c *Client) doPatch(endpoint string, payload interface{}, result interface{}) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal request body: %w", err)
	}
	req, err := http.NewRequest(http.MethodPatch, endpoint, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	c.setAuthHeaders(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return responseError(resp)
	}
	return json.NewDecoder(resp.Body).Decode(result)
}
