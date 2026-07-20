// swift-tools-version:5.9
import PackageDescription

// Standalone harness for the connection-status hysteresis used by the iOS
// app. Keeping the state machine free of SwiftUI makes relay-flap timing
// deterministic under `swift test`.
let package = Package(
  name: "PerchConnectivity",
  platforms: [.macOS(.v12), .iOS(.v15)],
  products: [
    .library(name: "PerchConnectivity", targets: ["PerchConnectivity"])
  ],
  targets: [
    .target(name: "PerchConnectivity"),
    .testTarget(
      name: "PerchConnectivityTests",
      dependencies: ["PerchConnectivity"]
    )
  ]
)
