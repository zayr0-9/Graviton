import Darwin
import Foundation

struct ToolFailure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

// Private, sequential newline JSON. The TypeScript front end owns all MCP framing and schemas.
struct HelperProtocol {
    let desktop: DesktopSession

    struct Request: Decodable {
        let app, window_id, permission, snapshot_id, key, mouse_button, direction, format, action, value, prefix, suffix, selection_type: String?
        let element_id, click_count, pages: Int?
        let x, y, from_x, from_y, to_x, to_y, duration: Double?
        let disableDiff: Bool?
        let method: String
        let screenshot: Bool?
        let snapshotId: String?
        let elementId: Int?
        let text: String?
    }

    private struct Reply: Encodable {
        var text: String? = nil
        var jpeg: String? = nil
        var error: String? = nil
    }

    func run() async {
        var line = Data()
        var overflow = false
        while true {
            let byte = getchar()
            if byte == EOF { return }
            if byte == 10 {
                let reply = overflow ? Reply(error: "Request too large.") : await handle(line)
                guard var data = try? JSONEncoder().encode(reply) else { return }
                data.append(10)
                FileHandle.standardOutput.write(data)
                line.removeAll(keepingCapacity: true)
                overflow = false
            } else if line.count < 64 * 1024 {
                line.append(UInt8(byte))
            } else {
                overflow = true
            }
        }
    }

    @MainActor private func handle(_ line: Data) async -> Reply {
        guard let request = try? JSONDecoder().decode(Request.self, from: line) else {
            return Reply(error: "Invalid helper request.")
        }
        do {
            switch request.method {
            case "status": return Reply(text: desktop.status())
            case "list_apps": return Reply(text: LocalControls.list())
            case "request_permissions": return Reply(text: try desktop.controls?.permissions(request.permission))
            case "select_app":
                guard let app = request.app else { throw ToolFailure("Missing app.") }
                try await desktop.controls?.select(app); return Reply(text: desktop.status())
            case "list_windows": return Reply(text: try desktop.windows())
            case "select_window": return Reply(text: try desktop.selectWindow(request.window_id))
            case "inspect_window", "get_app_state":
                if let app = request.app { try await desktop.controls?.select(app) }
                else if desktop.trustedURL == nil, !desktop.bundleID.isEmpty { try await desktop.controls?.select(desktop.bundleID) }
                let (text, image) = try await desktop.inspect(screenshot: request.screenshot ?? false, diff: request.method == "get_app_state" && request.disableDiff != true)
                return Reply(text: text, jpeg: image?.base64EncodedString())
            case "click", "set_text":
                guard let snapshot = request.snapshotId, let element = request.elementId, element > 0 else {
                    throw ToolFailure("Use a snapshot and element ID from inspect_window.")
                }
                if request.method == "click" {
                    try desktop.click(snapshotID: snapshot, elementID: element)
                } else {
                    guard let text = request.text, text.utf16.count <= 4000 else {
                        throw ToolFailure("Text must not exceed 4,000 UTF-16 code units.")
                    }
                    try desktop.setText(snapshotID: snapshot, elementID: element, value: text)
                }
                desktop.actionSent()
                return Reply(text: "Action completed. Inspect the window again to verify the result.")
            default:
                try await desktop.apply(request)
                desktop.actionSent()
                return Reply(text: "Action sent. Inspect again to verify.")
            }
        } catch {
            return Reply(error: error.localizedDescription)
        }
    }
}
