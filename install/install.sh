#!/bin/sh
# Zetta 3D CLI installer for macOS and Linux.
#
#   curl -fsSL https://zetta3d.ai/install.sh | sh
#   wget -qO- https://zetta3d.ai/install.sh | sh        (systems without curl, e.g. Alpine)
#
# Installs the single self-contained `zetta` binary into ~/.zetta/bin (no sudo, nothing else needed)
# and adds that folder to PATH. Running it again upgrades in place.
#
# Environment overrides:
#   ZETTA_VERSION=1.2.3      install this version instead of the latest
#   ZETTA_INSTALL_DIR=DIR    install into DIR instead of ~/.zetta/bin
#   ZETTA_DOWNLOAD_BASE=URL  download host (default https://downloads.zetta3d.ai/zcli)
#   ZETTA_NO_MODIFY_PATH=1   do not touch shell startup files
#   ZETTA_NO_SKILL=1         do not install the skill for AI coding agents (Claude Code, Codex, Cursor)
#   ZETTA_NO_LOGIN=1         do not start the browser sign-in after installing
#
# Everything runs inside main(), called on the last line, so a partly downloaded script does nothing.

set -u

DEFAULT_BASE="https://downloads.zetta3d.ai/zcli"

# ---- output ---------------------------------------------------------------------------------

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; then
	z_tty=1
	z_bold=$(printf '\033[1m')
	z_dim=$(printf '\033[2m')
	z_red=$(printf '\033[31m')
	z_green=$(printf '\033[32m')
	z_reset=$(printf '\033[0m')
else
	z_tty=0
	z_bold=""
	z_dim=""
	z_red=""
	z_green=""
	z_reset=""
fi

# Progress lines: only when a person is watching.
say() {
	if [ "$z_tty" = 1 ]; then printf '%s\n' "${z_dim}$*${z_reset}"; fi
}

# Always shown.
out() {
	printf '%s\n' "$*"
}

err() {
	printf '%s\n' "${z_red}error${z_reset}: $*" >&2
	exit 1
}

has() {
	command -v "$1" >/dev/null 2>&1
}

# ---- downloads ------------------------------------------------------------------------------

# fetch URL FILE [progress]: download URL to FILE. On failure returns 1 and leaves the reason
# (curl's or wget's last error line) in $z_fetch_msg.
fetch() {
	z_url=$1
	z_out=$2
	z_mode=${3:-}
	z_fetch_msg=""
	if [ "$z_downloader" = curl ]; then
		set -- --fail --location --show-error --retry 3 --connect-timeout 20
		# Never follow a redirect from https down to plain http.
		case "$z_url" in https://*) set -- "$@" --proto-redir '=https' ;; esac
		if [ "$z_mode" = progress ] && [ "$z_tty" = 1 ]; then
			curl "$@" --progress-bar --output "$z_out" "$z_url" </dev/null && return 0
			return 1
		fi
		curl "$@" --silent --output "$z_out" "$z_url" </dev/null 2>"$z_work/fetch.err" && return 0
	else
		wget -q -O "$z_out" "$z_url" </dev/null 2>"$z_work/fetch.err" && return 0
	fi
	z_fetch_msg=$(tail -n 1 "$z_work/fetch.err" 2>/dev/null || true)
	return 1
}

# Appends " (reason)" when the last fetch left one.
why() {
	if [ -n "${z_fetch_msg:-}" ]; then printf ' (%s)' "$z_fetch_msg"; fi
}

sha256_of() {
	if has sha256sum; then
		sha256sum "$1" | awk '{print $1}'
	elif has shasum; then
		shasum -a 256 "$1" | awk '{print $1}'
	elif has openssl; then
		openssl dgst -sha256 "$1" | awk '{print $NF}'
	else
		err "cannot verify the download: none of sha256sum, shasum or openssl is installed."
	fi
}

# ---- platform -------------------------------------------------------------------------------

