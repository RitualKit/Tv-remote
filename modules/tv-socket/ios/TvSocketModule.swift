import CryptoKit
import ExpoModulesCore
import Foundation
import Security

/// WebSocket client for a Samsung TV's secure remote-control port (8002).
///
/// The TV presents a self-signed certificate that URLSession would normally reject. This module
/// accepts it, with three limits:
///  - only for `wss://` URLs whose host is a private-LAN IPv4 address (10/8, 172.16/12, 192.168/16);
///  - only for the exact host being opened;
///  - if JS passes a pinned SHA-256 (saved on first connect), the leaf cert must match it.
public final class TvSocketModule: Module {
  private var connections: [String: TvSocketConnection] = [:]
  private let lock = NSLock()

  public func definition() -> ModuleDefinition {
    Name("TvSocket")

    Events("onOpen", "onMessage", "onClose", "onError")

    Function("open") { (id: String, url: String, pinnedSha256: String?) in
      guard let target = URL(string: url), target.scheme == "wss",
            let host = target.host, TvSocketConnection.isPrivateIPv4(host) else {
        self.sendEvent("onError", [
          "id": id,
          "message": "Only wss:// connections to a private LAN IPv4 address are allowed.",
          "fatal": true,
        ])
        self.sendEvent("onClose", ["id": id, "code": 1006, "reason": "rejected"])
        return
      }
      let connection = TvSocketConnection(
        id: id,
        url: target,
        pinnedSha256: pinnedSha256?.lowercased(),
        emit: { [weak self] name, body in self?.sendEvent(name, body) },
        onFinish: { [weak self] finishedId in self?.remove(finishedId) }
      )
      self.store(id, connection)
      connection.start()
    }

    // Multi-statement bodies on purpose: a single `x?.f()` expression would make the closure
    // return `Void?`, which isn't a JS-convertible return type.
    Function("send") { (id: String, text: String) in
      guard let connection = self.connection(for: id) else { return }
      connection.send(text)
    }

    Function("close") { (id: String) in
      guard let connection = self.connection(for: id) else { return }
      connection.close()
    }

    OnDestroy {
      self.lock.lock()
      let all = Array(self.connections.values)
      self.connections.removeAll()
      self.lock.unlock()
      all.forEach { $0.close() }
    }
  }

  private func store(_ id: String, _ connection: TvSocketConnection) {
    lock.lock()
    let previous = connections[id]
    connections[id] = connection
    lock.unlock()
    previous?.close()
  }

  private func connection(for id: String) -> TvSocketConnection? {
    lock.lock()
    defer { lock.unlock() }
    return connections[id]
  }

  private func remove(_ id: String) {
    lock.lock()
    connections.removeValue(forKey: id)
    lock.unlock()
  }
}

/// One socket. All state is touched only on `dispatchQueue` (also the URLSession delegate queue).
final class TvSocketConnection: NSObject, URLSessionWebSocketDelegate {
  private static let pingInterval: TimeInterval = 20

  private let id: String
  private let url: URL
  private let pinnedSha256: String?
  private let emit: (String, [String: Any?]) -> Void
  private let onFinish: (String) -> Void
  private let dispatchQueue: DispatchQueue
  private let operationQueue = OperationQueue()

  private var session: URLSession?
  private var task: URLSessionWebSocketTask?
  private var certSha256: String?
  private var pinMismatch = false
  private var finished = false

  init(
    id: String,
    url: URL,
    pinnedSha256: String?,
    emit: @escaping (String, [String: Any?]) -> Void,
    onFinish: @escaping (String) -> Void
  ) {
    self.id = id
    self.url = url
    self.pinnedSha256 = (pinnedSha256?.isEmpty ?? true) ? nil : pinnedSha256
    self.emit = emit
    self.onFinish = onFinish
    self.dispatchQueue = DispatchQueue(label: "TvSocket.\(id)")
    super.init()
    operationQueue.underlyingQueue = dispatchQueue
    operationQueue.maxConcurrentOperationCount = 1
  }

