import AppKit
import SwiftUI

/// First-run setup: collects what `devspace init` needs.
struct SetupView: View {
    let controller: ServerController

    @Environment(\.dismiss) private var dismiss
    @State private var roots: [String] = []
    @State private var publicURL = ""
    @State private var isWorking = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("设置 DevSpace").font(.title2.bold())

            Text("配置会写入 \(abbreviateHome(controller.configLocation?.directory.path ?? "~/.devspace"))，与命令行版本共用。")
                .font(.callout)
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 6) {
                Text("允许的目录").font(.headline)
                Text("ChatGPT 只能在这些目录内打开 workspace。").font(.caption).foregroundStyle(.secondary)

                List {
                    ForEach(roots, id: \.self) { root in
                        HStack {
                            Text(abbreviateHome(root)).font(.callout.monospaced())

                            Spacer()

                            Button {
                                roots.removeAll { $0 == root }
                            } label: {
                                Image(systemName: "minus.circle")
                            }
                            .buttonStyle(.borderless)
                        }
                    }
                }
                .frame(minHeight: 100)

                Button("添加目录…") { chooseRoots() }
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("公网地址（可选）").font(.headline)
                TextField("https://your-tunnel.example.com", text: $publicURL)
                    .textFieldStyle(.roundedBorder)
                Text("ChatGPT 通过这个地址访问本机，由你自己的 tunnel 提供。").font(.caption).foregroundStyle(.secondary)
            }

            if let errorMessage {
                Text(errorMessage).font(.caption).foregroundStyle(.red).textSelection(.enabled)
            }

            HStack {
                Spacer()

                if isWorking { ProgressView().controlSize(.small) }

                Button("完成设置") { Task { await submit() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(roots.isEmpty || isWorking)
            }
        }
        .padding(20)
        .frame(width: 480)
    }

    private func chooseRoots() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = true
        panel.prompt = "添加"

        guard panel.runModal() == .OK else { return }

        for url in panel.urls where !roots.contains(url.path) { roots.append(url.path) }
    }

    private func submit() async {
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }

        do {
            try await controller.completeSetup(roots: roots, publicURL: publicURL)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

/// Shows `devspace doctor` output for the bundled runtime and user environment.
struct DiagnosticsView: View {
    let controller: ServerController

    @State private var output = ""
    @State private var isRunning = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("devspace doctor").font(.headline)

                Spacer()

                if isRunning { ProgressView().controlSize(.small) }

                Button("重新运行") { Task { await run() } }.disabled(isRunning)
            }

            ScrollView {
                Text(output.isEmpty ? " " : output)
                    .font(.callout.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Color(nsColor: .textBackgroundColor))
        }
        .padding(16)
        .frame(minWidth: 620, minHeight: 360)
        .task { await run() }
    }

    private func run() async {
        guard let cli = controller.cli else {
            output = "运行环境尚未就绪。"

            return
        }

        isRunning = true
        defer { isRunning = false }

        do {
            output = try await cli.doctor()
        } catch {
            output = error.localizedDescription
        }
    }
}
