import AppKit
import CoreGraphics
import Foundation
import ServiceManagement

/// Screen Recording permission for the app. The bundled server is a child of
/// the app, so macOS attributes its captures to DevSpace.app.
enum ScreenRecordingPermission {
    static var isGranted: Bool { CGPreflightScreenCaptureAccess() }

    private static let settingsURL = URL(
        string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
    )!

    /// Registers the app in the Screen Recording list and opens that pane.
    static func request() {
        if !CGRequestScreenCaptureAccess() { NSWorkspace.shared.open(settingsURL) }
    }
}

enum LoginItem {
    static var isEnabled: Bool { SMAppService.mainApp.status == .enabled }

    static func setEnabled(_ enabled: Bool) throws {
        if enabled {
            try SMAppService.mainApp.register()
        } else {
            try SMAppService.mainApp.unregister()
        }
    }
}

/// A `devspace` command on PATH that runs the app's bundled DevSpace, so the
/// CLI (subagents, `devspace agents ...`) keeps working without a global npm
/// installation.
enum CommandLineTool {
    static let installPath = "/usr/local/bin/devspace"
    static let marker = "# Installed by DevSpace.app"

    enum Status: Equatable {
        case notInstalled
        /// Installed and pointing at this app; `shadowedBy` is the file PATH
        /// resolves `devspace` to when that is a different one.
        case installed(shadowedBy: String?)
        /// Our wrapper, but for an app at another location.
        case outdated
        /// Some other file already occupies the install path.
        case occupied
    }

    static func script(appPath: String) -> String {
        """
        #!/bin/sh
        \(marker)
        # Runs the DevSpace bundled with the app.
        APP=\(shellQuote(appPath))
        exec "$APP/Contents/MacOS/node" "$APP/Contents/Resources/devspace/node_modules/\(BundledRuntime.packageName)/bin/devspace.js" "$@"

        """
    }

    static func status(appPath: String, path: String?) -> Status {
        guard let contents = try? String(contentsOfFile: installPath, encoding: .utf8) else { return .notInstalled }

        guard contents.contains(marker) else { return .occupied }

        guard contents == script(appPath: appPath) else { return .outdated }

        let resolved = resolveExecutable("devspace", path: path) { FileManager.default.isExecutableFile(atPath: $0) }

        return .installed(shadowedBy: resolved == installPath ? nil : resolved)
    }

    /// First match for `name` across PATH entries, like `command -v`.
    static func resolveExecutable(_ name: String, path: String?, isExecutable: (String) -> Bool) -> String? {
        guard let path else { return nil }

        for directory in path.split(separator: ":") where !directory.isEmpty {
            let candidate = "\(directory)/\(name)"

            if isExecutable(candidate) { return candidate }
        }

        return nil
    }

    /// Writes the wrapper with administrator rights via the standard macOS
    /// authorization prompt.
    static func install(appPath: String) async throws {
        let staging = FileManager.default.temporaryDirectory.appendingPathComponent("devspace-cli-\(UUID().uuidString)")
        try script(appPath: appPath).write(to: staging, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: staging) }

        let directory = (installPath as NSString).deletingLastPathComponent
        let command = "/bin/mkdir -p \(shellQuote(directory)) && /usr/bin/install -m 0755 \(shellQuote(staging.path)) \(shellQuote(installPath))"
        let appleScript = "do shell script \(appleScriptString(command)) with administrator privileges"

        let result = try await CommandRunner.run(
            executable: URL(fileURLWithPath: "/usr/bin/osascript"),
            arguments: ["-e", appleScript],
            timeout: 300
        )

        guard result.succeeded else { throw DevSpaceCLIError.commandFailed("安装命令行工具", result.failureDescription) }
    }

    static func appleScriptString(_ value: String) -> String {
        "\"" + value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }
}
