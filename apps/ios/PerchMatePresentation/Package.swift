// swift-tools-version:5.9
import PackageDescription

// Focused, Foundation-only presentation contract for the Mate's pinned row.
// It runs under `swift test` on macOS while the iOS app imports the same source.
let package = Package(
  name: "PerchMatePresentation",
  platforms: [.macOS(.v12), .iOS(.v15)],
  products: [
    .library(name: "PerchMatePresentation", targets: ["PerchMatePresentation"])
  ],
  targets: [
    .target(name: "PerchMatePresentation"),
    .testTarget(
      name: "PerchMatePresentationTests",
      dependencies: ["PerchMatePresentation"]
    )
  ]
)
