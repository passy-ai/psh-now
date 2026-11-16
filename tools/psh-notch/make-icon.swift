// Renders the app icon: the idle notch pill on a white plate, so the thing you are about
// to install is visible in the dmg window and in the menu bar's app list.
import AppKit

let S: CGFloat = 1024
let img = NSImage(size: NSSize(width: S, height: S))
img.lockFocus()
NSGraphicsContext.current?.shouldAntialias = true

// white plate, macOS rounded square (the system masks it again, this is the drawn edge)
let plate = NSRect(x: 32, y: 32, width: S - 64, height: S - 64)
NSColor.white.setFill()
NSBezierPath(roundedRect: plate, xRadius: 180, yRadius: 180).fill()

let ink = NSColor(calibratedRed: 0.043, green: 0.043, blue: 0.047, alpha: 1)
let grey = NSColor(calibratedRed: 0.56, green: 0.56, blue: 0.58, alpha: 1)

// the pill, radius = half the height
let pillW: CGFloat = 600, pillH: CGFloat = 92
let pill = NSRect(x: (S - pillW) / 2, y: (S - pillH) / 2 + 20, width: pillW, height: pillH)
ink.setFill()
NSBezierPath(roundedRect: pill, xRadius: pillH / 2, yRadius: pillH / 2).fill()

// the idle dot
grey.setFill()
NSBezierPath(ovalIn: NSRect(x: pill.minX + 52, y: pill.midY - 13, width: 26, height: 26)).fill()

img.unlockFocus()

guard let tiff = img.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write("icon: could not encode png\n".data(using: .utf8)!)
    exit(1)
}
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"
try! png.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
