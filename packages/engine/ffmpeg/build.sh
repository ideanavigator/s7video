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
# Needs only Xcode's command line tools and uv: meson, ninja, pkgconf and PGPy come from PyPI,
# pinned by sha256 in build-tools.txt, installed by uv into a private venv. It runs in a clean
# environment with a system-only PATH, so nothing from Homebrew is found, and installs under the
# fixed prefix /s7video-ffmpeg through DESTDIR, so no path of the build Mac is built in. Source
# tarballs next to this recipe (as in a helper's sources/) are used before downloading. Downloads
# and build trees live in $S7VIDEO_FFMPEG_BUILD_DIR (default ~/Library/Caches/s7video-ffmpeg),
# under one lock; a finished helper is cached there by a hash of this recipe, so a second run only
# copies it. --out copies the helper to DIR. The last line printed is the cached helper's folder
# (scripts/build-desktop-artifact.ts and pnpm licenses:check read it). The helper ships its exact
# sources and this recipe in sources/, for the LGPL.
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
      sed -n '5,22p' "$HERE/build.sh"
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

LOCK="$HERE/versions.lock"
lock() { /usr/bin/plutil -extract "$1" raw -o - "$LOCK"; }

MACOS_MIN="$(lock target.macosMinimum)"
CACHE="$S7VIDEO_FFMPEG_BUILD_DIR"
# check.sh's test render uses the bundled Inter Bold: the engine's in the repository, or the
# recipe's own copy in a helper's sources/recipe.
FONT="$HERE/fonts/Inter-Bold.ttf"
[ -f "$FONT" ] || FONT="$HERE/../assets/fonts/Inter-Bold.ttf"
FONT_LICENCE="$(dirname "$FONT")/OFL.txt"
# Everything the helper is built from or ships in sources/recipe.
RECIPE_FILES=(build.sh check.sh versions.lock build-tools.txt pgp_verify.py keys/ffmpeg-devel.asc overlays/zimg/meson.build)
KEY="$( (cd "$HERE" && cat "${RECIPE_FILES[@]}") | cat - "$FONT" "$FONT_LICENCE" | /usr/bin/shasum -a 256 | cut -c1-16)"
SOURCES="$CACHE/sources"
WORK="$CACHE/work-$KEY"
HELPER="$CACHE/helper-$KEY"
# The prefix the binaries record (FFmpeg's configuration and data folder): fixed and neutral.
INSTALL_PREFIX=/s7video-ffmpeg
ROOT="$WORK/stage"
PREFIX="$ROOT$INSTALL_PREFIX"
TOOLS="$WORK/tools/bin"
VENV="$WORK/tools/venv"
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
  # A helper's sources/ folder holds the tarballs beside its recipe: no download needed. (A file
  # with no pinned hash is FFmpeg's signature, which is verified anyway.)
  if [ -f "$HERE/../$file" ] && { [ -z "$sha" ] || [ "$(sha256_of "$HERE/../$file")" = "$sha" ]; }; then
    cp "$HERE/../$file" "$target"
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

# The release key is kept in this recipe and pinned by sha256; only a signature made by its primary
# key counts. The self-test first proves a grafted subkey's signature would be refused.
verify_ffmpeg_signature() {
  local index file key
  index="$(source_index ffmpeg)"
  file="$(source_file ffmpeg)"
  key="$HERE/$(lock "sources.$index.signature.key")"
  [ "$(sha256_of "$key")" = "$(lock "sources.$index.signature.keySha256")" ] ||
    die "$key does not match its pinned sha256"
  fetch "$(lock "sources.$index.signature.url")" "$file.asc"
  "$VENV/bin/python" -I "$HERE/pgp_verify.py" --self-test "$key"
  "$VENV/bin/python" -I "$HERE/pgp_verify.py" "$key" "$(lock "sources.$index.signature.fingerprint")" \
    "$SOURCES/$file.asc" "$SOURCES/$file"
}

unpack() {
  local name="$1"
  rm -rf "$WORK/src/$name"
  mkdir -p "$WORK/src/$name"
  tar -xf "$SOURCES/$(source_file "$name")" -C "$WORK/src/$name" --strip-components 1
}

