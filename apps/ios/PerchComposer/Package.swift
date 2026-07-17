// swift-tools-version:5.9
import PackageDescription

// Standalone harness for composer state ownership. It compiles the same
// SessionScopedValues helper the iOS app uses and runs focused unit tests under
// `swift test` on macOS - no simulator needed.
let package = Package(
  name: "PerchComposer",
  platforms: [.macOS(.v12), .iOS(.v15)],
  products: [
    .library(name: "PerchComposer", targets: ["PerchComposer"])
  ],
  targets: [
    .target(name: "PerchComposer"),
    .testTarget(
      name: "PerchComposerTests",
      dependencies: ["PerchComposer"]
    )
  ]
)
