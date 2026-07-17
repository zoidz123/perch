import Foundation

// Client-side E2E channel over the raw WebSocket, mirroring the server's
// EncryptedServerChannel. The phone generates
// a fresh ephemeral box keypair per connection, derives the shared key from the
// server's long-term public key (the pairing offer's `pk`), runs the
// hello/ready handshake, then sends the device token as the FIRST encrypted
// frame and encrypts every app frame after that.
//
// This type is pure protocol logic: it does not own the URLSessionWebSocketTask.
// PerchStore drives the socket and asks the channel to classify inbound frames
// and seal outbound ones, so the reconnect/keepalive machinery stays unchanged.
final class EncryptedChannel {
  // The result of classifying one inbound raw text frame.
  enum Inbound {
    case ready // server acked the handshake; the caller sends auth + flushes.
    case plaintext(Data) // a decrypted app frame, ready for the payload decoder.
    case ignore // a duplicate/again handshake ack; nothing to do.
    case fatal(Error) // decrypt/protocol failure; the caller drops the socket.
  }

  private let sharedKey: Data
  private let ephemeralPublicKey: Data
  private let token: String
  private(set) var isOpen = false

  // Fails only if the offer's pk is malformed; the caller then falls back to the
  // legacy plaintext transport.
  init?(serverPublicKeyBase64: String, token: String) {
    guard let serverPublic = Data(base64Encoded: serverPublicKeyBase64) else { return nil }
    let pair = E2EE.generateKeyPair()
    guard
      let shared = try? E2EE.deriveSharedKey(ourSecret: pair.secretKey, peerPublic: serverPublic)
    else {
      return nil
    }
    self.sharedKey = shared
    self.ephemeralPublicKey = pair.publicKey
    self.token = token
  }

  // The plaintext e2ee_hello frame to send on connect and re-send every second
  // until the server replies e2ee_ready.
  func helloMessage() -> String {
    encodeJSON(["type": "e2ee_hello", "key": ephemeralPublicKey.base64EncodedString()]) ?? ""
  }

  // The sealed e2ee_auth frame: the first encrypted frame after the handshake,
  // carrying the device token end-to-end (never in a query param, never seen by
  // a relay).
  func authFrame() -> String? {
    guard
      let payload = encodeJSON(["type": "e2ee_auth", "token": token]),
      let data = payload.data(using: .utf8)
    else {
      return nil
    }
    return try? E2EE.sealFrame(sharedKey: sharedKey, plaintext: data)
  }

  // Seal an outbound app frame (JSON text) once the channel is open.
  func seal(_ text: String) -> String? {
    guard let data = text.data(using: .utf8) else { return nil }
    return try? E2EE.sealFrame(sharedKey: sharedKey, plaintext: data)
  }

  // Classify an inbound raw text frame: handshake acks are handled here; every
  // other frame is decrypted to plaintext for the existing payload decoder.
  func receive(_ text: String) -> Inbound {
    if let type = handshakeType(text) {
      guard type == "e2ee_ready" else { return .ignore }
      if isOpen { return .ignore }
      isOpen = true
      return .ready
    }
    do {
      return .plaintext(try E2EE.openFrame(sharedKey: sharedKey, frame: text))
    } catch {
      return .fatal(error)
    }
  }

  private func handshakeType(_ text: String) -> String? {
    guard
      let data = text.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let type = object["type"] as? String,
      type == "e2ee_hello" || type == "e2ee_ready"
    else {
      return nil
    }
    return type
  }

  private func encodeJSON(_ dict: [String: String]) -> String? {
    guard
      let data = try? JSONSerialization.data(withJSONObject: dict),
      let text = String(data: data, encoding: .utf8)
    else {
      return nil
    }
    return text
  }
}
