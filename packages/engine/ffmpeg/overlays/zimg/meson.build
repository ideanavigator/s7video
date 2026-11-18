# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
#
# A meson build for zimg 3.0.6 (S7V-016). zimg ships only autotools, and automake is not part of
# Xcode, so build.sh copies this file into the unpacked source. The source lists and flags follow
# zimg's own Makefile.am and configure.ac for an aarch64 host: ZIMG_ARM with the NEON files, C++14,
# hidden visibility (the API exports itself with ZIMG_VISIBILITY), and -DNDEBUG.
project('zimg', 'cpp', version: '3.0.6', default_options: ['cpp_std=c++14', 'warning_level=0'])

if host_machine.cpu_family() != 'aarch64'
  error('this overlay builds zimg for Apple Silicon (aarch64) only')
endif

sources = files(
  'src/zimg/api/zimg.cpp',
  'src/zimg/colorspace/colorspace.cpp',
  'src/zimg/colorspace/colorspace_param.cpp',
  'src/zimg/colorspace/gamma.cpp',
  'src/zimg/colorspace/graph.cpp',
  'src/zimg/colorspace/matrix3.cpp',
  'src/zimg/colorspace/operation.cpp',
  'src/zimg/colorspace/operation_impl.cpp',
  'src/zimg/common/cpuinfo.cpp',
  'src/zimg/common/libm_wrapper.cpp',
  'src/zimg/common/matrix.cpp',
  'src/zimg/depth/blue.cpp',
  'src/zimg/depth/depth_convert.cpp',
  'src/zimg/depth/depth.cpp',
  'src/zimg/depth/dither.cpp',
  'src/zimg/depth/quantize.cpp',
  'src/zimg/graph/basic_filter.cpp',
  'src/zimg/graph/filtergraph.cpp',
  'src/zimg/graph/graphbuilder.cpp',
  'src/zimg/graph/graphnode.cpp',
  'src/zimg/resize/filter.cpp',
  'src/zimg/resize/resize.cpp',
  'src/zimg/resize/resize_impl.cpp',
  'src/zimg/unresize/bilinear.cpp',
  'src/zimg/unresize/unresize.cpp',
  'src/zimg/unresize/unresize_impl.cpp',
  # ARMSIMD
  'src/zimg/colorspace/arm/operation_impl_arm.cpp',
  'src/zimg/common/arm/cpuinfo_arm.cpp',
  'src/zimg/common/arm/neon_util.cpp',
  'src/zimg/depth/arm/depth_convert_arm.cpp',
  'src/zimg/depth/arm/dither_arm.cpp',
  'src/zimg/resize/arm/resize_impl_arm.cpp',
  # libneon
  'src/zimg/colorspace/arm/operation_impl_neon.cpp',
  'src/zimg/depth/arm/depth_convert_neon.cpp',
  'src/zimg/depth/arm/dither_neon.cpp',
  'src/zimg/depth/arm/f16c_neon.cpp',
  'src/zimg/resize/arm/resize_impl_neon.cpp',
)

zimg = shared_library(
  'zimg',
  sources,
  cpp_args: ['-DZIMG_ARM', '-DNDEBUG', '-fvisibility=hidden'],
  include_directories: include_directories('src/zimg'),
  dependencies: dependency('threads'),
  version: '2.0.0',
  soversion: '2',
  install: true,
)

install_headers('src/zimg/api/zimg.h', 'src/zimg/api/zimg++.hpp')

import('pkgconfig').generate(
  zimg,
  name: 'zimg',
  description: 'Scaling, colorspace conversion, and dithering library',
)
