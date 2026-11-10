// PSHNotch - a menu bar and notch approver for psh.now.
//
// One credential, and it is not the account secret: the pairing flow mints a
// device token that can approve but cannot administer, and it can be revoked
// from the dashboard's Devices page. Store it in
// ~/.config/psh-notch/device.json (0600). Nothing else is needed.
//
//   PSHNotch --pair https://psh.now/pair/<token> --name "MacBook notch"
//   PSHNotch                       # menu bar item, live over the websocket
//   PSHNotch --selftest            # headless: connect, decide the first pending, exit
//   PSHNotch --geometry            # print the notch anchor this display gives us
//
// Build: swiftc -parse-as-library -O -o psh-notch PSHNotch.swift

import AppKit
import Foundation
import QuartzCore
import ServiceManagement

// MARK: - small helpers

func jsonObject(_ data: Data) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
}

func field(_ obj: [String: Any], _ keys: String...) -> String? {
    for k in keys {
        if let v = obj[k] as? String, !v.isEmpty { return v }
        if let v = obj[k] as? NSNumber { return v.stringValue }
    }
    return nil
}

func nested(_ obj: [String: Any], _ path: [String]) -> Any? {
    var cur: Any? = obj
    for key in path {
        guard let dict = cur as? [String: Any] else { return nil }
        cur = dict[key]
    }
    return cur
}

@discardableResult
func httpJSON(_ request: URLRequest, timeout: TimeInterval = 20) -> (Int, [String: Any]) {
    let sem = DispatchSemaphore(value: 0)
    var status = 0
    var body: [String: Any] = [:]
    let task = URLSession.shared.dataTask(with: request) { data, response, _ in
        status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if let data { body = jsonObject(data) }
        sem.signal()
    }
    task.resume()
    _ = sem.wait(timeout: .now() + timeout)
    return (status, body)
}

// MARK: - the ask

/// "1 min ago", the way the list shows the age of a request.
func agoText(_ date: Date?, now: Date = Date()) -> String {
    guard let date else { return "" }
    let seconds = max(0, now.timeIntervalSince(date))
    if seconds < 60 { return "now" }
    if seconds < 3_600 { return "\(Int(seconds / 60))m" }
    if seconds < 86_400 { return "\(Int(seconds / 3_600))h" }
    if seconds < 604_800 { return "\(Int(seconds / 86_400))d" }
    return "\(Int(seconds / 604_800))w"
}

/// The server may send ISO 8601 or an epoch number, in seconds or milliseconds.
func parseDate(_ value: Any?) -> Date? {
    if let number = value as? Double {
        let seconds = number > 1e11 ? number / 1_000 : number
        return Date(timeIntervalSince1970: seconds)
    }
    if let number = value as? Int { return parseDate(Double(number)) }
    guard let text = value as? String else { return nil }
    let iso = ISO8601DateFormatter()
    iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = iso.date(from: text) { return date }
    iso.formatOptions = [.withInternetDateTime]
    if let date = iso.date(from: text) { return date }
    return Double(text).flatMap(parseDate)
}

struct Ask {
    var id: String
    var title: String
    var message: String
    var channel: String?
    var agent: String?
    var status: String
    /// "low", "medium" or "high", from the server's own risk analysis of the request.
    var risk: String?
    /// When the request arrived, for the "2 min ago" label.
    var createdAt: Date?
    /// Recorded but unactionable: the workspace is out of requests. The request still arrives
    /// and is still shown; the three buttons and the answer field are what close.
    var limited: Bool

    init?(json: [String: Any]) {
        guard let id = field(json, "id", "promptId") else { return nil }
        self.id = id
        self.title = field(json, "title") ?? "(untitled request)"
        self.message = field(json, "message") ?? ""
        self.channel = field(json, "channelName", "sessionName", "connectionName", "channel")
            ?? (nested(json, ["session", "name"]) as? String)
            ?? (nested(json, ["connection", "name"]) as? String)
        self.agent = field(json, "agent")
        self.risk = field(json, "risk")
        self.status = field(json, "status") ?? "pending"
        self.limited = (json["limitReached"] as? Bool) ?? false
        self.createdAt = parseDate(json["createdAt"] ?? json["created_at"] ?? json["ts"])
    }
}

// MARK: - config

struct Config: Codable {
    var baseUrl: String
    var deviceToken: String
    var deviceName: String
    var workspaceId: String?
}

/// The app's one credential. `--config` points this elsewhere so a test can exercise
/// pairing without touching the pairing a person is actually using.
let defaultConfigURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(".config/psh-notch/device.json")
var configPathOverride: URL?
var configURL: URL { configPathOverride ?? defaultConfigURL }

func loadConfig() -> Config? {
    guard let data = try? Data(contentsOf: configURL) else { return nil }
    return try? JSONDecoder().decode(Config.self, from: data)
}

func saveConfig(_ config: Config) throws {
    let dir = configURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let data = try JSONEncoder().encode(config)
    try data.write(to: configURL, options: [.atomic])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: configURL.path)
}

/// One line per event, so a detached run can be followed in its log.
func log(_ message: String) {
    print("[notch] \(message)")
    fflush(stdout)
}

func die(_ message: String) -> Never {
    FileHandle.standardError.write(Data(("psh-notch: " + message + "\n").utf8))
    exit(1)
}

// MARK: - pairing

func pair(_ argument: String, name: String) {
    var base = "https://psh.now"
    var token = argument
    if let url = URL(string: argument), let scheme = url.scheme, let host = url.host {
        base = "\(scheme)://\(host)"
        token = url.lastPathComponent
    }
    guard token.count >= 4 else { die("that does not look like a pairing link or token") }

    var request = URLRequest(url: URL(string: "\(base)/api/v1/pairing/\(token)/claim")!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["name": name])

    let (status, body) = httpJSON(request)
    guard status == 200, let deviceToken = field(body, "deviceToken") else {
        die("pairing failed (HTTP \(status)): \(field(body, "message") ?? "unknown")")
    }
    let config = Config(
        baseUrl: base,
        deviceToken: deviceToken,
        deviceName: field(body, "name") ?? name,
        workspaceId: field(body, "workspaceId")
    )
    do { try saveConfig(config) } catch { die("could not save \(configURL.path): \(error)") }
    print("paired as \"\(config.deviceName)\" on workspace \(config.workspaceId ?? "?")")
    print("token saved to \(configURL.path) (0600), revoke it any time from the dashboard's Devices page")
    if let wsUrl = field(body, "wsUrl") { print("live feed: \(wsUrl)?token=<device token>") }
}

/// `psh-notch://paired?token=<device token>&host=https://psh.now`, handed over by the
/// dashboard once it has minted a device token. The token is a credential, so this validates
/// the shape and never logs it, and it only ever writes the token: the account key that the
/// page used to mint it is not part of this URL and is never written down here.
@discardableResult
func handleConnectURL(_ raw: String) -> Bool {
    guard let url = URL(string: raw),
          url.scheme?.lowercased() == "psh-notch",
          url.host?.lowercased() == "paired"
    else { return false }

    let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
    func value(_ name: String) -> String {
        (items.first { $0.name == name }?.value ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
    let token = value("token")
    // A device token is base64url-ish. Anything else, including a pasted account key with the
    // wrong shape, is refused rather than stored.
    guard token.count >= 16, token.count <= 200,
          token.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })
    else {
        FileHandle.standardError.write(Data("psh-notch: refused a connect URL with a bad token\n".utf8))
        return false
    }
    let host = value("host")
    guard let base = URL(string: host), let scheme = base.scheme?.lowercased(),
          scheme == "https" || scheme == "http", base.host != nil
    else {
        FileHandle.standardError.write(Data("psh-notch: refused a connect URL with a bad host\n".utf8))
        return false
    }
    var trimmed = host
    while trimmed.hasSuffix("/") { trimmed.removeLast() }

    let config = Config(
        baseUrl: trimmed,
        deviceToken: token,
        deviceName: Host.current().localizedName ?? "psh.now device",
        workspaceId: nil
    )
    do { try saveConfig(config) } catch {
        FileHandle.standardError.write(Data("psh-notch: could not save \(configURL.path): \(error)\n".utf8))
        return false
    }
    print("connected to \(trimmed)")
    print("token saved to \(configURL.path) (0600); revoke this device any time from the dashboard")
    return true
}

/// Forgets this Mac: removes the app's own config and nothing else. The device record on the
/// server, the workspace and the agent keys are all left alone.
/// Removes the app's own config file, and nothing else. Returns false if it could not.
@discardableResult
func removeConfigFile() -> Bool {
    let path = configURL
    guard FileManager.default.fileExists(atPath: path.path) else { return true }
    do {
        try FileManager.default.removeItem(at: path)
        log("config removed: \(path.path)")
        return true
    } catch {
        NSLog("unpair: could not remove %@: %@", path.path, String(describing: error))
        return false
    }
}

func unpair() -> Never {
    let path = configURL
    if FileManager.default.fileExists(atPath: path.path) {
        do { try FileManager.default.removeItem(at: path) } catch {
            die("could not remove \(path.path): \(error)")
        }
        print("disconnected: removed \(path.path)")
    } else {
        print("already disconnected: nothing at \(path.path)")
    }
    print("the device record still exists; revoke it on the dashboard's Devices page")
    exit(0)
}

// MARK: - the websocket feed

final class LiveFeed: NSObject {
    private var task: URLSessionWebSocketTask?
    private var session: URLSession!
    private let lock = NSLock()

    var onHello: (([Ask], String) -> Void)?
    var onCreated: ((Ask) -> Void)?
    var onDecided: ((String) -> Void)?
    var onAck: ((String, Bool, String?) -> Void)?
    var onState: ((String) -> Void)?

    override init() {
        super.init()
        session = URLSession(configuration: .default)
    }

    // Kept so a close can be recovered from. Without this the client stayed alive and connected
    // to nothing, silently receiving nothing: one reset by the tunnel or an idle timeout was
    // enough, and it never came back on its own.
    private var base = ""
    private var token = ""
    private var reconnectTimer: Timer?
    private var reconnectAttempt = 0

    func connect(base: String, token: String) {
        self.base = base
        // The orange line points at whichever host this client is actually paired with.
        NotchCardView.dashboardURL = base.hasSuffix("/")
            ? base + "app#topup"
            : base + "/app#topup"
        self.token = token
        let ws = base
            .replacingOccurrences(of: "https://", with: "wss://")
            .replacingOccurrences(of: "http://", with: "ws://")
        var components = URLComponents(string: ws + "/ws")
        components?.queryItems = [URLQueryItem(name: "token", value: token)]
        guard let url = components?.url else { return }
        let task = session.webSocketTask(with: url)
        lock.lock(); self.task = task; lock.unlock()
        task.resume()
        onState?("connecting")
        receive()
        keepAlive()
    }

    func disconnect() {
        lock.lock(); let task = self.task; self.task = nil; lock.unlock()
        task?.cancel(with: .goingAway, reason: nil)
    }

    private func keepAlive() {
        DispatchQueue.global().asyncAfter(deadline: .now() + 25) { [weak self] in
            guard let self, self.task != nil else { return }
            self.send(["type": "ping"])
            self.keepAlive()
        }
    }

    private func receive() {
        lock.lock(); let task = self.task; lock.unlock()
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                self.onState?("closed: \(error.localizedDescription)")
                self.scheduleReconnect()
            case .success(let message):
                switch message {
                case .string(let text): self.handle(text)
                case .data(let data): self.handle(String(decoding: data, as: UTF8.self))
                @unknown default: break
                }
                // Frames are arriving, so the connection is genuinely working: start the
                // backoff over rather than carrying a growing delay into the next failure.
                self.reconnectAttempt = 0
                self.receive()
            }
        }
    }

    /// Reconnects after a close, backing off so a server that is down is not hammered: one
    /// second, then two, four, eight, and fifteen apart from then on.
    private func scheduleReconnect() {
        guard reconnectTimer == nil else { return }
        reconnectAttempt = min(reconnectAttempt + 1, 5)
        let delay = min(pow(2.0, Double(reconnectAttempt - 1)), 15)
        log("feed reconnecting in \(Int(delay))s")
        let timer = Timer(timeInterval: delay, repeats: false) { [weak self] _ in
            guard let self else { return }
            self.reconnectTimer = nil
            self.connect(base: self.base, token: self.token)
        }
        reconnectTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func handle(_ text: String) {
        let json = jsonObject(Data(text.utf8))
        guard let type = field(json, "type") else { return }
        switch type {
        case "hello":
            onState?("live")
            let pending = (json["pending"] as? [[String: Any]] ?? []).compactMap { Ask(json: $0) }
            onHello?(pending, (nested(json, ["workspace", "name"]) as? String) ?? "workspace")
        case "prompt.created":
            if let raw = json["prompt"] as? [String: Any], let ask = Ask(json: raw) {
                onCreated?(ask)
            }
        case "prompt.decided":
            if let id = field(json, "promptId", "id") { onDecided?(id) }
        case "decision.ack":
            if let id = field(json, "promptId") {
                onAck?(
                    id,
                    (json["applied"] as? Bool) ?? false,
                    json["reason"] as? String
                )
            }
        case "error":
            onState?("error: \(field(json, "code") ?? "unknown")")
        default:
            break
        }
    }

    func send(_ frame: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: frame),
              let text = String(data: data, encoding: .utf8) else { return }
        lock.lock(); let task = self.task; lock.unlock()
        task?.send(.string(text)) { _ in }
    }

    func decide(_ id: String, approved: Bool, answer: String? = nil) {
        var frame: [String: Any] = ["type": "decision", "promptId": id, "approved": approved]
        if let answer, !answer.isEmpty { frame["answer"] = answer }
        send(frame)
    }
}

// MARK: - the notch

/// The physical cutout, and the strip beside it, as this display reports it.
struct NotchGeometry {
    var screen: NSScreen
    var frame: NSRect
    var cutout: NSRect
    var panel: NSRect

    var isNotched: Bool { cutout.width > 1 }

    var description: String {
        """
        screen \(frame.width)x\(frame.height), safe-area top \(cutout.height)
        cutout x \(Int(cutout.minX)) to \(Int(cutout.maxX)) (\(Int(cutout.width)) wide)
        panel  \(Int(panel.width))x\(Int(panel.height)) centred under it
        """
    }
}

/// The notch is a hole in the panel, so nothing can be drawn inside it. What notch
/// apps do instead is hang a borderless panel from the top edge, centred on the
/// cutout and extending below it, so it reads as the notch growing downward. The
/// cutout itself is what AppKit leaves out of `safeAreaInsets` between
/// `auxiliaryTopLeftArea` and `auxiliaryTopRightArea`.
/// A rectangle with square top corners and round ones underneath: the shape the notch has.
func addBottomRounded(_ path: CGMutablePath, in b: NSRect, r requested: CGFloat) {
    let r = max(0, min(requested, b.width / 2, b.height / 2))
    let k = r * 0.5523
    path.move(to: CGPoint(x: b.minX, y: b.maxY))
    path.addLine(to: CGPoint(x: b.maxX, y: b.maxY))
    path.addLine(to: CGPoint(x: b.maxX, y: b.minY + r))
    path.addCurve(
        to: CGPoint(x: b.maxX - r, y: b.minY),
        control1: CGPoint(x: b.maxX, y: b.minY + r - k),
        control2: CGPoint(x: b.maxX - r + k, y: b.minY)
    )
    path.addLine(to: CGPoint(x: b.minX + r, y: b.minY))
    path.addCurve(
        to: CGPoint(x: b.minX, y: b.minY + r),
        control1: CGPoint(x: b.minX + r - k, y: b.minY),
        control2: CGPoint(x: b.minX, y: b.minY + r - k)
    )
    path.closeSubpath()
}

/// One fixed canvas for every state, taller than the black ever gets. The window keeps this
/// size and position forever, so the badge at the top of it cannot move: only the black inside
/// it grows and shrinks. Animating the window was what dragged the badge around on close.
let canvasHeight: CGFloat = 220

/// Padding under the waiting capsules. The dot and the number keep their place and their
/// height, the black simply carries on a little further down.
let capsulePadding: CGFloat = 6

/// The waiting state is two small capsules inside the 32pt menu bar strip, one either side of
/// the cutout: the colour on the left, the number waiting on the right. Nothing covers the
/// notch itself and nothing shows a title, so waiting costs no height below the notch.
let capsuleHeight: CGFloat = 26
let capsuleWidth: CGFloat = 26
let capsuleGap: CGFloat = 0
/// How far the dot and the number sit from the notch's edge. They belong against the notch,
/// not out at the ends of the bar: a count parked 15pt away read as though it were floating.
let badgeGap: CGFloat = 9
/// The number sits further in than the dot, so it reads as nearer the middle of the screen.
let countInset: CGFloat = 3

/// Where the panel goes for a mode. Waiting is a capsule in the menu bar beside the notch, so
/// it costs no height below it. The list and the full request grow right and down from the
/// capsule's top left corner: that corner is inside the capsule, so the pointer that opened
/// the panel is still inside it, and nothing has to steal the pointer back.
/// How much wider the panel is than the notch's own footprint, on each side. Built to exactly
/// the cutout, the bar had no room before the dot or after the count, and the list cropped its
/// titles. Added on both sides, so the dot, the count and the three answers keep their places
/// relative to the middle of the screen.
/// The panel is drawn at 1.5x the notch footprint. Built to exactly the cutout it read as
/// cramped: no room before the dot, none after the count, and the rows cropped their titles.
/// Scaled rather than padded, so the extra room is split evenly either side of the middle.
let panelWidthScale: CGFloat = 1.5

func panelFrame(for mode: PanelMode, contentHeight: CGFloat, capsule: CGFloat = capsuleWidth) -> NSRect? {
    guard let screen = notchGeometry(width: 460, height: max(contentHeight, 1)) else { return nil }
    let cutout = screen.cutout
    if mode == .compact {
        let width = (cutout.width + 2 * (capsule + capsuleGap)) * panelWidthScale
        // An unpaired bar is one readable strip tall rather than a capsule with its words hidden
        // behind the cutout; a paired bar keeps the capsule height it always had.
        let height = max(capsuleHeight + capsulePadding, contentHeight)
        return NSRect(
            x: cutout.midX - width / 2,
            y: screen.frame.maxY - height,
            width: width,
            height: height
        )
    }
    // The list and the full request: centred under the notch, growing down, and no wider than
    // the content needs. Its top band still covers where the capsules were, so the pointer that
    // opened it is inside it.
    // Exactly the waiting band's width, so the widget never widens: only its height changes.
    let width = (cutout.width + 2 * (capsule + capsuleGap)) * panelWidthScale
    // The same x and width as the waiting bar: the panel sits in the idle footprint and only
    // grows downwards, by exactly as much as the state it is showing needs.
    return NSRect(
        x: cutout.midX - width / 2,
        y: screen.frame.maxY - contentHeight,
        width: width,
        height: contentHeight
    )
}

func notchGeometry(width: CGFloat = 460, height: CGFloat = 168) -> NotchGeometry? {
    guard let screen = NSScreen.main ?? NSScreen.screens.first else { return nil }
    let insets = screen.safeAreaInsets
    let left = screen.auxiliaryTopLeftArea
    let right = screen.auxiliaryTopRightArea
    let screenFrame = screen.frame

    let cutout: NSRect
    if let left, let right, insets.top > 0, right.minX > left.maxX {
        cutout = NSRect(x: left.maxX, y: left.minY,
                        width: right.minX - left.maxX, height: insets.top)
    } else {
        // No notch: anchor a pill in the middle of the menu bar strip.
        let strip = max(insets.top, 24)
        cutout = NSRect(x: screenFrame.midX - 100, y: screenFrame.maxY - strip,
                        width: 200, height: strip)
    }

    // Top edge flush with the top of the screen, so the panel looks attached.
    let panel = NSRect(
        x: (cutout.midX - width / 2).rounded(),
        y: screenFrame.maxY - height,
        width: width,
        height: height
    )
    return NotchGeometry(screen: screen, frame: screenFrame, cutout: cutout, panel: panel)
}

enum CardAction { case deny, answer, approve }

/// How round the bottom corners are. The MacBook Pro rounds the bottom of the notch and the
/// corners of the display, and no API reports either radius, so this is a number to look at.
/// `--corner <pt>` overrides it for a render.
var panelCornerRadius: CGFloat = 22

