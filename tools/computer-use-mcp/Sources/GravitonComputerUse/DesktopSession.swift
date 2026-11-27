import AppKit
import ApplicationServices
import ScreenCaptureKit

@MainActor final class DesktopSession {
    weak var controls: LocalControls?
    var trustedURL: URL?
    var windowChoices: [String: AXUIElement] = [:]
    private var lastLines: [String] = []
    private var lastWindow: AXUIElement?
    private var settleUntil: ContinuousClock.Instant?
    func actionSent() { settleUntil = clock.now.advanced(by: .milliseconds(900)) }
    func switchTo(_ id: String, url: URL?) {
        bundleID = id; trustedURL = url; snapshot = nil; lastLines = []; lastWindow = nil; windowChoices = [:]
    }
    private struct Snapshot {
        let id: String
        let pid: pid_t
        let window: AXUIElement
        let elements: [AXUIElement]
        let frame: CGRect?
        let imageSize: CGSize?
        let expires: ContinuousClock.Instant
    }

    private(set) var bundleID: String
    private var snapshot: Snapshot?
    private let clock = ContinuousClock()

    init(bundleID: String) {
        self.bundleID = bundleID
        // Bound IPC waits, including attribute reads on child elements.
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.25)
    }

    func status() -> String {
        if controls?.stopped == true { return "Computer Use stopped. Resume from the CU menu." }
        if bundleID.isEmpty { return "No app selected. Use select_app. Accessibility: \(AXIsProcessTrusted() ? "granted" : "not granted"). Screen Recording: \(CGPreflightScreenCaptureAccess() ? "granted" : "not granted")." }
        let count = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).count
        let app = count == 1 ? "running" : count == 0 ? "not running" : "multiple instances running"
        return "App: \(bundleID) (\(app)). Accessibility: \(AXIsProcessTrusted() ? "granted" : "not granted"). Screen Recording: \(CGPreflightScreenCaptureAccess() ? "granted" : "not granted")."
    }

    func inspect(screenshot: Bool, diff: Bool = false) async throws -> (String, Data?) {
        snapshot = nil
        if let deadline = settleUntil, deadline > clock.now { try await clock.sleep(until: deadline) }
        settleUntil = nil
        let (pid, window) = try focusedWindow()
        var elements: [AXUIElement] = []
        var lines: [String] = []
        let deadline = clock.now.advanced(by: .seconds(3))
        var stack: [(AXUIElement, Int)] = [(window, 0)]
        var truncated = false
        while let (element, depth) = stack.popLast() {
            guard elements.count < 120, clock.now < deadline else {
                truncated = true
                break
            }
            // Some apps expose elements from embedded processes. Do not read those.
            var owner: pid_t = 0
            guard AXUIElementGetPid(element, &owner) == .success, owner == pid else { continue }
            elements.append(element)
            let id = elements.count
            let role = attribute(element, kAXRoleAttribute) as? String ?? "Unknown"
            let indent = String(repeating: "  ", count: depth)
            let subrole = safeSubrole(element)
            if subrole == kAXSecureTextFieldSubrole || (isTextRole(role) && subrole == nil) {
                lines.append("\(indent)\(id). \(role) [field omitted]")
                continue
            }
            let title = abbreviated(attribute(element, kAXTitleAttribute), limit: 200)
                ?? abbreviated(attribute(element, kAXDescriptionAttribute), limit: 200)
            var details = [title.map { "label=\($0)" }].compactMap { $0 }
            if let value = abbreviated(attribute(element, kAXValueAttribute), limit: 500) {
                details.append("value=\(value)")
            }
            let actions = actionNames(element)
            if !actions.isEmpty { details.append("actions=" + actions.prefix(12).joined(separator: ",")) }
            if isTextRole(role), isValueWritable(element) { details.append("text writable") }
            lines.append((["\(indent)\(id). \(role)"] + details).joined(separator: " "))
            let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
            if depth < 12 {
                truncated = truncated || children.count > 120
                for child in children.prefix(120).reversed() { stack.append((child, depth + 1)) }
            } else if !children.isEmpty {
                truncated = true
            }
        }
        let capturedBounds = screenshot ? bounds(window) : nil
        let image = screenshot ? try await capture(window: window, pid: pid) : nil
        let (currentPID, currentWindow) = try focusedWindow()
        guard currentPID == pid, CFEqual(currentWindow, window), !screenshot || (capturedBounds != nil && capturedBounds == bounds(window)) else {
            throw ToolFailure("The target window changed during inspection. Inspect again.")
        }
        let id = UUID().uuidString
        snapshot = Snapshot(id: id, pid: pid, window: window, elements: elements,
                            frame: capturedBounds, imageSize: image.flatMap { NSBitmapImageRep(data: $0) }.map { CGSize(width: $0.pixelsWide, height: $0.pixelsHigh) }, expires: clock.now.advanced(by: .seconds(120)))
        var output = lines
        if diff, let previous = lastWindow, CFEqual(previous, window), !lastLines.isEmpty {
            let old = Set(lastLines), current = Set(lines)
            output = ["Changes since last snapshot:"] + lastLines.filter { !current.contains($0) }.map { "- " + $0 } + lines.filter { !old.contains($0) }.map { "+ " + $0 }
        }
        lastLines = lines; lastWindow = window
        let summary = ["App: \(bundleID)", "snapshot_id: \(id)"] + output
        return (summary.joined(separator: "\n") + (truncated ? "\n[Accessibility output truncated]" : ""), image)
    }

    func click(snapshotID: String, elementID: Int) throws {
        let element = try actionTarget(snapshotID: snapshotID, elementID: elementID)
        guard actionNames(element).contains(kAXPressAction) else {
            throw ToolFailure("This element does not support accessibility press.")
        }
        guard AXUIElementPerformAction(element, kAXPressAction as CFString) == .success else {
            throw ToolFailure("The app did not confirm the press. Inspect again before deciding whether to retry.")
        }
    }

    func setText(snapshotID: String, elementID: Int, value: String) throws {
        let element = try actionTarget(snapshotID: snapshotID, elementID: elementID)
        guard let role = attribute(element, kAXRoleAttribute) as? String,
              isTextRole(role), isValueWritable(element) else {
            throw ToolFailure("This element is not a writable text field or text area.")
        }
        guard AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString) == .success else {
            throw ToolFailure("The app did not confirm the text change. Inspect again before deciding whether to retry.")
        }
    }

    func actionTarget(snapshotID: String, elementID: Int) throws -> AXUIElement {
        guard let selected = snapshot, selected.id == snapshotID, clock.now < selected.expires,
              elementID > 0, elementID <= selected.elements.count else {
            throw ToolFailure("Use an element ID from a fresh inspect_window snapshot.")
        }
        snapshot = nil  // Every valid action attempt consumes the snapshot, including failures.
        let (pid, window) = try focusedWindow()
        let element = selected.elements[elementID - 1]
        var owner: pid_t = 0
        guard pid == selected.pid, CFEqual(window, selected.window),
              AXUIElementGetPid(element, &owner) == .success, owner == pid,
              let elementWindow = axElement(attribute(element, kAXWindowAttribute)), CFEqual(elementWindow, window),
              let enabled = attribute(element, kAXEnabledAttribute) as? Bool, enabled else {
            throw ToolFailure("The element is no longer actionable in the configured window. Inspect again.")
        }
        guard let subrole = safeSubrole(element), subrole != kAXSecureTextFieldSubrole else {
            throw ToolFailure("Secure text fields cannot be controlled.")
        }
        return element
    }

    func focusedWindow() throws -> (pid_t, AXUIElement) {
        guard controls?.stopped == false, trustedURL != nil, !bundleID.isEmpty else { throw ToolFailure("Select an app using select_app first, or resume from the Computer Use menu if stopped.") }
        guard AXIsProcessTrusted() else {
            throw ToolFailure("Accessibility permission is required. See the helper README for macOS setup.")
        }
        let apps = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
        guard apps.count == 1, let app = apps.first, trustedURL == nil || app.bundleURL?.standardizedFileURL.resolvingSymlinksInPath() == trustedURL else {
            throw ToolFailure("Open one instance of \(bundleID) and try again. The helper never launches apps.")
        }
        let application = AXUIElementCreateApplication(app.processIdentifier)
        guard let window = axElement(attribute(application, kAXFocusedWindowAttribute)) else {
            throw ToolFailure("Open a window in \(bundleID) and try again.")
        }
        return (app.processIdentifier, window)
    }

    func bounds(_ element: AXUIElement) -> CGRect? {
        guard let p = point(attribute(element, kAXPositionAttribute)), let s = size(attribute(element, kAXSizeAttribute)) else { return nil }; return CGRect(origin: p, size: s)
    }

    func consumeInput(_ id: String?, elementID: Int?) throws -> (pid_t, AXUIElement, CGRect, CGSize?, AXUIElement?) {
        guard let s = snapshot, s.id == id, clock.now < s.expires else { throw ToolFailure("Fresh snapshot required.") }
        let (pid, win) = try focusedWindow()
        guard s.pid == pid, CFEqual(s.window, win), let frame = bounds(win), s.frame == nil || frame == s.frame else { throw ToolFailure("Window changed. Inspect again.") }
        let el = try elementID.map { try actionTarget(snapshotID: s.id, elementID: $0) }
        snapshot = nil
        return (pid, win, frame, s.imageSize, el)
    }

    private func capture(window: AXUIElement, pid: pid_t) async throws -> Data {
        guard CGPreflightScreenCaptureAccess() else {
            throw ToolFailure("Screen Recording permission is required. Retry with screenshot=false for accessibility only.")
        }
        guard let origin = point(attribute(window, kAXPositionAttribute)),
              let size = size(attribute(window, kAXSizeAttribute)), size.width > 0, size.height > 0 else {
            throw ToolFailure("Cannot identify the target window for capture. Retry with screenshot=false.")
        }
        let title = attribute(window, kAXTitleAttribute) as? String
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        let matches = content.windows.filter { candidate in
            candidate.owningApplication?.processID == pid &&
            candidate.owningApplication?.bundleIdentifier == bundleID &&
            (title == nil || title == candidate.title) &&
            abs(candidate.frame.origin.x - origin.x) < 2 && abs(candidate.frame.origin.y - origin.y) < 2 &&
            abs(candidate.frame.width - size.width) < 2 && abs(candidate.frame.height - size.height) < 2
        }
        guard matches.count == 1, let target = matches.first else {
            throw ToolFailure("Cannot uniquely match the target window for capture. Retry with screenshot=false.")
        }
        let filter = SCContentFilter(desktopIndependentWindow: target)
        let config = SCStreamConfiguration()
        let scale = min(1, 1280 / max(size.width, size.height))
        config.width = max(1, Int(size.width * scale))
        config.height = max(1, Int(size.height * scale))
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        guard let data = NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: 0.65]),
              data.count <= 512 * 1024 else {
            throw ToolFailure("The screenshot exceeded the output limit. Retry with screenshot=false.")
        }
        return data
    }

    func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var result: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success ? result : nil
    }

    // Empty means the app explicitly does not expose a subrole. A failed lookup is unknown.
    private func safeSubrole(_ element: AXUIElement) -> String? {
        var result: CFTypeRef?
        switch AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &result) {
        case .success: return result as? String
        case .attributeUnsupported, .noValue: return ""
        default: return nil
        }
    }

    func axElement(_ value: CFTypeRef?) -> AXUIElement? {
        guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return value as! AXUIElement?
    }

    private func point(_ value: CFTypeRef?) -> CGPoint? {
        guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero
        return AXValueGetValue(value as! AXValue, .cgPoint, &point) ? point : nil
    }

    private func size(_ value: CFTypeRef?) -> CGSize? {
        guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        var size = CGSize.zero
        return AXValueGetValue(value as! AXValue, .cgSize, &size) ? size : nil
    }

    private func abbreviated(_ value: CFTypeRef?, limit: Int) -> String? {
        guard let text = value as? String, !text.isEmpty else { return nil }
        return String(decoding: text.utf16.prefix(limit), as: UTF16.self).debugDescription
    }

    func actionNames(_ element: AXUIElement) -> [String] {
        var result: CFArray?
        guard AXUIElementCopyActionNames(element, &result) == .success else { return [] }
        return result as? [String] ?? []
    }

    private func isValueWritable(_ element: AXUIElement) -> Bool {
        var result = DarwinBoolean(false)
        return AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &result) == .success && result.boolValue
    }

    private func isTextRole(_ role: String) -> Bool { role == kAXTextFieldRole || role == kAXTextAreaRole }
}
