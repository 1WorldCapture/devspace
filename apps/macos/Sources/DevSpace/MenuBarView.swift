import AppKit
import SwiftUI

struct MenuBarView: View {
    let controller: ServerController

    @Environment(\.openWindow) private var openWindow
    @State private var screenRecordingGranted = ScreenRecordingPermission.isGranted
    @State private var loginItemEnabled = LoginItem.isEnabled
    @State private var cliStatus: CommandLineTool.Status = .notInstalled
    @State private var notice: String?

    private var appPath: String { controller.runtime.bundleURL.path }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            statusDetail

            if let config = controller.config, controller.state != .needsSetup {
                addresses(config)
            }

            serverButtons

            Divider()

            if let roots = controller.config?.workspaces.allowedRoots, !roots.isEmpty {
                allowedRoots(roots)

                Divider()
            }

            integrations

            Divider()

            tools

            if let notice {
                Text(notice)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .transition(.opacity)
            }

            Divider()

            Button("退出 DevSpace") { NSApp.terminate(nil) }
                .buttonStyle(.borderless)
        }
        .padding(14)
        .frame(width: 340)
        .task { await refresh() }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("DevSpace").font(.headline)

            if let version = controller.version {
                Text(version).font(.caption).foregroundStyle(.secondary)
            }

            Spacer()

            Label(controller.state.title, systemImage: "circle.fill")
                .labelStyle(StatusLabelStyle(tint: controller.state.tint))
                .font(.caption)
        }
    }

    @ViewBuilder
    private var statusDetail: some View {
        switch controller.state {
        case .failed(let message):
            Text(message)
                .font(.caption.monospaced())
                .foregroundStyle(.red)
                .textSelection(.enabled)
                .lineLimit(8)
        case .externalServer:
            Text("配置的端口上已有另一个 DevSpace（例如终端里的 devspace serve）。先停掉它，再点「启动」。")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .needsSetup:
            Button("完成首次设置…") { presentWindow(WindowID.setup, using: openWindow) }
        default:
            EmptyView()
        }
    }

    private func addresses(_ config: DevSpaceConfig) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let url = config.publicMCPURL {
                copyRow(title: "公网 MCP 地址", value: url.absoluteString)
            } else {
                Text("未设置公网地址，ChatGPT 需要通过你的 tunnel 访问。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            copyRow(title: "本地地址", value: config.localMCPURL.absoluteString)
        }
    }

    private var serverButtons: some View {
        HStack {
            if controller.isProcessRunning {
                Button("停止") { controller.stop() }
            } else {
                Button("启动") { Task { await controller.start() } }
                    .disabled(controller.state == .needsSetup || controller.state == .preparing)
            }

            Button("重启") { Task { await controller.restart() } }
                .disabled(controller.state == .needsSetup || controller.state == .preparing)
        }
    }

    private func allowedRoots(_ roots: [String]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("允许的目录").font(.caption).foregroundStyle(.secondary)

            ForEach(roots, id: \.self) { root in
                Text(abbreviateHome(root))
                    .font(.caption.monospaced())
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
    }

    private var integrations: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("屏幕录制")

                Spacer()

                if screenRecordingGranted {
                    Label("已授权", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                        .font(.caption)
                } else {
                    Button("授权…") {
                        ScreenRecordingPermission.request()
                        show("授权后需要退出并重新打开 DevSpace 才会生效。")
                    }
                }
            }

            Toggle("登录时自动启动", isOn: Binding(
                get: { loginItemEnabled },
                set: { enabled in
                    do {
                        try LoginItem.setEnabled(enabled)
                    } catch {
                        show("无法修改登录项：\(error.localizedDescription)")
                    }

                    loginItemEnabled = LoginItem.isEnabled
                }
            ))

            HStack {
                Text("命令行工具")

                Spacer()

                cliStatusView
            }
        }
    }

    @ViewBuilder
    private var cliStatusView: some View {
        switch cliStatus {
        case .installed(let shadowedBy):
            if let shadowedBy {
                Text("被 \(abbreviateHome(shadowedBy)) 覆盖")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .help("PATH 中的 devspace 指向另一个安装，例如全局 npm 版本。卸载它后即可使用 App 内置版本。")
            } else {
                Label("已安装", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .font(.caption)
            }
        case .notInstalled, .outdated:
            Button(cliStatus == .outdated ? "更新…" : "安装…") { Task { await installCommandLineTool() } }
        case .occupied:
            Text("\(CommandLineTool.installPath) 已被占用")
                .font(.caption)
                .foregroundStyle(.orange)
        }
    }

    private var tools: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button("复制 Owner 密码") { copyOwnerToken() }
            Button("运行诊断…") { presentWindow(WindowID.diagnostics, using: openWindow) }
            Button("打开日志") { NSWorkspace.shared.open(LogLocation.serverLog) }

            if let configFile = controller.configLocation?.configFile {
                Button("打开配置文件") { NSWorkspace.shared.open(configFile) }
            }
        }
        .buttonStyle(.borderless)
    }

    private func copyRow(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption).foregroundStyle(.secondary)

            HStack {
                Text(value)
                    .font(.caption.monospaced())
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)

                Spacer()

                Button {
                    copy(value)
                    show("已复制\(title)")
                } label: {
                    Image(systemName: "doc.on.doc")
                }
                .buttonStyle(.borderless)
                .help("复制")
            }
        }
    }

    private func refresh() async {
        screenRecordingGranted = ScreenRecordingPermission.isGranted
        loginItemEnabled = LoginItem.isEnabled
        cliStatus = CommandLineTool.status(appPath: appPath, path: controller.environment?["PATH"])
        await controller.refreshConfig()
    }

    private func installCommandLineTool() async {
        do {
            try await CommandLineTool.install(appPath: appPath)
            show("已安装 \(CommandLineTool.installPath)")
        } catch {
            show(error.localizedDescription)
        }

        cliStatus = CommandLineTool.status(appPath: appPath, path: controller.environment?["PATH"])
    }

    private func copyOwnerToken() {
        guard let location = controller.configLocation else { return }

        do {
            copy(try location.ownerToken())
            show("已复制 Owner 密码")
        } catch {
            show("无法读取 \(abbreviateHome(location.authFile.path))：\(error.localizedDescription)")
        }
    }

    private func copy(_ value: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
    }

    private func show(_ message: String) {
        withAnimation { notice = message }

        Task {
            try? await Task.sleep(for: .seconds(4))

            withAnimation { if notice == message { notice = nil } }
        }
    }
}

private struct StatusLabelStyle: LabelStyle {
    let tint: Color

    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.icon.foregroundStyle(tint).imageScale(.small)
            configuration.title
        }
    }
}

func abbreviateHome(_ path: String) -> String {
    let home = FileManager.default.homeDirectoryForCurrentUser.path

    return path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
}