/// One action, drawn as in the reference: a ringed circle for the two verdicts, red
/// and green, and a ringless grey bubble in the middle for a typed answer, which is
/// neither a yes nor a no and should not look like one.
final class ActionButton: NSButton {
    let cardAction: CardAction
    private let accent: NSColor
    /// The plate and its edge, kept apart from the glyph: in the reference only approve is
    /// tinted, the other two are grey plates with a red or white mark on them.
    private let boxFill: NSColor
    private let boxEdge: NSColor
    private let ringed: Bool
    /// Whether the pointer is on it, for the circle and the tint.
    /// Told when the pointer enters or leaves, so the plate behind this button can light up.
    var onHoverChanged: ((Bool) -> Void)?
    private var isHovering = false
    /// Filled box rather than hollow ring: the shape the card uses once the comment bar is up.
    private var isBoxed = false
    private var sizeConstraints: [NSLayoutConstraint] = []

    init(_ action: CardAction) {
        cardAction = action
        let symbol: String
        switch action {
        case .deny:
            symbol = "hand.thumbsdown"
            accent = NSColor(srgbRed: 0.96, green: 0.34, blue: 0.33, alpha: 1)
            ringed = true
            boxFill = NSColor(white: 0.11, alpha: 1)
            boxEdge = NSColor(white: 0.20, alpha: 1)
        case .answer:
            symbol = "bubble.left"
            accent = NSColor(srgbRed: 0.84, green: 0.84, blue: 0.86, alpha: 1)
            ringed = false
            boxFill = NSColor(white: 0.11, alpha: 1)
            boxEdge = NSColor(white: 0.20, alpha: 1)
        case .approve:
            symbol = "hand.thumbsup"
            accent = NSColor(srgbRed: 0.30, green: 0.88, blue: 0.57, alpha: 1)
            ringed = true
            boxFill = NSColor(srgbRed: 0.30, green: 0.88, blue: 0.57, alpha: 0.12)
            boxEdge = NSColor(srgbRed: 0.30, green: 0.88, blue: 0.57, alpha: 0.45)
        }
        super.init(frame: .zero)
        isBordered = false
        bezelStyle = .regularSquare
        imagePosition = .imageOnly
        focusRingType = .none
        (image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(
                pointSize: 17,
                weight: action == .answer ? .medium : .regular)))
        image?.isTemplate = true
        contentTintColor = accent
        wantsLayer = true
        translatesAutoresizingMaskIntoConstraints = false
        // Drawn as a real circle path, not a corner radius: a radius follows the
        // layer's bounds, so any height the button picks up turns the ring into a
        // rounded square on screen.
        // Height only. A width constraint, even one that loses the fight, left the boxes at
        // their own width stranded in the middle of their slots; the row owns the width.
        sizeConstraints = [heightAnchor.constraint(equalToConstant: 26)]
        NSLayoutConstraint.activate(sizeConstraints)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Replaces the glyph with a mark, faded in, and refuses further presses. Sending takes a
    /// moment, so this is the button saying it heard you rather than looking inert.
    func showDone() {
        // Nothing to show. This used to fade out over 0.12s, swap in an 11pt cross or tick, and
        // fade back over 0.18s, which stalled the close for a third of a second and left a small
        // grey glyph on screen for the last frame of it.
        isEnabled = false
    }

    /// A hollow circle, drawn with the button rather than bolted on as a shape layer. A layer's
    /// path lives in its own coordinate space, so it went stale and offset from the button: that
    /// is the glitch. This is built from the button's own bounds on every draw, so it cannot be
    /// the wrong size or in the wrong place, and the icon is drawn over it.
    /// A filled, tinted box instead of the hairline ring. The same three marks, scaled up so the
    /// comment bar underneath is clearly a second thing rather than part of the same row.
    func setBoxed(_ on: Bool, height: CGFloat) {
        isBoxed = on
        sizeConstraints[0].constant = on ? height : 26
        // Nothing on the layer. The plate is drawn from the button's own bounds instead, for
        // the same reason the ring is: a layer's border follows the layer's bounds, which went
        // stale and shaved the outer corners off.
        layer?.cornerRadius = 0
        layer?.backgroundColor = nil
        layer?.borderWidth = 0
        // Centred in its own bounds. With a title box the glyph was laid out inside that box and
        // came out about fifteen points right of centre, which is what moved two of the three.
        imagePosition = .imageOnly
        alignment = .center
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        if ringed && !isBoxed {
            let side = min(bounds.width, bounds.height) - 2
            let circle = NSBezierPath(ovalIn: CGRect(
                x: bounds.midX - side / 2,
                y: bounds.midY - side / 2,
                width: side,
                height: side
            ))
            if isHovering {
                accent.withAlphaComponent(0.16).setFill()
                circle.fill()
            }
            accent.withAlphaComponent(isHovering ? 1 : 0.75).setStroke()
            circle.lineWidth = 1.5
            circle.stroke()
        }
        super.draw(dirtyRect)
    }

    /// Clicking this one needs the keyboard, and this property is how AppKit is told so:
    /// with `becomesKeyOnlyIfNeeded` set, the panel takes key status for a control that
    /// asks for it. The two verdicts do not ask, so they never pull focus.
    override var needsPanelToBecomeKey: Bool { cardAction == .answer }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeAlways],
            owner: self
        ))
    }

    override func mouseEntered(with event: NSEvent) { hover(true) }
    override func mouseExited(with event: NSEvent) { hover(false) }

    /// The press a keyboard shortcut plays. Identical to hovering in, then settling: it goes
    /// through `hover(_:)` rather than duplicating the keyframes, so the pointer and the key
    /// cannot drift apart.
    func playPressFeedback() {
        hover(true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.32) { [weak self] in
            guard let self, self.isHovering else { return }
            self.hover(false)
        }
    }

    private func hover(_ on: Bool) {
        isHovering = on
        contentTintColor = on ? (accent.blended(withFraction: 0.3, of: .white) ?? accent) : accent
        onHoverChanged?(on)
        // A bounce, not a displacement: it leaves the middle, overshoots, and comes back to it.
        // The layer's model value is never changed, only the animation, so the glyph cannot be
        // left sitting high or low when the pointer moves away.
        // A bounce, not a displacement: it leaves the middle, overshoots, and comes back to it.
        // The layer's model value is never changed, only the animation, so the glyph cannot be
        // left sitting high or low when the pointer moves away.
        if isBoxed, on {
            // Small, and slow enough to stay inside the plate. The verdicts turn as they travel:
            // clockwise going down, counter-clockwise going up.
            let lift: CGFloat
            let swing: CGFloat
            switch cardAction {
            case .approve: lift = 3; swing = 0.10
            case .deny: lift = -3; swing = -0.10
            case .answer: lift = 1.5; swing = 0
            }
            // Halfway through is the furthest it reaches, eased on both sides of that. There is
            // no overshoot curve any more: the old one had a control point at 1.35, which pushes
            // the interpolation past its own target by a third and carried the glyph out through
            // the plate it belongs to. That was the "way too far", not the distance itself.
            let times = [NSNumber(value: 0), NSNumber(value: 0.5), NSNumber(value: 1)]
            let curves = [CAMediaTimingFunction(name: .easeOut),
                          CAMediaTimingFunction(name: .easeInEaseOut)]
            let duration: CFTimeInterval = cardAction == .answer ? 0.4 : 0.5

            let move = CAKeyframeAnimation(keyPath: "transform.translation.y")
            move.values = [NSNumber(value: 0), NSNumber(value: lift), NSNumber(value: 0)]
            move.keyTimes = times
            move.timingFunctions = curves
            move.duration = duration
            layer?.add(move, forKey: "lift")

            if swing != 0 {
                let turn = CAKeyframeAnimation(keyPath: "transform.rotation.z")
                turn.values = [NSNumber(value: 0), NSNumber(value: swing), NSNumber(value: 0)]
                turn.keyTimes = times
                turn.timingFunctions = curves
                turn.duration = duration
                layer?.add(turn, forKey: "swing")
            }
        }
        needsDisplay = true
    }
}

/// The dot in front of a request. Red means the server flagged the request as high risk,
/// amber medium, and teal everything else, so the colour says something rather than
/// decorating. A request's risk comes from the server's own analysis of its text.
func riskColor(_ ask: Ask) -> NSColor {
    switch (ask.risk ?? "").lowercased() {
    case "high", "critical":
        return NSColor(srgbRed: 0.97, green: 0.36, blue: 0.34, alpha: 1)
    case "medium", "med":
        return NSColor(srgbRed: 0.98, green: 0.73, blue: 0.29, alpha: 1)
    default:
        return NSColor(srgbRed: 0.36, green: 0.80, blue: 0.85, alpha: 1)
    }
}

func requestDot(_ ask: Ask) -> NSView {
    let dot = NSView()
    dot.wantsLayer = true
    dot.layer?.backgroundColor = riskColor(ask).cgColor
    dot.layer?.cornerRadius = 4
    dot.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
        dot.widthAnchor.constraint(equalToConstant: 8),
        dot.heightAnchor.constraint(equalToConstant: 8),
    ])
    return dot
}

/// The bar shown while things are waiting: one dot, the newest request's name, and how many
/// are waiting. No agent logo, nothing else, and the count has no background of its own.
final class CompactRow: NSView {
    private let dot = NSView()
    private let count = NSTextField(labelWithString: "")
    /// "not connected" lives where the count lives. An unpaired app is not a connected
    /// workspace with nothing waiting, and must not read as one.
    private let status = NSTextField(labelWithString: "not connected")
    /// The invitation. It sits on the other side of the cutout, because the middle of the bar
    /// is a hole and nothing readable can be drawn there.
    private let invite = NSTextField(labelWithString: "Connect this Mac")

    override init(frame: NSRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false

        dot.wantsLayer = true
        dot.layer?.cornerRadius = 4.5
        dot.translatesAutoresizingMaskIntoConstraints = false
        // No pulse. It was distracting on a real screen: the colour alone is the signal.

        count.font = .systemFont(ofSize: 13, weight: .semibold)
        count.textColor = .white
        count.alignment = .center
        count.translatesAutoresizingMaskIntoConstraints = false

        status.font = .systemFont(ofSize: 11, weight: .semibold)
        status.textColor = NSColor(white: 1, alpha: 0.72)
        status.alignment = .right
        status.translatesAutoresizingMaskIntoConstraints = false
        status.isHidden = true

        invite.font = .systemFont(ofSize: 11, weight: .semibold)
        invite.textColor = NSColor(white: 1, alpha: 0.95)
        invite.alignment = .left
        invite.translatesAutoresizingMaskIntoConstraints = false
        invite.isHidden = true

        addSubview(dot)
        addSubview(count)
        addSubview(status)
        addSubview(invite)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: capsuleHeight),
            // The colour sits in the left capsule, the count in the right one.
            dot.centerXAnchor.constraint(
                equalTo: leadingAnchor, constant: capsuleWidth - badgeGap
            ),
            dot.centerYAnchor.constraint(equalTo: centerYAnchor),
            dot.widthAnchor.constraint(equalToConstant: 9),
            dot.heightAnchor.constraint(equalToConstant: 9),
            count.centerXAnchor.constraint(
                // Dead symmetric with the dot: the same distance in from the bar's end, so
                // both sit the same distance out from the notch.
                equalTo: trailingAnchor, constant: -(capsuleWidth - badgeGap + countInset)
            ),
            count.centerYAnchor.constraint(equalTo: centerYAnchor),
            // Words, not a digit: this is right-aligned inside the bar so "not connected"
            // cannot run past the edge the way a centred-in-the-capsule label would.
            // Centred, not pinned to the trailing edge: this line is a message, and in the
            // corner it read as a clipped label hanging off the bar.
            status.centerXAnchor.constraint(equalTo: centerXAnchor),
            invite.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            invite.trailingAnchor.constraint(lessThanOrEqualTo: dot.leadingAnchor, constant: -6),
            status.leadingAnchor.constraint(greaterThanOrEqualTo: dot.trailingAnchor, constant: 8),
            status.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Nothing waiting: the empty badge. The bar never withdraws, so it needs to be told to go
    /// empty rather than keeping the last count until an unrelated redraw clears it.
    func showIdle() {
        // Idle is the badge, not a blank bar: the circle is the thing you aim at. Hiding it
        // here left an empty black bar in every idle state, connected or not.
        dot.isHidden = false
        dot.layer?.backgroundColor = NSColor(white: 1, alpha: 0.35).cgColor
        count.stringValue = ""
        status.isHidden = true
        invite.isHidden = true
    }

    /// Nothing to say yet: just the grey dot, which is the thing you hover to open the list.
    func showIdleDot() {
        // The colour is assigned by the paths that show a count, so an idle dot was invisible.
        dot.layer?.backgroundColor = NSColor(white: 1, alpha: 0.35).cgColor
        count.stringValue = ""
        status.isHidden = true
        invite.isHidden = true
        dot.isHidden = false
    }

    /// Not paired at all: no dot, no count, and words that say so.
    func showDisconnected() {
        dot.isHidden = true
        count.stringValue = ""
        status.isHidden = false
        status.stringValue = "not connected"
        invite.isHidden = false
    }

    func show(_ ask: Ask, waiting: Int) {
        // The waiting bar's dot is always grey: the colour belongs to the list, which is
        // archived. A grey dot reads as "something is waiting" without claiming a risk level.
        dot.layer?.backgroundColor = NSColor(white: 0.62, alpha: 1).cgColor
        count.stringValue = waiting > 0 ? "\(waiting)" : ""
        status.isHidden = true
        invite.isHidden = true
            // Nothing waiting: no colour and no count, but the bar itself stays. On means on.
        dot.isHidden = waiting == 0
}
}

/// One request in the expanded list: a dot and a name, clickable, highlighting under the
/// pointer so it is obvious that it can be opened.
/// One request in the expanded list: a dot and a name, clickable, highlighting under the
/// pointer. The last row rounds its bottom corners to follow the panel it sits in.
final class RequestRow: NSView {
    let ask: Ask
    var onClick: ((Ask) -> Void)?
    /// True for the bottom row, which has to follow the panel's rounded bottom corners.
    var isLast = false {
        didSet { needsLayout = true }
    }
    private let dot = NSView()
    private let name = NSTextField(labelWithString: "")
    private let highlight = CAShapeLayer()
    private let ago = NSTextField(labelWithString: "")

    init(ask: Ask) {
        self.ask = ask
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
        // The fill is a path, not a background colour: `maskedCorners` is ignored on a
        // view-backed layer, so the only way the bottom row can follow the panel is a path.
        highlight.fillColor = NSColor.white.withAlphaComponent(0.08).cgColor
        highlight.opacity = 0
        layer?.addSublayer(highlight)
        translatesAutoresizingMaskIntoConstraints = false

        dot.wantsLayer = true
        dot.layer?.backgroundColor = riskColor(ask).cgColor
        dot.layer?.cornerRadius = 4
        dot.translatesAutoresizingMaskIntoConstraints = false

        name.stringValue = ask.title
        name.font = .systemFont(ofSize: 13)
        name.textColor = .white
        name.lineBreakMode = .byTruncatingTail
        name.translatesAutoresizingMaskIntoConstraints = false

        ago.stringValue = agoText(ask.createdAt)
        ago.font = .systemFont(ofSize: 11)
        ago.textColor = NSColor.white.withAlphaComponent(0.45)
        ago.isHidden = ask.createdAt == nil
        ago.translatesAutoresizingMaskIntoConstraints = false
        // The age keeps its width and the title gives way. The age is held only by its trailing
        // edge, so a long title's intrinsic width won and the time was pushed off the row.
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        name.setContentHuggingPriority(.defaultLow, for: .horizontal)
        ago.setContentCompressionResistancePriority(.required, for: .horizontal)
        ago.setContentHuggingPriority(.required, for: .horizontal)

        addSubview(dot)
        addSubview(name)
        addSubview(ago)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 40),
            // The same x as the waiting dot, less half the dot's width, so the colour does
            // not shift sideways when the list opens.
            dot.leadingAnchor.constraint(
                equalTo: leadingAnchor, constant: capsuleWidth - badgeGap - 4.5
            ),
            dot.centerYAnchor.constraint(equalTo: centerYAnchor),
            dot.widthAnchor.constraint(equalToConstant: 8),
            dot.heightAnchor.constraint(equalToConstant: 8),
            name.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 10),
            name.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -20),
            name.centerYAnchor.constraint(equalTo: centerYAnchor),
            ago.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            ago.centerYAnchor.constraint(equalTo: centerYAnchor),
            name.trailingAnchor.constraint(lessThanOrEqualTo: ago.leadingAnchor, constant: -10),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func layout() {
        super.layout()
        // Rounded on all four corners and inset from the card's edge. The bottom row used to
        // borrow the panel's corner radius instead, which only worked while every row was on
        // screen: in a scrolled list the row at the bottom is not the last request, so it drew
        // square corners straight over the card's rounded corner.
        let rect = bounds.insetBy(dx: 2, dy: 2)
        highlight.frame = bounds
        highlight.path = CGPath(
            roundedRect: rect, cornerWidth: 8, cornerHeight: 8, transform: nil
        )
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(
            rect: bounds, options: [.mouseEnteredAndExited, .activeAlways], owner: self
        ))
    }

    override func mouseEntered(with event: NSEvent) { highlight.opacity = 1 }
    override func mouseExited(with event: NSEvent) { highlight.opacity = 0 }
    override func mouseUp(with event: NSEvent) { onClick?(ask) }
}

/// The three plates behind the answers, drawn as one view from its own bounds.
///
/// Three separate buttons each drew their own plate, and each argued with the width it had been
/// given: the outer plates came out with a shaved edge, and adjusting the button never fixed it
/// because the plate and the slot were two different measurements. Here a third of the row less
/// its share of the gaps is the plate, and the same number positions it.
/// A field cell with room to breathe on the left. NSTextField has no content insets, and text
/// starting flush against the edge is most of why the bar read as a plain box.
final class PaddedFieldCell: NSTextFieldCell {
    private let pad: CGFloat = 14

    override func drawingRect(forBounds rect: NSRect) -> NSRect {
        // A line's height, in the middle of the field. The cell draws from the top of whatever
        // rect it is handed, which is why the text sat high in a 38pt bar.
        let font = self.font ?? NSFont.systemFont(ofSize: 15)
        let line = font.ascender - font.descender + font.leading
        var out = NSRect(
            x: rect.minX + pad,
            y: rect.midY - line / 2,
            width: rect.width - pad,
            height: line
        )
        out = out.integral
        return out
    }
}

/// A white caret when the field takes focus. The editor does not exist before focus and has
/// already drawn a blue caret by the time a delegate hears about it, so this is the one moment
/// where setting the colour is early enough to be seen on the first blink.
final class CommentField: NSTextField {
    /// While the bar has the cursor, CMD+J is swallowed by the field editor's
    /// jumpToSelection: and never reaches the card, so the toggle has to be answered here.
    var onCommandJ: (() -> Void)?

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.contains(.command),
           event.charactersIgnoringModifiers?.lowercased() == "j" {
            onCommandJ?()
            return true
        }
        return super.performKeyEquivalent(with: event)
    }

    override func becomeFirstResponder() -> Bool {
        let took = super.becomeFirstResponder()
        if took, let editor = currentEditor() as? NSTextView {
            editor.insertionPointColor = .white
            // The caret and the typed text sit where the editor's text container says, not
            // where the cell's padded rect says. That is why a padded cell moved the placeholder
            // and the caret not at all.
            editor.textContainer?.lineFragmentPadding = 14
            // And down, onto the placeholder's line: the editor starts at the top of the field,
            // so it gets half the height left over by one line of text.
            let type = editor.font ?? NSFont.systemFont(ofSize: 15)
            let spare = bounds.height - (type.ascender - type.descender)
            editor.textContainerInset = NSSize(width: 0, height: max(0, spare / 2))
        }
        return took
    }
}

final class PlateRow: NSView {
    /// The plate under the pointer. The buttons used to be the only thing that reacted, which
    /// left the highlight belonging to the glyph rather than to the shape behind it.
    var hoveredIndex: Int? {
        didSet { if hoveredIndex != oldValue { needsDisplay = true } }
    }

    /// Which plate is the approving one. Set from the row's own buttons, so the tint follows the
    /// action rather than a position that happens to be third today.
    var approvingIndex = 2
    private let gap: CGFloat = 8
    private let radius: CGFloat = 10

