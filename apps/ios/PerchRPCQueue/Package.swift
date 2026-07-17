// swift-tools-version:5.9
import PackageDescription

// Standalone harness for the relay RPC send queue. The app uses the same
// helper shape in Perch/RPCSendQueue.swift; this package keeps the timeout
// regression runnable with swift test on macOS.
let package = Package(
  name: "PerchRPCQueue",
  platforms: [.macOS(.v12), .iOS(.v15)],
  products: [
    .library(name: "PerchRPCQueue", targets: ["PerchRPCQueue"])
  ],
  targets: [
    .target(name: "PerchRPCQueue"),
    .testTarget(
      name: "PerchRPCQueueTests",
      dependencies: ["PerchRPCQueue"]
    )
  ]
)
