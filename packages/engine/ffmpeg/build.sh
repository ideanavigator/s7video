#!/bin/bash
# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
#
# Builds the LGPL FFmpeg helper that ships in the app as Contents/Resources/ffmpeg (S7V-016):
# ffmpeg and ffprobe with VideoToolbox, AudioToolbox, libass (CoreText fonts, no fontconfig), zimg
# and dav1d, from the pinned sources in versions.lock, for Apple Silicon and the minimum macOS there.
#
#   packages/engine/ffmpeg/build.sh [--out DIR] [--force]
#   packages/engine/ffmpeg/build.sh --print-dir   # where this recipe's helper is (or would be) cached
#
# Needs only Xcode's command line tools and uv (meson, ninja, pkgconf and PGPy run through
# `uv tool run`). It runs in a clean environment with a system-only PATH, so nothing from Homebrew
# is found. Downloads and build trees live in $S7VIDEO_FFMPEG_BUILD_DIR (default
# ~/Library/Caches/s7video-ffmpeg); a finished helper is cached there by a hash of this recipe, so
# a second run only copies it. --out copies the helper to DIR. The last line printed is the cached
# helper's folder (scripts/build-desktop-artifact.ts and pnpm licenses:check read it).
set -euo pipefail

die() {
  echo "build.sh: $*" >&2
  exit 1
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "${S7V_FFMPEG_CLEAN_ENV:-}" ]; then
  [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || die "builds on Apple Silicon Macs only"
  uv_bin="${UV:-$(command -v uv || true)}"
  if [ "${1:-}" != --print-dir ] && { [ -z "$uv_bin" ] || [ ! -x "$uv_bin" ]; }; then
    die "needs uv on PATH (or UV=/path/to/uv)"
  fi
  exec /usr/bin/env -i \
    S7V_FFMPEG_CLEAN_ENV=1 \
    HOME="$HOME" \
    USER="${USER:-}" \
    TMPDIR="${TMPDIR:-/tmp}" \
    LANG=C \
    UV="$uv_bin" \
    S7VIDEO_FFMPEG_BUILD_DIR="${S7VIDEO_FFMPEG_BUILD_DIR:-$HOME/Library/Caches/s7video-ffmpeg}" \
    PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    /bin/bash "$HERE/build.sh" "$@"
fi

OUT=""
FORCE=0
PRINT_DIR=0
while [ $# -gt 0 ]; do
  case "$1" in
    --out)
      [ $# -ge 2 ] || die "--out needs a folder"
      OUT="$2"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --print-dir)
      PRINT_DIR=1
      shift
      ;;
    -h | --help)
      sed -n '5,17p' "$HERE/build.sh"
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

LOCK="$HERE/versions.lock"
lock() { /usr/bin/plutil -extract "$1" raw -o - "$LOCK"; }

MACOS_MIN="$(lock target.macosMinimum)"
CACHE="$S7VIDEO_FFMPEG_BUILD_DIR"
KEY="$(cat "$LOCK" "$HERE/build.sh" "$HERE/check.sh" "$HERE/pgp_verify.py" "$HERE/overlays/zimg/meson.build" |
  /usr/bin/shasum -a 256 | cut -c1-16)"
SOURCES="$CACHE/sources"
WORK="$CACHE/work-$KEY"
HELPER="$CACHE/helper-$KEY"
PREFIX="$WORK/prefix"
TOOLS="$WORK/tools/bin"
LOGS="$WORK/logs"
UA="s7video-build/1.0 (+https://github.com/ideanavigator/s7video)"

if [ "$PRINT_DIR" = 1 ]; then
  echo "$HELPER"
  exit 0
fi

# Index of a source in versions.lock by name.
source_index() {
  local index=0 name
  while name="$(lock "sources.$index.name" 2>/dev/null)"; do
    [ "$name" = "$1" ] && {
      echo "$index"
      return
    }
    index=$((index + 1))
  done
  die "versions.lock has no source named $1"
}
src() { lock "sources.$(source_index "$1").$2"; }
tool_version() {
  local index=0 name
  while name="$(lock "buildTools.$index.name" 2>/dev/null)"; do
    [ "$name" = "$1" ] && {
      lock "buildTools.$index.version"
      return
    }
    index=$((index + 1))
  done
  die "versions.lock has no build tool named $1"
}

# Runs a step with its output in a log; shows the log's end when it fails.
step() {
  local name="$1"
  shift
  echo "build.sh: $name"
  # A subshell outside `if`, so `set -e` holds inside the step (bash ignores it under `if !`).
  set +e
  (
    set -e
    "$@"
  ) >"$LOGS/$name.log" 2>&1
  local status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    tail -n 40 "$LOGS/$name.log" >&2
    die "$name failed (log: $LOGS/$name.log)"
  fi
}

