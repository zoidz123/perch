// swift-tools-version:5.9
import PackageDescription

// Standalone harness for task status badge wording. It compiles the same
// TaskStatusPresentation.swift helper the iOS app uses and runs focused unit
// tests under `swift test` on macOS.
let package = Package(
  name: "PerchTaskStatus",
  platforms: [.macOS(.v12), .iOS(.v15)],
  products: [
    .library(name: "PerchTaskStatus", targets: ["PerchTaskStatus"])
  ],
  targets: [
    .target(name: "PerchTaskStatus"),
    .testTarget(
      name: "PerchTaskStatusTests",
      dependencies: ["PerchTaskStatus"]
    )
  ]
)
