// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"strings"
	"time"

	yaml "gopkg.in/yaml.v3"
)

// Two of the five clouds hand back their admin credential as a COMPLETE kubeconfig with an embedded
// client certificate rather than a bearer token: Talos (MintTalosKubeconfig) and ACK
// (DescribeClusterUserKubeconfig). The mint needs the pieces, not the file — the endpoint and CA to
// pin, the certificate and key to authenticate the read-only tier's setup calls, and the
// certificate's real expiry to state in expires_at — and it re-renders the user-facing file itself
// (kubeaccess.RenderStaticKubeconfig) so every cloud's kubeconfig names its context the same way.
//
// Nothing here logs, and no error quotes the input: the input carries a private key.

// certKubeconfig is the slice of a kubeconfig the mint reads.
type certKubeconfig struct {
	CurrentContext string `yaml:"current-context"`
	Clusters       []struct {
		Name    string `yaml:"name"`
		Cluster struct {
			Server                   string `yaml:"server"`
			CertificateAuthorityData string `yaml:"certificate-authority-data"`
		} `yaml:"cluster"`
	} `yaml:"clusters"`
	Users []struct {
		Name string `yaml:"name"`
		User struct {
			ClientCertificateData string `yaml:"client-certificate-data"`
			ClientKeyData         string `yaml:"client-key-data"`
		} `yaml:"user"`
	} `yaml:"users"`
	Contexts []struct {
		Name    string `yaml:"name"`
		Context struct {
			Cluster string `yaml:"cluster"`
			User    string `yaml:"user"`
		} `yaml:"context"`
	} `yaml:"contexts"`
}

// adminCertConn is a cluster's admin connection as a client certificate.
type adminCertConn struct {
	Server         string
	CAData         string
	ClientCertData string
	ClientKeyData  string
	// NotAfter is the client certificate's own expiry — the credential's TRUE lifetime.
	NotAfter time.Time
}

// parseCertKubeconfig extracts the current context's server, CA and client certificate from a
// kubeconfig (raw YAML, or base64-wrapped as some ACK responses return it), and reads the
// certificate's NotAfter. It refuses a kubeconfig whose current user authenticates any other way.
func parseCertKubeconfig(raw string) (adminCertConn, error) {
	kc, err := decodeCertKubeconfig(raw)
	if err != nil {
		return adminCertConn{}, err
	}
	clusterName, userName := "", ""
	for _, c := range kc.Contexts {
		if c.Name == kc.CurrentContext {
			clusterName, userName = c.Context.Cluster, c.Context.User
		}
	}
	if clusterName == "" && userName == "" {
		// No (resolvable) current-context: accept only the unambiguous single-entry shape both
		// clouds return, never a guess between two clusters.
		if len(kc.Clusters) != 1 || len(kc.Users) != 1 {
			return adminCertConn{}, errors.New("certificate kubeconfig: no current context and more than one cluster or user")
		}
		clusterName, userName = kc.Clusters[0].Name, kc.Users[0].Name
	}
	var out adminCertConn
	found := false
	for _, c := range kc.Clusters {
		if c.Name == clusterName {
			out.Server = strings.TrimSpace(c.Cluster.Server)
			out.CAData = strings.TrimSpace(c.Cluster.CertificateAuthorityData)
			found = true
		}
	}
	if !found || out.Server == "" || out.CAData == "" {
		return adminCertConn{}, errors.New("certificate kubeconfig: the current cluster has no server or CA")
	}
	found = false
	for _, u := range kc.Users {
		if u.Name == userName {
			out.ClientCertData = strings.TrimSpace(u.User.ClientCertificateData)
			out.ClientKeyData = strings.TrimSpace(u.User.ClientKeyData)
			found = true
		}
	}
	if !found || out.ClientCertData == "" || out.ClientKeyData == "" {
		return adminCertConn{}, errors.New("certificate kubeconfig: the current user carries no client certificate and key")
	}
	notAfter, err := certNotAfter(out.ClientCertData)
	if err != nil {
		return adminCertConn{}, err
	}
	out.NotAfter = notAfter
	if !strings.HasPrefix(out.Server, "https://") {
		out.Server = "https://" + out.Server
	}
	return out, nil
}

// decodeCertKubeconfig parses raw as YAML, then once more after a base64 unwrap.
func decodeCertKubeconfig(raw string) (certKubeconfig, error) {
	var kc certKubeconfig
	if err := yaml.Unmarshal([]byte(raw), &kc); err == nil && len(kc.Clusters) > 0 {
		return kc, nil
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(raw))
	if err != nil {
		return certKubeconfig{}, errors.New("certificate kubeconfig: not a kubeconfig")
	}
	kc = certKubeconfig{}
	if err := yaml.Unmarshal(decoded, &kc); err != nil || len(kc.Clusters) == 0 {
		return certKubeconfig{}, errors.New("certificate kubeconfig: not a kubeconfig")
	}
	return kc, nil
}

// certNotAfter decodes a base64 PEM certificate (the first block) and returns its NotAfter.
func certNotAfter(certData string) (time.Time, error) {
	pemBytes, err := base64.StdEncoding.DecodeString(certData)
	if err != nil {
		return time.Time{}, errors.New("certificate kubeconfig: client-certificate-data is not base64")
	}
	block, _ := pem.Decode(pemBytes)
	if block == nil || block.Type != "CERTIFICATE" {
		return time.Time{}, errors.New("certificate kubeconfig: client-certificate-data holds no PEM certificate")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return time.Time{}, errors.New("certificate kubeconfig: the client certificate does not parse")
	}
	return cert.NotAfter, nil
}
