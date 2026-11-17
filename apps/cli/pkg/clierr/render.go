// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package clierr

import (
	"encoding/json"
	"fmt"
	"io"
)

// Schema is the identifier of the JSON error envelope. A change that removes or re-types a field
// is a new version; adding a field is not.
const Schema = "alethia.error/v1"

// Styles lets the caller style the human rendering without this package importing a terminal
// library. A nil function leaves the text as it is.
type Styles struct {
	// Headline styles the first line, glyph included.
	Headline func(string) string
	// Detail styles each "label  value" line under it.
	Detail func(string) string
}

// styled applies fn when there is one.
func styled(fn func(string) string, s string) string {
	if fn == nil {
		return s
	}
	return fn(s)
}

// WriteHuman renders e for a person: a blank line, the message behind glyph, then one indented line
// for each of hint, docs and request that the error carries.
//
//	✗ No cluster named "prod-eu" in organisation "acme".
//	  hint     alethia cluster list --org acme
//	  docs     https://…
//	  request  req_01JD…
func WriteHuman(w io.Writer, e *Error, glyph string, st Styles) {
	fmt.Fprintf(w, "\n%s\n", styled(st.Headline, glyph+" "+e.Message))
	for _, row := range [][2]string{
		{"hint", e.Hint},
		{"docs", e.DocsURL},
		{"request", e.RequestID},
	} {
		if row[1] != "" {
			fmt.Fprintf(w, "%s\n", styled(st.Detail, fmt.Sprintf("  %-7s  %s", row[0], row[1])))
		}
	}
}

// envelope is the wire form of an Error. Every key is always present; a value the error does not
// carry is null, so a reader never has to tell "absent" from "empty".
type envelope struct {
	Error  envelopeError `json:"error"`
	Schema string        `json:"schema"`
}

// envelopeError is the "error" object of the envelope.
type envelopeError struct {
	Code              string   `json:"code"`
	Class             Class    `json:"class"`
	ExitCode          int      `json:"exit_code"`
	Message           string   `json:"message"`
	Hint              *string  `json:"hint"`
	DocsURL           *string  `json:"docs_url"`
	Retryable         bool     `json:"retryable"`
	RetryAfterSeconds *float64 `json:"retry_after_seconds"`
	RequestID         *string  `json:"request_id"`
	HTTPStatus        *int     `json:"http_status"`
	Operation         *Op      `json:"operation"`
}

// optional returns nil for an empty string and a pointer to it otherwise.
func optional(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// WriteJSON renders e as the alethia.error/v1 envelope: one JSON object on one line.
func WriteJSON(w io.Writer, e *Error) error {
	body := envelopeError{
		Code:      e.Code,
		Class:     e.Class,
		ExitCode:  e.Exit,
		Message:   e.Message,
		Hint:      optional(e.Hint),
		DocsURL:   optional(e.DocsURL),
		Retryable: e.Retryable,
		RequestID: optional(e.RequestID),
		Operation: e.Operation,
	}
	if e.RetryAfter > 0 {
		seconds := e.RetryAfter.Seconds()
		body.RetryAfterSeconds = &seconds
	}
	if e.HTTPStatus != 0 {
		status := e.HTTPStatus
		body.HTTPStatus = &status
	}
	return json.NewEncoder(w).Encode(envelope{Error: body, Schema: Schema})
}
