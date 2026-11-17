import AppKit
import SwiftUI

@main
struct DevSpaceApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        MenuBarExtra {
            MenuBarView(controller: appDelegate.controller)
        } label: {
            MenuBarLabel(controller: appDelegate.controller)
        }
        .menuBarExtraStyle(.window)

        Window("设置 DevSpace", id: WindowID.setup) {
            SetupView(controller: appDelegate.controller)
        }
        .windowResizability(.contentSize)

        Window("DevSpace 诊断", id: WindowID.diagnostics) {
            DiagnosticsView(controller: appDelegate.controller)
        }
    }
}

enum WindowID {
    static let setup = "setup"
    static let diagnostics = "diagnostics"
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let controller = ServerController()

    func applicationDidFinishLaunching(_ notification: Notification) {
        Task { await controller.bootstrap() }
    }

    func applicationWillTerminate(_ notification: Notification) {
        controller.terminateForAppExit()
    }
}

/// Menu bar icon. It is always rendered, so it also opens the setup window
/// as soon as the app finds no DevSpace config.
struct MenuBarLabel: View {
    let controller: ServerController

    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Image(systemName: controller.state.symbolName)
            .onChange(of: controller.state) { _, state in
                if state == .needsSetup { presentWindow(WindowID.setup, using: openWindow) }
            }
    }
}

@MainActor
func presentWindow(_ id: String, using openWindow: OpenWindowAction) {
    openWindow(id: id)
    NSApp.activate(ignoringOtherApps: true)
}

extension ServerState {
    var symbolName: String {
        switch self {
        case .running: return "bolt.horizontal.circle.fill"
        case .preparing, .starting, .restarting: return "bolt.horizontal.circle"
        case .stopped, .needsSetup: return "bolt.slash.circle"
        case .unresponsive, .externalServer, .failed: return "exclamationmark.triangle"
        }
    }

    var title: String {
        switch self {
        case .preparing: return "正在准备…"
        case .needsSetup: return "尚未设置"
        case .stopped: return "已停止"
        case .starting: return "正在启动…"
        case .running: return "运行中"
        case .unresponsive: return "无响应"
        case .restarting(let delay): return "异常退出，\(delay) 秒后重启"
        case .externalServer: return "已有其他 DevSpace 在运行"
        case .failed: return "启动失败"
        }
    }

    var tint: Color {
        switch self {
        case .running: return .green
        case .failed: return .red
        case .stopped: return .secondary
        default: return .orange
        }
    }
}
