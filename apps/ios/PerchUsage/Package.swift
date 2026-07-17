// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "PerchUsage",
  platforms: [.macOS(.v12), .iOS(.v15)],
  products: [
    .library(name: "PerchUsage", targets: ["PerchUsage"])
  ],
  targets: [
    .target(name: "PerchUsage"),
    .testTarget(
      name: "PerchUsageTests",
      dependencies: ["PerchUsage"]
    )
  ]
)
