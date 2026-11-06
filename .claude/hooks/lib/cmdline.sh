#!/usr/bin/env bash
# shellcheck disable=SC2034,SC2088
# (SC2034: the functions here SET globals — CMD, ABSPATH, EXPANDED … — for the sourcing hook.
#  SC2088: a quoted "~/" is a literal pattern to match in command text, not a path to expand.)
#
# Shared command-text parsing for .claude/hooks/guard-spend.sh and .claude/hooks/guard-destroy.sh.
#
# Sourced, never executed. Everything here is pure bash (parameter expansion and `read`), so the
# common path of a hook that sources it costs ONE fork — the `jq` that reads the payload — and
# nothing else. Both hooks run on every Bash call, so a fork per segment or per word would be felt.
#
# WHAT A "SEGMENT" IS, AND THE BOUNDARY OF THIS PARSER
#   `$(…)` and backtick bodies are lifted out as segments of their own; the text is then split on
#   `&&`, `||`, `;`, `|`, `&` and newlines — INCLUDING inside quotes, the same deliberate choice guard-runtime.sh makes, so
#   `sh -c "git push origin main"` still yields a segment that starts with `git push`. Each segment
#   is then normalised: leading `VAR=value` assignments are recorded (SEG_ENV) and stripped, and the
#   wrapper words `sudo env xargs command builtin exec nohup time then do else if while ! { (` and a
#   `sh|bash|zsh -c` prefix are peeled off, so what remains starts with the program that runs.
#
#   It does NOT: expand variables or globs, follow aliases or shell functions, open a script file
#   and judge what is inside it (`bash some-script.sh` is judged as `bash`), or decode text that is
#   built at run time (`eval "$(…)"`, base64). That is the classifier half's job (user settings);
#   this layer is deterministic text matching and says so.

# cmdline_read_payload — read the hook JSON on stdin into CMD (the command) and CWD.
# One jq call. The cwd is printed first so a multi-line command reads back intact.
cmdline_read_payload() {
	CMD=""
	CWD=""
	if command -v jq >/dev/null 2>&1; then
		{
			IFS= read -r CWD
			CMD="$(cat)"
		} < <(jq -r '(.cwd // ""), (.tool_input.command // "")' 2>/dev/null)
	else
		cat >/dev/null
	fi
	[ -n "$CWD" ] || CWD="$PWD"
}

# cmdline_strip_heredocs <text> — sets STRIPPED: the text with each heredoc BODY removed, unless
# the heredoc feeds a shell (`bash <<EOF`, `ssh host <<EOF`, `cat <<EOF | sh`), whose body is
# commands. `python3 - <<EOF` and `cat > f <<EOF` bodies are data: python source, a file being
# written. Writing a script and then running it (`bash f`) is the stated script-file boundary.
cmdline_strip_heredocs() {
	local text="$1" out="" line word="" keep=0 nl=$'\n' head re
	# `(^|[^<])` so a here-STRING (`<<<word`) is not read as a heredoc whose terminator never comes
	re='(^|[^<])<<-?[[:space:]]*["'"'"']?([A-Za-z_][A-Za-z0-9_]*)["'"'"']?'
	while IFS= read -r line || [ -n "$line" ]; do
		if [ -n "$word" ]; then
			local trimmed="${line#"${line%%[![:space:]]*}"}"
			if [ "$trimmed" = "$word" ]; then
				word=""
				out="$out$nl"
				continue
			fi
			[ "$keep" = 1 ] && out="$out$line$nl"
			continue
		fi
		out="$out$line$nl"
		if [[ "$line" =~ $re ]]; then
			word="${BASH_REMATCH[2]}"
			head="${line%%<<*}"
			head="${head##*[;&|(]}"
			head="${head#"${head%%[![:space:]]*}"}"
			keep=0
			case "${head%%[[:space:]]*}" in bash | sh | zsh | dash | ssh | sudo | eval | source | . | xargs) keep=1 ;; esac
			[[ "$line" =~ \|[[:space:]]*(sudo[[:space:]]+)?(ba|z|da)?sh([[:space:]]|$) ]] && keep=1
		fi
	done <<<"$text"
	STRIPPED="$out"
}

