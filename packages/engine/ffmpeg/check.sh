#!/bin/bash
# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
#
# Checks an FFmpeg helper folder (S7V-016): build.sh's output, or a packaged app's
# "s7video (Beta).app/Contents/Resources/ffmpeg".
#
#   packages/engine/ffmpeg/check.sh HELPER_DIR [--render]
#
# - every Mach-O file links only /System/Library, /usr/lib and @rpath/@loader_path, has no
#   absolute rpath, targets the minimum macOS in versions.lock, and has a valid code signature;
# - ffmpeg -L is LGPL 2.1 or later, and -buildconf has no --enable-gpl, -nonfree or -version3;
# - the features the engine needs: subtitles/ass (libass), zscale and tonemap (zimg), the
#   libdav1d AV1 decoder (no hardware needed), h264_videotoolbox, and the lavfi input;
# - no file names a folder of the build Mac (home, temp, /Users, /private/var): the user name
#   must not ship, and FFmpeg must look for nothing outside the app;
# - every licence text versions.lock lists is in LICENSES/, and SOURCES.md is there;
# - sources/ holds every source tarball (matching SHA256SUMS and versions.lock), FFmpeg's
#   signature, and the complete recipe, so the LGPL sources go out with the app;
# - with --render: a 2 s 1080x1920 captioned clip encodes with a system-only environment.
set -euo pipefail

