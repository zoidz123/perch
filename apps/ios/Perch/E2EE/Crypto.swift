import Foundation
import Clibsodium

// NaCl box E2E crypto for the perch encrypted channel, byte-identical to the
// TypeScript server's tweetnacl implementation (apps/server/src/e2ee/crypto.ts).
// It calls libsodium's crypto_box_*_afternm directly (the same NaCl primitive as
// tweetnacl's box.after / box.open.after), so the bytes match across languages.
//
// Wire frame, before base64:
//   [ 1B version ][ 24B nonce ][ ciphertext incl. 16B Poly1305 tag ]
//
// CryptoKit is deliberately NOT used: its AEAD is AES-GCM / ChaChaPoly, not
// XSalsa20-Poly1305, and its X25519 output would not feed a NaCl box.
public enum E2EE {
  // Wire version. Must match E2EE_VERSION in packages/shared. A frame with any
  // other version is rejected so the peer reconnects and renegotiates.
  public static let version: UInt8 = 0x01
  public static let nonceBytes = Int(crypto_box_noncebytes())

  public enum FrameError: Error, Equatable {
    case badVersion(UInt8)
    case truncated
    case badMAC
    case badKey
    case badBase64
  }

  private static let macBytes = Int(crypto_box_macbytes())
  private static let sharedKeyBytes = Int(crypto_box_beforenmbytes())
  // libsodium requires one-time initialization before any call.
  private static let initialized: Bool = { sodium_init() >= 0 }()
  private static func ensureInit() { _ = initialized }

  // Curve25519 ECDH into a precomputed 32-byte shared key (crypto_box_beforenm),
  // symmetric across the pair. Mirrors deriveSharedKey on the server.
  public static func deriveSharedKey(ourSecret: Data, peerPublic: Data) throws -> Data {
    ensureInit()
    guard
      ourSecret.count == Int(crypto_box_secretkeybytes()),
      peerPublic.count == Int(crypto_box_publickeybytes())
    else {
      throw FrameError.badKey
    }
    var shared = [UInt8](repeating: 0, count: sharedKeyBytes)
    let rc = crypto_box_beforenm(&shared, [UInt8](peerPublic), [UInt8](ourSecret))
    guard rc == 0 else { throw FrameError.badKey }
    return Data(shared)
  }

  // Seals plaintext into a base64 frame with a fresh random 24-byte nonce. There
  // is no nonce counter and no reuse tracking (a documented protocol limit).
  public static func sealFrame(sharedKey: Data, plaintext: Data) throws -> String {
    ensureInit()
    var nonce = [UInt8](repeating: 0, count: nonceBytes)
    randombytes_buf(&nonce, nonceBytes)
    return try sealFrame(sharedKey: sharedKey, plaintext: plaintext, nonce: Data(nonce))
  }

  // Seals with a caller-supplied nonce. Used by the parity harness to reproduce
  // a committed frame byte-for-byte; production uses the random-nonce variant.
  public static func sealFrame(sharedKey: Data, plaintext: Data, nonce: Data) throws -> String {
    ensureInit()
    guard nonce.count == nonceBytes else { throw FrameError.truncated }
    guard sharedKey.count == sharedKeyBytes else { throw FrameError.badKey }
    var cipher = [UInt8](repeating: 0, count: plaintext.count + macBytes)
    let rc = crypto_box_easy_afternm(
      &cipher,
      [UInt8](plaintext),
      UInt64(plaintext.count),
      [UInt8](nonce),
      [UInt8](sharedKey)
    )
    guard rc == 0 else { throw FrameError.badKey }
    var frame = Data([version])
    frame.append(nonce)
    frame.append(contentsOf: cipher)
    return frame.base64EncodedString()
  }

  // Reverses sealFrame: rejects an unknown version byte, a truncated frame, or a
  // bad Poly1305 tag (tampered ciphertext / wrong key).
  public static func openFrame(sharedKey: Data, frame: String) throws -> Data {
    ensureInit()
    guard let bytes = Data(base64Encoded: frame) else { throw FrameError.badBase64 }
    guard bytes.count >= 1 + nonceBytes + macBytes else { throw FrameError.truncated }
    guard sharedKey.count == sharedKeyBytes else { throw FrameError.badKey }
    let all = [UInt8](bytes)
    let ver = all[0]
    guard ver == version else { throw FrameError.badVersion(ver) }
    let nonce = Array(all[1..<(1 + nonceBytes)])
    let cipher = Array(all[(1 + nonceBytes)...])
    var message = [UInt8](repeating: 0, count: cipher.count - macBytes)
    let rc = crypto_box_open_easy_afternm(
      &message,
      cipher,
      UInt64(cipher.count),
      nonce,
      [UInt8](sharedKey)
    )
    guard rc == 0 else { throw FrameError.badMAC }
    return Data(message)
  }

  // A fresh ephemeral box keypair; the phone generates one per connection so no
  // persistent phone-side secret exists to steal.
  public static func generateKeyPair() -> (publicKey: Data, secretKey: Data) {
    ensureInit()
    var pk = [UInt8](repeating: 0, count: Int(crypto_box_publickeybytes()))
    var sk = [UInt8](repeating: 0, count: Int(crypto_box_secretkeybytes()))
    crypto_box_keypair(&pk, &sk)
    return (Data(pk), Data(sk))
  }
}
