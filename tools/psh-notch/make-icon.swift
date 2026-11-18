// Renders the app icon: the idle notch on a white plate, so the thing you are about to
// install is visible in the dmg window and in the menu bar's app list.
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

// The notch itself: square against the top edge, rounded only underneath. This is the shape
// the app actually draws (see `addBottomRounded` in PSHNotch.swift), because the hardware is
// like that - the 14 inch cutout meets the menu bar in a straight line and turns the corner
// only where it meets the desktop. A full pill, which this used to be, reads as a lozenge
// floating on the plate and is not the notch at any size.
//
// Proportions held to the display: the cutout is 185x32 at the top of the screen, so the icon
// is the same shape scaled up, radius included, rather than a pill of some other ratio.
let notchW: CGFloat = 600
let notchH = notchW * 32 / 185
let notch = NSRect(x: (S - notchW) / 2, y: (S - notchH) / 2 + 20, width: notchW, height: notchH)
ink.setFill()
// Half the height, which is what the app's `min(requested, w/2, h/2)` resolves to on a 32pt
// bar: the bottom is a true semicircle while the top stays square. Measured off the app's own
// `--render` output rather than assumed - a rounder value would have been a different shape.
let r = notchH / 2
let k = r * 0.5523
let path = NSBezierPath()
path.move(to: NSPoint(x: notch.minX, y: notch.maxY))
path.line(to: NSPoint(x: notch.maxX, y: notch.maxY))
path.line(to: NSPoint(x: notch.maxX, y: notch.minY + r))
path.curve(
    to: NSPoint(x: notch.maxX - r, y: notch.minY),
    controlPoint1: NSPoint(x: notch.maxX, y: notch.minY + r - k),
    controlPoint2: NSPoint(x: notch.maxX - r + k, y: notch.minY)
)
path.line(to: NSPoint(x: notch.minX + r, y: notch.minY))
path.curve(
    to: NSPoint(x: notch.minX, y: notch.minY + r),
    controlPoint1: NSPoint(x: notch.minX + r - k, y: notch.minY),
    controlPoint2: NSPoint(x: notch.minX, y: notch.minY + r - k)
)
path.close()
path.fill()

// the idle dot
grey.setFill()
let dot = notchH * 26 / 92
NSBezierPath(ovalIn: NSRect(x: notch.minX + notchW * 52 / 600, y: notch.midY - dot / 2, width: dot, height: dot)).fill()

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
