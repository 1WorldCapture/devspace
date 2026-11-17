import AppKit
import WebKit

/// The floating whiteboard window: an always-on-top panel holding the
/// server's Excalidraw page. Closing it destroys the web view, which drops the
/// page's connection, and the server then discards the board.
@MainActor
final class WhiteboardWindowController: NSObject, NSWindowDelegate {
    private var panel: NSPanel?

    var isOpen: Bool { panel != nil }

    func open(url: URL) {
        close()

        let frame = Self.defaultFrame(on: NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900))

        let panel = NSPanel(
            contentRect: frame,
            styleMask: [.titled, .closable, .resizable, .utilityWindow],
            backing: .buffered,
            defer: false
        )

        panel.title = "DevSpace 白板"
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.minSize = NSSize(width: 320, height: 240)
        panel.delegate = self

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()

        let webView = WKWebView(frame: panel.contentLayoutRect, configuration: configuration)
        webView.autoresizingMask = [.width, .height]
        panel.contentView = webView
        webView.load(URLRequest(url: url))

        self.panel = panel
        panel.orderFrontRegardless()
        panel.makeKey()
    }

    func close() {
        guard let panel else { return }

        self.panel = nil
        panel.delegate = nil
        (panel.contentView as? WKWebView)?.stopLoading()
        panel.contentView = nil
        panel.close()
    }

    func windowWillClose(_ notification: Notification) {
        close()
    }

    /// About an eighth of the screen (35% of each side), in the top-right corner.
    static func defaultFrame(on screen: NSRect) -> NSRect {
        let width = (screen.width * 0.35).rounded()
        let height = (screen.height * 0.35).rounded()
        let margin: CGFloat = 16

        return NSRect(
            x: screen.maxX - width - margin,
            y: screen.maxY - height - margin,
            width: width,
            height: height
        )
    }
}
