import Foundation

/// Decides whether and when to relaunch a server that exited unexpectedly.
///
/// Delays grow exponentially so a crash loop does not spin. A run that stayed
/// up long enough counts as healthy and resets the failure streak.
struct RestartPolicy {
    var maxConsecutiveFailures = 5
    var stableUptime: TimeInterval = 60
    var maxDelay: TimeInterval = 30

    private(set) var consecutiveFailures = 0

    /// Records an unexpected exit; returns the delay before relaunching, or
    /// nil when the server should stay stopped.
    mutating func recordUnexpectedExit(uptime: TimeInterval) -> TimeInterval? {
        if uptime >= stableUptime { consecutiveFailures = 0 }

        consecutiveFailures += 1

        guard consecutiveFailures <= maxConsecutiveFailures else { return nil }

        return min(maxDelay, pow(2, Double(consecutiveFailures - 1)))
    }

    mutating func reset() { consecutiveFailures = 0 }
}
