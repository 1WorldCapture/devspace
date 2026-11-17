import XCTest
@testable import DevSpace

final class ShellEnvironmentTests: XCTestCase {
    func testParsesNulSeparatedEnvironmentAndDropsShellBookkeeping() {
        let raw = "PATH=/opt/homebrew/bin:/usr/bin\0OPENAI_API_KEY=a=b\0_=/usr/bin/env\0PWD=/tmp\0SHLVL=2\0EMPTY=\0"
        let environment = ShellEnvironment.parse(Data(raw.utf8))

        XCTAssertEqual(environment, [
            "PATH": "/opt/homebrew/bin:/usr/bin",
            "OPENAI_API_KEY": "a=b",
            "EMPTY": "",
        ])
    }

    func testAppendsBundledNodeAfterUserPathOnce() {
        let environment = ["PATH": "/opt/homebrew/bin:/usr/bin"]
        let appended = ShellEnvironment.appendingToPath("/App/Contents/MacOS", in: environment)

        XCTAssertEqual(appended["PATH"], "/opt/homebrew/bin:/usr/bin:/App/Contents/MacOS")
        XCTAssertEqual(ShellEnvironment.appendingToPath("/App/Contents/MacOS", in: appended), appended)
    }

    func testFallbackAddsHomebrewAheadOfLaunchdPath() {
        let fallback = ShellEnvironment.fallback(from: ["PATH": "/usr/bin:/bin:/usr/local/bin"])

        XCTAssertEqual(fallback["PATH"], "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/local/bin")
    }
}

final class DevSpaceConfigTests: XCTestCase {
    func testDecodesConfigGetOutputAndBuildsURLs() throws {
        let output = """
        {
          "configVersion": 1,
          "server": { "host": "127.0.0.1", "port": 7676, "publicBaseUrl": "https://ai.example.com/", "allowedHosts": [] },
          "workspaces": { "allowedRoots": ["/Users/me/work"], "worktreeRoot": "~/.devspace/worktrees" }
        }
        """
        let config = try DevSpaceConfig.decode(fromCLIOutput: output)

        XCTAssertEqual(config.workspaces.allowedRoots, ["/Users/me/work"])
        XCTAssertEqual(config.healthURL.absoluteString, "http://127.0.0.1:7676/healthz")
        XCTAssertEqual(config.localMCPURL.absoluteString, "http://127.0.0.1:7676/mcp")
        XCTAssertEqual(config.publicMCPURL?.absoluteString, "https://ai.example.com/mcp")
    }

    func testMissingPublicURLAndWildcardHost() throws {
        let config = try DevSpaceConfig.decode(
            fromCLIOutput: #"{"server":{"host":"0.0.0.0","port":9000,"publicBaseUrl":null},"workspaces":{}}"#
        )

        XCTAssertNil(config.publicMCPURL)
        XCTAssertEqual(config.healthURL.absoluteString, "http://127.0.0.1:9000/healthz")
        XCTAssertEqual(config.workspaces.allowedRoots, [])
    }

    func testRejectsOutputWithoutJSON() {
        XCTAssertThrowsError(try DevSpaceConfig.decode(fromCLIOutput: "Config not found"))
    }
}

final class RestartPolicyTests: XCTestCase {
    func testBacksOffExponentiallyThenGivesUp() {
        var policy = RestartPolicy()
        let delays = (0..<6).map { _ in policy.recordUnexpectedExit(uptime: 1) }

        XCTAssertEqual(delays, [1, 2, 4, 8, 16, nil])
    }

    func testStableRunResetsFailureStreak() {
        var policy = RestartPolicy()
        _ = policy.recordUnexpectedExit(uptime: 1)
        _ = policy.recordUnexpectedExit(uptime: 1)

        XCTAssertEqual(policy.recordUnexpectedExit(uptime: 120), 1)
    }

    func testDelayIsCapped() {
        var policy = RestartPolicy(maxConsecutiveFailures: 10, stableUptime: 60, maxDelay: 30)
        let delays = (0..<8).compactMap { _ in policy.recordUnexpectedExit(uptime: 0) }

        XCTAssertEqual(delays.last, 30)
    }
}

