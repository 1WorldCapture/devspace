import Foundation

/// An event the server sends DevSpace.app on `/desktop/events`.
enum DesktopEvent: Equatable {
    /// Show the whiteboard window and load the page at this server path.
    case openWhiteboard(path: String)
    case closeWhiteboard

    /// Parses one SSE `data:` payload; unknown events are ignored.
    static func parse(_ payload: String) -> DesktopEvent? {
        guard let data = payload.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String else { return nil }

        switch type {
        case "whiteboard.open":
            guard let path = object["path"] as? String, path.hasPrefix("/") else { return nil }

            return .openWhiteboard(path: path)
        case "whiteboard.close":
            return .closeWhiteboard
        default:
            return nil
        }
    }
}

/// Subscribes to the server's desktop events with the token the app started it
/// with, reconnecting until cancelled. The open connection is also how the
/// server knows the app is there to show a whiteboard.
@MainActor
final class DesktopEventClient {
    private var task: Task<Void, Never>?

    func start(baseURL: URL, token: String, onEvent: @escaping @MainActor (DesktopEvent) -> Void) {
        stop()

        var request = URLRequest(url: baseURL.appendingPathComponent("desktop/events"))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = .infinity

        task = Task {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 60
            configuration.timeoutIntervalForResource = .infinity

            let session = URLSession(configuration: configuration)

            while !Task.isCancelled {
                do {
                    let (bytes, response) = try await session.bytes(for: request)

                    if (response as? HTTPURLResponse)?.statusCode == 200 {
                        for try await line in bytes.lines {
                            guard line.hasPrefix("data: "),
                                  let event = DesktopEvent.parse(String(line.dropFirst("data: ".count))) else { continue }

                            onEvent(event)
                        }
                    }
                } catch {
                    // The server is starting, restarting, or gone; retry below.
                }

                // The stream ended, so any open whiteboard is gone with it.
                if !Task.isCancelled { onEvent(.closeWhiteboard) }

                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }
}