    override func draw(_ dirtyRect: NSRect) {
        let green = NSColor(srgbRed: 0.30, green: 0.88, blue: 0.57, alpha: 1)
        let greyFill = NSColor(white: 0.11, alpha: 1)
        let greyEdge = NSColor(white: 0.20, alpha: 1)
        let plateWidth = (bounds.width - 2 * gap) / 3
        guard plateWidth > 4 else { return }
        for index in 0..<3 {
            let rect = NSRect(
                x: CGFloat(index) * (plateWidth + gap),
                y: 0,
                width: plateWidth,
                height: bounds.height
            ).insetBy(dx: 0.5, dy: 0.5)
            let plate = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
            let isApproving = index == approvingIndex
            let isHovered = index == hoveredIndex
            // The plate grows a point and a half either side and lifts its fill, so the ground
            // under the glyph moves before the glyph does.
            let grow: CGFloat = isHovered ? 1.5 : 0
            let hoveredRect = NSRect(
                x: rect.minX - grow + 0.5,
                y: rect.minY,
                width: rect.width + grow * 2,
                height: rect.height
            )
            let shape = NSBezierPath(
                roundedRect: hoveredRect, xRadius: radius, yRadius: radius
            )
            if isApproving {
                green.withAlphaComponent(isHovered ? 0.20 : 0.12).setFill()
            } else {
                (isHovered ? NSColor(white: 0.17, alpha: 1) : greyFill).setFill()
            }
            shape.fill()
            if isApproving {
                green.withAlphaComponent(isHovered ? 0.65 : 0.45).setStroke()
            } else {
                (isHovered ? NSColor(white: 0.30, alpha: 1) : greyEdge).setStroke()
            }
            shape.lineWidth = 1
            shape.stroke()
            // The key that does the same thing, on the plate itself. Nothing told the user the
            // letters existed, because nothing drew them.
            let hint = ["\u{2318}N", "\u{2318}J", "\u{2318}L"][index]
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 9, weight: .medium),
                .foregroundColor: NSColor(white: isHovered ? 0.62 : 0.45, alpha: 1),
            ]
            let size = (hint as NSString).size(withAttributes: attrs)
            (hint as NSString).draw(
                at: NSPoint(
                    x: hoveredRect.maxX - size.width - 9,
                    y: hoveredRect.minY + 5
                ),
                withAttributes: attrs
            )
        }
    }
}

/// The bar the three actions sit in. It is black like the card, so the panel is one flat
/// black shape and only the icons read as separate objects. It was rgb(19,19,20), which was
/// visible as a grey band against the card's rgb(0,0,0) on a real screen.
final class PillView: NSView {
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.cgColor
        // No radius at all. Black on black it was invisible, and at 32 on a 44pt bar it was a
        // lens that shaved the plates sitting inside it.
        layer?.cornerRadius = 0
        translatesAutoresizingMaskIntoConstraints = false
    }
    required init?(coder: NSCoder) { fatalError("not used") }
}

/// Title, subtitle, then the pill. `topInset` is the notch: the card's top strip sits
/// behind the physical cutout, so the text starts below it.
/// An SF Symbol drawn in a colour, for use inside an attributed string. A symbol used as a text
/// attachment does not take the button's tint colour, so it is drawn into an image of its own.
func tintedSymbol(
    _ name: String, pointSize: CGFloat, weight: NSFont.Weight, colour: NSColor
) -> NSImage? {
    guard let base = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
        .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: pointSize, weight: weight))
    else { return nil }
    let out = NSImage(size: base.size)
    out.lockFocus()
    base.draw(at: .zero, from: .zero, operation: .sourceOver, fraction: 1)
    colour.set()
    NSRect(origin: .zero, size: base.size).fill(using: .sourceAtop)
    out.unlockFocus()
    return out
}

/// A container that starts its content at the top. A scroll view's document view is bottom-up by
/// default, which would scroll a message in from its last line.
final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

/// The dashboard's send glyph, drawn from the same path the web uses
/// (public/app.js: "m22 2-7 20-4-9-9-4Z" and "M22 2 11 13") so the notch and the
/// page show the same button. Stroked, not filled, and flipped into AppKit's
/// upward y because the source path is SVG.
func sendGlyph(side: CGFloat) -> NSImage {
    NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
        let scale = rect.width / 24
        func point(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
            NSPoint(x: rect.minX + x * scale, y: rect.minY + (24 - y) * scale)
        }
        let outline = NSBezierPath()
        outline.move(to: point(22, 2))
        outline.line(to: point(15, 22))
        outline.line(to: point(11, 13))
        outline.line(to: point(2, 9))
        outline.close()
        let fold = NSBezierPath()
        fold.move(to: point(22, 2))
        fold.line(to: point(11, 13))
        NSColor.black.setStroke()
        for path in [outline, fold] {
            path.lineWidth = 2 * scale
            path.lineJoinStyle = .round
            path.lineCapStyle = .round
            path.stroke()
        }
        return true
    }
}

final class NotchCardView: NSView, NSTextFieldDelegate {
    var onAction: ((CardAction) -> Void)?
    var onAnswer: ((String) -> Void)?
    /// True while the field is open. Nothing may take the panel away from someone typing.
    private(set) var isAnswering = false
    var onCancelAnswer: (() -> Void)?
    private let answerField = CommentField()
    /// The placeholder is a label of its own rather than the cell's. The cell lays its own
    /// placeholder out by a path that cannot be overridden, and in the running app it drew at the
    /// top left with almost no padding even though the same field rendered centred offscreen.
    /// A label constrained to the field cannot disagree with the layout.
    private let placeholderLabel = NSTextField(labelWithString: "Add a comment\u{2026}")
    /// The comment bar, on its own row under the answers, the way the dashboard lays it out.
    private let composerRow = NSStackView()
    private let plates = PlateRow()
    private weak var pillView: NSView?
    private let sendButton = NSButton()
    /// The way back out of the composer. The dashboard folds its composer away with a chevron,
    /// so the notch uses the same shape in the same place rather than leaving Escape as the only
    /// exit from a field that covers the answers.
    private let backButton = NSButton()
    private var answerAction: ActionButton?
    private var denyAction: ActionButton?
    private var approveAction: ActionButton?
    private var row: NSStackView?
    /// The orange line under the card when there is nothing left to pay with. It is a link, so
    /// it is a button that looks like a label rather than a label that hopes to be clicked.
    private let limitLine = NSButton()
    /// The message box. Three lines tall, and it scrolls past that, so a long sentence can never
    /// grow the card until the answers are somewhere off the bottom of the screen.
    private let subtitleScroll = NSScrollView()
    private var subtitleHeight: NSLayoutConstraint?
    private var subtitleMeasuredWidth: CGFloat = 0
    private let subtitleLabel = NSTextField(wrappingLabelWithString: "")
    /// Where that line goes. Same host the pairing link came from, so a self-hosted install is
    /// not sent to someone else's dashboard.
    static var dashboardURL = "https://psh.now/app#topup"