# meson, ninja, pkgconf and PGPy (with its dependencies), each wheel pinned by sha256.
install_tools() {
  "$UV" venv -q --python 3.12 "$VENV"
  "$UV" pip install -q --python "$VENV/bin/python" --require-hashes --no-deps -r "$HERE/build-tools.txt"
  mkdir -p "$TOOLS"
  ln -s "$VENV/bin/meson" "$TOOLS/meson"
  ln -s "$VENV/bin/ninja" "$TOOLS/ninja"
  # pkgconf from PyPI warns when PKG_CONFIG_PATH is unset; both point at the private prefix only.
  ln -s "$VENV/bin/pkgconf" "$TOOLS/pkg-config"
}

meson_build() {
  local name="$1"
  shift
  meson setup "$WORK/build/$name" "$WORK/src/$name" \
    --prefix="$INSTALL_PREFIX" --libdir=lib --buildtype=release -Db_ndebug=true \
    -Ddefault_library=shared --wrap-mode=nodownload "$@"
  DESTDIR="$ROOT" ninja -C "$WORK/build/$name" install
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
      "$INSTALL_PREFIX"/* | "$PREFIX"/*) install_name_tool -id "@rpath/$(basename "$id")" "$lib" ;;
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
  # Every argument here is in the binaries' configuration string: nothing from the build Mac.
  ./configure --prefix="$INSTALL_PREFIX" --arch=arm64 --target-os=darwin --cc=/usr/bin/clang \
    --pkg-config=pkg-config --install-name-dir='@rpath' \
    --extra-cflags="-mmacosx-version-min=$MACOS_MIN" \
    --extra-ldflags="-mmacosx-version-min=$MACOS_MIN -Wl,-rpath,@loader_path/../lib" \
    "${FFMPEG_CONFIGURE[@]}"
  make -j"$(($(sysctl -n hw.ncpu) > 10 ? 10 : $(sysctl -n hw.ncpu)))"
  make install DESTDIR="$ROOT"
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
      # Relative paths kept: FreeType has two READMEs (src/bdf, src/pcf).
      mkdir -p "$dest/LICENSES/$name/$(dirname "$file")"
      cp "$WORK/src/$name/$file" "$dest/LICENSES/$name/$file"
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
    echo "They were built from the exact source tarballs in \`sources/\` (listed in \`sources/SHA256SUMS\`)"
    echo "by \`sources/recipe/build.sh\`, with \`sources/recipe/versions.lock\` and the zimg build file in"
    echo "\`sources/recipe/overlays/\` (our only addition to the sources), for Apple Silicon and macOS"
    echo "$MACOS_MIN or later. To rebuild, or to build a changed version and put it in place of these files,"
    echo "copy \`sources/\` somewhere and run \`recipe/build.sh --out <folder>\` (it needs Xcode's command"
    echo "line tools and uv). Licence texts are in \`LICENSES/\`."
    echo
    echo "This software uses code of [FFmpeg](https://ffmpeg.org) licensed under the LGPLv2.1 or later."
    echo "Portions of this software are copyright © The FreeType Project (www.freetype.org). All rights"
    echo "reserved. FreeType is used under the FreeType License (FTL), elected from its FTL or GPL choice."
    echo
    echo "| Source | Version | Licence | SHA-256 | Downloaded from |"
    echo "|---|---|---|---|---|"
    while name="$(lock "sources.$index.name" 2>/dev/null)"; do
      echo "| $name | $(lock "sources.$index.version") | $(lock "sources.$index.license") | \`$(lock "sources.$index.sha256")\` | $(lock "sources.$index.url") |"
      index=$((index + 1))
    done
    echo
    echo "FFmpeg's tarball was checked against its OpenPGP signature (\`sources/$(source_file ffmpeg).asc\`), made by the primary"
    echo "key $(src ffmpeg signature.fingerprint) (\`sources/recipe/$(src ffmpeg signature.key)\`)."
    echo
    echo "FFmpeg configuration (\`ffmpeg -buildconf\`):"
    echo
    echo '```'
    "$dest/bin/ffmpeg" -hide_banner -buildconf
    echo '```'
    echo
    echo "Build tools, not shipped: meson $(tool_version meson), ninja $(tool_version ninja), pkgconf $(tool_version pkgconf) and PGPy $(tool_version pgpy), pinned by sha256 in \`sources/recipe/build-tools.txt\`; Apple clang $(/usr/bin/clang --version | head -1 | sed 's/.*version \([0-9.]*\).*/\1/')."
  } >"$dest/SOURCES.md"
}

