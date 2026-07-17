import XCTest
@testable import PerchE2EE

// The cross-language parity gate. Every vector was produced by the TypeScript
// server's tweetnacl primitives (apps/server/src/e2ee/crypto.ts + vectors.json).
// If any of these fail, the Swift and TS crypto have diverged and the channel
// must not ship.
struct Vector: Decodable {
  let label: String
  let serverPub: String
  let serverSec: String
  let phonePub: String
  let phoneSec: String
  let nonce: String
  let plaintext: String
  let frame: String
}

final class CryptoParityTests: XCTestCase {
  private func loadVectors() throws -> [Vector] {
    let url = try XCTUnwrap(
      Bundle.module.url(forResource: "vectors", withExtension: "json"),
      "vectors.json missing from the test bundle"
    )
    return try JSONDecoder().decode([Vector].self, from: Data(contentsOf: url))
  }

  private func b64(_ s: String) throws -> Data {
    try XCTUnwrap(Data(base64Encoded: s), "bad base64: \(s)")
  }

  // Direction 1: a TS-produced frame decrypts in Swift to the expected plaintext,
  // from BOTH the server's and the phone's derived shared key.
  func testTSFramesDecryptInSwift() throws {
    for v in try loadVectors() {
      let serverShared = try E2EE.deriveSharedKey(
        ourSecret: try b64(v.serverSec), peerPublic: try b64(v.phonePub))
      let phoneShared = try E2EE.deriveSharedKey(
        ourSecret: try b64(v.phoneSec), peerPublic: try b64(v.serverPub))
      XCTAssertEqual(serverShared, phoneShared, "\(v.label): shared keys must match")

      let fromServer = try E2EE.openFrame(sharedKey: serverShared, frame: v.frame)
      let fromPhone = try E2EE.openFrame(sharedKey: phoneShared, frame: v.frame)
      XCTAssertEqual(String(data: fromServer, encoding: .utf8), v.plaintext, "\(v.label)")
      XCTAssertEqual(String(data: fromPhone, encoding: .utf8), v.plaintext, "\(v.label)")
    }
  }

  // Direction 2: Swift, given the vector's nonce, re-seals the plaintext and
  // reproduces the committed frame byte-for-byte. This is the strict parity gate.
  func testSwiftReSealsToExactFrame() throws {
    for v in try loadVectors() {
      let shared = try E2EE.deriveSharedKey(
        ourSecret: try b64(v.serverSec), peerPublic: try b64(v.phonePub))
      let reSealed = try E2EE.sealFrame(
        sharedKey: shared,
        plaintext: Data(v.plaintext.utf8),
        nonce: try b64(v.nonce)
      )
      XCTAssertEqual(reSealed, v.frame, "\(v.label): Swift re-seal must equal the TS frame")
    }
  }

  // A Swift-sealed frame (random nonce) round-trips back through Swift open, and
  // its version byte is E2EE.version.
  func testSwiftRoundTripAndVersionByte() throws {
    let phone = E2EE.generateKeyPair()
    let server = E2EE.generateKeyPair()
    let shared = try E2EE.deriveSharedKey(ourSecret: phone.secretKey, peerPublic: server.publicKey)
    let serverShared = try E2EE.deriveSharedKey(
      ourSecret: server.secretKey, peerPublic: phone.publicKey)

    let frame = try E2EE.sealFrame(sharedKey: shared, plaintext: Data("hello perch".utf8))
    let opened = try E2EE.openFrame(sharedKey: serverShared, frame: frame)
    XCTAssertEqual(String(data: opened, encoding: .utf8), "hello perch")

    let raw = try XCTUnwrap(Data(base64Encoded: frame))
    XCTAssertEqual(raw[raw.startIndex], E2EE.version)
  }

  func testTamperedFrameFailsMAC() throws {
    let v = try loadVectors().first { $0.label == "ascii-json" }!
    let shared = try E2EE.deriveSharedKey(
      ourSecret: try b64(v.serverSec), peerPublic: try b64(v.phonePub))
    var raw = try b64(v.frame)
    raw[raw.endIndex - 1] ^= 0x01 // flip a ciphertext bit
    let tampered = raw.base64EncodedString()
    XCTAssertThrowsError(try E2EE.openFrame(sharedKey: shared, frame: tampered)) { error in
      XCTAssertEqual(error as? E2EE.FrameError, .badMAC)
    }
  }

  func testUnknownVersionRejected() throws {
    let v = try loadVectors().first!
    let shared = try E2EE.deriveSharedKey(
      ourSecret: try b64(v.serverSec), peerPublic: try b64(v.phonePub))
    var raw = try b64(v.frame)
    raw[raw.startIndex] = 0x02
    XCTAssertThrowsError(try E2EE.openFrame(sharedKey: shared, frame: raw.base64EncodedString())) {
      error in
      XCTAssertEqual(error as? E2EE.FrameError, .badVersion(0x02))
    }
  }

  func testTruncatedFrameRejected() throws {
    let v = try loadVectors().first!
    let shared = try E2EE.deriveSharedKey(
      ourSecret: try b64(v.serverSec), peerPublic: try b64(v.phonePub))
    let raw = try b64(v.frame).prefix(10)
    XCTAssertThrowsError(
      try E2EE.openFrame(sharedKey: shared, frame: Data(raw).base64EncodedString())
    ) { error in
      XCTAssertEqual(error as? E2EE.FrameError, .truncated)
    }
  }
}
