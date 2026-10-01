// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package kubeaccess

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Rendering (#5250 §4 and decision 4): the two kubeconfig shapes a mint produces, and the
// ExecCredential the exec shape's plugin prints.
//
//   - Static: the endpoint and CA pinned, plus a bearer token or a client certificate. It works
//     until the credential expires and needs nothing installed. Hetzner/Alibaba admin and every
//     console download are this shape.
//   - Exec: the endpoint and CA pinned, plus a client.authentication.k8s.io/v1 exec plugin that runs
//     `alethia cluster token <cluster-id>`. The file holds no credential at all; every kubectl call
//     asks the CLI, which re-mints through the control plane (re-checking authz) when its cached
//     token expires. The CLI default on AWS/GCP/Azure.
//
// Both refuse an unpinned cluster: no https server, or no parsable CA, is an error, and
// insecure-skip-tls-verify is never written. Nothing here logs, and no error quotes a credential.

// ErrRender is wrapped by every rendering error.
var ErrRender = errors.New("kubeconfig render")

// ExecCredentialAPIVersion is the exec-plugin API version both the kubeconfig's exec stanza and the
// ExecCredential output use. v1 is the GA version (Kubernetes 1.22+); it requires interactiveMode.
const ExecCredentialAPIVersion = "client.authentication.k8s.io/v1"

// DefaultExecCommand is the program an exec kubeconfig runs, resolved on the user's PATH.
const DefaultExecCommand = "alethia"

// Target is the cluster a kubeconfig points at and the names it is filed under. Server and CAData
// come from the cluster's own record and cloud API (mint-bind, #5250 §2), never from a request.
type Target struct {
	// Project and Env name the context: alethia-<project>-<env>.
	Project string
	Env     string
	// Server is the API server URL (https).
	Server string
	// CAData is the cluster CA bundle, base64-encoded PEM, as kubeconfig's certificate-authority-data.
	CAData string
}

// ContextName returns `alethia-<project>-<env>`, each part folded to lowercase letters, digits and
// single hyphens, so a project called "Web Shop" and env "prod" file as alethia-web-shop-prod. The
// same name is used for the kubeconfig's cluster, user and context entries.
func (t Target) ContextName() (string, error) {
	p, e := slug(t.Project), slug(t.Env)
	if p == "" || e == "" {
		return "", fmt.Errorf("%w: a context name needs a project and an env (got %q, %q)", ErrRender, t.Project, t.Env)
	}
	return "alethia-" + p + "-" + e, nil
}

// slug folds s to [a-z0-9] runs joined by single hyphens.
func slug(s string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(s) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			if dash && b.Len() > 0 {
				b.WriteByte('-')
			}
			b.WriteRune(r)
			dash = false
			continue
		}
		dash = true
	}
	return b.String()
}

// pinned validates the target's endpoint and CA and returns the context name.
func (t Target) pinned() (string, error) {
	name, err := t.ContextName()
	if err != nil {
		return "", err
	}
	if _, err := parseServer(t.Server); err != nil {
		return "", fmt.Errorf("%w: %w", ErrRender, err)
	}
	if _, err := caPool(t.CAData); err != nil {
		return "", fmt.Errorf("%w: %w", ErrRender, err)
	}
	return name, nil
}

// StaticCredential is what a static kubeconfig authenticates with: a bearer token, or a client
// certificate and key (base64-encoded PEM). Exactly one.
type StaticCredential struct {
	Token          string
	ClientCertData string
	ClientKeyData  string
}

// The kubeconfig wire shape, as structs so the key order — and so the golden files — are stable.
type (
	kubeconfig struct {
		APIVersion     string         `yaml:"apiVersion"`
		Kind           string         `yaml:"kind"`
		Clusters       []namedCluster `yaml:"clusters"`
		Contexts       []namedContext `yaml:"contexts"`
		CurrentContext string         `yaml:"current-context"`
		Users          []namedUser    `yaml:"users"`
	}
	namedCluster struct {
		Name    string      `yaml:"name"`
		Cluster clusterInfo `yaml:"cluster"`
	}
	clusterInfo struct {
		Server                   string `yaml:"server"`
		CertificateAuthorityData string `yaml:"certificate-authority-data"`
	}
	namedContext struct {
		Name    string      `yaml:"name"`
		Context contextInfo `yaml:"context"`
	}
	contextInfo struct {
		Cluster string `yaml:"cluster"`
		User    string `yaml:"user"`
	}
	namedUser struct {
		Name string   `yaml:"name"`
		User userInfo `yaml:"user"`
	}
	userInfo struct {
		Token                 string      `yaml:"token,omitempty"`
		ClientCertificateData string      `yaml:"client-certificate-data,omitempty"`
		ClientKeyData         string      `yaml:"client-key-data,omitempty"`
		Exec                  *execConfig `yaml:"exec,omitempty"`
	}
	execConfig struct {
		APIVersion         string   `yaml:"apiVersion"`
		Command            string   `yaml:"command"`
		Args               []string `yaml:"args"`
		InstallHint        string   `yaml:"installHint"`
		InteractiveMode    string   `yaml:"interactiveMode"`
		ProvideClusterInfo bool     `yaml:"provideClusterInfo"`
	}
)

