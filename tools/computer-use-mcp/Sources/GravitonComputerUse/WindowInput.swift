import AppKit
import ApplicationServices

extension DesktopSession {
    func windows() throws -> String {
        let (pid, _) = try focusedWindow(); windowChoices = [:]
        let windows = attribute(AXUIElementCreateApplication(pid), kAXWindowsAttribute) as? [AXUIElement] ?? []
        return windows.prefix(100).map { w in
            let id = UUID().uuidString; windowChoices[id] = w
            return "\(id) | \(attribute(w, kAXTitleAttribute) as? String ?? "Untitled")"
        }.joined(separator: "\n")
    }
    func selectWindow(_ id: String?) throws -> String {
        let (pid, _) = try focusedWindow()
        guard let id, let w = windowChoices[id], let ws = attribute(AXUIElementCreateApplication(pid), kAXWindowsAttribute) as? [AXUIElement], ws.contains(where: { CFEqual($0,w) }) else { throw ToolFailure("Refresh list_windows and select a returned ID.") }
        NSRunningApplication(processIdentifier: pid)?.activate()
        guard AXUIElementPerformAction(w, kAXRaiseAction as CFString) == .success else { throw ToolFailure("Cannot raise the window.") }
        _ = AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
        guard CFEqual(try focusedWindow().1, w) else { throw ToolFailure("The requested window did not become focused.") }
        return "Window selected. Inspect to verify."
    }