sha256_of() { /usr/bin/shasum -a 256 "$1" | cut -d' ' -f1; }

# Downloads a URL into the sources cache, once; a pinned sha256 must match.
fetch() {
  local url="$1" file="$2" sha="${3:-}"
  local target="$SOURCES/$file"
  if [ -f "$target" ] && { [ -z "$sha" ] || [ "$(sha256_of "$target")" = "$sha" ]; }; then
    return
  fi
  /usr/bin/curl -fsSL --retry 3 -A "$UA" -o "$target.part" "$url" || die "could not download $url"
  if [ -n "$sha" ] && [ "$(sha256_of "$target.part")" != "$sha" ]; then
    rm -f "$target.part"
    die "$file does not match its pinned sha256 $sha"
  fi
  mv "$target.part" "$target"
}

source_file() {
  local file
  file="$(src "$1" file 2>/dev/null)" || file="$(basename "$(src "$1" url)")"
  echo "$file"
}

fetch_source() {
  local name="$1"
  fetch "$(src "$name" url)" "$(source_file "$name")" "$(src "$name" sha256)"
}

verify_ffmpeg_signature() {
  local index file
  index="$(source_index ffmpeg)"
  file="$(source_file ffmpeg)"
  # The signature and key are re-read each run: only the key's fingerprint is pinned.
  /usr/bin/curl -fsSL --retry 3 -A "$UA" -o "$WORK/ffmpeg.asc" "$(lock "sources.$index.signature.url")"
  /usr/bin/curl -fsSL --retry 3 -A "$UA" -o "$WORK/ffmpeg-key.asc" "$(lock "sources.$index.signature.keyUrl")"
  "$UV" tool run -q --python 3.12 --from "pgpy==$(tool_version pgpy)" python -I "$HERE/pgp_verify.py" \
    "$WORK/ffmpeg-key.asc" "$(lock "sources.$index.signature.fingerprint")" "$WORK/ffmpeg.asc" "$SOURCES/$file"
}

unpack() {
  local name="$1"
  rm -rf "$WORK/src/$name"
  mkdir -p "$WORK/src/$name"
  tar -xf "$SOURCES/$(source_file "$name")" -C "$WORK/src/$name" --strip-components 1
}

write_tool_shims() {
  mkdir -p "$TOOLS"
  local meson ninja pkgconf
  meson="$(tool_version meson)"
  ninja="$(tool_version ninja)"
  pkgconf="$(tool_version pkgconf)"
  printf '#!/bin/bash\nexec "%s" tool run -q --python 3.12 --from meson==%s meson "$@"\n' "$UV" "$meson" >"$TOOLS/meson"
  printf '#!/bin/bash\nexec "%s" tool run -q --python 3.12 --from ninja==%s ninja "$@"\n' "$UV" "$ninja" >"$TOOLS/ninja"
  # pkgconf from PyPI warns when PKG_CONFIG_PATH is unset; both point at the private prefix only.
  printf '#!/bin/bash\nexec "%s" tool run -q --python 3.12 --from pkgconf==%s pkgconf "$@"\n' "$UV" "$pkgconf" >"$TOOLS/pkg-config"
  chmod +x "$TOOLS/meson" "$TOOLS/ninja" "$TOOLS/pkg-config"
}

meson_build() {
  local name="$1"
  shift
  meson setup "$WORK/build/$name" "$WORK/src/$name" \
    --prefix="$PREFIX" --libdir=lib --buildtype=release -Db_ndebug=true \
    -Ddefault_library=shared --wrap-mode=nodownload "$@"
  ninja -C "$WORK/build/$name" install
  relative_ids
}

