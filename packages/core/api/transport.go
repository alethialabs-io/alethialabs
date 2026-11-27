// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// This file is the one place a request leaves the client. Every verb helper builds its request and
// hands it to (*Client).send, which adds the client's identity headers, writes the request log when
// one was asked for, repeats a safe request that met a transient failure, and renews the credential
// once when the control plane answers 401. A failure to get any answer comes back as a
// *TransportError, so no verb has to type it for itself.

// --- Process-wide settings ---

// DebugEnv names the environment variable that turns the request log on when it lists the "api"
// topic. The CLI's --debug flag turns the same log on through SetDebugOutput.
const DebugEnv = "ALETHIA_DEBUG"

// transportSettings is what the process told the client about itself. It is process-wide rather
// than per Client because a Client is built from a bare token at every call site, and none of these
// three differ between two clients of one process.
type transportSettings struct {
	mu         sync.RWMutex
	cliVersion string
	// agentTool is the agent tool a request is made for; empty for a request made for a person.
	agentTool string
	debugSet  bool
	debug     io.Writer
	refresh   func() (string, error)
}

var settings transportSettings

// SetCLIVersion names the CLI build that is sending. Once set, every request carries
// `User-Agent: alethia-cli/<version> (<os>; <arch>)` and `X-Alethia-CLI-Version: <version>`. While
// it is unset neither header is written, so a program that is not the CLI does not claim to be it.
func SetCLIVersion(version string) {
	settings.mu.Lock()
	defer settings.mu.Unlock()
	settings.cliVersion = strings.TrimSpace(version)
}

// AgentHeader and AgentToolHeader mark a request made on behalf of a coding agent: `alethia mcp`
// runs each tool call as a child CLI process, and the child sends both on every request.
//
// They are a statement the client makes about itself, not a credential. The control plane uses
// them only to hold the request to the org's agent policy (its agent access switch, its production
// rule) and to record it with the other agent tool calls; it never grants anything because of them,
// so a client that leaves them out is treated exactly as before.
const (
	AgentHeader     = "X-Alethia-Agent"
	AgentToolHeader = "X-Alethia-Agent-Tool"
	// AgentClientMCP is the AgentHeader value for a request `alethia mcp` makes.
	AgentClientMCP = "alethia-mcp"
)

// SetAgentTool marks every request this process sends as made for the agent tool named tool (see
// AgentHeader). An empty name removes the mark.
func SetAgentTool(tool string) {
	settings.mu.Lock()
	defer settings.mu.Unlock()
	settings.agentTool = strings.TrimSpace(tool)
}

// SetDebugOutput decides where the request log goes, overriding DebugEnv: a writer turns the log on
// and nil turns it off. The writer must be the process's diagnostic stream, never its result stream.
func SetDebugOutput(w io.Writer) {
	settings.mu.Lock()
	defer settings.mu.Unlock()
	settings.debugSet = true
	settings.debug = w
}

// SetTokenRefresher registers how to renew the credential when the control plane answers 401. It is
// called at most once per request and returns the new token. Register one only when the token came
// from the credential store: a token the user supplied directly has nothing to renew it with.
// Passing nil removes it.
func SetTokenRefresher(refresh func() (string, error)) {
	settings.mu.Lock()
	defer settings.mu.Unlock()
	settings.refresh = refresh
}

// DebugRequested reports whether a DebugEnv value asks for the request log: a comma-separated list
// of topics naming "api" or "all", or a plain true.
func DebugRequested(raw string) bool {
	for _, topic := range strings.Split(raw, ",") {
		switch strings.ToLower(strings.TrimSpace(topic)) {
		case "api", "all":
			return true
		}
	}
	on, err := strconv.ParseBool(strings.TrimSpace(raw))
	return err == nil && on
}

// debugOutput returns the writer the request log goes to, or nil when no log was asked for. Without
// an explicit SetDebugOutput it is standard error when DebugEnv asks, read at the time of the write.
func debugOutput() io.Writer {
	settings.mu.RLock()
	set, w := settings.debugSet, settings.debug
	settings.mu.RUnlock()
	if set {
		return w
	}
	if DebugRequested(os.Getenv(DebugEnv)) {
		return os.Stderr
	}
	return nil
}

// --- Identity headers ---

// setClientHeaders writes the headers that tell the control plane which CLI build is asking and,
// for a request made for an agent tool, that it is one.
func setClientHeaders(req *http.Request) {
	settings.mu.RLock()
	version, tool := settings.cliVersion, settings.agentTool
	settings.mu.RUnlock()
	if tool != "" {
		req.Header.Set(AgentHeader, AgentClientMCP)
		req.Header.Set(AgentToolHeader, tool)
	}
	if version == "" {
		return
	}
	req.Header.Set("User-Agent", fmt.Sprintf("alethia-cli/%s (%s; %s)", version, runtime.GOOS, runtime.GOARCH))
	req.Header.Set("X-Alethia-CLI-Version", version)
}

// --- Retry policy ---

