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

let configURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(".config/psh-notch/device.json")

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

// MARK: - the websocket feed

final class LiveFeed: NSObject {
    private var task: URLSessionWebSocketTask?
    private var session: URLSession!
    private let lock = NSLock()

    var onHello: (([Ask], String) -> Void)?
    var onCreated: ((Ask) -> Void)?
    var onDecided: ((String) -> Void)?
    var onAck: ((String, Bool) -> Void)?
    var onState: ((String) -> Void)?

    override init() {
        super.init()
        session = URLSession(configuration: .default)
    }

    func connect(base: String, token: String) {
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
            case .success(let message):
                switch message {
                case .string(let text): self.handle(text)
                case .data(let data): self.handle(String(decoding: data, as: UTF8.self))
                @unknown default: break
                }
                self.receive()
            }
        }
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
                onAck?(id, (json["applied"] as? Bool) ?? false)
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
func panelFrame(for mode: PanelMode, contentHeight: CGFloat, capsule: CGFloat = capsuleWidth) -> NSRect? {
    guard let screen = notchGeometry(width: 460, height: max(contentHeight, 1)) else { return nil }
    let cutout = screen.cutout
    if mode == .compact {
        let width = cutout.width + 2 * (capsule + capsuleGap)
        return NSRect(
            x: cutout.midX - width / 2,
            y: screen.frame.maxY - (capsuleHeight + capsulePadding),
            width: width,
            height: capsuleHeight + capsulePadding
        )
    }
    // The list and the full request: centred under the notch, growing down, and no wider than
    // the content needs. Its top band still covers where the capsules were, so the pointer that
    // opened it is inside it.
    // Exactly the waiting band's width, so the widget never widens: only its height changes.
    let width = cutout.width + 2 * (capsule + capsuleGap)
    // The same x and width as the waiting bar, and one fixed height for every state.
    return NSRect(
        x: cutout.midX - width / 2,
        y: screen.frame.maxY - canvasHeight,
        width: width,
        height: canvasHeight
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
    private let ringed: Bool
    private let ring = CAShapeLayer()
    private let fill = CAShapeLayer()

    init(_ action: CardAction) {
        cardAction = action
        let symbol: String
        switch action {
        case .deny:
            symbol = "hand.thumbsdown"
            accent = NSColor(srgbRed: 0.96, green: 0.34, blue: 0.33, alpha: 1)
            ringed = true
        case .answer:
            symbol = "bubble.left"
            accent = NSColor(srgbRed: 0.60, green: 0.60, blue: 0.63, alpha: 1)
            ringed = false
        case .approve:
            symbol = "hand.thumbsup"
            accent = NSColor(srgbRed: 0.30, green: 0.88, blue: 0.57, alpha: 1)
            ringed = true
        }
        super.init(frame: .zero)
        isBordered = false
        bezelStyle = .regularSquare
        imagePosition = .imageOnly
        focusRingType = .none
        (image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(
                pointSize: action == .answer ? 21 : 17, weight: .semibold)))
        image?.isTemplate = true
        contentTintColor = accent
        wantsLayer = true
        translatesAutoresizingMaskIntoConstraints = false
        // Drawn as a real circle path, not a corner radius: a radius follows the
        // layer's bounds, so any height the button picks up turns the ring into a
        // rounded square on screen.
        if ringed {
            layer?.addSublayer(fill)
            layer?.addSublayer(ring)
            ring.strokeColor = accent.withAlphaComponent(0.75).cgColor
            ring.fillColor = NSColor.clear.cgColor
            ring.lineWidth = 1.5
            fill.fillColor = NSColor.clear.cgColor
        }
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: 36),
            heightAnchor.constraint(equalToConstant: 36),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func circlePath() -> CGPath {
        let side = min(bounds.width, bounds.height) - 1.5
        return CGPath(ellipseIn: CGRect(
            x: bounds.midX - side / 2,
            y: bounds.midY - side / 2,
            width: side,
            height: side
        ), transform: nil)
    }

    override func layout() {
        super.layout()
        guard ringed else { return }
        ring.path = circlePath()
        ring.frame = bounds
        fill.path = circlePath()
        fill.frame = bounds
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

    private func hover(_ on: Bool) {
        contentTintColor = on ? (accent.blended(withFraction: 0.3, of: .white) ?? accent) : accent
        guard ringed else { return }
        ring.strokeColor = accent.withAlphaComponent(on ? 1 : 0.75).cgColor
        fill.fillColor = accent.withAlphaComponent(on ? 0.16 : 0).cgColor
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

        addSubview(dot)
        addSubview(count)
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
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func show(_ ask: Ask, waiting: Int) {
        dot.layer?.backgroundColor = riskColor(ask).cgColor
        count.stringValue = waiting > 0 ? "\(waiting)" : ""
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
        let path = CGMutablePath()
        if isLast {
            addBottomRounded(path, in: bounds, r: panelCornerRadius)
        } else {
            path.addRect(bounds)
        }
        highlight.frame = bounds
        highlight.path = path
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

/// The bar the three actions sit in. It is black like the card, so the panel is one flat
/// black shape and only the icons read as separate objects. It was rgb(19,19,20), which was
/// visible as a grey band against the card's rgb(0,0,0) on a real screen.
final class PillView: NSView {
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.cgColor
        layer?.cornerRadius = 32
        translatesAutoresizingMaskIntoConstraints = false
    }
    required init?(coder: NSCoder) { fatalError("not used") }
}

/// Title, subtitle, then the pill. `topInset` is the notch: the card's top strip sits
/// behind the physical cutout, so the text starts below it.
final class NotchCardView: NSView, NSTextFieldDelegate {
    var onAction: ((CardAction) -> Void)?
    var onAnswer: ((String) -> Void)?
    /// True while the field is open. Nothing may take the panel away from someone typing.
    private(set) var isAnswering = false
    var onCancelAnswer: (() -> Void)?
    private let answerField = NSTextField()
    private let sendButton = NSButton()
    private var answerAction: ActionButton?
    private var denyAction: ActionButton?
    private var approveAction: ActionButton?
    private var row: NSStackView?

    init(title: String, subtitle: String, meta: String?, topInset: CGFloat) {
        super.init(frame: NSRect(x: 0, y: 0, width: 460, height: 0))
        wantsLayer = true
        // No shape of its own: the panel draws the black background, this is only content.
        layer?.backgroundColor = NSColor.clear.cgColor

        let metaLabel = NSTextField(labelWithString: meta ?? "")
        metaLabel.font = .systemFont(ofSize: 10, weight: .medium)
        metaLabel.textColor = NSColor.white.withAlphaComponent(0.40)
        metaLabel.alignment = .left
        metaLabel.isHidden = (meta ?? "").isEmpty

        let titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = .systemFont(ofSize: 11, weight: .semibold)
        titleLabel.textColor = .white
        titleLabel.alignment = .left
        titleLabel.lineBreakMode = .byTruncatingTail

        let subtitleLabel = NSTextField(wrappingLabelWithString: subtitle)
        subtitleLabel.font = .systemFont(ofSize: 12)
        subtitleLabel.textColor = NSColor.white.withAlphaComponent(0.62)
        subtitleLabel.alignment = .left
        subtitleLabel.maximumNumberOfLines = 2
        // Wrap rather than clip: the subtitle is the sentence the human decides on.
        subtitleLabel.lineBreakMode = .byWordWrapping

        let pill = PillView(frame: .zero)
        let answerButton = ActionButton(.answer)
        let denyButton = ActionButton(.deny)
        let approveButton = ActionButton(.approve)
        answerAction = answerButton
        denyAction = denyButton
        approveAction = approveButton
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
        answerField.isHidden = true
        answerField.alphaValue = 0

        let row = NSStackView(views: [denyButton, answerButton, approveButton, answerField, sendButton])
        row.orientation = .horizontal
        row.distribution = .equalSpacing
        row.translatesAutoresizingMaskIntoConstraints = false
        self.row = row
        pill.addSubview(row)

        answerField.placeholderString = "Type your answer or clarification for the agent..."
        answerField.font = .systemFont(ofSize: 14)
        answerField.textColor = .white
        // Black fill with a hairline edge: the field has to be findable on a black panel,
        // and anything lighter than the panel is exactly the grey band that was removed.
        answerField.backgroundColor = .black
        answerField.wantsLayer = true
        answerField.layer?.borderWidth = 1
        answerField.layer?.borderColor = NSColor.white.withAlphaComponent(0.18).cgColor
        answerField.drawsBackground = true
        answerField.isBezeled = false
        answerField.focusRingType = .none
        answerField.wantsLayer = true
        answerField.layer?.cornerRadius = 9
        answerField.delegate = self
        answerField.target = self
        answerField.action = #selector(submitAnswer)

        // A grey circle with a white arrow: the end of the field says what it does.
        sendButton.isBordered = false
        sendButton.bezelStyle = .regularSquare
        sendButton.imagePosition = .imageOnly
        sendButton.focusRingType = .none
        sendButton.wantsLayer = true
        sendButton.layer?.cornerRadius = 15
        sendButton.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.18).cgColor
        (sendButton.image = NSImage(systemSymbolName: "arrow.up", accessibilityDescription: nil)?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 10, weight: .bold)))
        sendButton.image?.isTemplate = true
        sendButton.contentTintColor = .white
        sendButton.toolTip = "Send the answer"
        sendButton.target = self
        sendButton.action = #selector(submitAnswer)
        sendButton.isHidden = true
        sendButton.translatesAutoresizingMaskIntoConstraints = false
        let column = NSStackView(views: [metaLabel, titleLabel, subtitleLabel, pill])
        column.orientation = .vertical
        // Left, like the waiting line and the list: the panel reads as the same object in
        // every state instead of re-centring itself when a request is opened.
        column.alignment = .leading
        column.spacing = 8
        column.setCustomSpacing(16, after: subtitleLabel)
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)

        NSLayoutConstraint.activate([
            column.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 20),
            column.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -20),
            column.topAnchor.constraint(equalTo: topAnchor, constant: topInset + 14),
            column.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -18),
            titleLabel.leadingAnchor.constraint(equalTo: column.leadingAnchor),
            titleLabel.trailingAnchor.constraint(equalTo: column.trailingAnchor),
            subtitleLabel.leadingAnchor.constraint(equalTo: column.leadingAnchor),
            subtitleLabel.trailingAnchor.constraint(equalTo: column.trailingAnchor),
            pill.leadingAnchor.constraint(equalTo: column.leadingAnchor),
            pill.trailingAnchor.constraint(equalTo: column.trailingAnchor),
            pill.heightAnchor.constraint(equalToConstant: 64),
            answerField.heightAnchor.constraint(equalToConstant: 30),
            sendButton.widthAnchor.constraint(equalToConstant: 30),
            sendButton.heightAnchor.constraint(equalToConstant: 30),
            row.leadingAnchor.constraint(equalTo: pill.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: pill.trailingAnchor),
            row.centerYAnchor.constraint(equalTo: pill.centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    @objc private func tapped(_ sender: ActionButton) {
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
    func clickAnswer() { answerAction?.performClick(nil) }

    /// Open or close the field inside the pill. The bubble is already where it should be;
    /// the two verdicts step aside and the field comes in beside the bubble, animated, and
    /// the card does not change height at all.
    @discardableResult
    func setAnswering(_ on: Bool, animated: Bool = true) -> NSSize {
        isAnswering = on
        let apply = {
            self.row?.distribution = on ? .fill : .equalSpacing
            self.row?.spacing = on ? 10 : 0
            self.answerField.isHidden = !on
            self.sendButton.isHidden = !on
            self.denyAction?.isHidden = on
            self.approveAction?.isHidden = on
            self.answerField.alphaValue = on ? 1 : 0
            self.denyAction?.alphaValue = on ? 0 : 1
            self.approveAction?.alphaValue = on ? 0 : 1
            self.layoutSubtreeIfNeeded()
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

    /// Where the pieces actually landed, for checking the inline layout without a screen.
    func frameReport(_ label: String) -> String {
        let box = { (view: NSView?) -> String in
            guard let view, !view.isHidden else { return "hidden" }
            return String(format: "x %.0f w %.0f", view.frame.minX, view.frame.width)
        }
        return "\(label): bubble \(box(answerAction)) | field \(box(answerField)) | deny \(box(denyAction)) | approve \(box(approveAction))"
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
        let height = fittingSize.height
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
        level = .statusBar
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        hidesOnDeactivate = false
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
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// Build (or reuse) the notch panel for an ask and grow it out of the notch. The app and
/// `--preview` both go through here, so the preview is the real panel and not a mock.
func presentNotch(configure: (NotchPanelView) -> Void) -> (panel: NotchPanel, view: NotchPanelView)? {
    guard let screen = notchGeometry(width: 460, height: 0) else { return nil }
    let view = NotchPanelView(topInset: screen.cutout.height)
    configure(view)
    let size = view.remeasure()
    guard let target = panelFrame(for: .compact, contentHeight: size.height) else { return nil }

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
    panel.setFrame(collapsed, display: false)
    panel.orderFrontRegardless()
    NSAnimationContext.runAnimationGroup { context in
        context.duration = 0.26
        context.timingFunction = CAMediaTimingFunction(name: .easeOut)
        // The width is clamped, not requested: autolayout sizes a borderless window to fit
        // its content, which grew the bar rightward (26pt of overhang on the left, 61 on the
        // right). A content-size clamp cannot be overridden by a fitting pass.
        panel.contentMinSize = NSSize(width: target.width, height: 1)
        panel.contentMaxSize = NSSize(width: target.width, height: 4_000)
        panel.animator().setFrame(target, display: true)
    }
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
    var onSelect: ((Ask) -> Void)?
    var onAction: ((Ask, CardAction) -> Void)?
    var onAnswer: ((Ask, String) -> Void)?
    var onCancelAnswer: (() -> Void)?
    var onHover: ((Bool) -> Void)?

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
                equalToConstant: geometry.cutout.width + 2 * (capsuleWidth + capsuleGap)
            ).isActive = true
        } else {
                widthAnchor.constraint(equalTo: host.widthAnchor).isActive = true
        }
        // And it tracks the window's height, so it is laid out again on every frame of the
        // animation and the black is repainted at the size the window actually has. Setting
        // the height once left the shape stale while the window moved around it, which is the
        // transparency that shows up when opening and closing quickly. The content keeps its
        // own height and is simply clipped by the window's edge as it grows.
        // The canvas height, not the host's: the host is sized by the content, so mirroring it
        // let the content size the window. A fixed canvas is what keeps the window still.
        heightAnchor.constraint(equalToConstant: canvasHeight).isActive = true
        // And pinned to the top of it. Left to a manually-set origin the view's top drifts
        // above the window as it shrinks, which lifts the dot and the count off the screen and
        // brings them back on the next layout pass.
        topAnchor.constraint(equalTo: host.topAnchor).isActive = true
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
        super.layout()
        let b = bounds
        // Never clamped to the view's bounds. While the window catches up the bounds are
        // still the last mode's, and clamping to them left the list with a black strip only
        // behind its first row. A shape layer does not clip its path, so the full height is
        // drawn and the window reveals it as it grows.
        // The taller of the content and the window, and always anchored at the top. Sizing it
        // to the content alone left the window bare while it caught up; sizing it to the window
        // alone left the list bare when the content ran ahead. Taking both means there is no
        // state, mid-movement or settled, in which part of the panel is transparent.
        // The height of the state being shown, never the window's: the canvas is deliberately
        // taller than the black, and the black is the thing that animates.
        let shape = shapeHeight > 0 ? min(shapeHeight, b.height) : b.height
        let path = CGMutablePath()
        if mode == .compact {
            // Two capsules either side of the notch, flush with the top of the display and
            // round only underneath, the way the notch's own chin is.
            // One bar from the colour to the number, filled right across, rather than two
            // separate capsules with a gap: the notch sits in the middle of it anyway, so a
            // single filled shape is what reads as consistent.
            // Its own height, not the content's: the badges no longer contribute to it.
            let tall = capsuleHeight + capsulePadding
            addBottomRounded(
                path,
                in: NSRect(x: b.minX, y: b.maxY - tall, width: b.width, height: tall),
                r: panelCornerRadius
            )
            background.frame = bounds
            background.path = path
            return
        }
        addBottomRounded(
            path,
            in: NSRect(x: b.minX, y: b.maxY - shape, width: b.width, height: shape),
            r: panelCornerRadius
        )
        background.frame = bounds
        background.path = path
    }

    func setAsks(_ asks: [Ask]) {
        self.asks = asks
        if let newest = asks.first { compactRow.show(newest, waiting: asks.count) }
        for view in listStack.arrangedSubviews {
            listStack.removeArrangedSubview(view)
            view.removeFromSuperview()
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
        let rows = min(asks.count, maxVisibleRows)
        listHeight.constant = CGFloat(rows) * 40
        listScroll.hasVerticalScroller = asks.count > maxVisibleRows
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
        switch mode {
        case .compact:
            compactRow.isHidden = false
            listStack.isHidden = true
        case .list:
            compactRow.isHidden = false
            listStack.isHidden = false
        case .detail:
            compactRow.isHidden = false
            listStack.isHidden = true
            if let ask { buildDetail(ask) }
        }
        return remeasure()
    }

    /// The size the panel wants at this width, for whatever mode it is in.
    func remeasure() -> NSSize {
        let width = superview?.bounds.width ?? (frame.width > 0 ? frame.width : 460)
        // The view hangs from the top of the host, never from its bottom. An origin of zero
        // put the content above the window while the window was still short, which is what
        // landed the first list row 44pt above the top of the display, under the notch.
        let top = superview?.bounds.maxY ?? frame.maxY
        frame = NSRect(x: frame.minX, y: top - frame.height, width: width, height: frame.height)
        layoutSubtreeIfNeeded()
        let needed = fittingSize.height
        // Never shorter than the host, so the black shape keeps covering the window while
        // the window animates; the caller resizes the window to `needed`. The shape is a
        // layer path, so it only moves smoothly inside an implicit-animation context: the
        // path change animates with the window frame instead of snapping a size ahead of it.
        let height = max(needed, superview?.bounds.height ?? 0)
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.3
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            context.allowsImplicitAnimation = true
            shapeHeight = needed
            // Redraw in this same pass: without it a frame can be drawn between the mode
            // switch and the new height, which is the case that only showed up sometimes.
            needsLayout = true
            frame = NSRect(x: frame.minX, y: top - height, width: width, height: height)
            layoutSubtreeIfNeeded()
        }
        return NSSize(width: width, height: needed)
    }

    private func buildDetail(_ ask: Ask) {
        let card = NotchCardView(title: ask.title, subtitle: ask.message, meta: nil, topInset: 0)
        card.onAction = { [weak self] action in self?.onAction?(ask, action) }
        card.onAnswer = { [weak self] text in self?.onAnswer?(ask, text) }
        card.onCancelAnswer = { [weak self] in self?.onCancelAnswer?() }
        card.translatesAutoresizingMaskIntoConstraints = false
        content.addArrangedSubview(card)
        card.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
        detailCard = card
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
    private let feed = LiveFeed()
    private var statusItem: NSStatusItem!
    private var panel: NotchPanel?
    private var panelView: NotchPanelView?
    private var asks: [Ask] = []
    private var connected = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        guard let config = loadConfig() else {
            die("not paired yet. Run: PSHNotch --pair <dashboard pairing link>")
        }

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
                self?.asks = pending
                self?.refreshTitle()
                log("on \(workspace), \(pending.count) waiting")
                if !pending.isEmpty { self?.showNotch(for: pending[0]) }
            }
        }
        feed.onCreated = { [weak self] ask in
            DispatchQueue.main.async {
                guard let self else { return }
                self.asks.removeAll { $0.id == ask.id }
                self.asks.insert(ask, at: 0)
                self.refreshTitle()
                self.showNotch(for: ask)
                log("new request: \(ask.title)")
                NSSound(named: "Ping")?.play()
            }
        }
        feed.onDecided = { [weak self] id in
            DispatchQueue.main.async {
                guard let self else { return }
                self.asks.removeAll { $0.id == id }
                self.refreshTitle()
                log("decided elsewhere: \(id.prefix(8))")
                if let next = self.asks.first { self.showNotch(for: next) } else if let view = self.panelView {
                    self.resizePanel(to: view.show(.compact, ask: nil).height)
                }
            }
        }
        feed.onAck = { [weak self] id, applied in
            DispatchQueue.main.async {
                guard let self else { return }
                if applied { self.asks.removeAll { $0.id == id } }
                log("decision \(id.prefix(8)) applied=\(applied)")
                self.refreshTitle()
                // More than one request can be waiting: move to the next instead of
                // leaving the card for the one that was just answered on screen.
                if let next = self.asks.first { self.showNotch(for: next) } else if let view = self.panelView {
                    self.resizePanel(to: view.show(.compact, ask: nil).height)
                }
            }
        }
        feed.connect(base: config.baseUrl, token: config.deviceToken)
    }

    private func refreshTitle() {
        let pending = asks.count
        // Always the name. A count here spelled "psh 2" and read as a version, not a
        // number of requests; the count lives in the tooltip and in the notch itself.
        statusItem?.button?.title = "psh notch"
        statusItem?.button?.toolTip = connected
            ? "psh.now: \(pending) waiting"
            : "psh.now: reconnecting"
    }

    // MARK: menu

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        menu.addItem(withTitle: connected ? "Live" : "Reconnecting…", action: nil, keyEquivalent: "")
        menu.addItem(.separator())
        if asks.isEmpty {
            menu.addItem(withTitle: "Nothing waiting", action: nil, keyEquivalent: "")
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
        menu.addItem(withTitle: "Open dashboard", action: #selector(openDashboard), keyEquivalent: "").target = self
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
        asks.removeAll { $0.id == ask.id }
        refreshTitle()
        guard let view = panelView else { return }
        guard asks.first != nil else {
            // On means on: with nothing waiting the bar stays, empty and full width, so the
            // notch is never blank. It is only ever blank when the client is not running.
            resizePanel(to: view.show(.compact, ask: nil).height)
            return
        }
        view.setAsks(asks)
        resizePanel(to: view.show(view.hovering ? .list : .compact, ask: nil).height)
        // A request arriving opens the list by itself, then it goes back. Hover always wins:
        // if the pointer is on it, it stays open for as long as they are looking at it.
        if asks.count > autoExpandLastCount {
            resizePanel(to: view.show(.list, ask: nil).height)
            autoExpandTimer?.invalidate()
            let timer = Timer(timeInterval: 5, repeats: false) { [weak self, weak view] _ in
                guard let self, let view, !view.hovering else { return }
                self.resizePanel(to: view.show(.compact, ask: nil).height)
            }
            RunLoop.main.add(timer, forMode: .common)
            autoExpandTimer = timer
        }
        autoExpandLastCount = asks.count
    }

    // MARK: notch panel

    private func showNotch(for ask: Ask) {
        guard let view = ensurePanel() else { return }
        view.setAsks(asks)
        // A request that arrives mid-sentence joins the list behind the field; it does not
        // take the keyboard away.
        if view.detailCard?.isAnswering == true { return }
        // Waiting requests are one quiet line; the pointer opens the list.
        resizePanel(to: view.show(view.hovering ? .list : .compact, ask: nil).height)
    }

    private func ensurePanel() -> NotchPanelView? {
        if let panelView { return panelView }
        guard let created = presentNotch(configure: { [weak self] view in
            view.onSelect = { [weak self] ask in self?.showDetail(ask) }
            view.onAction = { [weak self] ask, action in
                guard let self else { return }
                switch action {
                case .approve: self.decide(ask, approved: true, answer: nil)
                case .deny: self.decide(ask, approved: false, answer: nil)
                case .answer: self.enterAnswerMode(for: ask)
                }
            }
            view.onAnswer = { [weak self] ask, text in
                self?.decide(ask, approved: false, answer: text)
            }
            view.onCancelAnswer = { [weak self] in self?.leaveAnswerMode() }
            view.onHover = { [weak self] inside in self?.hoverChanged(inside) }
        }) else { return nil }
        panel = created.panel
        panelView = created.view
        return created.view
    }

    /// Under the pointer the line becomes the list; away from it, back to the line.
    private func hoverChanged(_ inside: Bool) {
        guard let view = panelView else { return }
        // Leaving the notch goes back to the waiting state even from the answer field, and it
        // gives the keyboard back: a half-written answer is dropped rather than held while the
        // pointer is somewhere else.
        if !inside, view.detailCard?.isAnswering == true { leaveAnswerMode() }
        resizePanel(to: view.show(inside ? .list : .compact, ask: nil).height)
    }

    private func showDetail(_ ask: Ask) {
        guard let view = panelView else { return }
        resizePanel(to: view.show(.detail, ask: ask).height)
    }

    private func enterAnswerMode(for ask: Ask) {
        guard let view = panelView, let panel else { return }
        _ = view.show(.detail, ask: ask)
        guard let card = view.detailCard else { return }
        let state = focusAnswerField(panel: panel, card: card)
        resizePanel(to: view.remeasure().height)
        log("inline layout: \(card.frameReport("answering"))")
        log("answering \(ask.id.prefix(8)): key=\(state.key) appActive=\(state.appActive) caret=\(state.caret)")
        // AppKit decides key status again after the click that triggered this, and it can
        // take the keyboard back. Ask once more on the next turn and say what stuck, so
        // the next attempt is judged by the log rather than by guessing.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            guard let self, panel === self.panel, view === self.panelView else { return }
            if !panel.isKeyWindow {
                panel.becomesKeyOnlyIfNeeded = false
                panel.makeKeyAndOrderFront(nil)
                panel.makeKey()
                _ = card.setAnswering(true)
            }
            log("answer keyboard: key=\(panel.isKeyWindow) caret=\(card.isAnswerFocused)")
        }
    }

    private func leaveAnswerMode() {
        guard let view = panelView, let panel, let card = view.detailCard else { return }
        _ = card.setAnswering(false)
        resizePanel(to: view.remeasure().height)
        panel.resignKey()
        // Back to never asking for the keyboard until the bubble is used.
        panel.becomesKeyOnlyIfNeeded = true
    }

    private var autoExpandTimer: Timer?
    private var autoExpandLastCount = 0

    private func resizePanel(to height: CGFloat) {
        guard let panel, let view = panelView,
              let target = panelFrame(for: view.mode, contentHeight: height) else { return }
        // `setFrame(_:display:animate:)` instead of the animator proxy: on a borderless panel
        // the proxy snapped the frame straight to its new size, which is exactly what opening
        // and closing felt like. The shape morphs alongside it through the implicit animation
        // context in `remeasure`.
        // Through the animator proxy, so the duration is mine to choose:
        // `setFrame(_:display:animate:)` uses a fixed and much shorter one, which is why the
        // rows arrived in a blink.
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.3
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            context.allowsImplicitAnimation = true
            // The width is clamped, not requested: autolayout sizes a borderless window to fit
        // its content, which grew the bar rightward (26pt of overhang on the left, 61 on the
        // right). A content-size clamp cannot be overridden by a fitting pass.
        panel.contentMinSize = NSSize(width: target.width, height: 1)
        panel.contentMaxSize = NSSize(width: target.width, height: 4_000)
        panel.animator().setFrame(target, display: true)
        }
        view.needsLayout = true
        view.layoutSubtreeIfNeeded()
    }

    private func hideNotch() {
        panel?.orderOut(nil)
        panel = nil
        panelView = nil
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
                width: CGFloat, answering: Bool = false) {
    _ = NSApplication.shared
    var asks = sampleAsks()
    if !title.isEmpty {
        asks[0] = Ask(json: ["id": "a", "title": title, "message": subtitle, "risk": "low"])!
    }
    let view = NotchPanelView(topInset: topInset)
    view.setAsks(asks)
    _ = view.show(mode, ask: mode == .detail ? asks[0] : nil)
    if answering, let card = view.detailCard { _ = card.setAnswering(true, animated: false) }
    let needed = view.remeasure()
    // Render the frame the panel really gets, so the waiting badge is drawn as the capsule it
    // is on screen rather than at the width of the list.
    let size = panelFrame(for: mode, contentHeight: needed.height).map { $0.size } ?? needed
    view.frame = NSRect(origin: .zero, size: size)
    view.layoutSubtreeIfNeeded()

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

    guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
        die("could not make a bitmap")
    }
    view.cacheDisplay(in: view.bounds, to: rep)
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
    feed.onAck = { id, applied in
        print("ack: \(id.prefix(8)) applied=\(applied)")
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

        switch args.first {
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
                width: 460,
                answering: args.contains("--answer")
            )
        case "--help", "-h":
            print("""
            PSHNotch - approve psh.now requests from the notch or the menu bar

              --pair <link|token> [--name <label>]   claim a dashboard pairing link
              --selftest [--deny] [--prompt <id>]    headless: decide the first pending
              --geometry                             print this display's notch anchor
              --render <file.png> [--no-notch]        draw the panel offscreen and write it out
                        [--corner N] [--mode M]      ...that corner radius, mode
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
