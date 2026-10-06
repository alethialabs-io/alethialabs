// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

// The two 409 codes a component write is REFUSED with (#5551), as opposed to failing. They mirror
// cliComponentConflictResponse in apps/console/lib/validations/cli-contract.ts.
const (
	// ConflictComponentBusy — a DEPLOY or DESTROY job of the component's environment is queued or
	// running; a change cannot land until it finishes.
	ConflictComponentBusy = "component_busy"
	// ConflictComponentChanged — the write carried If-Match and the component is no longer at that
	// revision: someone else changed it (or removed it) after the caller read it.
	ConflictComponentChanged = "component_changed"
)

// conflictBodyLimit bounds a 409 body read. Larger than errorBodyLimit because a conflict carries the
// server's whole copy of the component, whose config can run to kilobytes; still bounded, for the
// reason errorBodyLimit is.
const conflictBodyLimit = 1 << 20

// ComponentConflict is the 409 body of a refused component write. Current is the server's copy now —
// nil when the component no longer exists — so a caller holding the copy it read can name the fields
// that changed.
type ComponentConflict struct {
	Error     string        `json:"error"`
	Code      string        `json:"code"`
	Status    *string       `json:"status"`
	Component *Component    `json:"component"`
	Run       *ComponentRun `json:"run"`
}

// ComponentRun is the deploy or destroy job a component_busy refusal waited on.
type ComponentRun struct {
	ID     string `json:"id"`
	Type   string `json:"type"`
	Status string `json:"status"`
}

// ComponentConflictError is a component write the server refused with one of the two conflict codes.
// It is returned bare (not wrapped in APIError) so a caller reaches the server's copy with errors.As.
type ComponentConflictError struct {
	Code    string
	Message string
	// Status is the component's own status on the server, empty when the server named none.
	Status string
	// Current is the server's copy now, nil when the component no longer exists.
	Current *Component
	// Run is the deploy or destroy a busy refusal waited on — nil when it is not busy, or when that
	// run finished between the refusal and the server explaining it.
	Run *ComponentRun
}

// Error renders the server's sentence, which already says what to do next.
func (e *ComponentConflictError) Error() string {
	return fmt.Sprintf("%s (status %d)", e.Message, http.StatusConflict)
}

// Busy reports whether the refusal is the run gate rather than the revision precondition.
func (e *ComponentConflictError) Busy() bool { return e.Code == ConflictComponentBusy }

// UpdateComponent changes the settable fields of an existing NAMED component — a database, cache,
// queue, … — in one environment: PATCH /api/cli/projects/:project/components/:kind/:name?env=.
//
// Only the fields passed are changed; every other column keeps its value. The server validates
// them against the same per-kind definition of "settable" as AddComponent, so a field that cannot
// be `--set` cannot be patched either. A singleton is not updated here: UpsertComponent does it.
//
// ifMatch is the component's revision (Component.UpdatedAt) as the caller read it; when non-empty it
// is sent as If-Match and the server refuses the write with a *ComponentConflictError if the
// component changed since. Empty writes unconditionally. While a deploy or destroy of the environment
// is queued or running, the write is refused either way.
func (c *Client) UpdateComponent(project, kind, name, env string, fields map[string]interface{}, ifMatch string) (*Component, error) {
	endpoint := withEnvParam(fmt.Sprintf("%s/cli/projects/%s/components/%s/%s",
		c.baseURL, url.PathEscape(project), url.PathEscape(kind), url.PathEscape(name)), env)
	if fields == nil {
		fields = map[string]interface{}{}
	}
	var resp struct {
		Component *Component `json:"component"`
	}
	if err := c.doComponentWrite(http.MethodPatch, endpoint, map[string]interface{}{"fields": fields}, ifMatch, http.StatusOK, &resp); err != nil {
		return nil, wrapComponentWrite("update", err)
	}
	return resp.Component, nil
}

// UpsertComponent changes the settable fields of a SINGLETON component — the network, the cluster,
// … — in one environment, through the add route that upserts it: POST
// /api/cli/projects/:project/components/:kind?env=. With an empty ifMatch it is AddComponent without a
// name; with one, the server updates only a row still at that revision and refuses otherwise — it
// never re-creates a singleton removed since it was read.
func (c *Client) UpsertComponent(project, kind, env string, fields map[string]interface{}, ifMatch string) (*Component, error) {
	endpoint := withEnvParam(fmt.Sprintf("%s/cli/projects/%s/components/%s",
		c.baseURL, url.PathEscape(project), url.PathEscape(kind)), env)
	if fields == nil {
		fields = map[string]interface{}{}
	}
	var resp struct {
		Component *Component `json:"component"`
	}
	if err := c.doComponentWrite(http.MethodPost, endpoint, map[string]interface{}{"fields": fields}, ifMatch, http.StatusCreated, &resp); err != nil {
		return nil, wrapComponentWrite("update", err)
	}
	return resp.Component, nil
}

// wrapComponentWrite prefixes a transport or server failure, and leaves a conflict bare: its message
// is already the whole sentence, and a caller unwraps it either way.
func wrapComponentWrite(verb string, err error) error {
	var conflict *ComponentConflictError
	if errors.As(err, &conflict) {
		return err
	}
	return fmt.Errorf("failed to %s component: %w", verb, err)
}

// doComponentWrite sends a JSON component write with an optional If-Match and decodes a success
// (200 or `created`) into result. A 409 carrying one of the two conflict codes becomes a
// *ComponentConflictError; any other failure is the usual *APIError. Kept here rather than beside
// doPut in api.go so this route's client lives in one file.
func (c *Client) doComponentWrite(method, endpoint string, payload interface{}, ifMatch string, created int, result interface{}) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal request body: %w", err)
	}
	req, err := http.NewRequest(method, endpoint, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if ifMatch != "" {
		// An entity-tag is quoted; the server accepts it either way.
		req.Header.Set("If-Match", `"`+ifMatch+`"`)
	}
	c.setAuthHeaders(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusOK || resp.StatusCode == created {
		return json.NewDecoder(resp.Body).Decode(result)
	}
	if resp.StatusCode == http.StatusConflict {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, conflictBodyLimit))
		var conflict ComponentConflict
		if json.Unmarshal(raw, &conflict) == nil &&
			(conflict.Code == ConflictComponentBusy || conflict.Code == ConflictComponentChanged) {
			out := &ComponentConflictError{Code: conflict.Code, Message: conflict.Error, Current: conflict.Component, Run: conflict.Run}
			if conflict.Status != nil {
				out.Status = *conflict.Status
			}
			return out
		}
		// Another 409 — a duplicate name on create — reads like any other failure.
		resp.Body = io.NopCloser(bytes.NewReader(raw))
	}
	return responseError(resp)
}