    init(title: String, subtitle: String, meta: String?, topInset: CGFloat) {
        super.init(frame: NSRect(x: 0, y: 0, width: 460, height: 0))
        wantsLayer = true
        // No shape of its own: the panel draws the black background, this is only content.
        layer?.backgroundColor = NSColor.clear.cgColor

        let metaLabel = NSTextField(labelWithString: meta ?? "")
        metaLabel.font = .systemFont(ofSize: 13, weight: .medium)
        metaLabel.textColor = NSColor.white.withAlphaComponent(0.40)
        metaLabel.alignment = .left
        metaLabel.isHidden = (meta ?? "").isEmpty

        let titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = .systemFont(ofSize: 16, weight: .semibold)
        titleLabel.textColor = .white
        titleLabel.alignment = .left
        titleLabel.lineBreakMode = .byTruncatingTail
        // Never squeezed. The message box carries a required height, so when the card came out
        // one line short it was the title that lost its space and vanished, not the box that shrank.
        titleLabel.setContentCompressionResistancePriority(.required, for: .vertical)

        subtitleLabel.stringValue = subtitle
        subtitleLabel.font = .systemFont(ofSize: 14)
        subtitleLabel.textColor = NSColor.white.withAlphaComponent(0.62)
        subtitleLabel.alignment = .left
        // Unbounded here, so the whole sentence is laid out. What is on screen is decided by the
        // box around it, which is what gives the message somewhere to scroll to.
        subtitleLabel.maximumNumberOfLines = 0
        subtitleLabel.lineBreakMode = .byWordWrapping
        subtitleLabel.translatesAutoresizingMaskIntoConstraints = false

        let subtitleDoc = FlippedView()
        subtitleDoc.translatesAutoresizingMaskIntoConstraints = false
        subtitleDoc.addSubview(subtitleLabel)

        subtitleScroll.translatesAutoresizingMaskIntoConstraints = false
        subtitleScroll.drawsBackground = false
        subtitleScroll.borderType = .noBorder
        subtitleScroll.hasVerticalScroller = true
        subtitleScroll.hasHorizontalScroller = false
        subtitleScroll.autohidesScrollers = true
        subtitleScroll.documentView = subtitleDoc
        subtitleHeight = subtitleScroll.heightAnchor.constraint(equalToConstant: 20)
        // High, not required: if space is ever short the message loses a line before anything
        // else loses all of its height.
        subtitleHeight?.priority = .defaultHigh
        subtitleHeight?.isActive = true

        let pill = PillView(frame: .zero)
        let answerButton = ActionButton(.answer)
        let denyButton = ActionButton(.deny)
        let approveButton = ActionButton(.approve)
        answerAction = answerButton
        denyAction = denyButton
        approveAction = approveButton
        for (index, button) in [denyButton, answerButton, approveButton].enumerated() {
            button.onHoverChanged = { [weak self] inside in
                self?.plates.hoveredIndex = inside ? index : nil
            }
        }
        for button in [denyButton, answerButton, approveButton] {
            button.target = self
            button.action = #selector(tapped(_:))
        }

        // The field is the fourth thing in the pill, and it stays hidden until the bubble
        // is used. Then the two verdicts leave, the bubble slides to the left, and the
        // field opens beside it inside the same dark bar. Nothing opens below the card.
        answerField.translatesAutoresizingMaskIntoConstraints = false
        answerField.setContentHuggingPriority(.defaultLow, for: .horizontal)
        answerField.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        // In the layout and opaque from construction. Nothing hides it: the drawer only ever
        // changes how much of the card the window shows.
        answerField.isHidden = false
        answerField.alphaValue = 1

        backButton.isBordered = false
        backButton.bezelStyle = .regularSquare
        backButton.imagePosition = .imageOnly
        backButton.focusRingType = .none
        backButton.isHidden = true
        backButton.alphaValue = 0
        backButton.contentTintColor = NSColor.white.withAlphaComponent(0.75)
        backButton.image = NSImage(
            systemSymbolName: "chevron.left", accessibilityDescription: "Back"
        )?.withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 15, weight: .semibold))
        backButton.target = self
        backButton.action = #selector(tappedBack)

        let row = NSStackView(views: [denyButton, answerButton, approveButton])
        row.orientation = .horizontal
        // The row owns the widths. Three equal boxes and two 8pt gaps divide the card exactly,
        // so nothing can be stretched past the edge: a per-button width constraint was losing
        // to the stack, and the outer two were pushed through the sides of the card.
        row.distribution = .fillEqually
        // No spacing. fillEqually divides the row without subtracting spacing, so three slots
        // and two 8pt gaps made the row 16pt wider than the card and pushed the outer plates
        // out through its edges. The gap is made inside each slot instead.
        row.spacing = 0
        row.translatesAutoresizingMaskIntoConstraints = false
        self.row = row
        plates.approvingIndex = row.arrangedSubviews
            .compactMap { ($0 as? ActionButton)?.cardAction }
            .firstIndex(of: .approve) ?? 2
        plates.translatesAutoresizingMaskIntoConstraints = false
        pill.addSubview(plates)
        pill.addSubview(row)
        NSLayoutConstraint.activate([
            plates.leadingAnchor.constraint(equalTo: pill.leadingAnchor),
            plates.trailingAnchor.constraint(equalTo: pill.trailingAnchor),
            plates.topAnchor.constraint(equalTo: pill.topAnchor),
            plates.bottomAnchor.constraint(equalTo: pill.bottomAnchor),
        ])

        // Boxes from the start. Applying them only in setAnswering meant the closed card still
        // drew the old rings, because a card that is not answering never runs that code.
        for button in [denyButton, answerButton, approveButton] {
            button.setBoxed(true, height: 44)
        }

        composerRow.orientation = .horizontal
        // Centre rather than fill: with fill the row imposed its own height on the send, which
        // is why changing the constant moved nothing.
        composerRow.alignment = .centerY
        composerRow.spacing = 8
        composerRow.alignment = .centerY
        composerRow.translatesAutoresizingMaskIntoConstraints = false
        composerRow.addArrangedSubview(answerField)
        composerRow.addArrangedSubview(sendButton)
        composerRow.isHidden = false
        composerRow.alphaValue = 1
        // The bar arrives and leaves in place: nothing about it is allowed to animate, so it is
        // simply there, at its full size, the moment it is shown. AppKit animates a layer-backed
        // view's position and bounds implicitly inside an animation group, which is what made it
        // glide in from the row above.
        for animated in [composerRow, answerField, sendButton] {
            animated.wantsLayer = true
            animated.layer?.actions = [
                "position": NSNull(),
                "bounds": NSNull(),
                "frame": NSNull(),
                "opacity": NSNull(),
                "contents": NSNull(),
                "transform": NSNull(),
            ]
        }

        // Short on purpose: the field is one row of a 237pt card, and the long wording was
        // clipped to "Type your" and told nobody anything.
        // "Add a comment" does not fit beside the back chevron and the send button in a 237pt
        // card: it wrapped to two lines and read as a broken field.
        // The cell is replaced before the placeholder is set, because the placeholder lives on
        // the cell and a new one would drop it.
        // textCell:, not init(): the plain initialiser leaves the cell in a state where it draws
        // its own default wording instead of the placeholder.
        let padding = PaddedFieldCell(textCell: "")
        padding.isBezeled = false
        padding.drawsBackground = false
        padding.isEditable = true
        padding.isSelectable = true
        padding.wraps = false
        padding.lineBreakMode = .byTruncatingTail
        answerField.cell = padding
        // The label is the only placeholder. The cell's own was being set again on
        // reuse, which drew both at once, a few points apart.
        answerField.placeholderString = nil
        placeholderLabel.font = .systemFont(ofSize: 15)
        placeholderLabel.textColor = NSColor(white: 0.55, alpha: 1)
        placeholderLabel.drawsBackground = false
        placeholderLabel.isBezeled = false
        placeholderLabel.isEditable = false
        placeholderLabel.isSelectable = false
        placeholderLabel.translatesAutoresizingMaskIntoConstraints = false
        answerField.addSubview(placeholderLabel)
        NSLayoutConstraint.activate([
            // Sixteen points in, and on the field's own centre line, because those are the two
            // things that kept coming back wrong.
            placeholderLabel.leadingAnchor.constraint(
                equalTo: answerField.leadingAnchor, constant: 16
            ),
            placeholderLabel.centerYAnchor.constraint(equalTo: answerField.centerYAnchor),
        ])
        answerField.font = .systemFont(ofSize: 15)
        answerField.textColor = .white
        // Black fill with a hairline edge: the field has to be findable on a black panel,
        // and anything lighter than the panel is exactly the grey band that was removed.
        // The fill lives on the layer, not on the cell. The cell paints a square background
        // under a rounded border, which is what made the bar look like a plain HTML input.
        answerField.backgroundColor = .clear
        answerField.drawsBackground = false
        answerField.wantsLayer = true
        answerField.layer?.backgroundColor = NSColor(white: 0.11, alpha: 1).cgColor
        answerField.layer?.borderWidth = 1
        answerField.layer?.borderColor = NSColor.white.withAlphaComponent(0.10).cgColor
        answerField.isBezeled = false
        answerField.focusRingType = .none
        answerField.wantsLayer = true
        // A stadium on a 34pt bar, which is what the reference's bar looks like next to its
        // send button. Eight was square enough to read as a text box, not a comment bar.
        answerField.layer?.cornerRadius = 10
        answerField.delegate = self
        answerField.onCommandJ = { [weak self] in self?.onCancelAnswer?() }
        answerField.target = self
        answerField.action = #selector(submitAnswer)

        // A grey circle with a white arrow: the end of the field says what it does.
        sendButton.isBordered = false
        sendButton.bezelStyle = .regularSquare
        sendButton.imagePosition = .imageOnly
        sendButton.focusRingType = .none
        sendButton.wantsLayer = true
        sendButton.layer?.cornerRadius = 11
        sendButton.layer?.backgroundColor = NSColor.white.cgColor
        sendButton.contentTintColor = .black
        sendButton.image = sendGlyph(side: 18)
        sendButton.image?.isTemplate = false
        sendButton.contentTintColor = .black
        sendButton.toolTip = "Send the answer"
        sendButton.target = self
        sendButton.action = #selector(submitAnswer)
        sendButton.isHidden = false
        sendButton.translatesAutoresizingMaskIntoConstraints = false
        limitLine.isBordered = false
        // The icon is part of the title, not a separate image. A button centres its title and
        // hangs an image outside that box, which left the pair about 6pt left of the card's
        // centre however the frame was constrained.
        let alert = tintedSymbol(
            "exclamationmark.triangle.fill", pointSize: 11, weight: .semibold, colour: .systemOrange
        )
        let icon = NSTextAttachment()
        icon.image = alert
        if let size = alert?.size {
            icon.bounds = CGRect(x: 0, y: -1.5, width: size.width, height: size.height)
        }
        let line = NSMutableAttributedString(attachment: icon)
        line.append(NSAttributedString(
            string: "  Limit exceeded \u{2192} Dashboard",
            attributes: [
                .foregroundColor: NSColor.systemOrange,
                // Sized to the card, not chosen by eye. The notch is 237pt wide, so 13pt ran
                // the word Dashboard off the right edge and clipped it.
                .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
            ]
        ))
        limitLine.attributedTitle = line
        limitLine.contentTintColor = .systemOrange
        limitLine.alignment = .center
        // One line, always. A button wraps its title by default, which put the arrow and the label
        // on a second row and made the line read as two separate things.
        limitLine.lineBreakMode = .byTruncatingTail
        limitLine.cell?.wraps = false
        limitLine.cell?.isScrollable = false
        limitLine.setContentCompressionResistancePriority(.required, for: .horizontal)
        limitLine.isHidden = true
        limitLine.target = self
        limitLine.action = #selector(openDashboard)
        limitLine.toolTip = "See your requests and add more"
        limitLine.translatesAutoresizingMaskIntoConstraints = false

        let column = NSStackView(
            views: [metaLabel, titleLabel, subtitleScroll, pill, composerRow, limitLine]
        )
        column.orientation = .vertical
        // Left, like the waiting line and the list: the panel reads as the same object in
        // every state instead of re-centring itself when a request is opened.
        column.alignment = .leading
        column.spacing = 8
        column.setCustomSpacing(16, after: subtitleScroll)
        // Permanent, like the row: the drawer is always in the layout, so the gap above it is
        // part of the card's height whether it is showing or not. Set to zero it measured the
        // closed card 12pt short the first time and 12pt taller once the toggle had run.
        // Wider than the closed panel's cut, so the black under the decision row is black and
        // not the top of the comment field showing through.
        column.setCustomSpacing(18, after: pill)
        // Kept so the gap above the comment bar can be taken away when the bar is closed. A
        // hidden arranged subview is removed from the layout but the spacing set after its
        // neighbour stays, which is height the card keeps paying for.
        pillView = pill
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)

        NSLayoutConstraint.activate([
            column.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 20),
            column.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -20),
            column.topAnchor.constraint(equalTo: topAnchor, constant: topInset + 14),
            // Room under the boxes. At 18pt the 56pt boxes sat inside the panel's bottom corner
            // and it cut their corners off, which the reference does not do.
            column.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -20),
            titleLabel.leadingAnchor.constraint(equalTo: column.leadingAnchor),
            titleLabel.trailingAnchor.constraint(equalTo: column.trailingAnchor),
            composerRow.leadingAnchor.constraint(equalTo: column.leadingAnchor),
            composerRow.trailingAnchor.constraint(equalTo: column.trailingAnchor),
            subtitleScroll.leadingAnchor.constraint(equalTo: column.leadingAnchor),
            subtitleScroll.trailingAnchor.constraint(equalTo: column.trailingAnchor),
            subtitleDoc.leadingAnchor.constraint(equalTo: subtitleScroll.contentView.leadingAnchor),
            subtitleDoc.trailingAnchor.constraint(equalTo: subtitleScroll.contentView.trailingAnchor),
            subtitleDoc.topAnchor.constraint(equalTo: subtitleScroll.contentView.topAnchor),
            subtitleDoc.widthAnchor.constraint(equalTo: subtitleScroll.contentView.widthAnchor),
            subtitleLabel.leadingAnchor.constraint(equalTo: subtitleDoc.leadingAnchor),
            subtitleLabel.trailingAnchor.constraint(equalTo: subtitleDoc.trailingAnchor),
            subtitleLabel.topAnchor.constraint(equalTo: subtitleDoc.topAnchor),
            subtitleLabel.bottomAnchor.constraint(equalTo: subtitleDoc.bottomAnchor),
            pill.leadingAnchor.constraint(equalTo: column.leadingAnchor),
            pill.trailingAnchor.constraint(equalTo: column.trailingAnchor),
            // Full width of the card, so the centred title lands on the card's centre rather
            // than on the centre of its own text.
            limitLine.leadingAnchor.constraint(equalTo: column.leadingAnchor),
            limitLine.trailingAnchor.constraint(equalTo: column.trailingAnchor),
            pill.heightAnchor.constraint(equalToConstant: 44),
            // A bar worth typing in. At 30pt with a 17pt face the field read as a caption.
            // Same outer height as the send button, so the two boxes line up top and bottom.
            answerField.heightAnchor.constraint(equalToConstant: 40),
            // Nearly square and the same height as the bar, which is what the reference's send
            // is. At 28 wide it read as a tab beside the field rather than a button.
            // Constants plus an aspect ratio, not an equality with the field: the stack was
            // overriding the height and leaving the send taller than it was wide.
            // Shorter than the field on purpose, and centred by the row rather than stretched by
            // it. At the field's height it read as a block beside the bar instead of a button.
            // Wider than it is tall: the square read as a tab, and the aspect constraint that
            // enforced the square has to go with it or the two fight.
            sendButton.widthAnchor.constraint(equalToConstant: 40),
            // Square: 40 by 40, the same as its width, so it reads as a button rather than a
            // squat pill beside the field.
            sendButton.heightAnchor.constraint(equalToConstant: 40),
            backButton.widthAnchor.constraint(equalToConstant: 26),
            backButton.heightAnchor.constraint(equalToConstant: 26),
            row.leadingAnchor.constraint(equalTo: pill.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: pill.trailingAnchor),
            row.centerYAnchor.constraint(equalTo: pill.centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    @objc private func tapped(_ sender: ActionButton) {
        // The bubble that opens the bar closes it again. The bar carries no chevron of its own,
        // so the control that opened it is the one that puts it away.
        if sender.cardAction == .answer, isAnswering {
            onCancelAnswer?()
            return
        }
        // Answer opens a field rather than sending anything, so only the two verdicts mark done.
        if sender.cardAction != .answer { sender.showDone() }
        onAction?(sender.cardAction)
    }

    @objc private func submitAnswer() {
        let text = answerField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        onAnswer?(text)
    }

    /// Whether the field has a live insertion point. This is the only honest test that
    /// a keystroke would land somewhere.
    var isAnswerFocused: Bool { answerField.currentEditor() != nil }

    /// Click the bubble from a script, through the very action a real click sends.
    /// The three plates answer to Command-N, M and L as well as to the pointer. The letters are
    /// shown on the plates, and until now nothing was listening for them: the labels were drawn
    /// and the keys did nothing.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        NSLog("keyeq entered: char=%@ cmd=%d keyWindow=%d appActive=%d",
              event.charactersIgnoringModifiers ?? "-",
              event.modifierFlags.contains(.command) ? 1 : 0,
              window?.isKeyWindow == true ? 1 : 0,
              NSApp.isActive ? 1 : 0)
        guard event.modifierFlags.contains(.command),
              let key = event.charactersIgnoringModifiers?.lowercased()
        else { return super.performKeyEquivalent(with: event) }
        keyeqTotal += 1
        return handleShortcut(key) ? true : super.performKeyEquivalent(with: event)
    }

    /// The single place the three shortcuts are decided, whether the key arrives through the
    /// responder chain or through the app's monitor.
    @discardableResult
    /// A key press has to look like a press. This runs the same hover animation the pointer
    /// runs, then lets it settle, so a shortcut and a click are indistinguishable on screen.
    private func playPressFeedback(_ button: ActionButton?) {
        guard let button else { return }
        button.playPressFeedback()
    }

    func handleShortcut(_ key: String) -> Bool {
        NSLog("shortcut: %@ (appActive=%d keyWindow=%d)", key,
              NSApp.isActive ? 1 : 0, window?.isKeyWindow == true ? 1 : 0)
        // CMD+J is a toggle: the same key that opens the bar puts it away again.
        if key == "j", isAnswering {
            playPressFeedback(answerAction)
            onCancelAnswer?()
            return true
        }
        let target: ActionButton?
        switch key {
        case "n": target = denyAction
        case "j": target = answerAction
        case "l": target = approveAction
        default: return false
        }
        guard let button = target, button.isEnabled else {
            return false
        }
        // The plates are drawn by PlateRow, so the buttons behind them are not laid out the way
        // a normal control is. A click asked for a visible, windowed button and therefore did
        // nothing at all; sending the action straight to its target works regardless.
        //
        // Press first, act second. The feedback is played on every shortcut now, including the
        // ones that fall back to sending the action directly, and the action is deferred until
        // the animation has been seen. Opening the answer field and taking a verdict both close
        // the card, so without this the card simply vanished and the key you pressed was never
        // confirmed.
        playPressFeedback(button)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) { [weak self] in
            guard let self, let button = target, button.isEnabled else { return }
            if button.isHidden || button.window == nil, let action = button.action {
                NSApp.sendAction(action, to: button.target, from: button)
            } else {
                button.performClick(nil)
            }
        }
        return true
    }

    private var keyeqTotal = 0

    func clickAnswer() { answerAction?.performClick(nil) }

    @objc private func openDashboard() {
        if let url = URL(string: Self.dashboardURL) { NSWorkspace.shared.open(url) }
    }

    /// Out of requests: the card is readable and the request is visible, but nothing can be
    /// answered, accepted or denied until the workspace can pay for it again.
    func applyLimit(_ limited: Bool) {
        limitLine.isHidden = !limited
        for button in [denyAction, answerAction, approveAction] {
            button?.isEnabled = !limited
            // Barely dimmed: at 0.35 the buttons read as disabled chrome rather than as
            // buttons you can see but not press yet.
            button?.alphaValue = limited ? 0.95 : 1
        }
        sendButton.isEnabled = !limited
        answerField.isEnabled = !limited
        // Disabled, not hidden. The bar is part of the card now, and hiding it left the card
        // with an empty gap where the field should be whenever the workspace was out of requests.
        answerField.isEditable = !limited
        sendButton.isEnabled = !limited
    }

    /// Open or close the field inside the pill. The bubble is already where it should be;
    /// the two verdicts step aside and the field comes in beside the bubble, animated, and
    /// the card does not change height at all.
    @discardableResult
    /// Where the drawer begins: the top edge of the bar, measured from the card's top. The closed
    /// window ends exactly on that line, so no part of the drawer can show through it. Derived
    /// from the laid-out row rather than added up from its height and its gap, which left twelve
    /// points of the bar's top edge underneath the closed cut.
    func closedHeight() -> CGFloat {
        guard bounds.height > 0, composerRow.frame.height > 0 else { return 0 }
        let row = composerRow.convert(composerRow.bounds, to: self)
        return isFlipped ? row.minY : bounds.maxY - row.maxY
    }

    /// How much of the card the window does without when the drawer is closed.
    func drawerHeight() -> CGFloat {
        let closed = closedHeight()
        guard closed > 0 else { return 0 }
        return max(bounds.height - closed, 0)
    }

    /// The plates in window coordinates. Opening the drawer must not move them by a point.
    func platesFrameInWindow() -> NSRect? {
        guard window != nil else { return nil }
        return plates.convert(plates.bounds, to: nil)
    }

    func setAnswering(_ on: Bool, animated: Bool = true) -> NSSize {
        isAnswering = on
        let apply = {
            // The three answers stay, filled and larger. The dashboard keeps them while the
            // comment bar is up underneath, and hiding them made the card look like a different
            // card rather than the same one with the bar open.
            // The button closes it again, and the gap above it goes with it. The gap used to stay
            // behind after a close, which is what made the card settle taller than it opened and
            // left the shape short of the window.
            self.composerRow.isHidden = false
            self.composerRow.alphaValue = 1
            if let columnStack = self.composerRow.superview as? NSStackView,
               let pillView = self.pillView {
                columnStack.setCustomSpacing(18, after: pillView)
            }
            // The bar's own children live hidden until their row opens, so the row would
            // otherwise measure to nothing and be drawn as an empty 12pt gap.
            self.answerField.isHidden = false
            self.sendButton.isHidden = false
            // Its own alpha was left at zero, so the bar opened with nothing in it but the send.
            self.answerField.alphaValue = 1
            // Re-asserted here, after the image exists: a template glyph takes the button's tint,
            // and left white it was a white plane on a white disc.
            self.sendButton.image?.isTemplate = true
            self.sendButton.contentTintColor = .black
            // Filled boxes at all times. They were 26pt rings until the bar opened, which made
            // the card look like two different cards depending on whether you were typing.
            for button in [self.denyAction, self.answerAction, self.approveAction] {
                button?.setBoxed(true, height: 44)
            }
            self.layoutSubtreeIfNeeded()
            // In place the moment the row is. Implicit animation was interpolating the send's
            // position from the collapsed row, so it glided in behind the field instead of being
            // there when the bar arrived.
            // After the group commits, not during it. Implicit animations are added at commit,
            // so clearing them inside the block cleared nothing and the bar and its icon still
            // slid in behind the field.
            DispatchQueue.main.async { [weak self] in
                self?.sendButton.layer?.removeAllAnimations()
                self?.answerField.layer?.removeAllAnimations()
            }
        }
        if animated {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.3
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                // Without this the stack's relayout jumps instead of gliding.
                context.allowsImplicitAnimation = true
                apply()
            }
        } else {
            apply()
        }
        if !on { answerField.stringValue = "" }
        if on, let window { window.makeFirstResponder(answerField) }
        return sized(width: frame.width)
            // While answering it is the field and the send button only: the reference bar is one
        // line, so the thumbs and the bubble step aside rather than sharing the row.
        // One line while answering is the goal, but the bar has to be re-measured at the same
        // moment: hiding the actions first only leaves empty black under a short row, because
        // the panel measured the tall card before this ran.
    }

    private func syncSubtitleHeight() {
        guard let box = subtitleHeight else { return }
        let width = subtitleScroll.contentSize.width
        guard width > 0, abs(width - subtitleMeasuredWidth) > 0.5 else { return }
        subtitleMeasuredWidth = width
        let font = subtitleLabel.font ?? .systemFont(ofSize: 14)
        let line = (font.ascender - font.descender + font.leading).rounded(.up)
        let needed = subtitleLabel
            .sizeThatFits(NSSize(width: width, height: .greatestFiniteMagnitude))
            .height.rounded(.up)
        box.constant = max(line, min(needed, line * 3))
    }

    override func layout() {
        super.layout()
        syncSubtitleHeight()
    }

    /// Where the pieces actually landed, for checking the inline layout without a screen.
    func frameReport(_ label: String) -> String {
        let box = { (view: NSView?) -> String in
            guard let view, !view.isHidden else { return "hidden" }
            return String(format: "x %.0f w %.0f", view.frame.minX, view.frame.width)
        }
        return "\(label): bubble \(box(answerAction)) | field \(box(answerField)) | deny \(box(denyAction)) | approve \(box(approveAction))" + " | plates x\(Int(plates.frame.minX)) w\(Int(plates.frame.width)) card\(Int(bounds.width))"
    }

    /// The chevron leaves the field the same way Escape does, so there is one exit, not two.
    @objc private func tappedBack() {
        onCancelAnswer?()
    }

    /// Shown while the field is empty, gone the moment there is something to read.
    func controlTextDidChange(_ obj: Notification) {
        placeholderLabel.isHidden = !answerField.stringValue.isEmpty
    }

    /// A white caret. The blue one is the system accent colour and reads as a link in a black
    /// card, and the field editor only exists once editing has begun, so it is set there.
    func controlTextDidBeginEditing(_ obj: Notification) {
        (answerField.currentEditor() as? NSTextView)?.insertionPointColor = .white
    }

    /// Escape leaves the field without sending anything.
    func control(_ control: NSControl, textView: NSTextView,
                 doCommandBy commandSelector: Selector) -> Bool {
        guard commandSelector == #selector(NSResponder.cancelOperation(_:)) else { return false }
        onCancelAnswer?()
        return true
    }

    /// The size the card wants at a given width, with the notch strip included.
    func sized(width: CGFloat) -> NSSize {
        frame = NSRect(x: 0, y: 0, width: width, height: 0)
        layoutSubtreeIfNeeded()
        // Same fixed point as the panel's measurement, for the same reason.
        var height = fittingSize.height
        for _ in 0..<3 {
            layoutSubtreeIfNeeded()
            let again = fittingSize.height
            if abs(again - height) < 0.5 { break }
            height = again
        }
        frame = NSRect(x: 0, y: 0, width: width, height: height)
        layoutSubtreeIfNeeded()
        return NSSize(width: width, height: height)
    }
}

