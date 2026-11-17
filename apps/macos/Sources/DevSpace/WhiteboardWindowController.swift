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

        let snapshots = SnapshotBridge()
        configuration.userContentController.addScriptMessageHandler(snapshots, contentWorld: .page, name: SnapshotBridge.name)

        let webView = WKWebView(frame: panel.contentLayoutRect, configuration: configuration)
        webView.autoresizingMask = [.width, .height]
        snapshots.webView = webView
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
        if let webView = panel.contentView as? WKWebView {
            webView.configuration.userContentController.removeAllScriptMessageHandlers()
            webView.stopLoading()
        }
        panel.contentView = nil
        panel.close()
    }

    func windowWillClose(_ notification: Notification) {
        close()
    }

    /// About an eighth of the screen, in the top-right corner. It is taller
    /// than the screen's shape because Excalidraw's toolbars take height.
    static func defaultFrame(on screen: NSRect) -> NSRect {
        let width = (screen.width * 0.3).rounded()
        let height = (screen.height * 0.42).rounded()
        let margin: CGFloat = 16

        return NSRect(
            x: screen.maxX - width - margin,
            y: screen.maxY - height - margin,
            width: width,
            height: height
        )
    }
}

/// Lets the whiteboard page capture the window exactly as the user sees it,
/// toolbars included, so the host can judge the drawing at its real size.
@MainActor
final class SnapshotBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "devspaceSnapshot"

    /// Widest snapshot in points; the image is twice that on Retina screens.
    private static let maxWidth: CGFloat = 900

    weak var webView: WKWebView?

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
    ) {
        guard let webView else {
            replyHandler(nil, "The whiteboard window is closed.")

            return
        }

        let configuration = WKSnapshotConfiguration()
        configuration.snapshotWidth = NSNumber(value: Double(min(webView.bounds.width, Self.maxWidth)))

        webView.takeSnapshot(with: configuration) { image, error in
            guard let image,
                  let tiff = image.tiffRepresentation,
                  let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else {
                replyHandler(nil, error?.localizedDescription ?? "The window could not be captured.")

                return
            }

            replyHandler(png.base64EncodedString(), nil)
        }
    }
}