is_musl() {
	if [ -f /etc/alpine-release ]; then return 0; fi
	if has ldd && ldd --version 2>&1 | grep -qi musl; then return 0; fi
	# No glibc loader, but a musl one.
	for z_f in /lib/ld-musl-*.so.1; do
		if [ -e "$z_f" ] && ! ls /lib*/ld-linux*.so* /lib/*/ld-linux*.so* >/dev/null 2>&1; then return 0; fi
	done
	return 1
}

has_avx2() {
	case "$z_os" in
	linux)
		if [ -r /proc/cpuinfo ]; then grep -qi 'avx2' /proc/cpuinfo; else return 0; fi
		;;
	darwin)
		z_feat=$(sysctl -n machdep.cpu.leaf7_features 2>/dev/null) || return 0
		printf '%s' "$z_feat" | grep -qi 'avx2'
		;;
	*) return 0 ;;
	esac
}

detect_platform() {
	z_uname_s=$(uname -s)
	z_uname_m=$(uname -m)
	case "$z_uname_s" in
	Darwin) z_os=darwin ;;
	Linux) z_os=linux ;;
	MINGW* | MSYS* | CYGWIN* | Windows_NT)
		err "this is the macOS/Linux installer. On Windows, run this in PowerShell instead:
    irm https://zetta3d.ai/install.ps1 | iex"
		;;
	*) err "zetta does not support $z_uname_s. It runs on macOS, Linux and Windows." ;;
	esac

	case "$z_uname_m" in
	x86_64 | amd64) z_arch=x64 ;;
	arm64 | aarch64) z_arch=arm64 ;;
	*) err "zetta does not support the $z_uname_m CPU architecture. It runs on x64 and arm64." ;;
	esac

	if [ "$z_os" = linux ] && [ "$(getconf LONG_BIT 2>/dev/null || echo 64)" = 32 ]; then
		err "this is a 32-bit Linux userland on a $z_uname_m CPU; zetta needs a 64-bit system."
	fi

	# An x64 shell under Rosetta on Apple Silicon should still get the native build.
	if [ "$z_os" = darwin ] && [ "$z_arch" = x64 ]; then
		if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ] || [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then
			z_arch=arm64
		fi
	fi

	z_key="$z_os-$z_arch"
	if [ "$z_os" = linux ] && is_musl; then z_key="$z_key-musl"; fi
	z_baseline=0
	if [ "$z_arch" = x64 ] && ! has_avx2; then z_baseline=1; fi
}

# The musl builds link the C++ runtime dynamically; stock Alpine does not ship it.
ensure_musl_runtime() {
	for z_f in /usr/lib/libstdc++.so.6 /lib/libstdc++.so.6 /usr/local/lib/libstdc++.so.6; do
		if [ -e "$z_f" ]; then return 0; fi
	done
	if [ "$(id -u 2>/dev/null)" = 0 ] && has apk; then
		say "Installing libstdc++ with apk (zetta needs it on Alpine)..."
		apk add --no-cache libstdc++ </dev/null >"$z_work/apk.log" 2>&1 ||
			err "zetta needs the libstdc++ package, and 'apk add libstdc++' failed:
$(tail -n 3 "$z_work/apk.log")"
		out "Installed the libstdc++ package with apk (zetta needs it on musl systems)."
		return 0
	fi
	if has apk; then z_hint="apk add libstdc++"; else z_hint="install your distribution's libstdc++ package"; fi
	err "zetta needs the C++ runtime library (libstdc++) on this musl system. As root, run:
    $z_hint
then run this installer again."
}

# ---- PATH -----------------------------------------------------------------------------------

# ~/x for paths under HOME, for messages (a literal ~ is intended).
# shellcheck disable=SC2088
tilde() {
	case "$1" in
	"${HOME:-/nonexistent}"/*) printf '%s' "~/${1#"$HOME"/}" ;;
	*) printf '%s' "$1" ;;
	esac
}

# The install dir as written into rc files: $HOME-relative when possible.
rc_dir() {
	case "$z_dir" in
	"${HOME:-/nonexistent}"/*) printf '%s' "\$HOME/${z_dir#"$HOME"/}" ;;
	*) printf '%s' "$z_dir" ;;
	esac
}

# add_line FILE LINE: append LINE to FILE unless FILE already mentions the install dir.
add_line() {
	z_rc=$1
	if [ -f "$z_rc" ] && { grep -qF "$z_dir" "$z_rc" 2>/dev/null || grep -qF "$(rc_dir)" "$z_rc" 2>/dev/null; }; then
		z_rc_ok=1
		return 0
	fi
	mkdir -p "$(dirname "$z_rc")" 2>/dev/null || true
	{
		if [ -s "$z_rc" ]; then
			# Keep the file's last line intact, then leave a blank line.
			if [ -n "$(tail -c 1 "$z_rc")" ]; then echo; fi
			echo
		fi
		echo "# zetta (Zetta 3D CLI)"
		echo "$2"
	} >>"$z_rc" 2>/dev/null || {
		out "Could not update $z_rc; add this line to it yourself:"
		out "  $2"
		return 0
	}
	z_changed="$z_changed $(tilde "$z_rc")"
	z_rc_ok=1
}

setup_path() {
	z_changed=""
	z_rc_ok=0
	z_on_path=0
	case ":${PATH:-}:" in
	*":$z_dir:"*) z_on_path=1 ;;
	esac

	if [ "${ZETTA_NO_MODIFY_PATH:-}" = 1 ]; then return 0; fi
	if [ -z "${HOME:-}" ]; then return 0; fi

	# GitHub Actions: make zetta available to the following steps too.
	if [ -n "${GITHUB_PATH:-}" ]; then echo "$z_dir" >>"$GITHUB_PATH" 2>/dev/null || true; fi

	if [ "$z_on_path" = 1 ]; then return 0; fi

	z_sh_line="export PATH=\"$(rc_dir):\$PATH\""
	case "$(basename "${SHELL:-sh}")" in
	zsh)
		add_line "${ZDOTDIR:-$HOME}/.zshrc" "$z_sh_line"
		;;
	bash)
		add_line "$HOME/.bashrc" "$z_sh_line"
		# Login shells (macOS Terminal, many SSH sessions) read .bash_profile, not .bashrc.
		if [ -f "$HOME/.bash_profile" ] || [ "$z_os" = darwin ]; then
			add_line "$HOME/.bash_profile" "$z_sh_line"
		fi
		;;
	fish)
		add_line "${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish" \
			"contains -- \"$(rc_dir)\" \$PATH; or set -gx PATH \"$(rc_dir)\" \$PATH"
		;;
	*)
		add_line "$HOME/.profile" "$z_sh_line"
		;;
	esac
}

# ---- main -----------------------------------------------------------------------------------

cleanup() {
	if [ -n "${z_work:-}" ]; then rm -rf "$z_work"; fi
}

main() {
	for z_cmd in uname mkdir chmod mv rm awk grep sed tr head tail dirname basename; do
		has "$z_cmd" || err "this installer needs '$z_cmd', which is not installed."
	done
	if has curl; then
		z_downloader=curl
	elif has wget; then
		z_downloader=wget
	else
		err "this installer needs curl or wget to download zetta. Install one of them and try again."
	fi

	detect_platform

	z_base=${ZETTA_DOWNLOAD_BASE:-$DEFAULT_BASE}
	z_base=${z_base%/}

	if [ -n "${ZETTA_INSTALL_DIR:-}" ]; then
		z_dir=$ZETTA_INSTALL_DIR
		case "$z_dir" in "~"/*) z_dir="${HOME:?}/${z_dir#"~/"}" ;; esac
	else
		[ -n "${HOME:-}" ] || err "HOME is not set; set ZETTA_INSTALL_DIR to choose where zetta goes."
		z_dir="$HOME/.zetta/bin"
	fi
	mkdir -p "$z_dir" 2>/dev/null || err "cannot create $z_dir. Set ZETTA_INSTALL_DIR to a folder you can write to."
	z_dir=$(cd "$z_dir" && pwd) || err "cannot use $z_dir."
	[ -w "$z_dir" ] || err "cannot write to $z_dir. Set ZETTA_INSTALL_DIR to a folder you can write to."
	z_bin="$z_dir/zetta"

	# Scratch space next to the binary, so the final rename is atomic (same file system) and a
	# noexec /tmp does not matter.
	z_work="$z_dir/.zetta-install-$$"
	trap cleanup EXIT
	trap 'cleanup; exit 130' INT
	trap 'cleanup; exit 143' TERM
	rm -rf "$z_work"
	mkdir "$z_work" || err "cannot write to $z_dir."

	case "$z_key" in *-musl) ensure_musl_runtime ;; esac

	# Which version.
	if [ -n "${ZETTA_VERSION:-}" ]; then
		z_version=${ZETTA_VERSION#v}
	else
		say "Finding the latest zetta release..."
		fetch "$z_base/latest.json" "$z_work/latest.json" ||
			err "could not download $z_base/latest.json$(why). Check your internet connection (and ZETTA_DOWNLOAD_BASE, if you set it)."
		z_version=$(tr -d '\r\n' <"$z_work/latest.json" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
		[ -n "$z_version" ] || err "$z_base/latest.json does not name a version."
	fi
	case "$z_version" in
	"" | *[!0-9A-Za-z.+-]*) err "'$z_version' is not a valid zetta version." ;;
	esac

	# Checksums for that version; also tells us which builds exist.
	if ! fetch "$z_base/v$z_version/SHA256SUMS" "$z_work/SHA256SUMS"; then
		case "$z_fetch_msg" in
		*404*) err "zetta $z_version was not found on $z_base." ;;
		esac
		err "could not download $z_base/v$z_version/SHA256SUMS$(why). Check your internet connection."
	fi

	# Pick the build: the AVX2-free one only when the CPU needs it.
	z_name="zetta-$z_key"
	if [ "$z_baseline" = 1 ]; then z_name="zetta-$z_key-baseline"; fi
	z_expected=$(awk -v n="$z_name" '$2 == n || $2 == "*" n { print $1; exit }' "$z_work/SHA256SUMS" | tr 'A-F' 'a-f')
	if [ -z "$z_expected" ]; then
		if [ "$z_baseline" = 1 ]; then
			err "zetta $z_version has no build for this CPU (an x64 processor without AVX2)."
		fi
		err "zetta $z_version has no build for $z_key."
	fi

	say "Downloading zetta $z_version for $z_key..."
	z_tmp="$z_work/zetta"
	# The gzip copy is about half the size; use it when this system can unpack it.
	z_gz_expected=""
	if has gzip; then
		z_gz_expected=$(awk -v n="$z_name.gz" '$2 == n || $2 == "*" n { print $1; exit }' "$z_work/SHA256SUMS" | tr 'A-F' 'a-f')
	fi
	if [ -n "$z_gz_expected" ]; then
		fetch "$z_base/v$z_version/$z_name.gz" "$z_tmp.gz" progress ||
			err "could not download $z_base/v$z_version/$z_name.gz$(why). Check your internet connection and try again."
		z_actual=$(sha256_of "$z_tmp.gz" | tr 'A-F' 'a-f')
		if [ "$z_actual" != "$z_gz_expected" ]; then
			err "checksum mismatch for $z_name.gz (expected $z_gz_expected, got $z_actual).
The download is corrupted or was tampered with. Nothing was installed."
		fi
		gzip -dc "$z_tmp.gz" >"$z_tmp" || err "could not unpack $z_name.gz."
		rm -f "$z_tmp.gz"
	else
		fetch "$z_base/v$z_version/$z_name" "$z_tmp" progress ||
			err "could not download $z_base/v$z_version/$z_name$(why). Check your internet connection and try again."
	fi

	z_actual=$(sha256_of "$z_tmp" | tr 'A-F' 'a-f')
	if [ "$z_actual" != "$z_expected" ]; then
		err "checksum mismatch for $z_name (expected $z_expected, got $z_actual).
The download is corrupted or was tampered with. Nothing was installed."
	fi
	say "Checksum verified."

	chmod 755 "$z_tmp"
	# Prove it runs here before replacing anything.
	if ! "$z_tmp" --version >"$z_work/version.txt" 2>&1 </dev/null; then
		err "the downloaded zetta does not run on this system ($z_key):
$(head -n 5 "$z_work/version.txt")"
	fi

	z_existed=0
	if [ -e "$z_bin" ]; then z_existed=1; fi
	mv -f "$z_tmp" "$z_bin" || err "could not install to $z_bin."

	setup_path

	out ""
	if [ "$z_existed" = 1 ]; then
		out "${z_green}zetta $z_version${z_reset} is installed at $z_bin (updated)."
	else
		out "${z_green}zetta $z_version${z_reset} is installed at $z_bin."
	fi
	if [ "$z_on_path" = 0 ]; then
		if [ -n "$z_changed" ]; then out "Added $(rc_dir) to PATH in:$z_changed"; fi
		if [ "$z_rc_ok" = 1 ]; then
			out "Open a new terminal, or run this to use zetta here now:"
		else
			out "$(rc_dir) is not on your PATH. To use zetta in this shell, run:"
		fi
		out "  export PATH=\"$(rc_dir):\$PATH\""
	fi
	install_skill
	if sign_in; then
		out ""
		out "You're all set. Try: ${z_bold}zetta generate -p \"a wooden chair\"${z_reset}  (or ${z_bold}zetta --help${z_reset})"
	else
		out ""
		out "Next: ${z_bold}zetta auth login${z_reset} (signs you in with your browser; on a server or in CI, use an API key: ZETTA_API_KEY)"
	fi
}

# Connects zetta to the user's Zetta 3D account with the browser sign-in, straight after installing,
# when a person is at this terminal. Skipped in CI, without a terminal, when ZETTA_API_KEY is set (a
# script's own identity), with ZETTA_NO_LOGIN=1, and when already signed in. Never fails the install.
sign_in() {
	if [ "${ZETTA_NO_LOGIN:-}" = 1 ] || [ -n "${CI:-}" ] || [ -n "${ZETTA_API_KEY:-}" ] || ! [ -t 1 ]; then return 1; fi
	# `curl | sh` feeds this script on stdin, so the sign-in talks to the terminal itself.
	(exec </dev/tty) 2>/dev/null || return 1
	# `auth status` succeeds either way; what it says decides.
	z_status=$("$z_bin" auth status --output json </dev/null 2>/dev/null) || z_status=""
	case "$z_status" in
	*'"signedIn": true'* | *'"signedIn":true'*)
		out "Signed in already."
		return 0
		;;
	esac
	out ""
	out "${z_bold}Sign in to your Zetta 3D account.${z_reset} Your browser opens; sign in there and click Connect (Ctrl-C to do it later)."
	# Ctrl-C stops the sign-in, not this script: zetta is installed either way.
	trap ':' INT
	"$z_bin" auth login </dev/tty >/dev/tty 2>&1
	z_login=$?
	trap - INT
	return "$z_login"
}

# Teaches the AI coding agents found here (Claude Code, Codex, Cursor) to use zetta: a skill folder
# in each agent's skills directory. Never fails the install. ZETTA_NO_SKILL=1 skips it.
install_skill() {
	if [ "${ZETTA_NO_SKILL:-}" = 1 ]; then return 0; fi
	z_skill=$("$z_bin" skill install --auto --output text </dev/null 2>/dev/null) || return 0
	case "$z_skill" in
	Installed* | Updated* | "Up to date"*) out "$z_skill" ;;
	esac
}

main "$@"
