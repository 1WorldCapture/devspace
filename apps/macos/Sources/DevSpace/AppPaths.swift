import Foundation

/// Locations inside the app bundle.
struct BundledRuntime {
    let bundleURL: URL

    static let packageName = "@waishnav/devspace"

    static var current: BundledRuntime { BundledRuntime(bundleURL: Bundle.main.bundleURL) }

    var nodeExecutable: URL { bundleURL.appendingPathComponent("Contents/MacOS/node") }

    var packageDirectory: URL {
        bundleURL.appendingPathComponent("Contents/Resources/devspace/node_modules/\(Self.packageName)")
    }

    var entryPoint: URL { packageDirectory.appendingPathComponent("bin/devspace.js") }

    var isComplete: Bool {
        let fileManager = FileManager.default

        return fileManager.isExecutableFile(atPath: nodeExecutable.path)
            && fileManager.fileExists(atPath: entryPoint.path)
    }

    var devspaceVersion: String? {
        let manifest = packageDirectory.appendingPathComponent("package.json")

        guard let data = try? Data(contentsOf: manifest),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }

        return object["version"] as? String
    }
}

/// DevSpace's own config directory; unchanged from a terminal installation.
struct ConfigLocation: Equatable {
    let directory: URL

    static func resolve(environment: [String: String]) -> ConfigLocation {
        let home = FileManager.default.homeDirectoryForCurrentUser

        if let override = environment["DEVSPACE_CONFIG_DIR"], !override.isEmpty {
            return ConfigLocation(directory: URL(fileURLWithPath: expandTilde(override, home: home.path)))
        }

        return ConfigLocation(directory: home.appendingPathComponent(".devspace", isDirectory: true))
    }

    /// The config file DevSpace reads, preferring the current JSONC format.
    var configFile: URL? {
        ["config.jsonc", "config.json"]
            .map { directory.appendingPathComponent($0) }
            .first { FileManager.default.fileExists(atPath: $0.path) }
    }

    var isInitialized: Bool { configFile != nil }

    var authFile: URL { directory.appendingPathComponent("auth.json") }

    func ownerToken() throws -> String {
        struct AuthFile: Decodable { let ownerToken: String }

        return try JSONDecoder().decode(AuthFile.self, from: Data(contentsOf: authFile)).ownerToken
    }
}

enum LogLocation {
    static var directory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/DevSpace", isDirectory: true)
    }

    static var serverLog: URL { directory.appendingPathComponent("server.log") }
}

func expandTilde(_ path: String, home: String) -> String {
    if path == "~" { return home }

    if path.hasPrefix("~/") { return home + path.dropFirst(1) }

    return path
}
