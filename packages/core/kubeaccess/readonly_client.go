// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package kubeaccess

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Why a twenty-line REST client and not client-go: packages/core carries no Kubernetes client
// library (it shells out to kubectl elsewhere, and its cloud resolvers are stdlib REST), and this
// package is also imported by the `alethia` CLI for Seal/Open and rendering. client-go would pull
// k8s.io/apimachinery and friends into the CLI's module and binary for five PATCH/POST/DELETE calls.
// The read-only tier talks to exactly five endpoints, all listed in readonly.go.

// KubeAPI is the one seam between the read-only tier and a Kubernetes API server: send a request
// with an optional body, get back the status code and the response body. [*Client] is the real
// implementation; tests substitute an in-memory API server.
//
// A transport failure (no response at all) is an error; any HTTP response, including a 4xx/5xx, is
// a status code, so the caller can tell "the server said 404" from "the server was unreachable".
type KubeAPI interface {
	Do(ctx context.Context, method, path, contentType string, body []byte) (status int, respBody []byte, err error)
}

// Conn is how to reach one cluster's API server: the pinned endpoint and CA, and ONE credential —
// a bearer token, or a client certificate and key (Talos admin certs, ACK user kubeconfigs). The
// runner builds it from the cluster's cloud-native ADMIN credential, which is what may create RBAC.
type Conn struct {
	// Server is the API server URL; it must be https.
	Server string
	// CAData is the cluster CA bundle, base64-encoded PEM (the kubeconfig
	// `certificate-authority-data` form). It is the ONLY trust root: the system pool is not used.
	CAData string
	// Token is a bearer token. Mutually exclusive with the client certificate.
	Token string
	// ClientCertData and ClientKeyData are a base64-encoded PEM client certificate and key.
	ClientCertData string
	ClientKeyData  string
	// Timeout bounds each request; zero means 30s.
	Timeout time.Duration
}

// Client is a minimal Kubernetes REST client over one [Conn]. It never logs, and its errors never
// carry the credential.
type Client struct {
	base  *url.URL
	http  *http.Client
	token string
}

// ErrKubeAPI is wrapped by every error the read-only tier returns, so a caller can tell a cluster
// failure from a seal failure without matching strings.
var ErrKubeAPI = errors.New("kubernetes api")

// NewClient validates conn and builds a client that trusts only conn's CA. It refuses a non-https
// server, a missing or unparsable CA, and anything other than exactly one credential.
func NewClient(conn Conn) (*Client, error) {
	base, err := parseServer(conn.Server)
	if err != nil {
		return nil, err
	}
	pool, err := caPool(conn.CAData)
	if err != nil {
		return nil, err
	}
	hasCert := conn.ClientCertData != "" || conn.ClientKeyData != ""
	if (conn.Token != "") == hasCert {
		return nil, fmt.Errorf("%w: a connection carries exactly one credential: a token, or a client certificate and key", ErrKubeAPI)
	}
	tlsConf := &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	if hasCert {
		pair, err := clientCertificate(conn.ClientCertData, conn.ClientKeyData)
		if err != nil {
			return nil, err
		}
		tlsConf.Certificates = []tls.Certificate{pair}
	}
	timeout := conn.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	return &Client{
		base:  base,
		token: conn.Token,
		http: &http.Client{
			Timeout:   timeout,
			Transport: &http.Transport{TLSClientConfig: tlsConf, Proxy: http.ProxyFromEnvironment},
			// A redirect would carry the Authorization header somewhere the CA pin never vetted.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}, nil
}

// Do sends one request to the API server. path is absolute ("/api/v1/..."), with any query string.
func (c *Client) Do(ctx context.Context, method, path, contentType string, body []byte) (int, []byte, error) {
	ref, err := url.Parse(path)
	if err != nil || !strings.HasPrefix(ref.Path, "/") || ref.Host != "" || ref.Scheme != "" {
		return 0, nil, fmt.Errorf("%w: request path %q is not an absolute API path", ErrKubeAPI, path)
	}
	target := *c.base
	target.Path = strings.TrimSuffix(c.base.Path, "/") + ref.Path
	target.RawPath = ""
	target.RawQuery = ref.RawQuery
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, target.String(), rdr)
	if err != nil {
		return 0, nil, fmt.Errorf("%w: build %s %s: %w", ErrKubeAPI, method, ref.Path, err)
	}
	req.Header.Set("Accept", "application/json")
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		// *url.Error names the URL (server + path), never a header, so the token cannot ride along.
		return 0, nil, fmt.Errorf("%w: %s %s: %w", ErrKubeAPI, method, ref.Path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return 0, nil, fmt.Errorf("%w: read %s %s: %w", ErrKubeAPI, method, ref.Path, err)
	}
	return resp.StatusCode, data, nil
}

// parseServer accepts only an absolute https URL with a host and no credentials, query or fragment.
func parseServer(server string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(server))
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("%w: server %q is not an https URL with a host", ErrKubeAPI, server)
	}
	return u, nil
}