const (
	// maxAttempts is the first try plus two retries.
	maxAttempts = 3
	// retryBaseDelay is the ceiling of the first retry's wait; each later retry doubles it.
	retryBaseDelay = 250 * time.Millisecond
	// maxRetryAfter is the longest wait the client will sit out on the server's request. A longer
	// one is not waited for: the answer is returned, and its error carries the wait for the caller.
	maxRetryAfter = 30 * time.Second
)

// retrySleep is the wait between two attempts. A variable so the tests do not sleep.
var retrySleep = time.Sleep

// backoff returns the wait before retry number n (1 for the first): between half of the ceiling
// and the whole of it, the ceiling doubling each time. The random half keeps many clients that
// failed together from returning together.
func backoff(n int) time.Duration {
	ceiling := retryBaseDelay << (n - 1)
	return ceiling/2 + rand.N(ceiling/2+1)
}

// repeatable reports whether sending the request a second time is safe when nobody knows whether
// the first one was acted on. Only a read is: a write has no key the control plane could recognise
// a repeat by, so repeating it could do the thing twice.
func repeatable(req *http.Request) bool {
	return req.Method == http.MethodGet || req.Method == http.MethodHead
}

// redirectError is a redirect the client refused to follow. It is a type so the retry policy can
// tell it from a transient failure: the same request would be redirected the same way again.
type redirectError struct {
	message string
}

// Error renders the refusal.
func (e *redirectError) Error() string { return e.message }

// transientTransportError reports whether a failed round trip is worth repeating. A refused
// redirect and a certificate the client does not trust fail the same way every time. A round trip
// that ran out of time is not repeated either: the caller has already waited the whole timeout, and
// two more would turn one minute into three.
func transientTransportError(err error) bool {
	var redirect *redirectError
	if errors.As(err, &redirect) {
		return false
	}
	var certificate *tls.CertificateVerificationError
	if errors.As(err, &certificate) {
		return false
	}
	var network net.Error
	if errors.As(err, &network) && network.Timeout() {
		return false
	}
	return true
}

// transientStatus reports whether a status says the control plane was briefly unable to answer:
// the three a gateway or a restarting server gives.
func transientStatus(status int) bool {
	return status == http.StatusBadGateway || status == http.StatusServiceUnavailable || status == http.StatusGatewayTimeout
}

// retryWait returns how long to wait before repeating a request that got a transient status, and
// false when it should not be repeated. The server's Retry-After wins over the client's own
// backoff; one longer than maxRetryAfter means "not soon", so the answer is returned instead.
func retryWait(resp *http.Response, n int) (time.Duration, bool) {
	asked := parseRetryAfter(resp.Header.Get("Retry-After"), time.Now())
	if asked == 0 {
		return backoff(n), true
	}
	if asked > maxRetryAfter {
		return 0, false
	}
	return asked, true
}

// nextAttempt returns a copy of the request that can be sent again, or false when its body cannot
// be read a second time.
func nextAttempt(req *http.Request) (*http.Request, bool) {
	next := req.Clone(req.Context())
	if req.Body == nil || req.Body == http.NoBody {
		return next, true
	}
	if req.GetBody == nil {
		return nil, false
	}
	body, err := req.GetBody()
	if err != nil {
		return nil, false
	}
	next.Body = body
	return next, true
}

// discard reads what is left of an answer that will not be used and closes it, so its connection
// can carry the next attempt.
func discard(resp *http.Response) {
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, errorBodyLimit))
	_ = resp.Body.Close()
}

// --- Credential renewal ---

// tokenMu guards every Client's authToken, which send replaces when the credential is renewed. It
// is one lock for the package rather than a field, so a Client stays a plain value that can be
// copied.
var tokenMu sync.RWMutex

// token returns the bearer token the client currently sends.
func (c *Client) token() string {
	tokenMu.RLock()
	defer tokenMu.RUnlock()
	return c.authToken
}

// renewToken asks the registered refresher for a new token and adopts it. It reports false when
// there is no refresher, when it fails, or when it hands back the token that was just refused.
func (c *Client) renewToken() bool {
	settings.mu.RLock()
	refresh := settings.refresh
	settings.mu.RUnlock()
	if refresh == nil {
		return false
	}
	renewed, err := refresh()
	if err != nil || renewed == "" || renewed == c.token() {
		return false
	}
	tokenMu.Lock()
	c.authToken = renewed
	tokenMu.Unlock()
	return true
}

// --- The send loop ---

