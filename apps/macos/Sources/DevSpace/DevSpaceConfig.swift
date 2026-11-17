import Foundation

/// The subset of `devspace config get` the app displays or relies on.
struct DevSpaceConfig: Decodable, Equatable {
    struct Server: Decodable, Equatable {
        var host: String
        var port: Int
        var publicBaseUrl: String?

        private enum CodingKeys: String, CodingKey { case host, port, publicBaseUrl }

        init(host: String, port: Int, publicBaseUrl: String?) {
            self.host = host
            self.port = port
            self.publicBaseUrl = publicBaseUrl
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            host = try container.decodeIfPresent(String.self, forKey: .host) ?? "127.0.0.1"
            port = try container.decodeIfPresent(Int.self, forKey: .port) ?? 7676
            publicBaseUrl = try container.decodeIfPresent(String.self, forKey: .publicBaseUrl)
        }
    }

    struct Workspaces: Decodable, Equatable {
        var allowedRoots: [String]

        private enum CodingKeys: String, CodingKey { case allowedRoots }

        init(allowedRoots: [String]) { self.allowedRoots = allowedRoots }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            allowedRoots = try container.decodeIfPresent([String].self, forKey: .allowedRoots) ?? []
        }
    }

    var server: Server
    var workspaces: Workspaces

    /// Decodes the JSON object printed by `devspace config get`.
    static func decode(fromCLIOutput output: String) throws -> DevSpaceConfig {
        guard let start = output.firstIndex(of: "{"), let end = output.lastIndex(of: "}") else {
            throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "No JSON object in config output."))
        }

        return try JSONDecoder().decode(DevSpaceConfig.self, from: Data(output[start...end].utf8))
    }

    /// Loopback-reachable base URL of the local server.
    var localBaseURL: URL {
        let host: String

        switch server.host {
        case "", "0.0.0.0", "localhost": host = "127.0.0.1"
        case "::", "::1": host = "[::1]"
        default: host = server.host.contains(":") ? "[\(server.host)]" : server.host
        }

        return URL(string: "http://\(host):\(server.port)")!
    }

    var healthURL: URL { localBaseURL.appendingPathComponent("healthz") }

    var localMCPURL: URL { localBaseURL.appendingPathComponent("mcp") }

    var publicMCPURL: URL? {
        guard var base = server.publicBaseUrl?.trimmingCharacters(in: .whitespacesAndNewlines),
              !base.isEmpty else { return nil }

        while base.hasSuffix("/") { base.removeLast() }

        return URL(string: base + "/mcp")
    }
}
