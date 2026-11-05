// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
//
// Regenerates the synthetic HEIC fixtures and their upright references:
//   swift fixtures/images/generate.swift fixtures/images
import CoreGraphics
import Foundation
import ImageIO

let directory = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ".")
let width = 192
let height = 128

// Quadrants (red, green / blue, white) under a left-to-right brightness ramp, so any rotation,
// mirror or channel swap is visible in the corners.
func storedPixel(_ x: Int, _ y: Int) -> (UInt8, UInt8, UInt8) {
  let base: (Double, Double, Double) =
    y < height / 2
    ? (x < width / 2 ? (220, 30, 30) : (30, 200, 60))
    : (x < width / 2 ? (30, 60, 220) : (240, 240, 240))
  let ramp = 0.65 + 0.35 * Double(x) / Double(width - 1)
  return (UInt8(base.0 * ramp), UInt8(base.1 * ramp), UInt8(base.2 * ramp))
}

func makeImage(_ w: Int, _ h: Int, _ pixel: (Int, Int) -> (UInt8, UInt8, UInt8)) -> CGImage {
  var bytes = [UInt8](repeating: 255, count: w * h * 4)
  for y in 0..<h {
    for x in 0..<w {
      let (r, g, b) = pixel(x, y)
      let i = (y * w + x) * 4
      bytes[i] = r
      bytes[i + 1] = g
      bytes[i + 2] = b
    }
  }
  let context = CGContext(
    data: &bytes, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
    space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
  return context.makeImage()!
}

func write(_ image: CGImage, _ name: String, _ type: String, _ properties: [CFString: Any]) {
  let url = directory.appendingPathComponent(name) as CFURL
  let destination = CGImageDestinationCreateWithURL(url, type as CFString, 1, nil)!
  CGImageDestinationAddImage(destination, image, properties as CFDictionary)
  precondition(CGImageDestinationFinalize(destination), "could not write \(name)")
}

let stored = makeImage(width, height, storedPixel)
let quality: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 0.9]
write(stored, "landscape.heic", "public.heic", quality.merging([kCGImagePropertyOrientation: 1]) { $1 })
// EXIF orientation 6, as an iPhone held upright writes: stored landscape, shown rotated 90° clockwise.
write(stored, "portrait.heic", "public.heic", quality.merging([kCGImagePropertyOrientation: 6]) { $1 })

write(stored, "landscape.expected.png", "public.png", [:])
// Orientation 6 shows stored pixel (x: Y, y: height - 1 - X) at display position (X, Y).
write(makeImage(height, width) { x, y in storedPixel(y, height - 1 - x) }, "portrait.expected.png", "public.png", [:])
