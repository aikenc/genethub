# Shared by install-macos.sh and install-linux.sh. Sourced, never run.
#
# The caller sets VERSION, RELEASE, TRIPLE and SHA256 and calls
# `install_runtime <runtime-dir>`. Everything here uses only tools every
# macOS and mainstream Linux install has: sh, uname, curl or wget, tar, and
# shasum or sha256sum.
#
# Output protocol, one JSON object per line on stdout:
#   {"phase":"…","message":"…"}   progress the daemon shows as a job
#   {"error":"…"}                 the reason it stopped (exit status non-zero)
#   {"python":"/abs/path"}        the interpreter; always the last line on success

# Tabs and line breaks become spaces and other control characters are
# dropped, so every message stays one valid JSON line.
json_escape() {
  printf '%s' "$1" | tr '\t\n\r' '   ' | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

say() {
  printf '{"phase":"%s","message":"%s"}\n' "$1" "$(json_escape "$2")"
}

fail() {
  printf '{"error":"%s"}\n' "$(json_escape "$1")"
  exit 1
}

# The interpreter is usable when it starts in isolated mode and reports
# exactly the pinned version. This catches a damaged or half-written tree.
usable() {
  [ -x "$1" ] && "$1" -I -c 'import sys; sys.exit(0 if sys.version.split()[0] == sys.argv[1] else 1)' "$VERSION" >/dev/null 2>&1
}

# Checked once, before anything is downloaded: a missing tool must be the
# reason reported, not a checksum mismatch on every mirror.
require_tools() {
  if command -v sha256sum >/dev/null 2>&1; then
    hasher=sha256sum
  elif command -v shasum >/dev/null 2>&1; then
    hasher=shasum
  else
    fail "neither sha256sum nor shasum is available"
  fi
  if command -v curl >/dev/null 2>&1; then
    fetcher=curl
  elif command -v wget >/dev/null 2>&1; then
    fetcher=wget
  else
    fail "neither curl nor wget is available"
  fi
  command -v tar >/dev/null 2>&1 || fail "tar is not available"
}

sha256_of() {
  if [ "$hasher" = sha256sum ]; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# A mirror that stalls (under 1 KiB/s for a minute) is given up on.
fetch() {
  if [ "$fetcher" = curl ]; then
    curl -fsSL --retry 2 --connect-timeout 15 --speed-limit 1024 --speed-time 60 -o "$2" "$1"
  else
    wget -q -T 60 -O "$2" "$1"
  fi
}

install_runtime() {
  root=$1
  [ -n "$root" ] || fail "usage: install-<os>.sh <runtime-dir>"
  mkdir -p "$root"
  name="python-$VERSION-$RELEASE"
  target="$root/$name"
  python="$target/bin/python3"

  if ! usable "$python"; then
    require_tools
    file="cpython-$VERSION%2B$RELEASE-$TRIPLE-install_only_stripped.tar.gz"
    # A configured mirror is tried first; the hash below makes any mirror
    # safe to use, because content that does not match is never unpacked.
    urls=""
    for base in ${GENEHUB_PYTHON_MIRRORS:-}; do
      urls="$urls ${base%/}/$RELEASE/$file"
    done
    urls="$urls https://github.com/astral-sh/python-build-standalone/releases/download/$RELEASE/$file"
    urls="$urls https://mirrors.aliyun.com/github/releases/astral-sh/python-build-standalone/$RELEASE/$file"

    staging="$root/.staging-$$"
    rm -rf "$staging"
    mkdir -p "$staging"
    archive="$staging/python.tar.gz"
    got=""
    for url in $urls; do
      say download "下载 Python $VERSION：$url"
      if fetch "$url" "$archive" 2>/dev/null; then
        if [ "$(sha256_of "$archive")" = "$SHA256" ]; then
          got=yes
          break
        fi
        say download "校验失败，换下一个地址"
      fi
      rm -f "$archive"
    done
    if [ -z "$got" ]; then
      rm -rf "$staging"
      fail "无法下载 Python $VERSION：所有地址都失败或校验不通过"
    fi

    say extract "解压 Python $VERSION"
    tar -xzf "$archive" -C "$staging" || { rm -rf "$staging"; fail "解压失败"; }
    rm -f "$archive"
    [ -d "$staging/python" ] || { rm -rf "$staging"; fail "压缩包里没有 python 目录"; }
    if [ "$(uname -s)" = Darwin ] && command -v xattr >/dev/null 2>&1; then
      xattr -dr com.apple.quarantine "$staging/python" 2>/dev/null || true
    fi
    rm -rf "$target"
    mv "$staging/python" "$target"
    rm -rf "$staging"
    chmod -R go-w "$target" 2>/dev/null || true
    # The install time, which is how the cleanup below tells builds apart.
    touch "$target"
    say verify "检查 Python $VERSION"
    usable "$python" || fail "安装后的 Python 无法以隔离模式启动"
  fi

  # The pinned build and the one installed before it stay: an Agent started
  # before this install may still be running on that one. Older builds go.
  kept=""
  for old in $(CDPATH= cd -- "$root" && ls -1td python-* 2>/dev/null); do
    [ "$root/$old" = "$target" ] && continue
    if [ -z "$kept" ]; then
      kept=yes
      continue
    fi
    rm -rf "${root:?}/$old"
  done

  printf '{"python":"%s"}\n' "$(json_escape "$python")"
}
