import Darwin
import AppKit

@main
struct GravitonComputerUse {
    @MainActor static func main() {
        let args = CommandLine.arguments
        let initial: String
        if args.count == 1 { initial = "" }
        else {
        guard CommandLine.arguments.count == 3,
              CommandLine.arguments[1] == "--app-bundle-id",
              let bundleID = CommandLine.arguments.last,
              bundleID.range(of: #"^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$"#,
                             options: .regularExpression) != nil else {
            FileHandle.standardError.write(Data("Usage: graviton-computer-use --app-bundle-id com.apple.TextEdit\n".utf8))
            exit(64)
        }
        initial = bundleID
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let desktop = DesktopSession(bundleID: initial)
        let controls = LocalControls(desktop: desktop)
        desktop.controls = controls
        Task { await HelperProtocol(desktop: desktop).run(); exit(0) }
        withExtendedLifetime(controls) { app.run() }
    }
}
