import Foundation

struct CommandResult: Sendable {
    let status: Int32
    let stdout: String
    let stderr: String

    var succeeded: Bool { status == 0 }

    /// Best human-readable explanation of a failed command.
    var failureDescription: String {
        let detail = [stderr, stdout]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }

        return detail ?? "exit status \(status)"
    }
}

enum CommandRunnerError: LocalizedError {
    case launchFailed(String)
    case timedOut(String)

    var errorDescription: String? {
        switch self {
        case .launchFailed(let message): return "无法启动命令：\(message)"
        case .timedOut(let command): return "命令超时：\(command)"
        }
    }
}

/// Runs a short-lived command and captures its output.
///
/// Output goes to temporary files instead of pipes: a command may leave a
/// detached descendant (for example a daemon) holding inherited pipe handles
/// open, which would otherwise block reading until that descendant exits.
enum CommandRunner {
    static func run(
        executable: URL,
        arguments: [String],
        environment: [String: String]? = nil,
        currentDirectory: URL? = nil,
        timeout: TimeInterval
    ) async throws -> CommandResult {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(with: Result {
                    try runBlocking(
                        executable: executable,
                        arguments: arguments,
                        environment: environment,
                        currentDirectory: currentDirectory,
                        timeout: timeout
                    )
                })
            }
        }
    }

    private static func runBlocking(
        executable: URL,
        arguments: [String],
        environment: [String: String]?,
        currentDirectory: URL?,
        timeout: TimeInterval
    ) throws -> CommandResult {
        let fileManager = FileManager.default
        let scratch = fileManager.temporaryDirectory
            .appendingPathComponent("devspace-command-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: scratch, withIntermediateDirectories: true)
        defer { try? fileManager.removeItem(at: scratch) }

        let stdoutURL = scratch.appendingPathComponent("stdout")
        let stderrURL = scratch.appendingPathComponent("stderr")
        fileManager.createFile(atPath: stdoutURL.path, contents: nil)
        fileManager.createFile(atPath: stderrURL.path, contents: nil)

        let stdoutHandle = try FileHandle(forWritingTo: stdoutURL)
        let stderrHandle = try FileHandle(forWritingTo: stderrURL)
        defer {
            try? stdoutHandle.close()
            try? stderrHandle.close()
        }

        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = stdoutHandle
        process.standardError = stderrHandle

        if let environment { process.environment = environment }

        if let currentDirectory { process.currentDirectoryURL = currentDirectory }

        let exited = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in exited.signal() }

        do {
            try process.run()
        } catch {
            throw CommandRunnerError.launchFailed(error.localizedDescription)
        }

        if exited.wait(timeout: .now() + timeout) == .timedOut {
            process.terminate()
            _ = exited.wait(timeout: .now() + 2)
            throw CommandRunnerError.timedOut(([executable.lastPathComponent] + arguments).joined(separator: " "))
        }

        let stdout = (try? String(contentsOf: stdoutURL, encoding: .utf8)) ?? ""
        let stderr = (try? String(contentsOf: stderrURL, encoding: .utf8)) ?? ""

        return CommandResult(status: process.terminationStatus, stdout: stdout, stderr: stderr)
    }
}
