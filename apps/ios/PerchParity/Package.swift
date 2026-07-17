// swift-tools-version:5.9
import PackageDescription

// Standalone parity harness for the E2E crypto. It compiles the SAME
// Crypto.swift the iOS app uses (its single source of truth lives here) and
// runs the cross-language golden vectors under `swift test` on macOS - no
// simulator needed. This is the #1-risk gate from the WAN relay plan: a payload
// sealed by the TypeScript server must decrypt in Swift and vice versa.
let package = Package(
  name: "PerchE2EE",
  platforms: [.macOS(.v12), .iOS(.v15)],
  products: [
    .library(name: "PerchE2EE", targets: ["PerchE2EE"])
  ],
  dependencies: [
    .package(url: "https://github.com/jedisct1/swift-sodium.git", from: "0.9.1")
  ],
  targets: [
    .target(
      name: "PerchE2EE",
      dependencies: [.product(name: "Clibsodium", package: "swift-sodium")]
    ),
    .testTarget(
      name: "PerchE2EETests",
      dependencies: ["PerchE2EE"],
      resources: [.copy("vectors.json")]
    )
  ]
)