/// The notch panel: no title bar, never steals focus, rides above the menu bar,
/// stays put across Spaces and over full-screen apps.
final class NotchPanel: NSPanel {
    init(content: NSView, frame: NSRect) {
        super.init(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        isFloatingPanel = true
        // Above the menu bar, not at status-bar level. A status-bar panel loses to an open
        // menu, and it also loses the Space-transition overlay, which is what took the bar off
        // screen on a three-finger swipe. Atoll sits at the same height for the same reason.
        level = .mainMenu + 3
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        hidesOnDeactivate = false
        // The panel is created once and reused. Releasing it is how you get a bar that works
        // until the first time something closes it.
        isReleasedWhenClosed = false
        isMovable = false
        becomesKeyOnlyIfNeeded = true
        // Transparent, so the card's rounded corners show the desktop under them. Painting
        // the window black as well would square them off again.
        backgroundColor = .clear
        isOpaque = false
        // No shadow and no border line: the shape alone should read as the notch.
        hasShadow = false
        contentView = content
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor.clear.cgColor
    }

    /// A borderless panel cannot become key by default, which is why nothing could be
    /// typed into it. The answer field needs the keyboard, so this says yes.
    override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown || event.type == .keyUp {
            NSLog("panel sendEvent: type=%d char=%@ cmd=%d keyWindow=%d",
                  event.type.rawValue,
                  event.charactersIgnoringModifiers ?? "-",
                  event.modifierFlags.contains(.command) ? 1 : 0,
                  isKeyWindow ? 1 : 0)
        }
        super.sendEvent(event)
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// Build (or reuse) the notch panel for an ask and grow it out of the notch. The app and
/// `--preview` both go through here, so the preview is the real panel and not a mock.
/// One window per layer. Layer 1 is the waiting bar: created once, at the notch, and never
/// resized or animated again. Layer 2 is the list: its own window, hanging from the bottom of the
/// bar, and its height is the only thing that ever animates. They share no window, no shape and no
/// animation, which is what stops the list dragging the bar around when it closes.
func presentNotch(
    topInset: CGFloat? = nil,
    mode: PanelMode = .compact,
    topOffset: CGFloat = 0,
    unroll: Bool = true,
    visible: Bool = true,
    configure: (NotchPanelView) -> Void
) -> (panel: NotchPanel, view: NotchPanelView)? {
    guard let screen = notchGeometry(width: 460, height: 0) else { return nil }
    let view = NotchPanelView(topInset: topInset ?? screen.cutout.height)
    configure(view)
    let size = view.remeasure()
    guard var target = panelFrame(for: mode, contentHeight: size.height) else { return nil }
    // Layer 2 hangs from the bottom of the bar rather than from the top of the display.
    target.origin.y -= topOffset

    let host = NSView(frame: NSRect(origin: .zero, size: target.size))
    host.wantsLayer = true
    view.frame = NSRect(origin: .zero, size: target.size)
    // Pinned to the top with the space below it flexible, so shrinking the window uncovers
    // the panel from the notch downward instead of squashing it.
    view.autoresizingMask = [.width, .minYMargin]
    host.addSubview(view)

    let panel = NotchPanel(content: host, frame: target)
    // Start as just the notch strip and unroll from there.
    let collapsed = NSRect(x: target.minX, y: target.minY, width: 40, height: target.height)
    if unroll { panel.setFrame(collapsed, display: false) }
    if visible { panel.orderFrontRegardless() }
    if unroll { NSAnimationContext.runAnimationGroup { context in
        context.duration = 0.26
        context.timingFunction = CAMediaTimingFunction(name: .easeOut)
        // The width is clamped, not requested: autolayout sizes a borderless window to fit
        // its content, which grew the bar rightward (26pt of overhang on the left, 61 on the
        // right). A content-size clamp cannot be overridden by a fitting pass.
        panel.contentMinSize = NSSize(width: target.width, height: 1)
        panel.contentMaxSize = NSSize(width: target.width, height: 4_000)
        panel.animator().setFrame(target, display: true)
    } }
    return (panel, view)
}

/// Hand the keyboard to the answer field. Everything that opens the field comes through
/// here, because this is the part the first real use got wrong.
///
/// The bug: the bubble was clicked, the field appeared, and nothing could be typed. A
/// borderless panel refuses key status, and `becomesKeyOnlyIfNeeded` makes it refuse
/// again because the click landed on the bubble rather than on the field that appears
/// afterwards. A `.nonactivatingPanel` is allowed to be key while the app stays in the
/// background, which is exactly what is needed here: the human is typing in another app,
/// clicks the bubble, and must not be thrown out of it.
@discardableResult
func focusAnswerField(panel: NotchPanel, card: NotchCardView) -> (key: Bool, appActive: Bool, caret: Bool) {
    panel.becomesKeyOnlyIfNeeded = false
    NSApp.activate(ignoringOtherApps: true)
    panel.makeKeyAndOrderFront(nil)
    panel.makeKey()
    _ = card.setAnswering(true)
    return (panel.isKeyWindow, NSApp.isActive, card.isAnswerFocused)
}

// MARK: - the panel

enum PanelMode { case compact, list, detail }

/// The whole notch panel: one quiet line while things wait, the list of them under the
/// pointer, and the full request once one is chosen. One view, so the panel is one window
/// whose height follows the mode, and nothing ever opens below the card.
final class NotchPanelView: NSView {
    /// The height of the window, as the last resize set it. The shape is drawn for this rather
    /// than for the view's bounds: the view is always the full card so the drawer can sit under
    /// the plates, while the window is only as tall as what is showing. A stored value, not a read
    /// of window?.contentView, because reading the window during layout fed layout its own answer
    /// and collapsed the panel to nothing.
    var visibleHeight: CGFloat = 0

    private var repaintingShape = false

    /// The shape is painted in layout, and the window clips whatever the paint has not caught up
    /// with. Repainting here catches every height change at its source: opening and closing the
    /// comment bar, switching between states, and the window's own resize. Patching the callers
    /// one at a time missed the comment path, which resizes without changing state at all.
    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        guard window != nil, !repaintingShape else { return }
        repaintingShape = true
        needsLayout = true
        layoutSubtreeIfNeeded()
        repaintingShape = false
    }


    var onSelect: ((Ask) -> Void)?
    var onAction: ((Ask, CardAction) -> Void)?
    var onAnswer: ((Ask, String) -> Void)?
    var onCancelAnswer: (() -> Void)?
    var onHover: ((Bool) -> Void)?
    /// Layer 2 carries the list only: the dot and the count belong to the bar's own window.
    var showsBadges = true

    private(set) var mode: PanelMode = .compact
    private(set) var hovering = false
    private(set) var asks: [Ask] = []
    private(set) var detailCard: NotchCardView?

    /// Where the first list row and the compact line sit, in window coordinates.
    func firstRowFrame() -> NSRect? {
        guard let row = listStack.arrangedSubviews.first else { return nil }
        return row.convert(row.bounds, to: nil)
    }

    func compactFrame() -> NSRect { compactRow.convert(compactRow.bounds, to: nil) }

    private let background = CAShapeLayer()
    /// Masks the panel to the same rounded path, so a row's hover highlight cannot paint outside
    /// the corners: inside a round shape the highlight was a straight rectangle.
    private let shapeMask = CAShapeLayer()
    private let content = NSStackView()
    private let compactRow = CompactRow(frame: .zero)
    private let listStack = NSStackView()
    private let listScroll = NSScrollView()
    private var listHeight: NSLayoutConstraint!
    /// Three rows fit; any more scroll, so the panel never runs down the screen.
    private let maxVisibleRows = 2
    private var inset: NSLayoutConstraint!
    private var bottomPad: NSLayoutConstraint!
    /// The height the black shape should be, which is the current mode's, not the view's.
    private var shapeHeight: CGFloat = 0
    private var widthPinned = false

    /// The panel's height when it is pinned to a counted size, and nil when it is not.
    private var heightConstraint: NSLayoutConstraint?

    /// Only the two states that must never grow are pinned to a counted height. The approval
    /// card is measured from its own content, so its pin is switched off rather than set to a
    /// guess.
    func syncHeight() {
        switch mode {
        case .list, .compact:
            heightConstraint?.isActive = true
            heightConstraint?.constant = max(stateHeight, 1)
        case .detail:
            // Content-measured, not pinned. Pinning this to the host's height stopped the window
            // growing into a card at all: the host was the list's height and the pin held it there.
            heightConstraint?.isActive = false
        }
        // Repaint the shape for the height just chosen, in this same turn, so the black is never
        // painted at the size it had before.
        if window != nil {
            needsLayout = true
            layoutSubtreeIfNeeded()
            // And once more on the next turn. The window takes its new size after the view does,
            // so a shape painted in the same turn is still the old one's and its rounded bottom
            // ends up outside the window, which is what leaves two square corners.
            DispatchQueue.main.async { [weak self] in
                guard let self, self.window != nil else { return }
                self.needsLayout = true
                self.layoutSubtreeIfNeeded()
            }
        }
    }

    override func viewDidMoveToSuperview() {
        super.viewDidMoveToSuperview()
        // The width belongs to the window, never to the content. Left to itself the view's own
        // fitting width grows the window to the right, which is what made the bar overhang
        // further past the notch on one side than the other.
        guard let host = superview, !widthPinned else { return }
        widthPinned = true
        // A fixed width, so nothing can imply a wider one: the fitting pass used to grow the
        // black to the right of the notch, 61pt of overhang against 26 on the left.
        if let geometry = notchGeometry() {
            widthAnchor.constraint(
                // The same scale as the window, or the bar is drawn 237 wide inside a wider window
            // and hangs off its left edge: this is the width the eye actually sees.
            equalToConstant: (geometry.cutout.width + 2 * (capsuleWidth + capsuleGap))
                * panelWidthScale
            ).isActive = true
        } else {
                widthAnchor.constraint(equalTo: host.widthAnchor).isActive = true
        }
        // And it tracks the window's height, so it is laid out again on every frame of the
        // animation and the black is repainted at the size the window actually has. Setting
        // the height once left the shape stale while the window moved around it, which is the
        // transparency that shows up when opening and closing quickly. The content keeps its
        // own height and is simply clipped by the window's edge as it grows.
        // Ours to set, not the host's to imply. Pinned to the host it was circular: the view's
        // fitting height grew the window, the window sized the host, and the host sized the view,
        // so one list row came out as tall as a whole approval card.
        let ownHeight = heightAnchor.constraint(equalToConstant: 1)
        ownHeight.isActive = true
        heightConstraint = ownHeight
        // And pinned to the top of it. Left to a manually-set origin the view's top drifts
        // above the window as it shrinks, which lifts the dot and the count off the screen and
        // brings them back on the next layout pass.
        topAnchor.constraint(equalTo: host.topAnchor).isActive = true
        syncHeight()
    }
    private let topInset: CGFloat

    init(topInset: CGFloat) {
        self.topInset = topInset
        super.init(frame: NSRect(x: 0, y: 0, width: 460, height: 0))
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
        // The black shape is a path on its own sublayer. `maskedCorners` is ignored on a
        // view-backed layer, and `draw(_:)` on one did not reach the offscreen bitmap that
        // `--render` uses, so a shape layer is the version that holds in both places.
        background.fillColor = NSColor.black.cgColor
        layer?.insertSublayer(background, at: 0)
        layer?.mask = shapeMask
        // The idle badge is drawn on the panel's own layer, above the black shape. As a subview
        // it rendered offscreen and never on screen, which is exactly the bug it kept causing.

        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 0
        content.translatesAutoresizingMaskIntoConstraints = false
        addSubview(content)

        listStack.orientation = .vertical
        listStack.alignment = .leading
        listStack.spacing = 0
        listStack.translatesAutoresizingMaskIntoConstraints = false
        listStack.isHidden = true

        compactRow.translatesAutoresizingMaskIntoConstraints = false
        // Outside the notch inset and pinned to the very top, so the badges sit beside the
        // notch in every mode instead of sliding down with the list.
        addSubview(compactRow)
        compactRow.topAnchor.constraint(equalTo: topAnchor).isActive = true
        // Pinned on the leading edge too. Width and top alone left its x ambiguous, which is
        // the kind of thing that shows up as a badge sitting further out for no reason.
        compactRow.leadingAnchor.constraint(equalTo: leadingAnchor).isActive = true
        compactRow.widthAnchor.constraint(equalTo: widthAnchor).isActive = true

        // The unpaired message belongs in the visible strip under the cutout, where the empty
        // list row used to be. In the capsule beside the notch it read as floating under the
        // camera housing, and nothing there is legible against a black hole.
        unpairedLabel.attributedStringValue = unpairedText()
        unpairedLabel.alignment = .center
        unpairedDot.wantsLayer = true
        unpairedDot.layer?.backgroundColor = NSColor(white: 1, alpha: 0.35).cgColor
        unpairedDot.layer?.cornerRadius = 4.5
        unpairedDot.translatesAutoresizingMaskIntoConstraints = false
        unpairedDot.isHidden = true
        addSubview(unpairedDot)
        unpairedLabel.translatesAutoresizingMaskIntoConstraints = false
        unpairedLabel.isHidden = true
        addSubview(unpairedLabel)
        NSLayoutConstraint.activate([
            unpairedLabel.centerXAnchor.constraint(equalTo: centerXAnchor),
            // Half a strip up from the bottom edge: dead centre of the part you can read.
            unpairedLabel.centerYAnchor.constraint(
                equalTo: bottomAnchor, constant: -(unpairedStrip / 2)
            ),
            unpairedDot.widthAnchor.constraint(equalToConstant: 9),
            unpairedDot.heightAnchor.constraint(equalToConstant: 9),
            unpairedDot.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 20),
            unpairedDot.centerYAnchor.constraint(equalTo: unpairedLabel.centerYAnchor),
            unpairedLabel.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 12),
            unpairedLabel.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -12),
        ])
        listScroll.documentView = listStack
        listScroll.drawsBackground = false
        listScroll.hasVerticalScroller = true
        listScroll.scrollerStyle = .overlay
        listScroll.autohidesScrollers = true
        listScroll.verticalScrollElasticity = .allowed
        listScroll.translatesAutoresizingMaskIntoConstraints = false
        content.addArrangedSubview(listScroll)
        compactRow.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
        listStack.widthAnchor.constraint(equalTo: listScroll.contentView.widthAnchor).isActive = true
        listStack.topAnchor.constraint(equalTo: listScroll.contentView.topAnchor).isActive = true
        listScroll.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
        listHeight = listScroll.heightAnchor.constraint(
            equalToConstant: CGFloat(maxVisibleRows) * 40
        )
        listHeight.isActive = true

        inset = content.topAnchor.constraint(
            equalTo: topAnchor, constant: mode == .compact ? 0 : topInset
        )
        bottomPad = content.bottomAnchor.constraint(
            equalTo: bottomAnchor, constant: -capsulePadding
        )
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: leadingAnchor),
            content.trailingAnchor.constraint(equalTo: trailingAnchor),
            inset,
            bottomPad,
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Black, square across the top and round underneath, following the current mode's height.
    /// The height is the shape's own and never the view's: during a collapse the bounds are
    /// still the old, taller size, and a radius derived from them turned each capsule into a
    /// dome and left the black behind.
    override func layout() {
        // If the content has settled at a different height than was last set, follow it. Some
        // paths build the card after the height was decided, and this is what catches up.
        // An unpaired bar owns its height. Anything that animates the window back to the capsule
        // size would hide the message behind the cutout again, so the state is re-asserted here
        // instead of in every path that can move the window.
        if isUnpaired, let window, abs(window.frame.height - stateHeight) > 0.5 {
            var frame = window.frame
            frame.origin.y = frame.maxY - stateHeight
            frame.size.height = stateHeight
            window.setFrame(frame, display: true)
        }
        if let heightConstraint, heightConstraint.constant != max(stateHeight, 1) {
            heightConstraint.constant = max(stateHeight, 1)
        }
        super.layout()
        let b = bounds
        // Never clamped to the view's bounds. While the window catches up the bounds are
        // still the last mode's, and clamping to them left the list with a black strip only
        // behind its first row. A shape layer does not clip its path, so the full height is
        // drawn and the window reveals it as it grows.
        // Each branch below works out its own height: the compact bar its band, everything else
        // what the window is showing, which is shorter than this view by the drawer.
        let path = CGMutablePath()
        if mode == .compact {
            // Two capsules either side of the notch, flush with the top of the display and
            // round only underneath, the way the notch's own chin is.
            // One bar from the colour to the number, filled right across, rather than two
            // separate capsules with a gap: the notch sits in the middle of it anyway, so a
            // single filled shape is what reads as consistent.
            // Its own height, not the content's: the badges no longer contribute to it. The
            // unpaired strip is the exception and the whole reason for this branch's shape: its
            // window is one readable row, so the black has to be the window, or the message it
            // exists to show lands on white underneath it.
            let tall = isUnpaired ? b.height : capsuleHeight + capsulePadding
            addBottomRounded(
                path,
                in: NSRect(x: b.minX, y: b.maxY - min(tall, b.height), width: b.width, height: min(tall, b.height)),
                r: panelCornerRadius
            )
            background.frame = bounds
            // Actions off. The close animates the window, and assigning a new path inside
            // that transaction asks Core Animation to interpolate between two rounded
            // rectangles of different sizes, which is not a rounded rectangle halfway.
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            background.path = path
        shapeMask.path = path
            CATransaction.commit()
            return
        }
        // The view's own bounds, every time. This used to be a content height, so at any moment
        // when the content and the view disagreed the rounded bottom was drawn outside the view
        // and clipped square. Bounds cannot disagree with the view.
        // Where the window ends, anchored at the top. The drawer lives in the extra height below
        // that edge, so the rounded bottom belongs on the edge, not on the view's own bottom.
        // The shape is the window, exactly. The single exception is the detail card with its
        // drawer showing: there the window is taller than the card, the extra height below the
        // plates has to stay transparent, and the card's own edge decides where the shape stops.
        // Everywhere else, reading a stored height instead of bounds is how a 72pt window ended
        // up painted 42pt tall, with the message that belongs in the strip left outside it.
        let usesDrawer = mode == .detail && visibleHeight > 0
        let shown = usesDrawer ? min(b.height, visibleHeight) : b.height
        addBottomRounded(
            path,
            in: NSRect(x: b.minX, y: b.maxY - shown, width: b.width, height: shown),
            r: panelCornerRadius
        )
        background.frame = bounds
        // Actions off. The close animates the window, and assigning a new path inside
        // that transaction asks Core Animation to interpolate between two rounded
        // rectangles of different sizes, which is not a rounded rectangle halfway.
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        background.path = path
        shapeMask.path = path
        let dotSize: CGFloat = 9
        CATransaction.commit()
    }

    /// The exact height of the state being shown: the band plus the rows, counted. The request
    /// measures its card the same way, which is why that one is smooth and the list was not.
    var stateHeight: CGFloat {
        switch mode {
        case .compact:
            // Unpaired is one readable strip under the cutout, not a capsule with a line hidden
            // behind the notch and a large black shape beneath it.
            // The strip is the OPEN list while unpaired. Closed, it is the ordinary bar with
            // the grey badge, which is what makes the notch look like a thing you can hover.
            return (isUnpaired && unpairedOpen)
                ? topInset + unpairedStrip
                : capsuleHeight + capsulePadding
        case .list:
            // The empty row counts too, so the window is always the size of what it shows.
            return topInset + CGFloat(asks.isEmpty ? 1 : min(asks.count, maxVisibleRows)) * 40
        case .detail:
            // The card measures the same either way now, drawer included. The window is what
            // decides how much of it is on screen: closed stops at the bottom of the plates.
            let full = max(fittingSize.height, topInset)
            guard let card = detailCard, !card.isAnswering,
                  card.closedHeight() > 0 else { return full }
            // The window stops where the drawer's spacing begins. That spacing is the black under
            // the decision row, so the field stays hidden and the panel is not longer than it needs
            // to be.
            return max(full - card.drawerHeight(), topInset)
        }
    }

    /// One list row: the strip under the cutout that an unpaired panel is exactly tall enough
    /// to hold, so the message is centred in it rather than pushed up behind the housing.
    // Two rows, not one: one of them sits behind the physical notch, so a single row put the
    // line right under the housing with no black above it.
    private let unpairedStrip: CGFloat = 80

    /// "Login to connect", with Login carrying the link styling. The whole panel is the click
    /// target, so the words are a signpost rather than the only hit area.
    private func unpairedText() -> NSAttributedString {
        let body: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 13, weight: .regular),
            .foregroundColor: NSColor(white: 1, alpha: 0.72),
        ]
        let line = NSMutableAttributedString(string: "Please ", attributes: body)
        var link = body
        link[.foregroundColor] = NSColor.controlAccentColor
        link[.underlineStyle] = NSUnderlineStyle.single.rawValue
        line.append(NSAttributedString(string: "login", attributes: link))
        line.append(NSAttributedString(string: " to connect", attributes: body))
        return line
    }
    private let unpairedLabel = NSTextField(labelWithString: "")
    /// The badge, repeated in the strip. The row's own dot sits up in the cutout when the panel
    /// is expanded, so on screen it was there and hidden by the housing.
    private let unpairedDot = NSView()
    /// True while this Mac has no config. It changes what the empty bar says, and nothing else.
    var isUnpaired = false
    /// Unpaired and nothing has asked for the panel yet: there is nothing under the cutout until
    /// the menu opens it, because a permanent signpost on a Mac that is not connected is clutter,
    /// and "closed" has to look the same as a connected workspace with nothing waiting.
    var unpairedOpen = false
    /// The list must not draw the bar's badge: it is the same view class and was showing a
    /// second circle inside the dropdown.
    private var badgeSuppressed = false
    /// Called when the unpaired bar is clicked: the bar is the affordance, not just a label.
    var onConnectRequest: (() -> Void)?

    override func mouseDown(with event: NSEvent) {
        if isUnpaired { onConnectRequest?(); return }
        super.mouseDown(with: event)
    }

    /// The list draws rows, not the bar's badge: its own copy of the idle row put a second
    /// circle under the first one inside the dropdown.
    func hideBadgeRow() {
        badgeSuppressed = true
        compactRow.isHidden = true
    }

    func setUnpaired(_ on: Bool) {
        isUnpaired = on
        let strip = on && unpairedOpen
        unpairedLabel.isHidden = true
        unpairedDot.isHidden = true
        // The dot stays either way: it is the thing you aim at, so it must not vanish the
        // moment hovering found it.
        // The row's own badge is for the closed bar; the strip has its own, lower down, so the
        // two do not both show when the panel is expanded.
        compactRow.isHidden = strip || badgeSuppressed
        if on && !strip { compactRow.showIdleDot() }
        if on {
            // Hidden here, the row took the badge with it: this was the line that kept the
            // circle off screen while the render still drew it. Unpaired idle is the same row
            // as connected idle, dot included.
            compactRow.isHidden = badgeSuppressed
            compactRow.showIdle()
        } else if asks.isEmpty {
            compactRow.showIdle()
        }
        syncHeight()
    }

    func setAsks(_ asks: [Ask]) {
        self.asks = asks
        defer { syncHeight() }
        if let newest = asks.first {
            compactRow.show(newest, waiting: asks.count)
        } else if isUnpaired {
            // Hidden outright, this undid the idle dot that setUnpaired had just shown: the
            // row was there in the render and absent on screen, because this ran last.
            compactRow.isHidden = unpairedOpen || badgeSuppressed
            if !unpairedOpen { compactRow.showIdleDot() }
        } else {
            compactRow.showIdle()
        }
        for view in listStack.arrangedSubviews {
            listStack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        // The empty list is not blank: an unpaired Mac offers Connect here, and a connected
        // one says there is nothing waiting. The line lives in the list, never in the idle bar.
        if asks.isEmpty {
            let row = NSView()
            let label = NSTextField(labelWithString: "")
            let body: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 13, weight: .regular),
                .foregroundColor: NSColor(white: 1, alpha: 0.72),
            ]
            if isUnpaired {
                let line = NSMutableAttributedString(string: "Please ", attributes: body)
                var link = body
                link[.foregroundColor] = NSColor.controlAccentColor
                link[.underlineStyle] = NSUnderlineStyle.single.rawValue
                line.append(NSAttributedString(string: "login", attributes: link))
                line.append(NSAttributedString(string: " to connect", attributes: body))
                label.attributedStringValue = line
            } else {
                label.attributedStringValue = NSAttributedString(string: "no requests left", attributes: body)
            }
            label.alignment = .center
            label.translatesAutoresizingMaskIntoConstraints = false
            row.addSubview(label)
            NSLayoutConstraint.activate([
                row.heightAnchor.constraint(equalToConstant: 40),
                label.centerXAnchor.constraint(equalTo: row.centerXAnchor),
                label.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            ])
            listStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
        }
        for (index, ask) in asks.enumerated() {
            let row = RequestRow(ask: ask)
            row.isLast = index == asks.count - 1
            row.onClick = { [weak self] tapped in self?.onSelect?(tapped) }
            listStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
        }
    }

    @discardableResult
    func show(_ mode: PanelMode, ask: Ask?) -> NSSize {

        self.mode = mode
        detailCard?.removeFromSuperview()
        detailCard = nil
        // Waiting is a capsule beside the notch, so it carries no notch inset of its own.
        // Answering is one line, so it rides in the notch's own band rather than below it.
        inset.constant = (mode == .compact || detailCard?.isAnswering == true) ? 0 : topInset
        // The row keeps its place and the black carries on under it while waiting.
        bottomPad.constant = mode == .compact ? -capsulePadding : 0
        // Three rows, then it scrolls, so the panel cannot grow down the screen.
        let rows = asks.isEmpty ? 1 : min(asks.count, maxVisibleRows)
        listHeight.constant = CGFloat(rows) * 40
        listScroll.scrollerStyle = .overlay
        listScroll.hasVerticalScroller = asks.count > maxVisibleRows
        // The list scrolls, so the row at the panel's bottom corner is no longer a fixed row:
        // it is whatever has been scrolled into it. Rounding the clip keeps that corner right
        // for every scroll position, which is what the per-row rounding did while all the rows
        // were on screen together. The top corners cost nothing, the panel behind them is black.
        // Nothing clip anything. The list used to be masked to follow the panel's bottom
        // corner, which shaved whatever sat in that corner: rows at the top of the scroll, the
        // scrollbar when it was dragged. The panel's own background is rounded; the content on
        // top of it is not cut anywhere.
        // Cross-fade the states so nothing from the last one is still on screen: the colour
        // used to sit there for a moment after the list had already opened.
        // The badge row stays put in every mode: the count belongs on screen while requests
        // are open, not only while waiting. It rides in the top band, above the list.
        compactRow.alphaValue = 1
        listStack.alphaValue = mode == .list ? 1 : 0
        // The scroll view is the arranged subview now, so it is what has to collapse in the
        // other two modes: left visible it pushed the whole request down by the list's height.
        listScroll.isHidden = mode != .list
        listScroll.alphaValue = mode == .list ? 1 : 0
        compactRow.isHidden = !showsBadges
        switch mode {
        case .compact:
            listStack.isHidden = true
        case .list:
            listStack.isHidden = false
        case .detail:
            listStack.isHidden = true
            if let ask { buildDetail(ask) }
        }
        let measured = remeasure()
        // The list is counted, the rest is measured. Asking the scroll view to fit itself gave
        // the same height for no rows and for one, so the count is what decides: the bar's band
        // plus 40pt a row, one row for nothing waiting, at most two with requests.
        // Told to the view as well, so the window's fitting pass lands on the size we asked for
        // instead of on whatever the last state happened to measure.
        syncHeight()
        return NSSize(width: measured.width, height: max(stateHeight, 1))
    }

    /// The size the panel wants at this width, for whatever mode it is in.
    func remeasure() -> NSSize {
        let width = superview?.bounds.width ?? (frame.width > 0 ? frame.width : 460)
        // The view hangs from the top of the host, never from its bottom.
        let top = superview?.bounds.maxY ?? frame.maxY
        frame = NSRect(x: frame.minX, y: top - frame.height, width: width, height: frame.height)
        layoutSubtreeIfNeeded()
        // To a fixed point, not one pass. The message box takes its height from the width, so the
        // first measurement can report the card before that height is applied, and a card one line
        // short is what squeezed the title away.
        var needed = fittingSize.height
        for _ in 0..<3 {
            layoutSubtreeIfNeeded()
            let again = fittingSize.height
            if abs(again - needed) < 0.5 { break }
            needed = again
        }
        // Never shorter than the host, and no animation anywhere: the shape is drawn at exactly
        // the size that was measured, so what is on screen is the size the content needs.
        let height = max(needed, superview?.bounds.height ?? 0)
        shapeHeight = needed
        needsLayout = true
        frame = NSRect(x: frame.minX, y: top - height, width: width, height: height)
        layoutSubtreeIfNeeded()
        return NSSize(width: width, height: max(stateHeight, 1))
    }

    private func buildDetail(_ ask: Ask) {
        let card = NotchCardView(title: ask.title, subtitle: ask.message, meta: nil, topInset: 0)
        card.onAction = { [weak self] action in self?.onAction?(ask, action) }
        card.onAnswer = { [weak self] text in self?.onAnswer?(ask, text) }
        card.onCancelAnswer = { [weak self] in self?.onCancelAnswer?() }
        // Read, not assumed: a request that arrived while the workspace was out of requests
        // stays visible and stays closed until it can be paid for.
        card.applyLimit(ask.limited)
        card.translatesAutoresizingMaskIntoConstraints = false
        content.addArrangedSubview(card)
        card.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
        detailCard = card
            // The card changes the height, so the height is set again with it in place.
        syncHeight()
    }

    /// The pointer opens the list, and leaving closes it again.
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        // Only the black is hoverable. The canvas reaches further down, and the empty part of it
        // belongs to whatever is underneath.
        let h = shapeHeight > 0 ? min(shapeHeight, bounds.height) : bounds.height
        addTrackingArea(NSTrackingArea(
            rect: NSRect(x: 0, y: bounds.maxY - h, width: bounds.width, height: h),
            options: [.mouseEnteredAndExited, .activeAlways],
            owner: self
        ))
    }

    override func mouseEntered(with event: NSEvent) {
        hovering = true
        if mode == .compact { onHover?(true) }
    }

    override func mouseExited(with event: NSEvent) {
        hovering = false
        onHover?(false)
    }

    func frameReport(_ label: String) -> String {
        let box = { (view: NSView?) -> String in
            guard let view, !view.isHidden else { return "hidden" }
            return String(format: "y %.0f h %.0f", view.frame.minY, view.frame.height)
        }
        return "\(label): panel h \(Int(frame.height)) | compact \(box(compactRow)) | list \(box(listStack)) | detail \(box(detailCard))"
    }
}