// decodeB64PEM decodes a base64-encoded PEM blob (standard alphabet, padded, as kubeconfig fields
// carry it). what names the field for the error, which never echoes the value.
func decodeB64PEM(what, data string) ([]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(data))
	if err != nil || len(raw) == 0 {
		return nil, fmt.Errorf("%w: %s is not base64-encoded PEM", ErrKubeAPI, what)
	}
	return raw, nil
}

// caPool parses the cluster CA bundle into a pool that contains it and nothing else.
func caPool(caData string) (*x509.CertPool, error) {
	if strings.TrimSpace(caData) == "" {
		return nil, fmt.Errorf("%w: the cluster CA is required (it is the only trust root)", ErrKubeAPI)
	}
	pemBytes, err := decodeB64PEM("the cluster CA", caData)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pemBytes) {
		return nil, fmt.Errorf("%w: the cluster CA holds no PEM certificate", ErrKubeAPI)
	}
	return pool, nil
}

// clientCertificate parses a base64-encoded PEM certificate and key into a TLS client certificate.
// Its error never wraps the tls error, which can quote key material in its text.
func clientCertificate(certData, keyData string) (tls.Certificate, error) {
	certPEM, err := decodeB64PEM("the client certificate", certData)
	if err != nil {
		return tls.Certificate{}, err
	}
	keyPEM, err := decodeB64PEM("the client key", keyData)
	if err != nil {
		return tls.Certificate{}, err
	}
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("%w: the client certificate and key do not form a pair", ErrKubeAPI)
	}
	return pair, nil
}

// APIError is a non-success HTTP answer from the API server. It carries the server's Status reason
// and a bounded message, never a request or response body.
type APIError struct {
	Method  string
	Path    string
	Code    int
	Reason  string
	Message string
}

// Error renders the API error without any body content beyond the server's short Status message.
func (e *APIError) Error() string {
	msg := fmt.Sprintf("%s %s: HTTP %d", e.Method, e.Path, e.Code)
	if e.Reason != "" {
		msg += " " + e.Reason
	}
	if e.Message != "" {
		msg += ": " + e.Message
	}
	return msg
}

// Unwrap lets errors.Is(err, ErrKubeAPI) hold for an API error.
func (e *APIError) Unwrap() error { return ErrKubeAPI }

// maxStatusMessage bounds how much of a server's Status message an error repeats.
const maxStatusMessage = 300

// apiError builds an APIError from a non-2xx response, reading only the Status reason and message.
func apiError(method, path string, code int, body []byte) *APIError {
	var st struct {
		Reason  string `json:"reason"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(body, &st)
	msg := st.Message
	if len(msg) > maxStatusMessage {
		msg = msg[:maxStatusMessage] + "…"
	}
	if i := strings.IndexByte(path, '?'); i >= 0 {
		path = path[:i]
	}
	return &APIError{Method: method, Path: path, Code: code, Reason: st.Reason, Message: msg}
}

// isStatus reports whether err is an APIError with the given HTTP code.
func isStatus(err error, code int) bool {
	var ae *APIError
	return errors.As(err, &ae) && ae.Code == code
}

// call sends one request and decodes a 2xx JSON answer into out (when out is non-nil). A non-2xx
// answer becomes an *APIError.
func call(ctx context.Context, kube KubeAPI, method, path, contentType string, in, out any) error {
	var body []byte
	if in != nil {
		var err error
		if body, err = json.Marshal(in); err != nil {
			return fmt.Errorf("%w: encode %s %s: %w", ErrKubeAPI, method, path, err)
		}
	}
	code, resp, err := kube.Do(ctx, method, path, contentType, body)
	if err != nil {
		return err
	}
	if code < 200 || code > 299 {
		return apiError(method, path, code, resp)
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(resp, out); err != nil {
		// The decode error is NOT wrapped. Today encoding/json's errors describe the body (an offending
		// character, an offset, a field path) rather than quote it, but that is its choice, not a
		// contract, and this body may be a TokenRequest answer carrying a token. This package's rule is
		// that an error describes and never quotes, so it does not depend on json's wording.
		return fmt.Errorf("%w: %s %s answered with a body that is not the expected JSON", ErrKubeAPI, method, path)
	}
	return nil
}
