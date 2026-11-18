import AppKit

@MainActor enum Keys {
    static let codes: [String: CGKeyCode] = ["a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"equal":24,"9":25,"7":26,"minus":27,"8":28,"0":29,"bracketright":30,"o":31,"u":32,"bracketleft":33,"i":34,"p":35,"return":36,"enter":36,"l":37,"j":38,"apostrophe":39,"k":40,"semicolon":41,"backslash":42,"comma":43,"slash":44,"n":45,"m":46,"period":47,"tab":48,"space":49,"grave":50,"backspace":51,"escape":53,"esc":53,"kp_0":82,"kp_1":83,"kp_2":84,"kp_3":85,"kp_4":86,"kp_5":87,"kp_6":88,"kp_7":89,"kp_8":91,"kp_9":92,"kp_enter":76,"home":115,"end":119,"page_up":116,"page_down":121,"pageup":116,"pagedown":121,"delete":117,"left":123,"right":124,"down":125,"up":126,"f1":122,"f2":120,"f3":99,"f4":118,"f5":96,"f6":97,"f7":98,"f8":100,"f9":101,"f10":109,"f11":103,"f12":111]
    static func flags(_ chord: String) throws -> CGEventFlags {
        var flags: CGEventFlags = []
        for part in chord.lowercased().split(separator: "+") {
            switch part { case "cmd","command","super","super_l","meta": flags.insert(.maskCommand)
            case "ctrl","control","control_l": flags.insert(.maskControl)
            case "shift","shift_l": flags.insert(.maskShift)
            case "alt","alt_l","option": flags.insert(.maskAlternate)
            default: throw ToolFailure("Unsupported modifier: \(part)") }
        }; return flags
    }
    static func press(_ chord: String, pid: pid_t, duration: Double) async throws {
        let parts = chord.lowercased().split(separator: "+"); guard let key = parts.last.flatMap({ codes[String($0)] }), (0...2).contains(duration) else { throw ToolFailure("Unsupported key chord or hold time.") }
        let modifiers = try flags(parts.dropLast().joined(separator: "+"))
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: true), let up = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false) else { throw ToolFailure("Cannot create key events.") }
        down.flags = modifiers; up.flags = modifiers; down.postToPid(pid); defer { up.postToPid(pid) }; if duration > 0 { try await Task.sleep(nanoseconds: UInt64(duration * 1e9)) }
    }
    static func paste(_ text: String, format: String?, pid: pid_t) async throws {
        let board = NSPasteboard.general
        let previous = try (board.pasteboardItems ?? []).map { item -> NSPasteboardItem in
            let copy = NSPasteboardItem(); for type in item.types {
                guard let bytes = item.data(forType: type), copy.setData(bytes, forType: type) else { throw ToolFailure("Cannot preserve the current clipboard; paste cancelled.") }
            }; return copy
        }
        let payload = NSPasteboardItem(); payload.setString(text, forType: .string)
        switch format {
        case "text": break
        case "html": payload.setString(text, forType: .html)
        case "md":
            payload.setString(text, forType: NSPasteboard.PasteboardType("net.daringfireball.markdown"))
            let styled = try AttributedString(markdown: text); let attr = NSAttributedString(styled)
            payload.setData(try attr.data(from: NSRange(location: 0,length: attr.length), documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf]), forType: .rtf)
        default: throw ToolFailure("Unknown paste format.")
        }
        board.clearContents(); let wrote = board.writeObjects([payload]); let revision = board.changeCount
        defer { if board.changeCount == revision { board.clearContents(); if !previous.isEmpty { board.writeObjects(previous) } } }
        guard wrote else { throw ToolFailure("Pasteboard write failed.") }
        try await press("super+v", pid: pid, duration: 0); try await Task.sleep(nanoseconds: 350_000_000)
    }
}
