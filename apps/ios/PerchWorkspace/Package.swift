// swift-tools-version:5.9
import PackageDescription

// Standalone harness for the Workspace home grouping. It compiles the SAME
// WorkspaceGrouping.swift the iOS app uses (its single source of truth lives
// here) and runs the grouping unit tests under `swift test` on macOS - no
// simulator needed. Same pattern as PerchParity/PerchE2EE.
let package = Package(
  name: "PerchWorkspace",
  platforms: [.macOS(.v12), .iOS(.v15)],
  products: [
    .library(name: "PerchWorkspace", targets: ["PerchWorkspace"])
  ],
  targets: [
    .target(name: "PerchWorkspace"),
    .testTarget(
      name: "PerchWorkspaceTests",
      dependencies: ["PerchWorkspace"]
    )
  ]
)