# cmdline_join_quoted_newlines <text> — sets JOINED: newlines INSIDE a quoted string become
# spaces, so a multi-line `--body "…"` is one segment, not a stack of lines that each look like a
# command. Only newlines: `;`, `&` and `|` inside quotes are still split on (the `sh -c "a; b"`
# case). It jumps quote to quote with parameter expansion — a per-character loop cost >100 ms on
# a 2 KB comment body — and runs only for text that has both a newline and a quote.
cmdline_join_quoted_newlines() {
	local rest="$1" out="" pre q body chunk bs nl=$'\n'
	case "$rest" in *"$nl"*) ;; *)
		JOINED="$rest"
		return
		;;
	esac
	case "$rest" in *\"* | *\'*) ;; *)
		JOINED="$rest"
		return
		;;
	esac
	while :; do
		pre="${rest%%[\"\']*}"
		if [ "$pre" = "$rest" ]; then
			out="$out$rest"
			break
		fi
		out="$out$pre"
		q="${rest:${#pre}:1}"
		rest="${rest:$((${#pre} + 1))}"
		body=""
		if [ "$q" = "'" ]; then
			body="${rest%%\'*}"
			if [ "$body" = "$rest" ]; then rest=""; else rest="${rest:$((${#body} + 1))}"; fi
		else
			# the closing `"` is the first one NOT escaped by an odd run of backslashes
			while :; do
				chunk="${rest%%\"*}"
				if [ "$chunk" = "$rest" ]; then
					body="$body$rest"
					rest=""
					break
				fi
				rest="${rest:$((${#chunk} + 1))}"
				bs="${chunk##*[!\\]}"
				[ "$bs" = "$chunk" ] && bs="${chunk//[!\\]/}"
				if [ $((${#bs} % 2)) -eq 1 ]; then
					body="$body$chunk\""
					continue
				fi
				body="$body$chunk"
				break
			done
		fi
		out="$out$q${body//$nl/ }$q"
	done
	JOINED="$out"
}

# cmdline_split <text> — split into the SEGS array (raw segments, not yet normalised).
cmdline_split() {
	local s="$1" nl=$'\n' line inner pre post lifted=""
	case "$s" in *'<<'*)
		cmdline_strip_heredocs "$s"
		s="$STRIPPED"
		;;
	esac
	cmdline_join_quoted_newlines "$s"
	s="$JOINED"
	# Lift each `$(…)` and `…` body out as a segment of its own and leave `$__SUBST__` in the
	# outer command, so `X="$(aws …)" pnpm -F console db:migrate` stays ONE segment that starts
	# with the assignment and runs pnpm — with a value the rules can see is not a literal. Not
	# nesting-aware: the inner body ends at the first `)`, which is enough for every rule here.
	while [[ "$s" == *'$('* ]]; do
		pre="${s%%\$(*}"
		post="${s#*\$(}"
		inner="${post%%)*}"
		if [ "$inner" = "$post" ]; then post=""; else post="${post#*)}"; fi
		lifted="$lifted$inner$nl"
		s="$pre\$__SUBST__$post"
	done
	# An ESCAPED backtick (`\``, Markdown in a double-quoted --body) is a literal character to the
	# shell, not a substitution, so it is replaced by a placeholder before the pairing.
	s="${s//\\\`/__ALETHIA_BQ__}"
	while [[ "$s" == *'`'*'`'* ]]; do
		pre="${s%%\`*}"
		post="${s#*\`}"
		inner="${post%%\`*}"
		post="${post#*\`}"
		lifted="$lifted$inner$nl"
		s="$pre\$__SUBST__$post"
	done
	s="$s$nl$lifted"
	s="${s//&&/$nl}"
	s="${s//||/$nl}"
	s="${s//;/$nl}"
	s="${s//|/$nl}"
	s="${s//&/$nl}"
	s="${s//\`/$nl}"
	SEGS=()
	while IFS= read -r line; do
		SEGS+=("$line")
	done <<<"$s"
}

# cmdline_normalise <segment> — sets SEG (the runnable remainder), TOK (its words with quote
# characters removed — a guard compares NAMES, `"main"` must equal main) and SEG_ENV
# (newline-separated NAME=value assignments that prefixed it).
cmdline_normalise() {
	local seg="$1" first rest r name w
	SEG_ENV=""
	while :; do
		seg="${seg#"${seg%%[![:space:]]*}"}"
		first="${seg%%[[:space:]]*}"
		rest="${seg#"$first"}"
		case "$first" in
		then | do | else | elif | if | while | until | '{' | '!' | '(' | command | builtin | exec | nohup | time)
			seg="$rest"
			continue
			;;
		sudo | env | xargs)
			seg="$rest"
			# the wrapper's own flags (`env -i`, `sudo -E`, `xargs -0`), and nothing else
			while :; do
				seg="${seg#"${seg%%[![:space:]]*}"}"
				case "$seg" in
				-*)
					w="${seg%%[[:space:]]*}"
					seg="${seg#"$w"}"
					;;
				*) break ;;
				esac
			done
			continue
			;;
		sh | bash | zsh | dash)
			r="${rest#"${rest%%[![:space:]]*}"}"
			case "$r" in
			-c[[:space:]]* | -[a-z]c[[:space:]]* | -[a-z][a-z]c[[:space:]]*)
				r="${r#*[[:space:]]}"
				r="${r#"${r%%[![:space:]]*}"}"
				r="${r#[\"\']}"
				seg="$r"
				continue
				;;
			esac
			break
			;;
		[A-Za-z_]*=*)
			name="${first%%=*}"
			case "$name" in *[!A-Za-z0-9_]*) break ;; esac
			SEG_ENV="$SEG_ENV$first"$'\n'
			seg="$rest"
			continue
			;;
		esac
		# a subshell's opening paren glued to the program: `(cd x && …`
		case "$seg" in "("*)
			seg="${seg#(}"
			continue
			;;
		esac
		break
	done
	# Parentheses are not split on (a quoted workflow name may contain them), so a subshell's
	# closing `)` and a `$(…)`'s are trimmed from the end of the segment instead.
	seg="${seg%"${seg##*[![:space:]]}"}"
	while :; do
		case "$seg" in *")") seg="${seg%)}" ;; *) break ;; esac
		seg="${seg%"${seg##*[![:space:]]}"}"
	done
	seg="${seg%[\"\']}"
	SEG="$seg"
	TOK=()
	local _words
	read -r -a _words <<<"$seg"
	for w in "${_words[@]}"; do
		w="${w//\"/}"
		w="${w//\'/}"
		TOK+=("$w")
	done
}

