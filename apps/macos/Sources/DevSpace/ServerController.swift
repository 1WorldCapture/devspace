import Foundation
import Observation

enum ServerState: Equatable {
    /// Reading the login environment and config at app launch.
    case preparing
    /// No DevSpace config exists yet.
    case needsSetup
    case stopped
    case starting
    case running
    /// The process is alive but its health endpoint stopped answering.
    case unresponsive
    /// Waiting before relaunching after an unexpected exit.
    case restarting(delaySeconds: Int)
    /// Another DevSpace server (for example a terminal `devspace serve`)
    /// already answers on the configured port.
    case externalServer
    case failed(String)
}

/// Owns the lifecycle of the bundled `devspace serve` process.
@MainActor
@Observable
final class ServerController {
    private(set) var state: ServerState = .preparing
    private(set) var config: DevSpaceConfig?
    private(set) var configLocation: ConfigLocation?
    private(set) var environment: [String: String]?

    let runtime = BundledRuntime.current

    @ObservationIgnored private var process: Process?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var launchedAt: Date?
    @ObservationIgnored private var stopRequested = false
    @ObservationIgnored private var restartPolicy = RestartPolicy()
    @ObservationIgnored private var healthTask: Task<Void, Never>?
    @ObservationIgnored private var restartTask: Task<Void, Never>?
    @ObservationIgnored private var logHandle: FileHandle?

    var version: String? { runtime.devspaceVersion }

    var cli: DevSpaceCLI? { environment.map { DevSpaceCLI(runtime: runtime, environment: $0) } }

    var isProcessRunning: Bool { process?.isRunning == true }

    func bootstrap() async {
        guard runtime.isComplete else {
            state = .failed("App 内置的 DevSpace 运行时不完整，请重新构建 App。")

            return
        }

        await reloadEnvironment()
        await start()
    }

    /// Re-reads the login shell environment, e.g. after the user changed PATH.
    func reloadEnvironment() async {
        let environment = await ShellEnvironment.resolve(
            bundledNodeDirectory: runtime.nodeExecutable.deletingLastPathComponent().path
        )

        self.environment = environment
        configLocation = ConfigLocation.resolve(environment: environment)
    }

    func start() async {
        guard !isProcessRunning else { return }

        cancelPendingRestart()
        stopRequested = false
        restartPolicy.reset()
        await launch()
    }

    func stop() {
        stopRequested = true
        cancelPendingRestart()

        guard let process, process.isRunning else {
            if state != .needsSetup { state = .stopped }

            return
        }

        process.terminate()

        let pid = process.processIdentifier

        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak process] in
            if process?.isRunning == true { kill(pid, SIGKILL) }
        }
    }

    func restart() async {
        stop()

        for _ in 0..<70 where isProcessRunning {
            try? await Task.sleep(for: .milliseconds(100))
        }

        await reloadEnvironment()
        await start()
    }

    func refreshConfig() async {
        guard let cli, configLocation?.isInitialized == true else { return }

        if let config = try? await cli.loadConfig() { self.config = config }
    }

    /// Runs `devspace init` from the setup window, then starts the server.
    func completeSetup(roots: [String], publicURL: String?) async throws {
        if environment == nil { await reloadEnvironment() }

        guard let cli else { return }

        try await cli.initialize(roots: roots, publicURL: publicURL)
        await start()
    }

    /// Stops the server before the app quits; blocks briefly so the child is
    /// not orphaned.
    func terminateForAppExit() {
        stopRequested = true
        cancelPendingRestart()
        healthTask?.cancel()

        guard let process, process.isRunning else { return }

        process.terminate()

        let deadline = Date().addingTimeInterval(5)

        while process.isRunning, Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }

        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
    }

    private func launch() async {
        guard let environment, let cli, let location = configLocation else { return }

        guard location.isInitialized else {
            state = .needsSetup

            return
        }

        state = .starting

        let config: DevSpaceConfig

        do {
            config = try await cli.loadConfig()
        } catch {
            state = .failed(error.localizedDescription)

            return
        }

        self.config = config

        if await HealthProbe.isDevSpaceHealthy(at: config.healthURL) {
            state = .externalServer

            return
        }

        // The user may have stopped or another launch may have won while awaiting.
        guard !stopRequested, !isProcessRunning else { return }

        let handle: FileHandle

        do {
            handle = try ServerLog.open()
        } catch {
            state = .failed("无法写入日志：\(error.localizedDescription)")

            return
        }

        ServerLog.write("starting devspace \(version ?? "unknown") serve", to: handle)

        let process = Process()
        process.executableURL = runtime.nodeExecutable
        process.arguments = [runtime.entryPoint.path, "serve"]
        process.environment = environment
        process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = handle
        process.standardError = handle

        generation += 1

        let launchGeneration = generation

        process.terminationHandler = { [weak self] finished in
            let status = finished.terminationStatus

            Task { @MainActor in self?.handleExit(generation: launchGeneration, status: status) }
        }

        do {
            try process.run()
        } catch {
            try? handle.close()
            state = .failed("无法启动 DevSpace：\(error.localizedDescription)")

            return
        }

        self.process = process
        logHandle = handle
        launchedAt = Date()
        monitorHealth(config: config, generation: launchGeneration)
    }

    private func monitorHealth(config: DevSpaceConfig, generation launchGeneration: Int) {
        healthTask?.cancel()
        healthTask = Task { [weak self] in
            var wasHealthy = false

            while !Task.isCancelled {
                let healthy = await HealthProbe.isDevSpaceHealthy(at: config.healthURL)

                guard let self, self.generation == launchGeneration, self.isProcessRunning else { return }

                if healthy {
                    self.state = .running
                    wasHealthy = true
                } else if wasHealthy {
                    self.state = .unresponsive
                }

                try? await Task.sleep(for: .seconds(healthy ? 5 : 1))
            }
        }
    }

    private func handleExit(generation exitedGeneration: Int, status: Int32) {
        guard exitedGeneration == generation else { return }

        healthTask?.cancel()
        healthTask = nil

        if let logHandle {
            ServerLog.write("devspace exited with status \(status)", to: logHandle)
            try? logHandle.close()
        }

        logHandle = nil
        process = nil

        let uptime = launchedAt.map { Date().timeIntervalSince($0) } ?? 0
        launchedAt = nil

        if stopRequested {
            state = .stopped

            return
        }

        guard let delay = restartPolicy.recordUnexpectedExit(uptime: uptime) else {
            let tail = ServerLog.tail(lines: 6)
            state = .failed("DevSpace 多次异常退出（状态码 \(status)）。" + (tail.isEmpty ? "" : "\n\(tail)"))

            return
        }

        state = .restarting(delaySeconds: Int(delay))
        restartTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))

            guard !Task.isCancelled, let self, !self.stopRequested else { return }

            await self.launch()
        }
    }

    private func cancelPendingRestart() {
        restartTask?.cancel()
        restartTask = nil
    }
}