# The LGPL sources: every tarball, FFmpeg's signature, and the recipe that builds them, runnable
# from a copy of this folder.
write_source_folder() {
  local dest="$1/sources" index=0 name file
  mkdir -p "$dest/recipe/fonts"
  while name="$(lock "sources.$index.name" 2>/dev/null)"; do
    file="$(source_file "$name")"
    cp "$SOURCES/$file" "$dest/$file"
    (cd "$dest" && /usr/bin/shasum -a 256 "$file") >>"$dest/SHA256SUMS"
    index=$((index + 1))
  done
  cp "$SOURCES/$(source_file ffmpeg).asc" "$dest/"
  (cd "$HERE" && for file in "${RECIPE_FILES[@]}"; do
    mkdir -p "$dest/recipe/$(dirname "$file")"
    cp "$file" "$dest/recipe/$file"
  done)
  cp "$FONT" "$FONT_LICENCE" "$dest/recipe/fonts/"
}

assemble() {
  local dest="$HELPER.tmp"
  rm -rf "$dest"
  mkdir -p "$dest/bin" "$dest/lib"
  cp "$PREFIX/bin/ffmpeg" "$PREFIX/bin/ffprobe" "$dest/bin/"
  copy_closure "$dest"
  # Strip local symbols, then sign ad hoc again: Apple Silicon runs no unsigned code. The release
  # build signs every file again with the Developer ID (S7V-011).
  strip -x "$dest"/lib/*.dylib
  while read -r file; do codesign --force --sign - "$file"; done < <(macho_files "$dest")
  write_licences "$dest"
  write_source_folder "$dest"
  write_sources "$dest"
  # AC-2, AC-3, AC-4 and Check 2: links, rpaths, minimum macOS, signatures, no build-Mac paths,
  # licence, features, sources.
  /bin/bash "$HERE/check.sh" "$dest" --render
  echo "$KEY" >"$dest/.complete"
  rm -rf "$HELPER"
  mv "$dest" "$HELPER"
}

# One build at a time per cache: worktrees share it, and a build removes its own work folder.
# A lock whose owner is gone is taken over (as scripts/build-engine-runtime.ts does).
take_cache_lock() {
  local lock_dir="$CACHE/.lock" holder waited=0
  mkdir -p "$CACHE"
  until mkdir "$lock_dir" 2>/dev/null; do
    holder="$(cat "$lock_dir/owner" 2>/dev/null || true)"
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
      rm -rf "$lock_dir"
      continue
    fi
    [ "$waited" -lt 3600 ] || die "$lock_dir is held by PID ${holder:-unknown}; another build is using the cache"
    [ "$waited" -gt 0 ] || echo "build.sh: waiting for another build (PID ${holder:-unknown}) to release $lock_dir"
    sleep 5
    waited=$((waited + 5))
  done
  echo "$$" >"$lock_dir/owner"
  trap 'rm -rf "$CACHE/.lock"' EXIT
}

take_cache_lock
if [ "$FORCE" = 1 ] || [ "$(cat "$HELPER/.complete" 2>/dev/null)" != "$KEY" ]; then
  rm -rf "$WORK"
  mkdir -p "$SOURCES" "$WORK/src" "$WORK/build" "$LOGS" "$PREFIX"
  export MACOSX_DEPLOYMENT_TARGET="$MACOS_MIN"
  export CC=/usr/bin/clang CXX=/usr/bin/clang++
  export CFLAGS="-mmacosx-version-min=$MACOS_MIN" CXXFLAGS="-mmacosx-version-min=$MACOS_MIN"
  export LDFLAGS="-mmacosx-version-min=$MACOS_MIN"
  # The .pc files say /s7video-ffmpeg; the sysroot points their flags at the DESTDIR copy.
  export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig" PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
  export PKG_CONFIG_SYSROOT_DIR="$ROOT"
  export PATH="$TOOLS:$PATH"
  step tools install_tools
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
