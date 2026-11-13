// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package git

import (
	"net/url"
	"regexp"
	"strings"
)

// UnparsedRepoURL is what RedactURL prints for a remote it cannot parse. A fixed placeholder, not a
// best-effort cut of the input: an input that does not parse has no reliable boundary between its
// userinfo and its host, so no part of it is printed.
const UnparsedRepoURL = "(unparsed repo URL)"

// remoteURLUnparsed replaces the whole text of a transport error about a remote URL that does not
// parse: nothing in such a message can be shown to be free of the URL's userinfo.
const remoteURLUnparsed = "the remote URL could not be parsed"

// RedactURL returns the form of a git remote URL that is safe to print in an error or a log line:
// scheme, host (with port) and path. Userinfo, query and fragment are dropped. An scp-style
// `user@host:path` prints as `host:path`; a bare `host/owner/repo` prints as given minus any
// userinfo; anything that does not parse prints as UnparsedRepoURL.
func RedactURL(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return UnparsedRepoURL
	}
	if strings.Contains(s, "://") {
		u, err := url.Parse(s)
		if err != nil || u.Scheme == "" || (u.Host == "" && u.Scheme != "file") {
			return UnparsedRepoURL
		}
		return (&url.URL{Scheme: u.Scheme, Host: u.Host, Path: u.Path, RawPath: u.RawPath}).String()
	}
	if host, path, ok := splitSCP(s); ok {
		if i := strings.IndexAny(path, "?#"); i >= 0 {
			path = path[:i]
		}
		if strings.Contains(path, "@") {
			// An `@` past the colon means the split above may have cut inside a userinfo.
			return UnparsedRepoURL
		}
		return host + ":" + path
	}
	// A bare `[userinfo@]host/path`: parse it as a scheme-relative URL so userinfo is split off by
	// the same rules as above, and print it without inventing a scheme.
	u, err := url.Parse("//" + s)
	if err != nil || u.Host == "" {
		return UnparsedRepoURL
	}
	return u.Host + (&url.URL{Path: u.Path, RawPath: u.RawPath}).String()
}

// splitSCP splits an scp-style remote `[user@]host:path` into host and path. It reads the part
// before the first slash: past its last `@`, a colon ends the host. A bare `[userinfo@]host/path`
// has no colon there (a password's colon sits BEFORE the `@`), so it is not split.
func splitSCP(s string) (host, path string, ok bool) {
	prefix := s
	if i := strings.Index(s, "/"); i >= 0 {
		prefix = s[:i]
	}
	rest := s[strings.LastIndex(prefix, "@")+1:]
	colon := strings.Index(rest, ":")
	if colon <= 0 || (strings.Contains(rest, "/") && colon > strings.Index(rest, "/")) {
		return "", "", false
	}
	return rest[:colon], rest[colon+1:], true
}

// redactedURL is RedactURL of this wrapper's remote, for errors and progress lines.
func (g *GIT) redactedURL() string {
	return RedactURL(g.RepoURL)
}

// scrubbedError wraps a transport error whose text may carry the remote's userinfo. It keeps the
// original in the chain (errors.Is / errors.As still see the provider's failure) and only rewrites
// the text that is printed.
type scrubbedError struct {
	err error
	msg string
}

// Error returns the cause's text with the remote's userinfo removed.
func (e *scrubbedError) Error() string { return e.msg }

// Unwrap returns the original transport error.
func (e *scrubbedError) Unwrap() error { return e.err }

// scrubCause returns err with every occurrence of rawURL's userinfo removed from its text. A
// transport library may put the endpoint it dialled into its own error message, and that endpoint
// is built from the URL as given; this is what keeps such a message from printing the userinfo
// back. The error chain is unchanged.
func scrubCause(rawURL string, err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	clean := scrubUserinfo(rawURL, msg)
	if clean == msg {
		return err
	}
	return &scrubbedError{err: err, msg: clean}
}

// scrubUserinfo removes rawURL itself, and its userinfo in each spelling a transport might print,
// from msg. An scp-style remote is skipped: its user is the ssh login (`git`), not a credential, and
// removing that word would mangle unrelated text.
func scrubUserinfo(rawURL, msg string) string {
	s := strings.TrimSpace(rawURL)
	if s != "" {
		msg = strings.ReplaceAll(msg, s, RedactURL(s))
	}
	parse := s
	if !strings.Contains(s, "://") {
		if _, _, scp := splitSCP(s); scp {
			return msg
		}
		parse = "//" + s // a bare `[userinfo@]host/path`, read as RedactURL reads it
	}
	u, err := url.Parse(parse)
	if err != nil {
		// The remote does not parse, so its userinfo cannot be told apart, and a transport's error may
		// quote the input in an escaped form a verbatim replace would miss. Say what happened instead;
		// the original error stays in the chain for errors.Is / errors.As.
		return remoteURLUnparsed
	}
	if u.User == nil {
		return msg
	}
	user := u.User.Username()
	pass, hasPass := u.User.Password()
	// `user@` or `user:<anything>@` — the password as given, escaped, or already masked by net/http
	// (`user:***@`): every spelling ends at the `@`.
	for _, name := range []string{u.User.String(), url.PathEscape(user), url.QueryEscape(user), user} {
		if name == "" {
			continue
		}
		msg = regexp.MustCompile(regexp.QuoteMeta(name)+`(?::[^@\s/]*)?@`).ReplaceAllString(msg, "")
	}
	if hasPass && pass != "" {
		msg = strings.ReplaceAll(msg, pass, "***")
	}
	// RedactURL drops the query and fragment, so the cause text does too (a transport may print the
	// URL with the userinfo masked, which the verbatim replace above cannot match).
	if u.RawQuery != "" {
		msg = strings.ReplaceAll(msg, "?"+u.RawQuery, "")
	}
	if u.Fragment != "" {
		msg = strings.ReplaceAll(msg, "#"+u.EscapedFragment(), "")
	}
	return msg
}
