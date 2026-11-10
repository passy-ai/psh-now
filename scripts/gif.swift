// Frames in, one looping GIF out, using ImageIO so it needs nothing installed.
//
//   swift tools/gif.swift <frames-dir> <output.gif> <delay-seconds>
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count >= 4 else {
    FileHandle.standardError.write("usage: gif <frames-dir> <output.gif> <delay>\n".data(using: .utf8)!)
    exit(2)
}
let dir = args[1]
let out = args[2]
let delay = Double(args[3]) ?? 0.06

let frames = (try! FileManager.default.contentsOfDirectory(atPath: dir))
    .filter { $0.hasSuffix(".png") }
    .sorted()
guard !frames.isEmpty else {
    FileHandle.standardError.write("no png frames in \(dir)\n".data(using: .utf8)!)
    exit(1)
}

let url = URL(fileURLWithPath: out)
guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.gif.identifier as CFString,
                                                 frames.count, nil) else {
    FileHandle.standardError.write("could not create \(out)\n".data(using: .utf8)!)
    exit(1)
}
let gifProps: [CFString: Any] = [
    kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0],
]
CGImageDestinationSetProperties(dest, gifProps as CFDictionary)

for name in frames {
    let path = "\(dir)/\(name)"
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
        FileHandle.standardError.write("skipping \(name)\n".data(using: .utf8)!)
        continue
    }
    let frameProps: [CFString: Any] = [
        kCGImagePropertyGIFDictionary: [
            kCGImagePropertyGIFDelayTime: delay,
            kCGImagePropertyGIFUnclampedDelayTime: delay,
        ],
    ]
    CGImageDestinationAddImage(dest, img, frameProps as CFDictionary)
}

guard CGImageDestinationFinalize(dest) else {
    FileHandle.standardError.write("could not write \(out)\n".data(using: .utf8)!)
    exit(1)
}
print("wrote \(out) from \(frames.count) frames at \(delay)s")
