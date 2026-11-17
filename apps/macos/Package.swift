// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "DevSpaceMac",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "DevSpace",
            path: "Sources/DevSpace"
        ),
        .testTarget(
            name: "DevSpaceTests",
            dependencies: ["DevSpace"],
            path: "Tests/DevSpaceTests"
        ),
    ]
)
