// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "GravitonComputerUse",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "graviton-computer-use", targets: ["GravitonComputerUse"])],
    targets: [.executableTarget(name: "GravitonComputerUse")]
)
