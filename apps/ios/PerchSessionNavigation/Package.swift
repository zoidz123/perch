// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "PerchSessionNavigation",
  platforms: [.macOS(.v12), .iOS(.v15)],
  products: [
    .library(name: "PerchSessionNavigation", targets: ["PerchSessionNavigation"])
  ],
  targets: [
    .target(name: "PerchSessionNavigation"),
    .testTarget(
      name: "PerchSessionNavigationTests",
      dependencies: ["PerchSessionNavigation"]
    )
  ]
)
