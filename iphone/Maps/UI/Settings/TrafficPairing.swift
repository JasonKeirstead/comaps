import Foundation
import UIKit

/// Pairing with a self-hosted traffic service.
///
/// The QR carries a short-lived, single-use token rather than the API key itself, so a code can
/// be shown on a screen without exposing a long-lived secret:
/// `comaps://traffic/pair?u=<url-encoded base>&t=<token>`
///
/// Mirrors app/organicmaps/traffic/TrafficPairing.java on Android.
enum TrafficPairing {
    struct Request {
        let baseUrl: String
        let token: String
    }

    struct Result {
        let baseUrl: String
        let apiKey: String
        let serverName: String
    }

    enum Failure: LocalizedError {
        case unreachable(String)
        case rejected(String)
        case malformedResponse

        var errorDescription: String? {
            switch self {
            case .unreachable(let detail): return detail
            case .rejected(let detail): return detail
            case .malformedResponse: return "The traffic server sent an unexpected response."
            }
        }
    }

    private static let pairPrefix = "comaps://traffic/pair?"

    /// Trims, requires an http(s) scheme and a host, and guarantees a trailing slash. The client
    /// appends "{version}/{country}.traffic" straight onto this, so a missing slash silently
    /// produces requests to the wrong path.
    static func normalize(url raw: String) -> String? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty,
              text.hasPrefix("http://") || text.hasPrefix("https://"),
              let parsed = URL(string: text),
              let host = parsed.host,
              !host.isEmpty
        else { return nil }

        if !text.hasSuffix("/") { text += "/" }
        return text
    }

    /// Returns nil for anything that is not a CoMaps pairing code, so the scanner can keep
    /// scanning rather than complaining about every stray barcode in frame.
    static func parse(_ scanned: String) -> Request? {
        let text = scanned.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.hasPrefix(pairPrefix) else { return nil }

        var baseUrl: String?
        var token: String?
        for pair in text.dropFirst(pairPrefix.count).split(separator: "&") {
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard parts.count == 2 else { continue }
            let value = String(parts[1]).removingPercentEncoding ?? String(parts[1])
            switch parts[0] {
            case "u": baseUrl = value
            case "t": token = value
            default: break
            }
        }

        guard let baseUrl,
              let token,
              !token.isEmpty,
              let normalized = normalize(url: baseUrl)
        else { return nil }

        return Request(baseUrl: normalized, token: token)
    }

    static func redeem(_ request: Request) async throws -> Result {
        guard let endpoint = URL(string: request.baseUrl + "v1/pair") else {
            throw Failure.unreachable("That server address is not usable.")
        }

        var urlRequest = URLRequest(url: endpoint)
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 15
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try JSONSerialization.data(withJSONObject: [
            "token": request.token,
            "device": UIDevice.current.name,
        ])

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: urlRequest)
        } catch {
            throw Failure.unreachable("Could not reach the traffic server: \(error.localizedDescription)")
        }

        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]

        guard status == 200 else {
            if let detail = body?["error"] as? String, !detail.isEmpty {
                throw Failure.rejected(detail)
            }
            if status == 410 || status == 409 {
                throw Failure.rejected("That pairing code has expired or was already used. Generate a new one.")
            }
            throw Failure.rejected("The traffic server refused the pairing (HTTP \(status)).")
        }

        guard let body, let apiKey = body["apiKey"] as? String, !apiKey.isEmpty else {
            throw Failure.malformedResponse
        }

        // The server knows the address clients should use, which may differ from the one on the
        // QR when it sits behind a reverse proxy. Fall back to what we scanned.
        let baseUrl = normalize(url: body["baseUrl"] as? String ?? "") ?? request.baseUrl
        return Result(baseUrl: baseUrl, apiKey: apiKey, serverName: body["serverName"] as? String ?? "")
    }
}