// send performs one API call and returns the control plane's answer, whatever its status.
//
// A read that gets no answer, or a 502, 503 or 504, is tried up to maxAttempts times with a
// jittered, doubling wait, or the wait the server named in Retry-After. A write is sent once. A 401
// is answered by renewing the credential and sending the same request again, once and for any
// method: a 401 says the request was refused before it was acted on. Each attempt has the client's
// whole timeout to itself.
//
// The error, when there is one, is always a *TransportError.
func (c *Client) send(req *http.Request) (*http.Response, error) {
	setClientHeaders(req)
	renewed := false
	for attempt := 1; ; attempt++ {
		logRequest(req, attempt)
		started := time.Now()
		resp, err := c.httpClient.Do(req)
		elapsed := time.Since(started)

		if err != nil {
			if attempt < maxAttempts && repeatable(req) && transientTransportError(err) {
				if next, ok := nextAttempt(req); ok {
					wait := backoff(attempt)
					logFailure(err, elapsed, wait)
					retrySleep(wait)
					req = next
					continue
				}
			}
			logFailure(err, elapsed, 0)
			return nil, &TransportError{Err: err}
		}

		if resp.StatusCode == http.StatusUnauthorized && !renewed {
			if next, ok := nextAttempt(req); ok && c.renewToken() {
				logResponse(resp, elapsed, "; credential renewed, sending again")
				discard(resp)
				next.Header.Set("Authorization", "Bearer "+c.token())
				req, renewed = next, true
				attempt--
				continue
			}
		}

		if transientStatus(resp.StatusCode) && attempt < maxAttempts && repeatable(req) {
			if wait, ok := retryWait(resp, attempt); ok {
				if next, ok := nextAttempt(req); ok {
					logResponse(resp, elapsed, fmt.Sprintf("; retrying in %s", wait.Round(time.Millisecond)))
					discard(resp)
					retrySleep(wait)
					req = next
					continue
				}
			}
		}

		logResponse(resp, elapsed, "")
		return resp, nil
	}
}

// --- The request log ---

// redacted stands in for every value the log does not print.
const redacted = "[redacted]"

// loggedHeaders are the request headers whose VALUES the request log prints. It is an allowlist:
// a header that is not named here is logged by name with its value replaced, so a header added to
// this client later is withheld until someone decides it is safe to show. None of these can carry a
// credential.
var loggedHeaders = map[string]bool{
	"Accept":                true,
	"Content-Length":        true,
	"Content-Type":          true,
	"If-Match":              true,
	"User-Agent":            true,
	"X-Alethia-Agent":       true,
	"X-Alethia-Agent-Tool":  true,
	"X-Alethia-Cli-Version": true,
	"X-Alethia-Org":         true,
}

// loggedQueryKeys are the query parameters whose values the request log prints, on the same rule.
var loggedQueryKeys = map[string]bool{
	"after":  true,
	"env":    true,
	"format": true,
	"id":     true,
	"kind":   true,
	"limit":  true,
	"name":   true,
	"offset": true,
	"status": true,
}

// logURL renders a request's address for the log: scheme, host and path, then the query with every
// value outside loggedQueryKeys replaced. Credentials written into the address itself, and the
// fragment, are left out.
func logURL(u *url.URL) string {
	out := u.Scheme + "://" + u.Host + u.EscapedPath()
	query := u.Query()
	if len(query) == 0 {
		return out
	}
	keys := make([]string, 0, len(query))
	for key := range query {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		for _, value := range query[key] {
			if !loggedQueryKeys[key] {
				value = redacted
			} else {
				value = url.QueryEscape(value)
			}
			parts = append(parts, url.QueryEscape(key)+"="+value)
		}
	}
	return out + "?" + strings.Join(parts, "&")
}

// logRequest writes the request line and the request's headers. Bodies are never written.
func logRequest(req *http.Request, attempt int) {
	w := debugOutput()
	if w == nil {
		return
	}
	var b strings.Builder
	fmt.Fprintf(&b, "debug: api > %s %s (attempt %d of %d)\n", req.Method, logURL(req.URL), attempt, maxAttempts)
	names := make([]string, 0, len(req.Header))
	for name := range req.Header {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		value := redacted
		if loggedHeaders[http.CanonicalHeaderKey(name)] {
			value = strings.Join(req.Header[name], ", ")
		}
		fmt.Fprintf(&b, "debug: api >   %s: %s\n", name, value)
	}
	_, _ = io.WriteString(w, b.String())
}

// logResponse writes the answer's status, request id and duration, and what the client does next.
func logResponse(resp *http.Response, elapsed time.Duration, next string) {
	w := debugOutput()
	if w == nil {
		return
	}
	requestID := strings.TrimSpace(resp.Header.Get("X-Request-Id"))
	if requestID == "" {
		requestID = "-"
	}
	fmt.Fprintf(w, "debug: api < %d request_id=%s in %s%s\n", resp.StatusCode, requestID, elapsed.Round(time.Millisecond), next)
}

// logFailure writes a round trip that got no answer, and the wait before the next attempt when
// there is one. The address is dropped from the failure's text: the HTTP client's own rendering
// repeats it with its query unredacted.
func logFailure(err error, elapsed, wait time.Duration) {
	w := debugOutput()
	if w == nil {
		return
	}
	var addressed *url.Error
	if errors.As(err, &addressed) {
		err = addressed.Err
	}
	next := ""
	if wait > 0 {
		next = fmt.Sprintf("; retrying in %s", wait.Round(time.Millisecond))
	}
	fmt.Fprintf(w, "debug: api ! no answer in %s: %v%s\n", elapsed.Round(time.Millisecond), err, next)
}
