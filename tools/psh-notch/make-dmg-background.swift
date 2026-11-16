// Renders the dmg window plate: white, the idle notch pill at the top, and one short
// lucide style arrow between the two icon slots. Nothing else, no caption.
import AppKit

let W: CGFloat = 640, H: CGFloat = 400
let img = NSImage(size: NSSize(width: W, height: H))
img.lockFocus()
NSGraphicsContext.current?.shouldAntialias = true

NSColor.white.setFill()
NSBezierPath(rect: NSRect(x: 0, y: 0, width: W, height: H)).fill()

let grey = NSColor(calibratedRed: 0.45, green: 0.45, blue: 0.48, alpha: 1)
let ink = NSColor(calibratedRed: 0.043, green: 0.043, blue: 0.047, alpha: 1)

// --- the idle notch: a true pill, radius = half the height ---
let pillW: CGFloat = 180, pillH: CGFloat = 28
let pill = NSRect(x: (W - pillW) / 2, y: H - 44 - pillH, width: pillW, height: pillH)
ink.setFill()
NSBezierPath(roundedRect: pill, xRadius: pillH / 2, yRadius: pillH / 2).fill()

// the one grey dot, the whole idle state
grey.setFill()
NSBezierPath(ovalIn: NSRect(x: pill.minX + 15, y: pill.midY - 4, width: 8, height: 8)).fill()

// --- the drag arrow: shorter, one shaft and one chevron, round caps ---
let y: CGFloat = 200
func seg(_ a: NSPoint, _ b: NSPoint) {
    let p = NSBezierPath()
    p.lineWidth = 2.5
    p.lineCapStyle = .round
    p.lineJoinStyle = .round
    p.move(to: a)
    p.line(to: b)
    p.stroke()
}
grey.setStroke()
seg(NSPoint(x: 296, y: y), NSPoint(x: 372, y: y))
seg(NSPoint(x: 356, y: y + 14), NSPoint(x: 372, y: y))
seg(NSPoint(x: 356, y: y - 14), NSPoint(x: 372, y: y))

img.unlockFocus()

guard let tiff = img.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write("background: could not encode png\n".data(using: .utf8)!)
    exit(1)
}
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "dist/dmg-bg.png"
try! png.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