final class CommandLineToolTests: XCTestCase {
    func testWrapperRunsBundledRuntimeAndQuotesAppPath() {
        let script = CommandLineTool.script(appPath: "/Applications/Dev Space's.app")

        XCTAssertTrue(script.hasPrefix("#!/bin/sh\n\(CommandLineTool.marker)\n"))
        XCTAssertTrue(script.contains("APP='/Applications/Dev Space'\\''s.app'"))
        XCTAssertTrue(script.contains(#"exec "$APP/Contents/MacOS/node" "$APP/Contents/Resources/devspace/node_modules/@waishnav/devspace/bin/devspace.js" "$@""#))
    }

    func testResolvesFirstExecutableOnPath() {
        let executables: Set<String> = ["/opt/homebrew/bin/devspace", "/usr/local/bin/devspace"]
        let resolved = CommandLineTool.resolveExecutable(
            "devspace",
            path: "/usr/bin:/opt/homebrew/bin:/usr/local/bin",
            isExecutable: executables.contains
        )

        XCTAssertEqual(resolved, "/opt/homebrew/bin/devspace")
    }

    func testAppleScriptStringEscaping() {
        XCTAssertEqual(CommandLineTool.appleScriptString(#"a "b" \c"#), #""a \"b\" \\c""#)
    }
}

final class DevSpaceCLITests: XCTestCase {
    func testInitArguments() throws {
        XCTAssertEqual(
            try DevSpaceCLI.initArguments(roots: ["/a", "/b c"], publicURL: " https://x.example.com "),
            ["init", "--yes", "--json", "--roots", "/a,/b c", "--public-url", "https://x.example.com"]
        )
        XCTAssertEqual(
            try DevSpaceCLI.initArguments(roots: ["/a"], publicURL: ""),
            ["init", "--yes", "--json", "--roots", "/a"]
        )
    }

    func testRejectsRootsContainingCommas() {
        XCTAssertThrowsError(try DevSpaceCLI.initArguments(roots: ["/a,b"], publicURL: nil))
    }

    func testExpandsTilde() {
        XCTAssertEqual(expandTilde("~/x", home: "/Users/me"), "/Users/me/x")
        XCTAssertEqual(expandTilde("~", home: "/Users/me"), "/Users/me")
        XCTAssertEqual(expandTilde("/abs", home: "/Users/me"), "/abs")
    }
}

final class CommandRunnerTests: XCTestCase {
    func testCapturesOutputAndStatus() async throws {
        let result = try await CommandRunner.run(
            executable: URL(fileURLWithPath: "/bin/sh"),
            arguments: ["-c", "echo out; echo err >&2; exit 3"],
            timeout: 10
        )

        XCTAssertEqual(result.status, 3)
        XCTAssertEqual(result.stdout, "out\n")
        XCTAssertEqual(result.stderr, "err\n")
    }

    func testDoesNotWaitForDetachedDescendantsHoldingOutput() async throws {
        let started = Date()
        let result = try await CommandRunner.run(
            executable: URL(fileURLWithPath: "/bin/sh"),
            arguments: ["-c", "(sleep 30 &) ; echo done"],
            timeout: 10
        )

        XCTAssertEqual(result.stdout, "done\n")
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
    }

    func testTimesOut() async {
        do {
            _ = try await CommandRunner.run(
                executable: URL(fileURLWithPath: "/bin/sleep"),
                arguments: ["30"],
                timeout: 0.5
            )
            XCTFail("expected timeout")
        } catch CommandRunnerError.timedOut {
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }
}

final class DesktopEventTests: XCTestCase {
    func testParsesWhiteboardEvents() {
        XCTAssertEqual(
            DesktopEvent.parse(#"{"type":"whiteboard.open","path":"/desktop/whiteboard/#session=s&token=t"}"#),
            .openWhiteboard(path: "/desktop/whiteboard/#session=s&token=t")
        )
        XCTAssertEqual(DesktopEvent.parse(#"{"type":"whiteboard.close"}"#), .closeWhiteboard)
        // A path that is not on this server is refused.
        XCTAssertNil(DesktopEvent.parse(#"{"type":"whiteboard.open","path":"https://evil.example"}"#))
        XCTAssertNil(DesktopEvent.parse(#"{"type":"other"}"#))
    }

    @MainActor
    func testDefaultWhiteboardFrameIsAboutAnEighthOfTheScreenAtTopRight() {
        let frame = WhiteboardWindowController.defaultFrame(on: NSRect(x: 0, y: 0, width: 1000, height: 800))

        XCTAssertEqual(frame, NSRect(x: 684, y: 448, width: 300, height: 336))
    }
}