# meson installs dylibs with their absolute install path as the id; make each one @rpath/<name>
# before the next library or FFmpeg links it, so nothing records a path on the build machine.
relative_ids() {
  local lib id
  for lib in "$PREFIX"/lib/*.dylib; do
    [ -L "$lib" ] && continue
    id="$(otool -D "$lib" | tail -n +2)"
    case "$id" in
      "$PREFIX"/*) install_name_tool -id "@rpath/$(basename "$id")" "$lib" ;;
    esac
  done
}

# FFmpeg's own AV1 decoder needs a hardware decoder, which M1 and M2 Macs lack.
build_dav1d() {
  meson_build dav1d -Denable_tools=false -Denable_examples=false -Denable_tests=false \
    -Denable_docs=false -Denable_asm=true
}

build_freetype() {
  meson_build freetype -Dbrotli=disabled -Dbzip2=disabled -Dharfbuzz=disabled -Dpng=disabled \
    -Dzlib=none -Dhvf=disabled -Dtests=disabled
}

build_fribidi() {
  meson_build fribidi -Ddocs=false -Dbin=false -Dtests=false
}

build_harfbuzz() {
  meson_build harfbuzz -Dfreetype=enabled -Dglib=disabled -Dgobject=disabled -Dcairo=disabled \
    -Dchafa=disabled -Dicu=disabled -Dgraphite2=disabled -Dfontations=disabled -Dcoretext=disabled \
    -Dharfrust=disabled -Dkbts=disabled -Dwasm=disabled -Draster=disabled -Dvector=disabled \
    -Dgpu=disabled -Dgpu_demo=disabled -Dsubset=disabled -Dpng=disabled -Dzlib=disabled \
    -Dtests=disabled -Dintrospection=disabled -Ddocs=disabled -Dutilities=disabled -Dbenchmark=disabled
}

build_libass() {
  meson_build libass -Dfontconfig=disabled -Dcoretext=enabled -Ddirectwrite=disabled \
    -Dlibunibreak=disabled -Drequire-system-font-provider=true -Dtest=disabled -Dcompare=disabled \
    -Dprofile=disabled -Dfuzz=disabled -Dcheckasm=disabled
}

build_zimg() {
  cp "$HERE/overlays/zimg/meson.build" "$WORK/src/zimg/meson.build"
  meson_build zimg
}

FFMPEG_CONFIGURE=(
  --disable-gpl --disable-nonfree --disable-version3
  --enable-shared --disable-static --disable-doc --disable-debug
  --disable-programs --enable-ffmpeg --enable-ffprobe
  --disable-indevs --enable-indev=lavfi --disable-outdevs
  --disable-sdl2 --disable-libxcb --disable-xlib --disable-lzma
  --enable-videotoolbox --enable-audiotoolbox
  --enable-libass --enable-libfreetype --enable-libfribidi --enable-libharfbuzz --enable-libzimg
  --enable-libdav1d
)

build_ffmpeg() {
  cd "$WORK/src/ffmpeg"
  ./configure --prefix="$PREFIX" --arch=arm64 --target-os=darwin --cc=/usr/bin/clang \
    --pkg-config="$TOOLS/pkg-config" --install-name-dir='@rpath' \
    --extra-cflags="-mmacosx-version-min=$MACOS_MIN" \
    --extra-ldflags="-mmacosx-version-min=$MACOS_MIN -Wl,-rpath,@loader_path/../lib" \
    "${FFMPEG_CONFIGURE[@]}"
  make -j"$(($(sysctl -n hw.ncpu) > 10 ? 10 : $(sysctl -n hw.ncpu)))"
  make install
}

# The libraries ffmpeg and ffprobe load, by install name, from the private prefix.
copy_closure() {
  local dest="$1" queue=("$dest/bin/ffmpeg" "$dest/bin/ffprobe") file dep name
  while [ "${#queue[@]}" -gt 0 ]; do
    file="${queue[0]}"
    queue=("${queue[@]:1}")
    while read -r dep; do
      case "$dep" in
        /System/Library/* | /usr/lib/*) ;;
        @rpath/*)
          name="${dep#@rpath/}"
          if [ ! -f "$dest/lib/$name" ]; then
            [ -f "$PREFIX/lib/$name" ] || die "$file needs $dep, which the build did not make"
            cp -L "$PREFIX/lib/$name" "$dest/lib/$name"
            chmod 644 "$dest/lib/$name"
            queue+=("$dest/lib/$name")
          fi
          ;;
        *) die "$file links $dep, outside the system and the helper" ;;
      esac
    done < <(otool -L "$file" | tail -n +2 | awk '{print $1}' | grep -v "^$(otool -D "$file" | tail -n +2)\$" || true)
  done
}

macho_files() { find "$1/bin" "$1/lib" -type f; }

write_licences() {
  local dest="$1" index=0 name file
  while name="$(lock "sources.$index.name" 2>/dev/null)"; do
    mkdir -p "$dest/LICENSES/$name"
    local files=0
    while file="$(lock "sources.$index.licenseFiles.$files" 2>/dev/null)"; do
      cp "$WORK/src/$name/$file" "$dest/LICENSES/$name/$(basename "$file")"
      files=$((files + 1))
    done
    [ "$files" -gt 0 ] || die "versions.lock lists no licence file for $name"
    index=$((index + 1))
  done
}

write_sources() {
  local dest="$1" index=0 name
  {
    echo "# Sources of this FFmpeg helper"
    echo
    echo "s7video runs these programs as separate processes; it does not link them into its own code."
    echo "They are built by \`recipe/build.sh\` from the exact sources below (\`recipe/versions.lock\`),"
    echo "for Apple Silicon and macOS $MACOS_MIN or later. You may replace them with your own build of"
    echo "the same libraries; licence texts are in \`LICENSES/\`."
    echo
    echo "This software uses code of [FFmpeg](https://ffmpeg.org) licensed under the LGPLv2.1 or later."
    echo "Portions of this software are copyright © The FreeType Project (www.freetype.org). All rights"
    echo "reserved. FreeType is used under the FreeType License (FTL), elected from its FTL or GPL choice."
    echo
    echo "| Source | Version | Licence | SHA-256 | URL |"
    echo "|---|---|---|---|---|"
    while name="$(lock "sources.$index.name" 2>/dev/null)"; do
      echo "| $name | $(lock "sources.$index.version") | $(lock "sources.$index.license") | \`$(lock "sources.$index.sha256")\` | $(lock "sources.$index.url") |"
      index=$((index + 1))
    done
    echo
    echo "FFmpeg's tarball was checked against its OpenPGP signature by key $(src ffmpeg signature.fingerprint)."
    echo
    echo "FFmpeg configuration (\`ffmpeg -buildconf\`):"
    echo
    echo '```'
    "$dest/bin/ffmpeg" -hide_banner -buildconf
    echo '```'
    echo
    echo "Build tools, not shipped: meson $(tool_version meson), ninja $(tool_version ninja), pkgconf $(tool_version pkgconf), PGPy $(tool_version pgpy), run through uv; Apple clang $(/usr/bin/clang --version | head -1 | sed 's/.*version \([0-9.]*\).*/\1/')."
  } >"$dest/SOURCES.md"
}

