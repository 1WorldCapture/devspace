import Foundation

enum DevSpaceCLIError: LocalizedError {
    case commandFailed(String, String)
    case invalidRoot(String)

    var errorDescription: String? {
        switch self {
        case .commandFailed(let command, let detail): return "devspace \(command) 失败：\(detail)"
        case .invalidRoot(let path): return "目录路径不能包含逗号：\(path)"
        }
    }
}

/// Runs the bundled `devspace` CLI with the resolved user environment.
struct DevSpaceCLI {
    let runtime: BundledRuntime
    let environment: [String: String]

    func run(_ arguments: [String], timeout: TimeInterval = 60) async throws -> CommandResult {
        try await CommandRunner.run(
            executable: runtime.nodeExecutable,
            arguments: [runtime.entryPoint.path] + arguments,
            environment: environment,
            currentDirectory: FileManager.default.homeDirectoryForCurrentUser,
            timeout: timeout
        )
    }

    func loadConfig() async throws -> DevSpaceConfig {
        let result = try await run(["config", "get"])

        guard result.succeeded else { throw DevSpaceCLIError.commandFailed("config get", result.failureDescription) }

        return try DevSpaceConfig.decode(fromCLIOutput: result.stdout)
    }

    func initialize(roots: [String], publicURL: String?) async throws {
        try await run(Self.initArguments(roots: roots, publicURL: publicURL), timeout: 120, label: "init")
    }

    func doctor() async throws -> String {
        let result = try await run(["doctor"], timeout: 120)

        return [result.stdout, result.stderr]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n\n")
    }

    /// `devspace init` takes a comma-separated root list, so commas cannot be
    /// represented and are rejected instead of silently splitting a path.
    static func initArguments(roots: [String], publicURL: String?) throws -> [String] {
        if let invalid = roots.first(where: { $0.contains(",") }) { throw DevSpaceCLIError.invalidRoot(invalid) }

        var arguments = ["init", "--yes", "--json", "--roots", roots.joined(separator: ",")]
        let trimmedURL = publicURL?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        if !trimmedURL.isEmpty { arguments += ["--public-url", trimmedURL] }

        return arguments
    }

    private func run(_ arguments: [String], timeout: TimeInterval, label: String) async throws {
        let result = try await run(arguments, timeout: timeout)

        guard result.succeeded else { throw DevSpaceCLIError.commandFailed(label, result.failureDescription) }
    }
}