// MARK: - the app

final class Approver: NSObject, NSApplicationDelegate, NSMenuDelegate {
    /// Ids this client has decided. A snapshot that still lists one of them is stale, and
    /// re-adding it is what made an approved request sit there until the client was restarted.
    private var decidedIDs = Set<String>()
    /// Requests sent but not yet acknowledged, kept so a refused decision can be put back.
    private var inFlight: [String: Ask] = [:]
    private let feed = LiveFeed()
    private var statusItem: NSStatusItem!
    private var panel: NotchPanel?
    private var panelView: NotchPanelView?
    private var asks: [Ask] = []
    private var connected = false
    private var currentConfig: Config?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        // An unpaired launch is a first run, not an error: the bar appears, the menu offers the
        // one-click connect, and nothing spins waiting for a token it does not have.
        currentConfig = loadConfig()
        enableLaunchAtLoginOnFirstRun()

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "psh notch"
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
        refreshTitle()

        feed.onState = { [weak self] state in
            DispatchQueue.main.async {
                self?.connected = (state == "live")
                self?.refreshTitle()
                log("feed \(state)")
            }
        }
        feed.onHello = { [weak self] pending, workspace in
            DispatchQueue.main.async {
                log("feed snapshot: \(pending.count) pending: \(pending.map { String($0.id.prefix(8)) }.joined(separator: ","))")
                self?.asks = pending.filter { !(self?.decidedIDs.contains($0.id) ?? false) }
                self?.refreshTitle()
                log("on \(workspace), \(pending.count) waiting")
                if !pending.isEmpty { self?.showNotch(for: pending[0]) }
                if !pending.isEmpty { self?.reconcilePending() }
            }
        }
        feed.onCreated = { [weak self] ask in
            DispatchQueue.main.async {
                guard let self else { return }
                self.asks.removeAll { $0.id == ask.id }
                self.asks.insert(ask, at: 0)
                self.refreshTitle()
                // Hidden means quiet: this is the mode for meetings and screen recordings, so
                // no ping and no panel. The request is still recorded, so the count and the list
                // are correct the moment the notch comes back.
                if self.notchHidden {
                    self.applyAsks()
                    log("new request while hidden, kept quiet: \(ask.title)")
                    return
                }
                self.showNotch(for: ask)
                self.autoExpand()
                self.reconcilePending()
                log("new request: \(ask.title)")
                if !self.notchMuted { NSSound(named: "Ping")?.play() }
            }
        }
        feed.onDecided = { [weak self] id in
            DispatchQueue.main.async {
                guard let self else { return }
                self.decidedIDs.insert(id)
                self.asks.removeAll { $0.id == id }
                self.refreshTitle()
                log("decided elsewhere: \(id.prefix(8))")
                // A decision closes the notch and it stays closed. Re-showing the next request
                // here is what made an answered card look like it had not been answered.
                self.applyAsks()
                self.withdrawList()
            }
        }
        feed.onAck = { [weak self] id, applied, reason in
            DispatchQueue.main.async {
                guard let self else { return }
                if applied {
                    self.decidedIDs.insert(id)
                    self.asks.removeAll { $0.id == id }
                } else if var back = self.inFlight[id] {
                    // Refused, so it goes back, and it is no longer final.
                    self.decidedIDs.remove(id)
                    // Out of requests: the request stays visible, but it cannot be answered until
                    // the workspace can pay, so the card says so rather than holding a checkmark
                    // for a decision that never happened.
                    if reason == "blocked" { back.limited = true }
                    self.asks.insert(back, at: 0)
                    self.applyAsks()
                    self.showNotch(for: back)
                }
                self.inFlight[id] = nil
                log("decision \(id.prefix(8)) applied=\(applied) reason=\(reason ?? "-")")
                self.refreshTitle()
                // More than one request can be waiting: move to the next instead of
                // leaving the card for the one that was just answered on screen.
                // A decision closes the notch and it stays closed. Re-showing the next request
                // here is what made an answered card look like it had not been answered.
                self.applyAsks()
                self.withdrawList()
            }
        }
        // The bar exists from launch, whether or not anything is waiting. On means on: with
        // nothing pending it is an empty badge at the notch, not a missing window.
        _ = ensurePanel()
        syncVisibility()
        // A Space swipe re-parents every window, and an all-spaces panel can be dropped from the
        // incoming Space's window list for a frame. Nothing else ever re-orders it, so the bar
        // stayed gone until the next ask arrived. Put it back the moment the swipe settles.
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.activeSpaceDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.reassertPanel()
        }
        reconcilePending()
        // An accessory app can take focus, and therefore receive keystrokes, while still
        // showing no Dock icon. A process launched from a terminal has no policy at all and
        // cannot activate, which is why CMD+N, CMD+J and CMD+L were never delivered.
        NSApp.setActivationPolicy(.accessory)

        // macOS hands the psh-notch:// URL to the running app as an Apple event. A bare binary
        // has no bundle and therefore no scheme, which is why --handle-url and --pair exist.
        NSAppleEventManager.shared().setEventHandler(
            self,
            andSelector: #selector(handleURLEvent(_:withReply:)),
            forEventClass: AEEventClass(kInternetEventClass),
            andEventID: AEEventID(kAEGetURL)
        )

        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self,
                  event.modifierFlags.contains(.command),
                  event.modifierFlags.intersection([.shift, .option, .control]).isEmpty,
                  let key = event.charactersIgnoringModifiers?.lowercased(),
                  ["n", "j", "l"].contains(key),
                  let card = self.listView?.detailCard ?? self.panelView?.detailCard,
                  card.window?.isVisible == true else { return event }
            return card.handleShortcut(key) ? nil : event
        }

        // Open the list on demand from a terminal, which is otherwise impossible without a
        // pointer on the bar:
        //   touch /tmp/psh-notch-open
        // It takes the same path a request arriving takes, including the automatic withdraw.
        // Open a card, open its comment bar and close it again, logging the three heights at
        // each stage:
        //   touch /tmp/psh-notch-comment
        // The window is what the shape is clipped by, so the numbers say whether the shape or
        // the window is left at the wrong height after the bar closes.
        // Opens and closes the unpaired strip without a pointer, so its height can be measured:
        //   touch /tmp/psh-notch-open
        let openTrigger = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self,
                  FileManager.default.fileExists(atPath: "/tmp/psh-notch-open") else { return }
            try? FileManager.default.removeItem(atPath: "/tmp/psh-notch-open")
            let want = !(self.panelView?.unpairedOpen ?? false)
            self.panelView?.unpairedOpen = want
            self.syncVisibility()
            NSLog("openTrigger: open=%@ window=%.0fx%.0f content=%.0fx%.0f view=%.0fx%.0f state=%.0f",
                  want ? "true" : "false",
                  self.panel?.frame.width ?? 0, self.panel?.frame.height ?? 0,
                  self.panel?.contentView?.frame.width ?? 0,
                  self.panel?.contentView?.frame.height ?? 0,
                  self.panelView?.frame.width ?? 0, self.panelView?.frame.height ?? 0,
                  self.panelView?.stateHeight ?? 0)
        }
        RunLoop.main.add(openTrigger, forMode: .common)

        let commentTrigger = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self,
                  FileManager.default.fileExists(atPath: "/tmp/psh-notch-comment") else {
                return
            }
            try? FileManager.default.removeItem(atPath: "/tmp/psh-notch-comment")
            // Every visible window, because the card is not in the bar's window and the panel
            // this trigger can reach is the bar's.
            func report(_ stage: String) {
                let sizes = NSApp.windows
                    .filter { $0.isVisible }
                    .map { String(format: "%.0fx%.0f", $0.frame.width, $0.frame.height) }
                    .joined(separator: " + ")
                let viewHeight = self.listView?.frame.height ?? 0
                let visible = self.listView?.visibleHeight ?? 0
                let plates = self.listView?.detailCard?.platesFrameInWindow()
                    .map { String(format: "%.1f,%.1f %.0fx%.0f", $0.minX, $0.minY, $0.width, $0.height) }
                    ?? "none"
                NSLog("comment-trigger %@ view %.0f visible %.0f plates %@: %@",
                      stage, viewHeight, visible, plates, sizes)
            }
            self.autoExpand()
            // The requests live on the list's view, not on this object.
            if let first = self.listView?.asks.first { self.showDetail(first) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) {
                report("card-open")
                // The card lives in the list's view, not the bar's.
                let card = self.listView?.detailCard
                _ = card?.setAnswering(true)
                // The window is resized by the caller, not by setAnswering: without this the bar
                // opened inside a window that never grew.
                if let list = self.listView { self.resizeList(to: list.remeasure().height) }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) {
                    report("comment-open")
                    _ = card?.setAnswering(false)
                    if let list = self.listView { self.resizeList(to: list.remeasure().height) }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) {
                        report("comment-closed")
                    }
                }
            }
        }
        RunLoop.main.add(commentTrigger, forMode: .common)

        // Synthesise CMD+L (approve), CMD+N (deny) and CMD+J (comment) against an open card:
        //   touch /tmp/psh-notch-keys
        let keyTrigger = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self,
                  FileManager.default.fileExists(atPath: "/tmp/psh-notch-keys") else { return }
            try? FileManager.default.removeItem(atPath: "/tmp/psh-notch-keys")
            self.autoExpand()
            if let first = self.listView?.asks.first { self.showDetail(first) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) {
                NSLog("keys: appActive=%d keyWindow=%d",
                      NSApp.isActive ? 1 : 0,
                      self.listPanel?.isKeyWindow == true ? 1 : 0)
                func press(_ character: String, _ code: UInt16) {
                    guard let event = NSEvent.keyEvent(
                        with: .keyDown, location: .zero, modifierFlags: .command,
                        timestamp: ProcessInfo.processInfo.systemUptime,
                        windowNumber: self.listPanel?.windowNumber ?? 0, context: nil,
                        characters: character, charactersIgnoringModifiers: character,
                        isARepeat: false, keyCode: code
                    ) else { return }
                    NSLog("keys: sending cmd+%@", character)
                    NSApp.sendEvent(event)
                    self.listPanel?.sendEvent(event)
                }
                press("j", 38)
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                    NSLog("keys: second press, hoping the bar closes")
                    press("j", 38)
                }
            }
        }
        RunLoop.main.add(keyTrigger, forMode: .common)

        let trigger = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self,
                  FileManager.default.fileExists(atPath: "/tmp/psh-notch-open") else { return }
            try? FileManager.default.removeItem(atPath: "/tmp/psh-notch-open")
            self.autoExpand()
        }
        RunLoop.main.add(trigger, forMode: .common)

        if let config = currentConfig {
            feed.connect(base: config.baseUrl, token: config.deviceToken)
            panelView?.setUnpaired(false)
        } else {
            panelView?.setUnpaired(true)
            refreshTitle()
        }
    }

    /// A connect URL, from the scheme handler or from a test. The token inside it is a
    /// credential: it is validated by `handleConnectURL`, written at 0600, and never logged.
    @discardableResult
    func connect(from raw: String) -> Bool {
        guard handleConnectURL(raw) else { return false }
        currentConfig = loadConfig()
        if let config = currentConfig {
            feed.connect(base: config.baseUrl, token: config.deviceToken)
            panelView?.setUnpaired(false)
        }
        connected = false
        syncVisibility()
        refreshTitle()
        log("connected this Mac; the feed is reconnecting")
        return true
    }

    @objc private func handleURLEvent(_ event: NSAppleEventDescriptor, withReply reply: NSAppleEventDescriptor) {
        guard let raw = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue else { return }
        _ = connect(from: raw)
    }

    /// Open and close the unpaired strip. It is the only thing that puts anything under the
    /// cutout while there is no config, so it doubles as the signpost and the way to reach it.
    /// Hidden on purpose, for screen recordings. Persisted, so turning it off survives a
    /// restart: it used to come back on every launch, which meant hiding it every time.
    /// Silent but visible: the panel still opens and counts, it just makes no sound. Separate
    /// from `notchHidden`, which is the meeting mode that shows nothing at all.
    private var notchMuted: Bool {
        get { UserDefaults.standard.bool(forKey: "notchMuted") }
        set { UserDefaults.standard.set(newValue, forKey: "notchMuted") }
    }

    private var notchHidden: Bool {
        get { UserDefaults.standard.bool(forKey: "notchHidden") }
        set { UserDefaults.standard.set(newValue, forKey: "notchHidden") }
    }

    @objc private func toggleNotchMuted() {
        notchMuted.toggle()
    }

    @objc private func toggleNotchHidden() {
        notchHidden.toggle()
        syncVisibility()
        refreshTitle()
    }

    @objc private func toggleUnpairedPanel() {
        guard let panelView else { return }
        panelView.unpairedOpen.toggle()
        if panelView.unpairedOpen {
            if let geometry = panelFrame(for: .compact, contentHeight: panelView.stateHeight) {
                panelView.frame = geometry
                panelView.needsDisplay = true
            }
        }
        syncVisibility()
        refreshTitle()
    }

    @objc private func connectThisMac() {
        let base = currentConfig?.baseUrl ?? "https://psh.now"
        guard let url = URL(string: base + "/connect") else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func disconnectThisMac() {
        // Two steps, because this sits next to Dashboard in a menu that opens by accident and
        // one stray click should not take the notch offline for the rest of the day.
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Disconnect this Mac?"
        alert.informativeText = "The notch will stop showing requests until it is connected again."
        alert.addButton(withTitle: "Disconnect")
        alert.addButton(withTitle: "Cancel")
        alert.buttons.last?.keyEquivalent = "\u{1b}"
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else {
            log("disconnect cancelled")
            return
        }
        // Only this app's own credential. The device record on the server stays until it is
        // revoked on the dashboard, which is the other half of disconnecting.
        guard removeConfigFile() else { return }
        currentConfig = nil
        asks = []
        applyAsks()
        syncVisibility()
        withdrawList()
        refreshTitle()
        log("disconnected this Mac; config removed")
    }

    /// Prints one line per state so the state table can be checked without a server, a
    /// request or a screenshot. Cleans up after itself and leaves nothing on screen.
    /// Prints the menu exactly as the status item would show it, so a change to the menu can
    /// be checked without a human opening it. Structure only: titles, separators, submenus.
    func runMenuProbe() {
        let menu = NSMenu()
        menu.delegate = self
        menuNeedsUpdate(menu)
        func dump(_ items: [NSMenuItem], _ depth: Int) {
            for item in items {
                let pad = String(repeating: "  ", count: depth)
                if item.isSeparatorItem { print("\(pad)---"); continue }
                let mark = item.submenu == nil ? "" : " >"
                print("\(pad)\(item.title)\(mark)")
                if let sub = item.submenu { dump(sub.items, depth + 1) }
            }
        }
        dump(menu.items, 0)

        // The same menu on a paired Mac: Connect is replaced by Disconnect, and the toggles
        // read in the other direction. Both states are printed because the unpaired one hides
        // a row that most people will actually see.
        currentConfig = Config(
            baseUrl: "https://probe.invalid",
            deviceToken: String(repeating: "p", count: 24),
            deviceName: "probe",
            workspaceId: nil
        )
        print("")
        print("paired:")
        let paired = NSMenu()
        paired.delegate = self
        menuNeedsUpdate(paired)
        dump(paired.items, 0)
    }

    func runStateProbe() {
        guard ensurePanel() != nil, let panel, let view = panelView else {
            die("the bar panel could not be created")
        }
        currentConfig = nil
        asks = []
        applyAsks()
        print("no config        visible=\(panel.isVisible) size=\(Int(panel.frame.width))x\(Int(panel.frame.height))")

        currentConfig = Config(
            baseUrl: "https://probe.invalid",
            deviceToken: String(repeating: "p", count: 24),
            deviceName: "probe",
            workspaceId: nil
        )
        asks = []
        applyAsks()
        print("paired, empty    visible=\(panel.isVisible)")

        let probe = sampleAsks()
        asks = probe
        applyAsks()
        showNotch(for: probe[0])
        print("paired, waiting  visible=\(panel.isVisible) size=\(Int(panel.frame.width))x\(Int(panel.frame.height))")

        withdrawList()
        panel.orderOut(nil)
        listPanel?.orderOut(nil)
    }

    private func refreshTitle() {
        let pending = asks.count
        // Always the name. A count here spelled "psh 2" and read as a version, not a
        // number of requests; the count lives in the tooltip and in the notch itself.
        statusItem?.button?.title = "psh notch"
        statusItem?.button?.toolTip = currentConfig == nil
            ? "psh notch: not connected, click Connect this Mac"
            : (connected ? "psh.now: \(pending) waiting" : "psh.now: reconnecting")
    }

    // MARK: menu

    // MARK: - open at login

    /// Since macOS 13 an app can register itself as a login item, so this needs no helper
    /// bundle and no AppleScript. Ad-hoc signing is not a problem: SMAppService cares where
    /// the bundle lives and what its identifier is, not about a Team ID. It does mean the app
    /// has to be in /Applications - registering from the mounted dmg records a path that will
    /// not exist next boot, which is the one reason the drag out of the image matters.
    private static let launchAtLoginKey = "psh.launchAtLogin.initialised"

    private var launchAtLogin: Bool {
        if #available(macOS 13.0, *) { return SMAppService.mainApp.status == .enabled }
        return false
    }

    private func setLaunchAtLogin(_ on: Bool) {
        guard #available(macOS 13.0, *) else { return }
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            log("launch at login: \(on ? "on" : "off")")
        } catch {
            // A refusal is worth hearing: silent means "I ticked it and nothing happened".
            log("launch at login failed: \(error.localizedDescription)")
            NSSound.beep()
        }
    }

    /// Turned on once, on the first launch after install: a notch that does not come back
    /// after a reboot reads as broken. It stays a setting afterwards, and the menu flips it.
    private func enableLaunchAtLoginOnFirstRun() {
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: Self.launchAtLoginKey) else { return }
        defaults.set(true, forKey: Self.launchAtLoginKey)
        if !launchAtLogin { setLaunchAtLogin(true) }
    }

    @objc private func toggleLaunchAtLogin() {
        setLaunchAtLogin(!launchAtLogin)
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        // A connected Mac has nothing to connect, so the item is not offered there. The list
        // below already says "Please login to connect" only while unpaired.
        menu.items.first { $0.action == #selector(connectThisMac) }?.isHidden = currentConfig != nil
        menu.removeAllItems()
        let status = currentConfig == nil ? "Not connected" : (connected ? "Live" : "Reconnecting…")
        menu.addItem(withTitle: status, action: nil, keyEquivalent: "")
        menu.addItem(.separator())
        if asks.isEmpty {
            // "Nothing waiting" is a connected workspace's empty state. Unpaired must not
            // borrow it, or a broken setup reads as a working one.
            let empty = currentConfig == nil
                ? "Not connected yet, use Connect this Mac"
                : "Nothing waiting"
            menu.addItem(withTitle: empty, action: nil, keyEquivalent: "")
        }
        for ask in asks {
            let item = NSMenuItem(title: shorten(ask.title, 52), action: nil, keyEquivalent: "")
            item.representedObject = ask
            let sub = NSMenu()
            sub.addItem(withTitle: shorten(ask.message, 70), action: nil, keyEquivalent: "")
            sub.addItem(.separator())
            sub.addItem(withTitle: "Approve", action: #selector(approve(_:)), keyEquivalent: "").representedObject = ask
            sub.addItem(withTitle: "Deny", action: #selector(deny(_:)), keyEquivalent: "").representedObject = ask
            sub.addItem(withTitle: "Answer…", action: #selector(answer(_:)), keyEquivalent: "").representedObject = ask
            for entry in sub.items where entry.action != nil { entry.target = self }
            item.submenu = sub
            menu.addItem(item)
        }
        menu.addItem(.separator())
        if currentConfig == nil {
            // The open list is where the message lives, so the menu has to be able to open it.
            // Without this there would be no way to reach the strip at all.
            let open = panelView?.unpairedOpen == true
            menu.addItem(withTitle: open ? "Close list" : "Open list",
                         action: #selector(toggleUnpairedPanel), keyEquivalent: "")
        }
        // Everything that changes how the notch behaves lives behind one Settings row: five
        // top level items read as a control panel, and the menu is opened far more often to
        // see what is waiting than to change a setting.
        let settings = NSMenu()
        let hide = settings.addItem(withTitle: notchHidden ? "Show notch" : "Hide notch",
                                    action: #selector(toggleNotchHidden), keyEquivalent: "")
        hide.target = self
        let mute = settings.addItem(withTitle: notchMuted ? "Unmute" : "Mute",
                                    action: #selector(toggleNotchMuted), keyEquivalent: "")
        mute.target = self
        let login = settings.addItem(withTitle: launchAtLogin ? "Don't open at login" : "Open at login",
                                     action: #selector(toggleLaunchAtLogin), keyEquivalent: "")
        login.target = self
        // Offered only while unpaired: a connected Mac has nothing to connect.
        if currentConfig == nil {
            let connect = settings.addItem(withTitle: "Connect this Mac",
                                           action: #selector(connectThisMac), keyEquivalent: "")
            connect.target = self
        } else {
            let disconnect = settings.addItem(withTitle: "Disconnect",
                                              action: #selector(disconnectThisMac), keyEquivalent: "")
            disconnect.target = self
        }
        settings.addItem(.separator())
        let dashboard = settings.addItem(withTitle: "Dashboard",
                                         action: #selector(openDashboard), keyEquivalent: "")
        dashboard.target = self

        let settingsRow = NSMenuItem(title: "Settings", action: nil, keyEquivalent: "")
        settingsRow.submenu = settings
        menu.addItem(settingsRow)
        menu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    }

    private func shorten(_ text: String, _ limit: Int) -> String {
        text.count <= limit ? text : String(text.prefix(limit - 1)) + "…"
    }

    @objc private func approve(_ sender: NSMenuItem) {
        guard let ask = sender.representedObject as? Ask else { return }
        decide(ask, approved: true, answer: nil)
    }

    @objc private func deny(_ sender: NSMenuItem) {
        guard let ask = sender.representedObject as? Ask else { return }
        decide(ask, approved: false, answer: nil)
    }

    @objc private func answer(_ sender: NSMenuItem) {
        guard let ask = sender.representedObject as? Ask else { return }
        promptForAnswer(ask)
    }

    /// Answering happens in the panel itself, not in a modal alert: the panel is the one
    /// window already on screen, and it is now allowed to take the keyboard. A separate
    /// alert on an accessory app was the thing that could not be typed into.
    private func promptForAnswer(_ ask: Ask) {
        showNotch(for: ask)
        enterAnswerMode(for: ask)
    }

    @objc private func openDashboard() {
        guard let config = loadConfig(), let url = URL(string: "\(config.baseUrl)/app") else { return }
        NSWorkspace.shared.open(url)
    }

    private func decide(_ ask: Ask, approved: Bool, answer: String?) {
        let what = answer != nil ? "answer" : (approved ? "approve" : "deny")
        log("sending \(what) for \(ask.id.prefix(8))")
        feed.decide(ask.id, approved: approved, answer: answer)
        // Final at once, and off the screen at once. The round trip used to be what cleared the
        // card, so a press sat there looking ignored until the server answered. If the server
        // refuses, the acknowledgement puts it back.
        decidedIDs.insert(ask.id)
        inFlight[ask.id] = ask
        asks.removeAll { $0.id == ask.id }
        refreshTitle()
        guard panelView != nil else { return }
        applyAsks()
        // Closed on the click, whatever is left waiting and wherever the pointer is. Showing the
        // next request straight away, or leaving the panel up because the cursor is over it, is
        // what made a decision look like nothing had happened.
        withdrawList()
    }

    // MARK: the two layers

    /// Layer 1: the waiting bar. Created once at the notch and never resized or animated again,
    /// so there is no animation on it that could move it, blank it, or make it withdraw.
    private func ensurePanel() -> NotchPanelView? {
        if let panelView { return panelView }
        guard let created = presentNotch(configure: { [weak self] view in
            guard let self else { return }
            self.wire(view)
            view.onHover = { [weak self, weak view] inside in
                guard let self, let view else { return }
                self.barHoverChanged(inside)
            }
        }) else { return nil }
        panel = created.panel
        panelView = created.view
        _ = ensureListPanel()
        // A first run has no config, and its height comes from that state. A bar created before
        // syncVisibility ran kept the capsule height for good, which is how the message ended up
        // in a 32pt window with nowhere to sit.
        if currentConfig == nil {
            syncVisibility()
            NSLog("ensurePanel: unpaired bar %.0fx%.0f state %.0f", created.panel.frame.width,
                  created.panel.frame.height, created.view.stateHeight)
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                NSLog("after 2s: bar %.0fx%.0f visible=%d state %.0f",
                      created.panel.frame.width, created.panel.frame.height,
                      created.panel.isVisible ? 1 : 0, created.view.stateHeight)
            }
        }
        return created.view
    }

    /// Layer 2: the list. Its own window, top flush with the bar's bottom, and the only thing
    /// in the client whose size ever animates. Nothing it does touches the bar.
    @discardableResult
    private func ensureListPanel() -> NotchPanelView? {
        if let listView { return listView }
        guard let created = presentNotch(
            // The bar's height (32), not the notch's (46). The 14pt difference was a band of
            // black above the first row.
            topInset: capsuleHeight + capsulePadding,
            mode: .list,
            unroll: false,
            visible: false,
            configure: { [weak self] view in
                guard let self else { return }
                view.showsBadges = false
                // Once, at creation: the badge is suppressed for the life of this view, so no
                // later setAsks can put a second circle back inside the dropdown.
                view.hideBadgeRow()
                view.setAsks(self.asks)
                self.wire(view)
              view.onConnectRequest = { [weak self] in self?.connectThisMac() }
                view.onHover = { [weak self] inside in
                    guard let self else { return }
                    self.listHoverChanged(inside)
                }
            }
        ) else { return nil }
        listPanel = created.panel
        listView = created.view
        return created.view
    }

    private func wire(_ view: NotchPanelView) {
        view.onSelect = { [weak self] ask in self?.showDetail(ask) }
        view.onAction = { [weak self] ask, action in
            guard let self else { return }
            switch action {
            case .approve: self.decide(ask, approved: true, answer: nil)
            case .deny: self.decide(ask, approved: false, answer: nil)
            case .answer: self.enterAnswerMode(for: ask)
            }
        }
        view.onAnswer = { [weak self] ask, text in self?.decide(ask, approved: false, answer: text) }
        view.onCancelAnswer = { [weak self] in self?.leaveAnswerMode() }
    }

    /// Content only. The bar is already on screen and stays exactly where and what it is.
    private func applyAsks() {
        // Built here, not only at launch: if the panel could not be created then, because the
        // screen geometry was not ready, a request arriving later found panel == nil and
        // syncVisibility gave up, so the notch never appeared even with requests waiting.
        _ = ensurePanel()
        panelView?.setAsks(asks)
        listView?.setAsks(asks)
        syncVisibility()
    }

    // MARK: - reconcile

    /// The live feed is the primary path: `prompt.decided` removes a card the moment
    /// anyone answers it. But a frame can be dropped (socket reconnecting, Mac asleep,
    /// server restarted), and until now the card then stayed on screen until something
    /// else moved it, which reads as the notch being slow rather than as a lost event.
    ///
    /// This asks the server what is still pending while there is anything to show, and
    /// drops whatever is no longer there. 1.5s, not a poll loop: it runs only while asks
    /// exist, and stops the moment the list empties.
    private var reconcileTimer: Timer?

    private func startReconcile() {
        guard reconcileTimer == nil, !asks.isEmpty else { return }
        let timer = Timer(timeInterval: 1.5, repeats: true) { [weak self] _ in
            self?.reconcilePending()
        }
        // .common, or the timer stops firing while a menu or a drag is tracking.
        RunLoop.main.add(timer, forMode: .common)
        reconcileTimer = timer
    }

    private func stopReconcile() {
        reconcileTimer?.invalidate()
        reconcileTimer = nil
    }

    private func reconcilePending() {
        guard !asks.isEmpty else { stopReconcile(); return }
        guard let config = loadConfig() else { stopReconcile(); return }
        startReconcile()
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard var comps = URLComponents(string: "\(config.baseUrl)/api/v1/approvals") else { return }
            comps.queryItems = [URLQueryItem(name: "limit", value: "50")]
            guard let url = comps.url else { return }
            var request = URLRequest(url: url)
            request.setValue(config.deviceToken, forHTTPHeaderField: "x-psh-device")
            let (status, body) = httpJSON(request, timeout: 8)
            guard status == 200 else { return }
            let pending = (body["prompts"] as? [[String: Any]] ?? []).compactMap { Ask(json: $0) }
            let live = Set(pending.map { $0.id })
            DispatchQueue.main.async {
                guard let self else { return }
                // A decision this app just sent may not be reflected yet; decidedIDs
                // already covers that, so only trust the server about ids it knows.
                let stale = self.asks.filter { !live.contains($0.id) && !self.decidedIDs.contains($0.id) }
                guard !stale.isEmpty else {
                    if self.asks.isEmpty { self.stopReconcile() }
                    return
                }
                for ask in stale { self.decidedIDs.insert(ask.id) }
                self.asks.removeAll { ask in stale.contains { $0.id == ask.id } }
                log("reconciled: \(stale.count) closed elsewhere")
                self.refreshTitle()
                self.applyAsks()
                self.withdrawList()
                if self.asks.isEmpty { self.stopReconcile() }
            }
        }
    }

    /// Put the panel back after the window server has moved every window to a new Space.
    /// Idempotent on purpose: ordering an already-visible panel front changes nothing on screen,
    /// and doing it unconditionally is the only reliable way to recover the one frame where the
    /// swipe drops an all-spaces panel out of the incoming Space's list.
    private func reassertPanel() {
        guard !notchHidden else { return }
        panel?.orderFrontRegardless()
        if let list = listPanel, listOpen { list.orderFrontRegardless() }
    }

    /// The whole of what the screen shows, decided in one place:
    ///   no config        one strip under the cutout saying "not connected"; the menu connects
    ///   paired, empty    nothing at all: ordered out, not a zero-height window left painting
    ///   paired, waiting  the bar, at the notch
    private func syncVisibility() {
        guard let panel, let panelView else { return }
        // Nothing waiting means nothing to list: the list panel used to survive the withdraw
        // and hang under the bar, which is the "dropdown" that was still showing.
        if asks.isEmpty { listPanel?.orderOut(nil) }
        if notchHidden {
            if panel.isVisible { panel.orderOut(nil) }
            listPanel?.orderOut(nil)
            return
        }
        if currentConfig == nil {
            panelView.setUnpaired(true)
            // The list is its own view, so it has its own idea of the state. Left unset, it
            // said "no requests left" on a Mac that has never been connected.
            listView?.setUnpaired(true)
            listView?.setAsks(asks)
            listView?.hideBadgeRow()
            panelView.setAsks(asks)
            // The view's own height is what the black is painted at. The window growing without
            // this left a 112pt window with a 32pt shape inside it: the strip never appeared.
            panelView.syncHeight()
            // Always on screen, even unpaired: the grey badge at the notch is how anyone finds
            // this thing. Opening it is what shows the connect line, not being visible at all.
            if panelView.unpairedOpen {
                let height = panelView.stateHeight
                // The view is what the black is painted at. Resizing only the window left a
                // 112pt window holding a 32pt shape, so the strip never appeared.
                panelView.setFrameSize(NSSize(width: panel.frame.width, height: height))
                if let geometry = panelFrame(for: .compact, contentHeight: height) {
                    panel.setFrame(geometry, display: true)
                } else {
                    // Expanded by hand if the helper declines, so hovering can never leave a
                    // strip that is too short to hold its own line.
                    let frame = panel.frame
                    panel.setFrame(
                        NSRect(x: frame.minX, y: frame.maxY - height,
                               width: frame.width, height: height),
                        display: true
                    )
                }
            }
            if !panel.isVisible { panel.orderFrontRegardless() }
            return
        }
        panelView.setUnpaired(false)
        listView?.setUnpaired(false)
        listView?.setAsks(asks)
        listView?.hideBadgeRow()
        panelView.setAsks(asks)
        // Kept on screen with nothing waiting: the idle badge is the way in, not a hidden app.
        if !panel.isVisible { panel.orderFrontRegardless() }
    }

    private func showNotch(for ask: Ask) {
        guard ensurePanel() != nil, let list = ensureListPanel() else { return }
        applyAsks()
        // A request that arrives mid-sentence joins the list behind the field; it does not take
        // the keyboard away.
        if list.detailCard?.isAnswering == true { return }
        // The counted height, not remeasure()'s: that one is the scroll view's fitting height,
        // 86 whatever the list holds, and it was being applied straight after a correct open.
        if listOpen { resizeList(to: list.stateHeight) }
    }

    // MARK: hover, the only link between the layers

    private var barHovered: Bool { panelView?.hovering ?? false }
    private var listHovered: Bool { listView?.hovering ?? false }

    /// The pointer on the bar opens layer 2. Focus of the bar never changes: it is not
    /// hover-dependent and does not withdraw.
    private func barHoverChanged(_ inside: Bool) {
        if inside {
            withdrawTimer?.invalidate()
            openList()
        } else {
            scheduleWithdraw()
        }
    }

    /// The pointer leaving layer 2 withdraws it, unless it went back onto the bar.
    private func listHoverChanged(_ inside: Bool) {
        if inside {
            withdrawTimer?.invalidate()
            return
        }
        if listView?.detailCard?.isAnswering == true { leaveAnswerMode() }
        scheduleWithdraw()
    }

    /// A short grace period, because moving from the bar down onto the list crosses the boundary
    /// between two windows and the enter arrives after the exit.
    private func scheduleWithdraw() {
        withdrawTimer?.invalidate()
        let timer = Timer(timeInterval: 0.18, repeats: false) { [weak self] _ in
            guard let self else { return }
            guard !self.barHovered, !self.listHovered else { return }
            self.withdrawList()
        }
        RunLoop.main.add(timer, forMode: .common)
        withdrawTimer = timer
    }

    private func openList() {
        guard let list = listView, let listPanel else { return }
        // The first hover of a launch measured a list that had never been given its rows, so it
        // hung there as an empty slab and only filled in on the second hover. Populate it before
        // it is measured, every time it opens.
        list.setUnpaired(currentConfig == nil)
        list.setAsks(asks)
        list.hideBadgeRow()
        let first = !listOpen
        listOpen = true
        // Measure first, then place. Collapsing to zero and growing meant the first paint was an
        // empty slab at the wrong size, and its corners were drawn before the final height
        // existed. One frame, at the size it will actually have.
        let measured = list.show(.list, ask: nil).height
        if let bar = panel?.frame {
            listPanel.setFrame(
                NSRect(x: bar.minX, y: bar.minY - measured, width: bar.width, height: measured),
                display: false
            )
        }
        listPanel.orderFrontRegardless()
        // Above it: layer 2's black fills the notch band, and the bar's badges sit on top.
        panel?.orderFrontRegardless()
        // Always the list, even when a card was up. That card belongs to a request that may have
        // been decided since, and putting it back on screen is how a decided request reappeared
        // with the checkmark still on its button. One measure per open: `show` already measures,
        // so measuring again straight after is the layout shift that reads as opening twice.
        resizeList(to: list.show(.list, ask: nil).height)
        // The frame changes after `show` measured it, so on the first open the rounded shape was
        // drawn from the old bounds and the corners came out square. Lay it out and redraw once
        // the new size is in place.
        list.needsLayout = true
        list.layoutSubtreeIfNeeded()
        list.needsDisplay = true
        list.displayIfNeeded()
    }

    /// Withdraws upward into the bar. The bar does not move, because it is a different window.
    private func withdrawList() {
        guard let listPanel, listOpen else { return }
        listOpen = false
        if listView?.detailCard?.isAnswering == true { leaveAnswerMode() }
        listPanel.becomesKeyOnlyIfNeeded = true
        // Ordered out outright: no intermediate frame, and no zero-size window left on screen.
        listPanel.orderOut(nil)
    }

    /// A new request opens the list by itself, then it withdraws. Hover always wins: while the
    /// pointer is on either layer it stays open.
    private func autoExpand() {
        // One gate for every caller: hidden never opens anything.
        guard !notchHidden else { return }
        openList()
        autoExpandTimer?.invalidate()
        let timer = Timer(timeInterval: 5, repeats: false) { [weak self] _ in
            guard let self, !self.barHovered, !self.listHovered else { return }
            self.withdrawList()
        }
        RunLoop.main.add(timer, forMode: .common)
        autoExpandTimer = timer
    }

    // MARK: the request itself, in layer 2

    private func showDetail(_ ask: Ask) {
        guard let list = ensureListPanel() else { return }
        listOpen = true
        listPanel?.orderFrontRegardless()
        // A non-activating panel that never becomes key receives neither keyDown nor key
        // equivalents, which is why CMD+N, CMD+J and CMD+L did nothing at all: the app was not
        // active and the panel was not key, so macOS delivered the keystrokes elsewhere.
        listPanel?.becomesKeyOnlyIfNeeded = false
        NSApp.activate(ignoringOtherApps: true)
        listPanel?.makeKeyAndOrderFront(nil)
        resizeList(to: list.show(.detail, ask: ask).height)
    }

    private func enterAnswerMode(for ask: Ask) {
        guard let list = ensureListPanel(), let listPanel else { return }
        listOpen = true
        listPanel.orderFrontRegardless()
        _ = list.show(.detail, ask: ask)
        guard let card = list.detailCard else { return }
        let state = focusAnswerField(panel: listPanel, card: card)
        resizeList(to: list.remeasure().height)
        log("answering \(ask.id.prefix(8)): key=\(state.key) appActive=\(state.appActive) caret=\(state.caret)")
        // AppKit decides key status again after the click that triggered this, and it can take
        // the keyboard back. Ask once more on the next turn and say what stuck.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            guard let self, listPanel === self.listPanel, list === self.listView else { return }
            if !listPanel.isKeyWindow {
                listPanel.becomesKeyOnlyIfNeeded = false
                listPanel.makeKeyAndOrderFront(nil)
                listPanel.makeKey()
                _ = card.setAnswering(true)
            }
            log("answer keyboard: key=\(listPanel.isKeyWindow) caret=\(card.isAnswerFocused)")
        }
    }

    private func leaveAnswerMode() {
        guard let list = listView, let listPanel, let card = list.detailCard else { return }
        _ = card.setAnswering(false)
        resizeList(to: list.remeasure().height)
        listPanel.resignKey()
        listPanel.becomesKeyOnlyIfNeeded = true
    }

    private var listPanel: NotchPanel?
    private var listView: NotchPanelView?
    private var listOpen = false
    private var withdrawTimer: Timer?
    private var autoExpandTimer: Timer?

    /// The only resize in the client, and it is always layer 2. The bar's window is created at
    /// its final size and left alone for the life of the process.
    private func resizeList(to height: CGFloat) {
        guard let listPanel, let base = panelFrame(for: .list, contentHeight: height) else { return }
        // With no animation. An animated frame means frames in between that do not match the
        // content, which is what left the list looking like it opened to the wrong size.
        let frame = NSRect(
            x: base.minX,
            y: base.maxY - height,
            width: base.width,
            height: max(height, 0.5)
        )
        // Clamped to exactly the counted height, the same way the width is clamped to 237. Left
        // free, the window sizes itself to its content's fitting height: the scroll view's, which
        // is 86 whatever the list holds. That was the band of black below the last row.
        listPanel.contentMinSize = NSSize(width: frame.width, height: frame.height)
        listPanel.contentMaxSize = NSSize(width: frame.width, height: frame.height)
        listPanel.setFrame(frame, display: true)
        NSLog("resizeList: asked %.1f, window %.1f -> %.1f, view before %.1f",
              height, listPanel.frame.height, frame.height, listView?.frame.height ?? -1)
        // The view keeps its full height so the drawer stays in the card's layout, and it has to
        // be the same full height every time: the card hangs inside it, so a view that is short by
        // the notch band shifts the plates down by that much. Guarded against a degenerate window,
        // which is what made an unguarded measure here collapse the panel.
        if frame.height > 100 { _ = listView?.remeasure() }
        // What the window shows of the view, set before the layout pass that draws the shape.
        listView?.visibleHeight = frame.height
        listView?.needsLayout = true
        listView?.layoutSubtreeIfNeeded()
    }

    private func hideNotch() {
        panel?.orderOut(nil)
        listPanel?.orderOut(nil)
        panel = nil
        panelView = nil
        listPanel = nil
        listView = nil
        listOpen = false
    }

}

// MARK: - headless modes

/// The value after a `--flag`, for the modes that take options.
/// The `--mode` names, for the headless renders.
func panelMode(from name: String) -> PanelMode {
    switch name {
    case "list": return .list
    case "detail": return .detail
    default: return .compact
    }
}

func value(of flag: String, in args: [String]) -> String? {
    guard let index = args.firstIndex(of: flag), index + 1 < args.count else { return nil }
    return args[index + 1]
}

/// The panel hangs from the top of the display, so growing it must push content *down*.
/// This walks the modes on a real panel and prints where each row lands on the screen.
func modeProbe() -> Never {
    _ = NSApplication.shared
    let asks = sampleAsks()
    guard let shown = presentNotch(configure: { view in view.setAsks(asks) }) else { die("no screen") }
    let screenTop = NSScreen.main?.frame.maxY ?? 0
    let report = { (label: String, rect: NSRect?) in
        guard let rect else { print("  \(label): nothing"); return }
        let onScreen = shown.panel.convertToScreen(rect)
        print(String(
            format: "  %@: row top %.0fpt below the screen top, bottom %.0fpt, h %.0f | panel h %.0f",
            label, screenTop - onScreen.maxY, screenTop - onScreen.minY, onScreen.height,
            shown.panel.frame.height
        ))
    }
    let settle = { RunLoop.current.run(until: Date().addingTimeInterval(0.4)) }
    settle()
    report("compact", shown.view.compactFrame())
    for mode in [PanelMode.list, .detail] {
        _ = shown.view.show(mode, ask: mode == .detail ? asks[0] : nil)
        if let geometry = panelFrame(for: mode, contentHeight: shown.view.remeasure().height) {
            shown.panel.setFrame(geometry, display: true)
        }
        settle()
        report(mode == .list ? "list   " : "detail ",
               mode == .list ? shown.view.firstRowFrame()
                             : shown.view.detailCard.map { $0.convert($0.bounds, to: nil) })
    }
    exit(0)
}

/// Print where the bubble and the field land, open and closed. Static end states only:
/// an animation cannot be judged from a headless run.
/// A few requests, so the headless modes have something to look at.
func sampleAsks() -> [Ask] {
    [
        Ask(json: [
            "id": "a", "title": "Fix the checkout flow",
            "message": "The total is wrong when a coupon is applied.", "risk": "low",
        ])!,
        Ask(json: [
            "id": "b", "title": "Force-push the rebased branch",
            "message": "git push --force origin main", "risk": "high",
        ])!,
        Ask(json: [
            "id": "c", "title": "Drop the legacy sessions table",
            "message": "Migration 0042 drops a table with twelve thousand rows.", "risk": "medium",
        ])!,
    ]
}

/// Where each mode puts things. Static end states only: an animation cannot be judged from
/// a headless run.
func layoutProbe() -> Never {
    _ = NSApplication.shared
    let view = NotchPanelView(topInset: 32)
    let asks = sampleAsks()
    view.setAsks(asks)
    _ = view.remeasure()
    print(view.frameReport("compact"))
    _ = view.show(.list, ask: nil)
    print(view.frameReport("list   "))
    _ = view.show(.detail, ask: asks[1])
    print(view.frameReport("detail "))
    if let card = view.detailCard {
        _ = card.setAnswering(true, animated: false)
        _ = view.remeasure()
        print(card.frameReport("field  "))
    }
    exit(0)
}

/// Show the real panel with a sample request for a few seconds. This is the same
/// presenter the live socket uses, so what it draws is what a real ask looks like.
/// Show the real panel with sample requests for a few seconds. The same view the live socket
/// uses, so hovering it here gives the same list a real request gives.
func previewCard(seconds: Double, answering: Bool, background: Bool = false) -> Never {
    _ = NSApplication.shared
    let asks = sampleAsks()
    var holder: (panel: NotchPanel, view: NotchPanelView)?
    let show = { (mode: PanelMode, ask: Ask?) in
        guard let holder else { return }
        let size = holder.view.show(mode, ask: ask)
        guard let geometry = notchGeometry(width: 460, height: size.height) else { return }
        holder.panel.setFrame(geometry.panel, display: true)
    }
    guard let shown = presentNotch(configure: { view in
        view.setAsks(asks)
        view.onHover = { inside in show(inside ? .list : .compact, nil) }
        view.onSelect = { ask in show(.detail, ask) }
        view.onAction = { _, action in print("action: \(action)") }
        view.onAnswer = { _, text in print("answer: \(text)") }
    }) else { die("no screen to put the panel on") }
    holder = shown
    if answering { show(.detail, asks[0]) }
    print("showing the notch panel for \(seconds)s")
    // Let the pop-out animation settle before reporting where it landed.
    RunLoop.current.run(until: Date().addingTimeInterval(0.5))
    let frame = shown.panel.frame
    let screenTop = NSScreen.main?.frame.maxY ?? 0
    print("settled at x \(Int(frame.minX)) y \(Int(frame.minY)), \(Int(frame.width))x\(Int(frame.height))")
    print("top edge is \(Int(screenTop - frame.maxY))pt from the top of the screen")
    if answering {
        if background {
            // Pretend something else is frontmost, which is the case that failed: the
            // human was typing in another app when they clicked the bubble.
            NSApp.deactivate()
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        }
        guard let card = shown.view.detailCard else { die("no detail view to type in") }
        let state = focusAnswerField(panel: shown.panel, card: card)
        RunLoop.current.run(until: Date().addingTimeInterval(0.4))
        print("key=\(shown.panel.isKeyWindow) appActive=\(NSApp.isActive) caret=\(card.isAnswerFocused)")
        print("handover said key=\(state.key) appActive=\(state.appActive) caret=\(state.caret)")
    }
    RunLoop.current.run(until: Date().addingTimeInterval(max(0, seconds - 1)))
    exit(0)
}

/// The bubble could not be typed into. This isolates why: the same panel, the same
/// `makeKey` call, one flag apart, and the app deliberately inactive for the second half.
/// The bubble could not be typed into. This isolates why: the same panel, the same
/// `makeKey` call, one flag apart, and the app deliberately inactive for the second half.
func keyProbe() -> Never {
    _ = NSApplication.shared
    let asks = sampleAsks()
    guard let shown = presentNotch(configure: { view in view.setAsks(asks) }) else { die("no screen") }
    _ = shown.view.show(.detail, ask: asks[0])
    if let geometry = notchGeometry(width: 460, height: shown.view.remeasure().height) {
        shown.panel.setFrame(geometry.panel, display: true)
    }
    RunLoop.current.run(until: Date().addingTimeInterval(0.6))
    guard let card = shown.view.detailCard else { die("no detail view") }
    _ = card.setAnswering(true)

    shown.panel.becomesKeyOnlyIfNeeded = true
    shown.panel.makeKey()
    print("becomesKeyOnlyIfNeeded=true  -> key=\(shown.panel.isKeyWindow) appActive=\(NSApp.isActive) caret=\(card.isAnswerFocused)")

    shown.panel.resignKey()
    NSApp.deactivate()
    RunLoop.current.run(until: Date().addingTimeInterval(0.3))
    shown.panel.becomesKeyOnlyIfNeeded = false
    shown.panel.makeKey()
    print("becomesKeyOnlyIfNeeded=false -> key=\(shown.panel.isKeyWindow) appActive=\(NSApp.isActive) caret=\(card.isAnswerFocused)")
    exit(0)
}

/// Draw the card offscreen and write it out, so the design can be looked at without
/// putting a panel over whatever the human is doing.
/// Draw one mode offscreen and write it out, so the design can be looked at without putting
/// a panel over whatever the human is doing.
func renderCard(to path: String, title: String = "", subtitle: String = "",
                meta: String? = nil, mode: PanelMode = .compact, topInset: CGFloat,
                width: CGFloat, answering: Bool = false, limited: Bool = false) {
    _ = NSApplication.shared
    // An unpaired render is the empty one: there is no workspace to have requests in, and an
    // empty ask list used to trap on asks[0] here, which is why the state could not be seen.
    let unpaired = CommandLine.arguments.contains("--unpaired")
    // The open strip, which is the state the connect line lives in.
    let stripOpen = CommandLine.arguments.contains("--open")
    var asks = unpaired ? [] : sampleAsks()
    if !title.isEmpty, !asks.isEmpty {
        asks[0] = Ask(json: ["id": "a", "title": title, "message": subtitle, "risk": "low"])!
    }
    // After the replacement above, so a custom title is limited too. Without this flag no
    // headless mode can draw the out-of-requests card, which is why it went unchecked.
    if limited { for i in asks.indices { asks[i].limited = true } }
    let view = NotchPanelView(topInset: topInset)
    if unpaired {
        view.unpairedOpen = stripOpen
        view.setUnpaired(true)
    }
    view.setAsks(asks)
    // Unpaired is always the short bar: a tall empty card is what made it look broken.
    let drawn: PanelMode = unpaired ? .compact : mode
    _ = view.show(drawn, ask: (drawn == .detail && !asks.isEmpty) ? asks[0] : nil)
    if answering, let card = view.detailCard { _ = card.setAnswering(true, animated: false) }
    let needed = view.remeasure()
    // Render the frame the panel really gets, so the waiting badge is drawn as the capsule it
    // is on screen rather than at the width of the list.
    var size = panelFrame(for: mode, contentHeight: needed.height).map { $0.size } ?? needed
    // Unpaired is one strip tall, so its height comes from the view's own state rather than
    // from the compact panel's constant, which assumes a bar with nothing to say.
    if unpaired {
        size.height = view.stateHeight
        // The shape is clipped to this, so without it the black stops at the capsule and the
        // line renders on white underneath the panel.
        view.visibleHeight = size.height
    }
    view.frame = NSRect(origin: .zero, size: size)
    view.layoutSubtreeIfNeeded()
    if unpaired {
        // After layout, not before: the shape is clipped to this, and a value set earlier was
        // being redrawn away, which left the black at the capsule height with the line on white.
        view.visibleHeight = size.height
        view.needsDisplay = true
        view.displayIfNeeded()
    }

    // A view only draws once it is in a window, so park one far off any display.
    let window = NSWindow(
        contentRect: NSRect(origin: .zero, size: size),
        styleMask: [.borderless],
        backing: .buffered,
        defer: false
    )
    window.contentView = view
    window.setFrameOrigin(NSPoint(x: -30000, y: -30000))
    window.orderFrontRegardless()
    view.layoutSubtreeIfNeeded()
    window.displayIfNeeded()

    // The drawer is in the card's layout at all times, so the view is taller than the window that
    // shows it. What is rendered is the part the window shows, which is the top of the view: the
    // window's bottom edge is the cut.
    let full = view.bounds.height
    let visible = NSRect(
        x: 0,
        y: full - min(size.height, full),
        width: size.width,
        height: min(size.height, full)
    )
    guard let rep = view.bitmapImageRepForCachingDisplay(in: visible) else {
        die("could not make a bitmap")
    }
    view.cacheDisplay(in: visible, to: rep)
    guard let data = rep.representation(using: .png, properties: [:]) else {
        die("could not encode the png")
    }
    do {
        try data.write(to: URL(fileURLWithPath: path))
    } catch {
        die("could not write \(path): \(error)")
    }
    print("rendered \(path) at \(Int(size.width))x\(Int(size.height))")
    exit(0)
}

/// Connect, decide the first pending request, print the ack, exit. This is the same
/// code path the buttons use, minus the buttons, so it can be verified from a script.
func selftest(approved: Bool, wanted: String?, answer: String?) -> Never {
    guard let config = loadConfig() else { die("not paired: run --pair first") }

    let feed = LiveFeed()
    let sem = DispatchSemaphore(value: 0)
    var acked = false
    var pendingCount = -1

    feed.onHello = { pending, workspace in
        pendingCount = pending.count
        print("hello: workspace \(workspace), \(pending.count) pending")
        for ask in pending {
            print("  - \(ask.id.prefix(8))  \(ask.title)  [\(ask.channel ?? "-")]")
        }
        let target = wanted.map { id in pending.first { $0.id.hasPrefix(id) } } ?? pending.first
        guard let target else {
            print("nothing to decide")
            sem.signal()
            return
        }
        if let answer, !answer.isEmpty {
            print("sending answer for \(target.id.prefix(8)): \(answer)")
            feed.decide(target.id, approved: false, answer: answer)
        } else {
            print("sending decision for \(target.id.prefix(8)): \(approved ? "approve" : "deny")")
            feed.decide(target.id, approved: approved)
        }
    }
    feed.onAck = { id, applied, reason in
        print("ack: \(id.prefix(8)) applied=\(applied) reason=\(reason ?? "-")")
        acked = applied
        sem.signal()
    }
    feed.onState = { state in
        print("state: \(state)")
        if state.hasPrefix("closed") || state.hasPrefix("error") { sem.signal() }
    }

    feed.connect(base: config.baseUrl, token: config.deviceToken)
    _ = sem.wait(timeout: .now() + 25)
    if pendingCount <= 0 { print("no pending request was waiting") }
    exit(acked ? 0 : 1)
}

// MARK: - entry

@main
struct PSHNotch {
    static func main() {
        var args = Array(CommandLine.arguments.dropFirst())
        var name = Host.current().localizedName ?? "psh.now device"

        if let index = args.firstIndex(of: "--name"), index + 1 < args.count {
            name = args[index + 1]
            args.removeSubrange(index...(index + 1))
        }

        if let index = args.firstIndex(of: "--config"), index + 1 < args.count {
            configPathOverride = URL(fileURLWithPath: args[index + 1])
            args.removeSubrange(index...(index + 1))
        }

        switch args.first {
        case "--handle-url":
            guard args.count > 1 else { die("usage: PSHNotch --handle-url <psh-notch://paired?...>") }
            exit(handleConnectURL(args[1]) ? 0 : 1)
        case "--unpair":
            unpair()
        case "--pair":
            guard args.count > 1 else { die("usage: PSHNotch --pair <pairing link or token>") }
            pair(args[1], name: name)
        case "--selftest":
            let approved = !args.contains("--deny")
            let wanted = args.firstIndex(of: "--prompt").flatMap { idx -> String? in
                idx + 1 < args.count ? args[idx + 1] : nil
            }
            selftest(approved: approved, wanted: wanted, answer: value(of: "--answer", in: args))
        case "--geometry":
            guard let geometry = notchGeometry() else { die("no screen") }
            print(geometry.description)
        case "--modeprobe":
            modeProbe()
        case "--layout":
            layoutProbe()
        case "--keyprobe":
            keyProbe()
        case "--states":
            Approver().runStateProbe()
        case "--menu":
            Approver().runMenuProbe()
        case "--preview":
            previewCard(
                seconds: Double(value(of: "--seconds", in: args) ?? "4") ?? 4,
                answering: args.contains("--answer"),
                background: args.contains("--background")
            )
        case "--render":
            if let corner = value(of: "--corner", in: args), let pt = Double(corner) {
                panelCornerRadius = CGFloat(pt)
            }
            renderCard(
                to: args.count > 1 ? args[1] : "notch.png",
                title: value(of: "--title", in: args) ?? "Did the psh.now test request arrive?",
                subtitle: value(of: "--message", in: args)
                    ?? "Approve to confirm the round trip works from this project, and I will carry on.",
                meta: value(of: "--meta", in: args),
                mode: panelMode(from: value(of: "--mode", in: args) ?? "compact"),
                topInset: args.contains("--no-notch") ? 0 : 32,
                width: CGFloat(Double(value(of: "--width", in: args) ?? "460") ?? 460),
                answering: args.contains("--answer"),
                limited: args.contains("--limit")
            )
        case "--help", "-h":
            print("""
            PSHNotch - approve psh.now requests from the notch or the menu bar

              --pair <link|token> [--name <label>]   claim a dashboard pairing link
              --selftest [--deny] [--prompt <id>]    headless: decide the first pending
              --geometry                             print this display's notch anchor
              --render <file.png> [--no-notch]        draw the panel offscreen and write it out
                        [--corner N] [--mode M]      ...that corner radius, mode
                        [--answer] [--limit]         ...answering, out of requests
                        [--answer]                   compact | list | detail
              --layout                              print where each mode puts things
              --modeprobe                           print where each mode's rows land on screen
              --preview [--seconds N] [--answer]     show the real panel for a moment
                        [--background]               ...with nothing else focused, as a test
              --selftest [--deny|--answer <text>]     decide the first pending request
            """)
        default:
            let app = NSApplication.shared
            let approver = Approver()
            app.delegate = approver
            app.run()
        }
    }
}
