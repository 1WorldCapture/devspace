import Foundation

/// Append-only server log with a single rotated predecessor.
enum ServerLog {
    static let maxBytes: UInt64 = 10 * 1024 * 1024

    /// Opens the log for appending, rotating it first when it grew too large.
    static func open(at url: URL = LogLocation.serverLog) throws -> FileHandle {
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)

        if let size = (try? fileManager.attributesOfItem(atPath: url.path)[.size]) as? UInt64, size > maxBytes {
            let rotated = url.appendingPathExtension("1")
            try? fileManager.removeItem(at: rotated)
            try fileManager.moveItem(at: url, to: rotated)
        }

        if !fileManager.fileExists(atPath: url.path) { fileManager.createFile(atPath: url.path, contents: nil) }

        let handle = try FileHandle(forWritingTo: url)
        try handle.seekToEnd()

        return handle
    }

    static func write(_ line: String, to handle: FileHandle) {
        let timestamp = ISO8601DateFormatter().string(from: Date())
        try? handle.write(contentsOf: Data("[devspace-app \(timestamp)] \(line)\n".utf8))
    }

    /// Last lines of the log, used to explain a failed start.
    static func tail(lines count: Int, at url: URL = LogLocation.serverLog) -> String {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return "" }

        return text.split(separator: "\n", omittingEmptySubsequences: true).suffix(count).joined(separator: "\n")
    }
}

enum HealthProbe {
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 2
        configuration.timeoutIntervalForResource = 2

        return URLSession(configuration: configuration)
    }()

    /// True when a DevSpace server answers its health endpoint at `url`.
    static func isDevSpaceHealthy(at url: URL) async -> Bool {
        guard let (data, response) = try? await session.data(from: url),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }

        return object["name"] as? String == "devspace"
    }
}
