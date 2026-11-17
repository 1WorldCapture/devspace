import Foundation

/// Reconstructs the environment a terminal-launched `devspace` would see.
///
/// Apps started from Finder or as login items inherit launchd's minimal
/// environment, so Homebrew tools, provider CLIs, and exported API keys would
/// be missing. Reading the user's login shell environment once mirrors what a
/// terminal session provides.
enum ShellEnvironment {
    static let fallbackPathPrefix = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"]
    static let defaultSystemPath = "/usr/bin:/bin:/usr/sbin:/sbin"

    /// Shell bookkeeping variables that must not leak into the server process.
    static let droppedKeys: Set<String> = ["_", "PWD", "OLDPWD", "SHLVL"]

    /// Parses `env -0` output.
    static func parse(_ data: Data) -> [String: String] {
        var environment: [String: String] = [:]

        for entry in data.split(separator: 0, omittingEmptySubsequences: true) {
            guard let text = String(data: Data(entry), encoding: .utf8),
                  let separator = text.firstIndex(of: "=") else { continue }

            let key = String(text[..<separator])

            guard !key.isEmpty, !droppedKeys.contains(key) else { continue }

            environment[key] = String(text[text.index(after: separator)...])
        }

        return environment
    }

    /// Appends `directory` to PATH so the bundled runtime is only a fallback for
    /// tools that expect `node` but find none of the user's own.
    static func appendingToPath(_ directory: String, in environment: [String: String]) -> [String: String] {
        var result = environment
        let path = environment["PATH"].flatMap { $0.isEmpty ? nil : $0 } ?? defaultSystemPath
        let components = path.split(separator: ":").map(String.init)

        result["PATH"] = components.contains(directory) ? path : "\(path):\(directory)"

        return result
    }

    /// Environment used when the login shell cannot be read.
    static func fallback(from base: [String: String]) -> [String: String] {
        var result = base
        let path = base["PATH"].flatMap { $0.isEmpty ? nil : $0 } ?? defaultSystemPath
        let existing = Set(path.split(separator: ":").map(String.init))
        let prefix = fallbackPathPrefix.filter { !existing.contains($0) }

        result["PATH"] = (prefix + [path]).joined(separator: ":")

        return result
    }

    /// Reads the login shell environment, falling back to the app environment.
    static func resolve(bundledNodeDirectory: String) async -> [String: String] {
        let base = ProcessInfo.processInfo.environment
        let captured = await captureLoginShell(base: base)
        let environment = captured ?? fallback(from: base)

        return appendingToPath(bundledNodeDirectory, in: environment)
    }

    private static func captureLoginShell(base: [String: String]) async -> [String: String]? {
        let shell = base["SHELL"].flatMap { $0.isEmpty ? nil : $0 } ?? "/bin/zsh"
        let output = FileManager.default.temporaryDirectory
            .appendingPathComponent("devspace-env-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: output) }

        // Interactive login shells read the same profile files as a terminal.
        // The environment is written to a file so prompt or banner output from
        // shell startup cannot corrupt it.
        let command = "/usr/bin/env -0 > \(shellQuote(output.path))"

        guard let result = try? await CommandRunner.run(
            executable: URL(fileURLWithPath: shell),
            arguments: ["-l", "-i", "-c", command],
            environment: base,
            currentDirectory: FileManager.default.homeDirectoryForCurrentUser,
            timeout: 15
        ), result.succeeded,
              let data = try? Data(contentsOf: output) else { return nil }

        let environment = parse(data)

        return environment["PATH"] == nil ? nil : environment
    }
}

/// Quotes a string for POSIX shells.
func shellQuote(_ value: String) -> String {
    "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
}