  static func isPrivateIPv4(_ host: String) -> Bool {
    let parts = host.split(separator: ".", omittingEmptySubsequences: false).compactMap { UInt8($0) }
    guard parts.count == 4, host.split(separator: ".").count == 4 else { return false }
    switch (parts[0], parts[1]) {
    case (10, _): return true
    case (172, 16...31): return true
    case (192, 168): return true
    default: return false
    }
  }

  func start() {
    dispatchQueue.async {
      // `.ephemeral`, not `.default`: no cookies/cache, and the dev-client network inspector only
      // hooks `.default`, so it can't interfere with the certificate handling below.
      let session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: self.operationQueue)
      let task = session.webSocketTask(with: self.url)
      task.maximumMessageSize = 8 * 1024 * 1024
      self.session = session
      self.task = task
      task.resume()
      self.receiveNext()
    }
  }

  func send(_ text: String) {
    dispatchQueue.async {
      guard !self.finished, let task = self.task else { return }
      task.send(.string(text)) { [weak self] error in
        guard let self, let error else { return }
        self.dispatchQueue.async { self.fail(error.localizedDescription) }
      }
    }
  }

  func close() {
    dispatchQueue.async {
      guard !self.finished else { return }
      self.task?.cancel(with: .normalClosure, reason: nil)
      self.finish(code: 1000, reason: "")
    }
  }

  // MARK: - Receiving / keep-alive

  private func receiveNext() {
    task?.receive { [weak self] result in
      guard let self else { return }
      self.dispatchQueue.async {
        guard !self.finished else { return }
        switch result {
        case .success(.string(let text)):
          self.emit("onMessage", ["id": self.id, "data": text])
          self.receiveNext()
        case .success(.data(let data)):
          self.emit("onMessage", ["id": self.id, "data": String(decoding: data, as: UTF8.self)])
          self.receiveNext()
        case .success:
          self.receiveNext()
        case .failure(let error):
          self.fail(error.localizedDescription)
        }
      }
    }
  }

  private func schedulePing() {
    dispatchQueue.asyncAfter(deadline: .now() + Self.pingInterval) { [weak self] in
      guard let self, !self.finished, let task = self.task else { return }
      task.sendPing { [weak self] error in
        guard let self else { return }
        self.dispatchQueue.async {
          if let error { self.fail("Keep-alive failed: \(error.localizedDescription)") } else { self.schedulePing() }
        }
      }
    }
  }

  // MARK: - URLSession delegate (runs on operationQueue → dispatchQueue)

  func urlSession(
    _ session: URLSession,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    let space = challenge.protectionSpace
    guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust,
          space.host == url.host,
          let trust = space.serverTrust,
          let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
          let leaf = chain.first
    else {
      completionHandler(.performDefaultHandling, nil)
      return
    }
    let der = SecCertificateCopyData(leaf) as Data
    let fingerprint = SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
    if let pinned = pinnedSha256, pinned != fingerprint {
      pinMismatch = true
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    certSha256 = fingerprint
    completionHandler(.useCredential, URLCredential(trust: trust))
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    guard !finished else { return }
    emit("onOpen", ["id": id, "certSha256": certSha256])
    schedulePing()
  }

  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
    reason: Data?
  ) {
    finish(code: closeCode.rawValue, reason: reason.map { String(decoding: $0, as: UTF8.self) } ?? "")
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if let error {
      fail(error.localizedDescription)
    } else {
      finish(code: 1000, reason: "")
    }
  }

  // MARK: - Teardown

  private func fail(_ message: String) {
    guard !finished else { return }
    if pinMismatch {
      emit("onError", [
        "id": id,
        "message": "The TV's certificate changed since pairing. If the TV was updated or replaced, use Settings → Reset TV certificate.",
        "fatal": true,
      ])
    } else {
      emit("onError", ["id": id, "message": message, "fatal": false])
    }
    finish(code: 1006, reason: message)
  }

  private func finish(code: Int, reason: String) {
    guard !finished else { return }
    finished = true
    emit("onClose", ["id": id, "code": code, "reason": reason])
    session?.invalidateAndCancel() // also breaks URLSession's strong reference to self
    session = nil
    task = nil
    onFinish(id)
  }
}