// assemble builds the single-cluster, single-context kubeconfig around user and marshals it.
func assemble(name string, t Target, user userInfo) ([]byte, error) {
	kc := kubeconfig{
		APIVersion:     "v1",
		Kind:           "Config",
		Clusters:       []namedCluster{{Name: name, Cluster: clusterInfo{Server: strings.TrimSpace(t.Server), CertificateAuthorityData: strings.TrimSpace(t.CAData)}}},
		Contexts:       []namedContext{{Name: name, Context: contextInfo{Cluster: name, User: name}}},
		CurrentContext: name,
		Users:          []namedUser{{Name: name, User: user}},
	}
	out, err := yaml.Marshal(kc)
	if err != nil {
		return nil, fmt.Errorf("%w: marshal kubeconfig %s", ErrRender, name)
	}
	return out, nil
}

// RenderStaticKubeconfig renders a self-contained kubeconfig for t that authenticates with cred. It
// refuses an unpinned target and anything other than exactly one well-formed credential. The result
// contains the credential; write it 0600 and never log it.
func RenderStaticKubeconfig(t Target, cred StaticCredential) ([]byte, error) {
	name, err := t.pinned()
	if err != nil {
		return nil, err
	}
	hasCert := cred.ClientCertData != "" || cred.ClientKeyData != ""
	if (cred.Token != "") == hasCert {
		return nil, fmt.Errorf("%w: a static kubeconfig carries exactly one credential: a token, or a client certificate and key", ErrRender)
	}
	var user userInfo
	if hasCert {
		if _, err := clientCertificate(cred.ClientCertData, cred.ClientKeyData); err != nil {
			return nil, fmt.Errorf("%w: %w", ErrRender, err)
		}
		user = userInfo{ClientCertificateData: strings.TrimSpace(cred.ClientCertData), ClientKeyData: strings.TrimSpace(cred.ClientKeyData)}
	} else {
		if strings.ContainsAny(cred.Token, " \t\r\n") {
			return nil, fmt.Errorf("%w: the token contains whitespace, which no bearer token does", ErrRender)
		}
		user = userInfo{Token: cred.Token}
	}
	return assemble(name, t, user)
}

// RenderExecKubeconfig renders a kubeconfig for t whose user is an exec plugin running
// `<command> cluster token <clusterID>` (command defaults to DefaultExecCommand) with
// interactiveMode Never — kubectl in CI or an IDE must fail, never hang on a prompt — and
// provideClusterInfo false, since the plugin resolves the cluster by id, not from kubectl. The file
// holds no credential. clusterID must be the canonical lowercase UUID of the project_cluster row.
func RenderExecKubeconfig(t Target, clusterID, command string) ([]byte, error) {
	name, err := t.pinned()
	if err != nil {
		return nil, err
	}
	if !canonicalUUID.MatchString(clusterID) {
		return nil, fmt.Errorf("%w: cluster id %q is not a canonical lowercase uuid", ErrRender, clusterID)
	}
	if command == "" {
		command = DefaultExecCommand
	}
	if strings.TrimSpace(command) != command || strings.ContainsAny(command, "\r\n") {
		return nil, fmt.Errorf("%w: exec command %q has surrounding whitespace or a newline", ErrRender, command)
	}
	return assemble(name, t, userInfo{Exec: &execConfig{
		APIVersion:         ExecCredentialAPIVersion,
		Command:            command,
		Args:               []string{"cluster", "token", clusterID},
		InstallHint:        "This kubeconfig gets its credentials from the Alethia CLI. Install `alethia` and sign in with `alethia login`.",
		InteractiveMode:    "Never",
		ProvideClusterInfo: false,
	}})
}

// execCredential is the client.authentication.k8s.io/v1 ExecCredential an exec plugin prints.
type execCredential struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Status     struct {
		ExpirationTimestamp string `json:"expirationTimestamp"`
		Token               string `json:"token"`
	} `json:"status"`
}

// RenderExecCredential renders the ExecCredential JSON that `alethia cluster token` prints on stdout
// for kubectl: the token and its expiry (RFC 3339, UTC), so client-go re-runs the plugin when it
// lapses. It refuses an empty token or a zero expiry; it does not refuse an expired one, since the
// caller decides whether to re-mint first.
func RenderExecCredential(token string, expiresAt time.Time) ([]byte, error) {
	if token == "" {
		return nil, fmt.Errorf("%w: an ExecCredential needs a token", ErrRender)
	}
	if expiresAt.IsZero() {
		return nil, fmt.Errorf("%w: an ExecCredential needs an expiry", ErrRender)
	}
	var ec execCredential
	ec.APIVersion, ec.Kind = ExecCredentialAPIVersion, "ExecCredential"
	ec.Status.ExpirationTimestamp = expiresAt.UTC().Format(time.RFC3339)
	ec.Status.Token = token
	out, err := json.Marshal(ec)
	if err != nil {
		return nil, fmt.Errorf("%w: marshal ExecCredential", ErrRender)
	}
	return append(out, '\n'), nil
}
