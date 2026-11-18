// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package clierr is the CLI's error contract: one typed error, one classifier, one exit table.
//
// A command reports a failure as an error value. The single fatal path (cmd.fail) passes it through
// From, renders the result on stderr, and exits with the code the error's class owns. Nothing else
// decides an exit code, which is what lets the table in registry.go be the whole truth.
//
// The package is deliberately free of rendering style and of cobra: it is imported by the command
// layer and by anything that needs to return a classified failure without printing or exiting.
package clierr

import (
	"errors"
	"net/http"
	"net/url"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/spec"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

// Op identifies the remote operation an error is about, so a caller can resume or inspect it.
type Op struct {
	ID   string `json:"id"`
	Type string `json:"type"`
}

// Error is a classified CLI failure.
//
// Code is the precise, stable contract and Exit is the coarse one: a script branches on the exit
// code, an agent reads the code. Class and Exit always agree with the exit table — New, Wrap and
// From are the constructors, and each derives both from the registry.
type Error struct {
	// Code is the stable snake_case identifier, for example "not_found".
	Code string
	// Class is the row of the exit table this error belongs to.
	Class Class
	// Message is the sentence shown to the person. It is what Error() returns.
	Message string
	// Hint is one concrete next step, or empty.
	Hint string
	// DocsURL points at the documentation for this error, or is empty.
	DocsURL string
	// RequestID is the control plane's identifier for the failed request, or empty.
	RequestID string
	// HTTPStatus is the status the control plane answered with, or 0 when no answer was involved.
	HTTPStatus int
	// Exit is the process exit code.
	Exit int
	// Retryable reports whether repeating the same command unchanged can succeed.
	Retryable bool
	// RetryAfter is the wait the control plane asked for, or zero when it named none.
	RetryAfter time.Duration
	// Operation is the remote operation the error is about, or nil.
	Operation *Op
	// Cause is the underlying error, reachable through errors.Is and errors.As.
	Cause error
}

// Error returns the message.
func (e *Error) Error() string { return e.Message }

// Unwrap returns the underlying error.
func (e *Error) Unwrap() error { return e.Cause }

// New builds an Error with a registered code. A code the registry does not carry is kept as
// written and classed as unclassified, so a typo costs precision and never a wrong exit code.
func New(code, message string) *Error {
	class, _ := classOfCode(code)
	def := classDef(class)
	return &Error{
		Code:      code,
		Class:     def.Class,
		Message:   message,
		Exit:      def.Exit,
		Retryable: def.Retryable,
	}
}

// Wrap classifies cause under code, keeping cause's text as the message and cause itself reachable
// through errors.Is and errors.As.
func Wrap(code string, cause error) *Error {
	e := New(code, cause.Error())
	e.Cause = cause
	return e
}

// From classifies any error. It never returns nil for a non-nil error, and returns nil for nil.
//
// The order is the precedence: an error some layer already classified is believed; then the
// control plane's own answer; then the CLI's sentinels; then a transport failure. Anything else is
// unclassified and exits 1, exactly as every failure did before the table existed.
//
// Three classes are never inferred here, because no error value proves them: a wait that timed out,
// a remote operation that failed, and an interrupt. The code that knows says so with New or Wrap.
//
// The message is always the text of the WHOLE chain (err.Error()), not of the link that decided the
// class, so the prefix a caller added with %w — "failed to get runners: …" — is still shown.
func From(err error) *Error {
	if err == nil {
		return nil
	}

	var typed *Error
	if errors.As(err, &typed) {
		if error(typed) == err {
			return typed
		}
		outer := *typed
		outer.Message = err.Error()
		return &outer
	}

	var apiErr *api.APIError
	if errors.As(err, &apiErr) {
		return fromAPIError(err, apiErr)
	}

	var missing *spec.MissingError
	if errors.As(err, &missing) {
		return Wrap(CodeInputRequired, err)
	}

	var transport *api.TransportError
	var urlErr *url.Error
	if errors.As(err, &transport) || errors.As(err, &urlErr) {
		return Wrap(CodeNetworkUnreachable, err)
	}

	return Wrap(CodeInternal, err)
}

// fromAPIError classifies a control-plane answer: by the code the server sent when the registry
// knows it, otherwise by HTTP status. A server code the registry does not know is kept as the
// Error's Code — it is still the precise contract — while the class comes from the status, so a
// newer control plane cannot make an older CLI exit with a number it never documented.
func fromAPIError(err error, apiErr *api.APIError) *Error {
	code := codeForStatus(apiErr.StatusCode)
	class, _ := classOfCode(code)
	if apiErr.Code != "" {
		code = apiErr.Code
		if known, ok := classOfCode(apiErr.Code); ok {
			class = known
		}
	}
	def := classDef(class)
	return &Error{
		Code:       code,
		Class:      def.Class,
		Message:    err.Error(),
		Hint:       apiErr.Hint,
		DocsURL:    apiErr.DocsURL,
		RequestID:  apiErr.RequestID,
		HTTPStatus: apiErr.StatusCode,
		Exit:       def.Exit,
		Retryable:  def.Retryable,
		RetryAfter: apiErr.RetryAfter,
		Cause:      err,
	}
}

// codeForStatus is the classification of a control-plane answer that carried no code, which is
// every answer of a control plane older than the code field.
//
// 501 is left unclassified on purpose: the 5xx row promises a retry can help, and no retry turns
// "not implemented" into an answer.
func codeForStatus(status int) string {
	switch status {
	case http.StatusUnauthorized:
		return CodeAuthRequired
	case http.StatusForbidden:
		return CodeForbidden
	case http.StatusNotFound:
		return CodeNotFound
	case http.StatusConflict, http.StatusPreconditionFailed:
		return CodeConflict
	case http.StatusBadRequest, http.StatusUnprocessableEntity:
		return CodeValidationFailed
	case http.StatusPaymentRequired:
		return CodePlanLimit
	case http.StatusTooManyRequests:
		return CodeRateLimited
	case http.StatusRequestTimeout:
		return CodeServiceUnavailable
	case http.StatusNotImplemented:
		return CodeInternal
	}
	if status >= http.StatusInternalServerError {
		return CodeServiceUnavailable
	}
	return CodeInternal
}
