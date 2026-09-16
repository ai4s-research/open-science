// swift-tools-version: 6.0
//
// Ported from Orca (github.com/stablyai/orca, MIT, Copyright (c) 2026 Lovecast
// Inc.) — its accessibility-first computer-use design is the one this follows.

import PackageDescription

let package = Package(
    name: "OsdComputerUseMacOS",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "OsdComputerUseMacOSCore",
            targets: ["OsdComputerUseMacOSCore"]
        ),
        .executable(
            name: "osd-computer-use-macos",
            targets: ["OsdComputerUseMacOS"]
        )
    ],
    targets: [
        .target(
            name: "OsdComputerUseMacOSCore",
            path: "Sources/OsdComputerUseMacOSCore"
        ),
        .executableTarget(
            name: "OsdComputerUseMacOS",
            dependencies: ["OsdComputerUseMacOSCore"],
            path: "Sources/OsdComputerUseMacOS"
        ),
        .testTarget(
            name: "OsdComputerUseMacOSTests",
            dependencies: ["OsdComputerUseMacOSCore"],
            path: "Tests/OsdComputerUseMacOSTests"
        )
    ]
)
