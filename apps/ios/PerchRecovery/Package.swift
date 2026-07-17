// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "PerchRecovery",
  platforms: [.macOS(.v12), .iOS(.v15)],
  products: [
    .library(name: "PerchRecovery", targets: ["PerchRecovery"])
  ],
  targets: [
    .target(name: "PerchRecovery"),
    .testTarget(name: "PerchRecoveryTests", dependencies: ["PerchRecovery"])
  ]
)