assemble() {
  local dest="$HELPER.tmp"
  rm -rf "$dest"
  mkdir -p "$dest/bin" "$dest/lib" "$dest/recipe/overlays/zimg"
  cp "$PREFIX/bin/ffmpeg" "$PREFIX/bin/ffprobe" "$dest/bin/"
  copy_closure "$dest"
  # Strip local symbols, then sign ad hoc again: Apple Silicon runs no unsigned code. The release
  # build signs every file again with the Developer ID (S7V-011).
  strip -x "$dest"/lib/*.dylib
  while read -r file; do codesign --force --sign - "$file"; done < <(macho_files "$dest")
  write_licences "$dest"
  cp "$HERE/build.sh" "$HERE/check.sh" "$HERE/versions.lock" "$HERE/pgp_verify.py" "$dest/recipe/"
  cp "$HERE/overlays/zimg/meson.build" "$dest/recipe/overlays/zimg/"
  write_sources "$dest"
  # AC-2, AC-3, AC-4 and Check 2: links, rpaths, minimum macOS, signatures, licence, features.
  /bin/bash "$HERE/check.sh" "$dest" --render
  echo "$KEY" >"$dest/.complete"
  rm -rf "$HELPER"
  mv "$dest" "$HELPER"
}

if [ "$FORCE" = 1 ] || [ "$(cat "$HELPER/.complete" 2>/dev/null)" != "$KEY" ]; then
  rm -rf "$WORK"
  mkdir -p "$SOURCES" "$WORK/src" "$WORK/build" "$LOGS"
  export MACOSX_DEPLOYMENT_TARGET="$MACOS_MIN"
  export CC=/usr/bin/clang CXX=/usr/bin/clang++
  export CFLAGS="-mmacosx-version-min=$MACOS_MIN" CXXFLAGS="-mmacosx-version-min=$MACOS_MIN"
  export LDFLAGS="-mmacosx-version-min=$MACOS_MIN"
  export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig" PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
  export PATH="$TOOLS:$PATH"
  write_tool_shims
  for name in ffmpeg dav1d freetype fribidi harfbuzz libass zimg; do step "fetch-$name" fetch_source "$name"; done
  step verify-ffmpeg-signature verify_ffmpeg_signature
  for name in ffmpeg dav1d freetype fribidi harfbuzz libass zimg; do unpack "$name"; done
  step freetype build_freetype
  step fribidi build_fribidi
  step harfbuzz build_harfbuzz
  step libass build_libass
  step zimg build_zimg
  step dav1d build_dav1d
  step ffmpeg build_ffmpeg
  step assemble assemble
  # Keep the downloads and the helper; the build tree is only needed to debug a failed build.
  rm -rf "$WORK"
else
  echo "build.sh: reusing the cached helper ($KEY)"
fi

if [ -n "$OUT" ]; then
  rm -rf "$OUT"
  mkdir -p "$(dirname "$OUT")"
  /usr/bin/ditto "$HELPER" "$OUT"
  rm -f "$OUT/.complete"
fi
echo "$HELPER"