    func apply(_ r: HelperProtocol.Request) async throws {
        if r.method == "set_value", let id = r.snapshot_id, let el = r.element_id, let value = r.value {
            try setText(snapshotID: id, elementID: el, value: value); return
        }
        if r.method == "input_click", let el = r.element_id, let id = r.snapshot_id, r.x == nil, r.y == nil, r.key == nil,
           (r.mouse_button ?? "left") == "left", (r.click_count ?? 1) == 1, (r.duration ?? 0) == 0 {
            try click(snapshotID: id, elementID: el); return
        }
        let (pid, window, frame, pixels, el) = try consumeInput(r.snapshot_id, elementID: r.element_id)
        func live() throws {
            let (current, w) = try focusedWindow()
            guard current == pid, CFEqual(w,window), bounds(w) == frame else { throw ToolFailure("Target changed. Inspect again.") }
        }
        func point(_ x: Double?, _ y: Double?) throws -> CGPoint {
            if el != nil && (x != nil || y != nil) { throw ToolFailure("Choose either an element or coordinates, not both.") }
            if r.method == "scroll", x == nil, y == nil, el == nil { return CGPoint(x:frame.midX,y:frame.midY) }
            if x == nil && y == nil, let el, let rect = bounds(el) {
                let p = CGPoint(x: rect.midX, y: rect.midY); if frame.contains(p) { return p }
            }
            guard let x, let y, let pixels, x >= 0, y >= 0, x < pixels.width, y < pixels.height else { throw ToolFailure("Use valid coordinates from a fresh screenshot or a positioned element.") }
            return CGPoint(x: frame.minX + x * frame.width / pixels.width, y: frame.minY + y * frame.height / pixels.height)
        }
        // Events use PID-targeted delivery, never the global event tap. Require the
        // foreground window for synthetic input; AX actions do not need this step.
        func focus() async throws {
            guard let app = NSRunningApplication(processIdentifier: pid) else { throw ToolFailure("Target exited.") }
            if !app.isActive { app.activate(); try await Task.sleep(nanoseconds: 150_000_000) }
            guard app.isActive else { throw ToolFailure("Bring the target window to the front and retry.") }; try live()
        }
        switch r.method {
        case "perform_secondary_action":
            guard let el, let action = r.action, actionNames(el).contains(action), AXUIElementPerformAction(el, action as CFString) == .success else { throw ToolFailure("Unsupported or failed accessibility action.") }
        case "select_text":
            guard let el, let search = r.text, !search.isEmpty, let content = attribute(el, kAXValueAttribute) as? String else { throw ToolFailure("Element has no selectable text.") }
            let prefix = r.prefix ?? "", suffix = r.suffix ?? "", value = content as NSString, needle = prefix + search + suffix
            let found = value.range(of: needle, options: .literal)
            guard found.location != NSNotFound, value.range(of: needle, options: .literal, range: NSRange(location: found.location + 1, length: value.length-found.location-1)).location == NSNotFound else { throw ToolFailure("Text missing or ambiguous. Supply prefix/suffix.") }
            var range = CFRange(location: found.location + prefix.utf16.count, length: search.utf16.count)
            if r.selection_type == "cursor_after" { range.location += range.length }
            if ["cursor_before","cursor_after"].contains(r.selection_type ?? "") { range.length = 0 }
            guard let ax = AXValueCreate(.cfRange, &range), AXUIElementSetAttributeValue(el, kAXSelectedTextRangeAttribute as CFString, ax) == .success else { throw ToolFailure("App rejected the selection.") }
        case "press_key", "type_text", "paste":
            try await focus()
            let app = AXUIElementCreateApplication(pid)
            if let field = axElement(attribute(app, kAXFocusedUIElementAttribute)), attribute(field,kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole { throw ToolFailure("User must operate secure fields.") }
            if r.method == "press_key" { try await Keys.press(r.key ?? "", pid: pid, duration: r.duration ?? 0); return }
            guard let text = r.text, text.utf16.count <= 4000 else { throw ToolFailure("Invalid text.") }
            if r.method == "paste" { try await Keys.paste(text, format: r.format, pid: pid); return }
            for (offset, char) in text.enumerated() {
                if offset % 16 == 0 { await Task.yield(); try live() }
                if char == "\n" || char == "\r" { try await Keys.press("Return", pid: pid, duration: 0); continue }
                let units = Array(String(char).utf16)
                for down in [true,false] {
                    guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) else { throw ToolFailure("Cannot create key event.") }
                    event.flags = []; event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units); event.postToPid(pid)
                }
            }
        case "input_click", "drag", "scroll":
            try await focus()
            let start = try point(r.method == "drag" ? r.from_x : r.x, r.method == "drag" ? r.from_y : r.y)
            if r.method == "scroll" {
                let pages = r.pages ?? 1, d = r.direction ?? ""
                guard (1...10).contains(pages), ["up","down","left","right"].contains(d) else { throw ToolFailure("Invalid scroll.") }
                let horizontal = d == "left" || d == "right", extent = horizontal ? frame.width : frame.height
                let delta = Int32(min(32000, extent * 0.8 * Double(pages))) * (["up","left"].contains(d) ? 1 : -1)
                guard let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: horizontal ? 0 : delta, wheel2: horizontal ? delta : 0, wheel3: 0) else { throw ToolFailure("Cannot create scroll event.") }
                e.location = start; e.postToPid(pid); return
            }
            let button: CGMouseButton = r.mouse_button == "right" ? .right : r.mouse_button == "middle" ? .center : .left
            let down: CGEventType = button == .right ? .rightMouseDown : button == .center ? .otherMouseDown : .leftMouseDown
            let up: CGEventType = button == .right ? .rightMouseUp : button == .center ? .otherMouseUp : .leftMouseUp
            let flags = try Keys.flags(r.key ?? "")
            func mouse(_ kind: CGEventType, _ p: CGPoint, _ count: Int) throws {
                guard let e = CGEvent(mouseEventSource: nil, mouseType: kind, mouseCursorPosition: p, mouseButton: button) else { throw ToolFailure("Cannot create mouse event.") }
                e.setIntegerValueField(.mouseEventClickState, value: Int64(count)); e.flags = flags; e.postToPid(pid)
            }
            if r.method == "drag" {
                let end = try point(r.to_x, r.to_y); var last = start
                try mouse(down, start, 1); defer { try? mouse(up,last,1) }
                for i in 1...12 { try await Task.sleep(nanoseconds: 12_000_000); try live(); last = CGPoint(x:start.x+(end.x-start.x)*Double(i)/12,y:start.y+(end.y-start.y)*Double(i)/12); try mouse(.leftMouseDragged,last,1) }
            } else {
                let count = r.click_count ?? 1, hold = r.duration ?? 0
                guard (1...3).contains(count), (0...2).contains(hold) else { throw ToolFailure("Invalid click count or duration.") }
                for i in 1...count { try live(); try mouse(down,start,i); defer { try? mouse(up,start,i) }; try await Task.sleep(nanoseconds: UInt64(max(0.025, hold)*1e9)) }
            }
        default: throw ToolFailure("Unknown helper method.")
        }
    }
}