# cmdline_is_inspect — is SEG a search-or-print command whose arguments are data?
# The carve-out guard-runtime.sh makes, with two holes closed: `sed -i` edits a file, and
# `find -delete` / `find -exec` removes or runs something, so neither counts as inspection.
# Output REDIRECTION is not judged here — a caller that cares (`echo > x.tfstate`) checks it first.
cmdline_is_inspect() {
	case "${TOK[0]:-}" in
	grep | egrep | fgrep | rg | ag | ack | cat | bat | head | tail | less | more | wc | jq | yq | echo | printf | cut | sort | uniq | diff | comm | column | awk | ls | stat | file | which | type | true | false | test | '[')
		return 0
		;;
	sed)
		case " $SEG " in *" -i"* | *" --in-place"*) return 1 ;; esac
		return 0
		;;
	find | fd)
		case " $SEG " in *" -delete"* | *" -exec"* | *" -ok"* | *" -x "* | *" --exec"*) return 1 ;; esac
		return 0
		;;
	git)
		case "${TOK[1]:-}" in grep | log | show | diff | status | blame) return 0 ;; esac
		;;
	esac
	return 1
}

# cmdline_abspath <path> <base> — sets ABSPATH: the path made absolute WITHOUT touching the
# filesystem. Expands a leading `~`, `$HOME` and `${HOME}`; every other variable is left in place
# (the caller decides what an unexpanded `$X` means for its rule). `..` is collapsed lexically.
cmdline_abspath() {
	local p="$1" base="$2" out="" part
	case "$p" in
	"~") p="$HOME" ;;
	"~/"*) p="$HOME/${p#\~/}" ;;
	"\$HOME"*) p="$HOME${p#\$HOME}" ;;
	"\${HOME}"*) p="$HOME${p#\$\{HOME\}}" ;;
	esac
	case "$p" in
	/*) ;;
	*) p="$base/$p" ;;
	esac
	# `read -a`, not `for part in $p`: an unquoted expansion would also GLOB each part.
	local _parts
	IFS=/ read -r -a _parts <<<"$p"
	for part in "${_parts[@]}"; do
		case "$part" in
		"" | .) ;;
		..) out="${out%/*}" ;;
		*) out="$out/$part" ;;
		esac
	done
	[ -n "$out" ] || out="/"
	ABSPATH="$out"
}

# cmdline_expand <word> — sets EXPANDED: `$NAME` / `${NAME}` replaced from the NAME=value
# assignments made EARLIER IN THE SAME COMMAND (the caller keeps them in EXPORTS, one per line),
# and $HOME. Fails (1) when any variable is left unresolved — the caller then treats the word as
# unknown, exactly as before. `W=/x; git -C $W push` is the case this exists for.
cmdline_expand() {
	local w="$1" name val line guard=0
	while [[ "$w" =~ \$\{?([A-Za-z_][A-Za-z0-9_]*)\}? ]] && [ "$guard" -lt 20 ]; do
		guard=$((guard + 1))
		name="${BASH_REMATCH[1]}"
		val=""
		if [ "$name" = HOME ]; then val="$HOME"; else
			while IFS= read -r line; do
				case "$line" in "$name="*) val="${line#*=}" ;; esac
			done <<<"${EXPORTS:-}"
			val="${val//\"/}"
			val="${val//\'/}"
			[ -n "$val" ] || {
				EXPANDED="$w"
				return 1
			}
			case "$val" in *'$'* | *'`'*)
				EXPANDED="$w"
				return 1
				;;
			esac
		fi
		w="${w/"${BASH_REMATCH[0]}"/$val}"
	done
	EXPANDED="$w"
	case "$w" in *'$'* | *'`'*) return 1 ;; esac
	return 0
}

# cmdline_has_var <word> — does the word still carry an unexpanded variable or substitution?
cmdline_has_var() {
	case "$1" in *'$'* | *'`'*) return 0 ;; esac
	return 1
}
