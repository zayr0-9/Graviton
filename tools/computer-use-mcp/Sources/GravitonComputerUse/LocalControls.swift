import AppKit
import ApplicationServices

/// All prompts and consent changes originate in the user's GUI, never in MCP data.
@MainActor final class LocalControls: NSObject {
    unowned let desktop: DesktopSession
    private let defaults = UserDefaults(suiteName: "local.graviton.computer-use.v2")!
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private var session: Set<String> = []
    var stopped: Bool { defaults.bool(forKey: "stopped") }
    init(desktop: DesktopSession) {
        self.desktop = desktop
        super.init(); refreshMenu()
    }
    private func refreshMenu() {
        item.button?.title = stopped ? "CU: stopped" : "CU"
        let menu = NSMenu()
        menu.addItem(withTitle: "Graviton Computer Use", action: nil, keyEquivalent: "")
        menu.addItem(withTitle: stopped ? "Resume Computer Use" : "Stop Computer Use", action: #selector(toggleStop), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Forget all app approvals", action: #selector(forget), keyEquivalent: "").target = self
        item.menu = menu
    }
    @objc private func toggleStop() {
        defaults.set(!stopped, forKey: "stopped"); session.removeAll(); desktop.switchTo("", url: nil); refreshMenu()
    }
    @objc private func forget() {
        defaults.removeObject(forKey: "always"); session.removeAll(); desktop.switchTo("", url: nil)
    }
    static func apps() -> [URL] {
        let fm = FileManager.default
        var urls = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.compactMap(\.bundleURL)
        for root in ["/Applications", "/System/Applications", "/System/Applications/Utilities", "/Applications/Utilities", NSHomeDirectory() + "/Applications"] {
            urls += (try? fm.contentsOfDirectory(at: URL(fileURLWithPath: root), includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])) ?? []
        }
        return Array(Set(urls.filter { $0.pathExtension.lowercased() == "app" }.map { $0.standardizedFileURL.resolvingSymlinksInPath() })).sorted { $0.path < $1.path }
    }
    static func list() -> String {
        apps().compactMap { url in Bundle(url: url)?.bundleIdentifier.map { "\(url.deletingPathExtension().lastPathComponent) | \($0) | \(url.path)" } }.joined(separator: "\n")
    }
    func select(_ name: String) async throws {
        guard !stopped else { throw ToolFailure("Computer Use was stopped. Resume it from the CU menu.") }
        var selected = false
        defer { if !selected { desktop.switchTo("", url: nil) } }
        let candidates: [URL]
        if name.hasPrefix("/") { candidates = [URL(fileURLWithPath: name).standardizedFileURL.resolvingSymlinksInPath()] }
        else if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: name) { candidates = [url.standardizedFileURL.resolvingSymlinksInPath()] }
        else { candidates = Self.apps().filter { $0.deletingPathExtension().lastPathComponent.caseInsensitiveCompare(name) == .orderedSame || Bundle(url: $0)?.bundleIdentifier == name } }
        guard candidates.count == 1, let url = candidates.first, url.pathExtension.lowercased() == "app", let bundle = Bundle(url: url), let id = bundle.bundleIdentifier, bundle.executableURL != nil else { throw ToolFailure("App missing or ambiguous. Use list_apps, then its exact bundle ID or path.") }
        // Never allow the agent to operate approval dialogs or its own host.
        guard !["local.graviton.computer-use.helper", "com.graviton.chat", "com.apple.systempreferences", "com.apple.SecurityAgent", "com.apple.UserNotificationCenter"].contains(id), id != Bundle.main.bundleIdentifier else { throw ToolFailure("This app cannot be targeted by Computer Use.") }
        let identity = id + "|" + url.path
        var always = defaults.stringArray(forKey: "always") ?? []
        if !session.contains(identity) && !always.contains(identity) {
            let alert = NSAlert(); alert.messageText = "Allow Graviton Computer Use to operate \(url.deletingPathExtension().lastPathComponent)?"
            alert.informativeText = "\(id)\n\(url.path)\nThe agent can read and change this app and send window contents to your model provider. Use the CU menu to stop or revoke approvals."
            for label in ["Deny", "Allow for this session", "Always allow"] { alert.addButton(withTitle: label) }
            NSApp.activate(ignoringOtherApps: true)
            switch alert.runModal() {
            case .alertSecondButtonReturn: session.insert(identity)
            case .alertThirdButtonReturn: always.append(identity); defaults.set(always, forKey: "always")
            default: throw ToolFailure("User did not approve \(id).")
            }
        }
        guard !stopped else { throw ToolFailure("Computer Use is stopped.") }
        if NSRunningApplication.runningApplications(withBundleIdentifier: id).isEmpty {
            let config = NSWorkspace.OpenConfiguration(); config.activates = false
            _ = try await NSWorkspace.shared.openApplication(at: url, configuration: config)
        }
        let instances = NSRunningApplication.runningApplications(withBundleIdentifier: id)
        guard !stopped, instances.count == 1, instances.first?.bundleURL?.standardizedFileURL.resolvingSymlinksInPath() == url else { throw ToolFailure("Cannot uniquely identify the approved app process.") }
        if desktop.trustedURL != url { desktop.switchTo(id, url: url) }
        selected = true
    }
    func permissions(_ name: String?) throws -> String {
        guard !stopped else { throw ToolFailure("Computer Use is stopped.") }
        switch name {
        case "accessibility":
            let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
            _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
        case "screen_recording": _ = CGRequestScreenCaptureAccess()
        default: throw ToolFailure("Unknown permission.")
        }
        return desktop.status()
    }
}