die() {
  echo "check.sh: $*" >&2
  exit 1
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ $# -ge 1 ] || die "usage: check.sh HELPER_DIR [--render]"
DIR="$(cd "$1" && pwd)"
RENDER="${2:-}"
MACOS_MIN="$(/usr/bin/plutil -extract target.macosMinimum raw -o - "$HERE/versions.lock")"
[ -x "$DIR/bin/ffmpeg" ] && [ -x "$DIR/bin/ffprobe" ] || die "$DIR has no bin/ffmpeg and bin/ffprobe"

count=0
while read -r file; do
  /usr/bin/file -b "$file" | grep -q "Mach-O" || die "$file is not a Mach-O file"
  while read -r dep; do
    case "$dep" in
      /System/Library/* | /usr/lib/* | @rpath/* | @loader_path/*) ;;
      *) die "$file links $dep" ;;
    esac
  done < <(otool -L "$file" | tail -n +2 | awk '{print $1}')
  while read -r rpath; do
    case "$rpath" in
      @loader_path* | @executable_path*) ;;
      *) die "$file has the absolute rpath $rpath" ;;
    esac
  done < <(otool -l "$file" | awk '/cmd LC_RPATH/{getline; getline; print $2}')
  minos="$(otool -l "$file" | awk '/cmd LC_BUILD_VERSION/{for (i = 0; i < 4; i++) {getline; if ($1 == "minos") print $2}}')"
  [ "$minos" = "$MACOS_MIN" ] || die "$file targets macOS ${minos:-unknown}, not $MACOS_MIN"
  /usr/bin/codesign --verify --strict "$file" 2>/dev/null || die "$file has no valid code signature"
  count=$((count + 1))
done < <(find "$DIR/bin" "$DIR/lib" -type f)
echo "check.sh: $count Mach-O files link only the system and the helper, for macOS $MACOS_MIN"

# A system-only environment, as the packaged server starts the engine (no Homebrew on PATH).
run() { /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$HOME" "$@"; }
ffmpeg="$DIR/bin/ffmpeg"
licence="$(run "$ffmpeg" -hide_banner -L | tr '\n' ' ')"
grep -q "GNU Lesser General Public License as published by the Free Software Foundation; either version 2.1 of the License, or (at your option) any later version" <<<"$licence" ||
  die "ffmpeg -L does not say LGPL 2.1 or later"
buildconf="$(run "$ffmpeg" -hide_banner -buildconf)"
for flag in --enable-gpl --enable-nonfree --enable-version3; do
  if grep -qe "$flag" <<<"$buildconf"; then die "-buildconf has $flag"; fi
done
filters="$(run "$ffmpeg" -hide_banner -filters)"
for filter in subtitles ass zscale tonemap; do
  grep -qE "^ [A-Z.|]+ $filter " <<<"$filters" || die "ffmpeg has no $filter filter"
done
# Lists are read whole first: with pipefail, `grep -q` closing the pipe early fails the pipeline.
encoders="$(run "$ffmpeg" -hide_banner -encoders)"
decoders="$(run "$ffmpeg" -hide_banner -decoders)"
devices="$(run "$ffmpeg" -hide_banner -devices 2>/dev/null)"
grep -qE "^ V\S* h264_videotoolbox " <<<"$encoders" || die "ffmpeg has no h264_videotoolbox"
grep -qE "^ V\S* libdav1d " <<<"$decoders" || die "ffmpeg has no libdav1d AV1 decoder"
grep -q " lavfi " <<<"$devices" || die "ffmpeg has no lavfi input"
run "$DIR/bin/ffprobe" -hide_banner -version >/dev/null || die "ffprobe does not run"
echo "check.sh: LGPL 2.1 or later; libass, zimg, libdav1d, h264_videotoolbox and lavfi present"

# The build Mac's folders, spelt so this file does not match itself.
leaks=("/Us""ers/" "/priv""ate/var/" "/var/fol""ders/")
[ -n "${HOME:-}" ] && [ "$HOME" != / ] && leaks+=("$HOME")
patterns=()
for leak in "${leaks[@]}"; do patterns+=(-e "$leak"); done
# Tarballs are upstream's compressed bytes; everything else that ships is checked.
found="$(find "$DIR" -type f ! -path "$DIR/sources/*.tar.*" -print0 | xargs -0 /usr/bin/grep -a -l -F "${patterns[@]}" || true)"
[ -z "$found" ] || die "these files name a folder of the build Mac: $(echo "$found" | tr '\n' ' ')"
echo "check.sh: no file names a folder of the build Mac"

[ -f "$DIR/SOURCES.md" ] || die "no SOURCES.md"
lock() { /usr/bin/plutil -extract "$1" raw -o - "$HERE/versions.lock"; }
index=0
while name="$(lock "sources.$index.name" 2>/dev/null)"; do
  files=0
  while file="$(lock "sources.$index.licenseFiles.$files" 2>/dev/null)"; do
    [ -s "$DIR/LICENSES/$name/$file" ] || die "LICENSES/$name/$file is missing"
    files=$((files + 1))
  done
  [ "$files" -gt 0 ] || die "versions.lock lists no licence text for $name"
  tarball="$(lock "sources.$index.file" 2>/dev/null || basename "$(lock "sources.$index.url")")"
  [ -f "$DIR/sources/$tarball" ] || die "sources/$tarball is missing"
  grep -q "^$(lock "sources.$index.sha256")  $tarball\$" "$DIR/sources/SHA256SUMS" 2>/dev/null ||
    die "sources/SHA256SUMS does not pin $tarball to versions.lock's sha256"
  index=$((index + 1))
done
[ "$index" -gt 0 ] || die "versions.lock lists no sources"
(cd "$DIR/sources" && /usr/bin/shasum -a 256 -c -s SHA256SUMS) || die "a tarball in sources/ does not match SHA256SUMS"
ls "$DIR/sources/"*.asc >/dev/null 2>&1 || die "sources/ has no FFmpeg signature"
for file in build.sh check.sh versions.lock build-tools.txt pgp_verify.py keys/ffmpeg-devel.asc \
  overlays/zimg/meson.build fonts/Inter-Bold.ttf fonts/OFL.txt; do
  [ -f "$DIR/sources/recipe/$file" ] || die "sources/recipe/$file is missing"
done
echo "check.sh: LICENSES/, SOURCES.md and sources/ (tarballs, signature, recipe) present"


if [ "$RENDER" = --render ]; then
  work="$(mktemp -d "${TMPDIR:-/tmp}/s7v-ffmpeg-check.XXXXXX")"
  trap 'rm -rf "$work"' EXIT
  mkdir "$work/fonts"
  font="$HERE/fonts/Inter-Bold.ttf"
  [ -f "$font" ] || font="$HERE/../assets/fonts/Inter-Bold.ttf"
  ln -s "$font" "$work/fonts/Inter-Bold.ttf"
  printf '[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, Bold, Alignment, MarginV\nStyle: Default,Inter,96,&H00FFFFFF,-1,2,300\n\n[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:00.00,0:00:02.00,Default,check こんにちは\n' >"$work/check.ass"
  (cd "$work" && run "$ffmpeg" -v error -nostdin -f lavfi -i testsrc2=size=1080x1920:rate=30:duration=2 \
    -f lavfi -i sine=frequency=440:sample_rate=48000:duration=2 \
    -vf "subtitles=filename=check.ass:fontsdir=fonts" -c:v h264_videotoolbox -b:v 6M -pix_fmt yuv420p \
    -c:a aac -shortest check.mp4) || die "the captioned test render failed"
  frames="$(run "$DIR/bin/ffprobe" -v error -count_packets -select_streams v:0 -show_entries stream=nb_read_packets -of csv=p=0 "$work/check.mp4")"
  [ "$frames" = 60 ] || die "the test render has $frames frames, not 60"
  echo "check.sh: a 2 s captioned 1080x1920 render encoded with h264_videotoolbox (60 frames)"
fi
