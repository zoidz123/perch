// swift-tools-version:5.9
import PackageDescription

// Standalone harness for the dictation record -> stop -> review flow. It
// compiles the SAME DictationFlow.swift the iOS app uses (its single source of
// truth lives here) and runs the state-machine unit tests under `swift test`
// on macOS - no simulator or microphone needed. Same pattern as
// PerchWorkspace/PerchParity.
let package = Package(
  name: "PerchDictation",
  platforms: [.macOS(.v12), .iOS(.v15)],
  products: [
    .library(name: "PerchDictation", targets: ["PerchDictation"])
  ],
  targets: [
    .target(name: "PerchDictation"),
    .testTarget(
      name: "PerchDictationTests",
      dependencies: ["PerchDictation"]
    )
  ]
)
