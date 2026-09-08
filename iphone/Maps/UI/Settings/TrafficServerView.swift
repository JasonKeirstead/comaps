import SwiftUI

/// Pairing with a self-hosted traffic service.
///
/// Traffic has no default provider: the user runs their own server and points the app at it,
/// either by scanning the QR code the server prints or by typing its address in. See
/// docs/DEPLOY_OWN_TRAFFIC_SERVER.md.
struct TrafficServerView: View {
    @State private var serverUrl: String = ""
    @State private var apiKey: String = ""
    @State private var isScanning = false
    @State private var isPairing = false
    @State private var errorMessage: String?

    private var isConfigured: Bool {
        !Settings.trafficServerUrl.isEmpty
    }

    var body: some View {
        Form {
            Section {
                if isConfigured {
                    LabeledContent("traffic_server_title", value: Settings.trafficServerUrl)
                } else {
                    Text("traffic_server_summary_none")
                        .foregroundStyle(.secondary)
                }
            } footer: {
                Text("traffic_server_message")
            }

            Section {
                Button {
                    isScanning = true
                } label: {
                    Label("traffic_server_scan", systemImage: "qrcode.viewfinder")
                }
                .disabled(isPairing)
            }

            Section {
                TextField("traffic_server_url_hint", text: $serverUrl)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                TextField("traffic_server_key_hint", text: $apiKey)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()

                Button("save") {
                    save()
                }
                .disabled(serverUrl.isEmpty)
            } header: {
                Text("traffic_server_manual")
            } footer: {
                if let errorMessage {
                    Text(errorMessage).foregroundStyle(.red)
                } else {
                    Text("traffic_server_enable_hint")
                }
            }

            if isConfigured {
                Section {
                    Button("traffic_server_disconnect", role: .destructive) {
                        Settings.setTrafficServer(url: "", apiKey: "")
                        serverUrl = ""
                        apiKey = ""
                    }
                }
            }
        }
        .navigationTitle("traffic_server_title")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            serverUrl = Settings.trafficServerUrl
            apiKey = Settings.trafficApiKey
        }
        .sheet(isPresented: $isScanning) {
            TrafficQRScannerView { scanned in
                isScanning = false
                pair(with: scanned)
            }
        }
    }

    private func save() {
        guard let normalized = TrafficPairing.normalize(url: serverUrl) else {
            errorMessage = NSLocalizedString("traffic_server_url_error", comment: "")
            return
        }
        errorMessage = nil
        serverUrl = normalized
        Settings.setTrafficServer(url: normalized, apiKey: apiKey)
    }

    private func pair(with scanned: String) {
        guard let request = TrafficPairing.parse(scanned) else {
            errorMessage = NSLocalizedString("traffic_server_url_error", comment: "")
            return
        }

        isPairing = true
        errorMessage = nil

        Task {
            do {
                let result = try await TrafficPairing.redeem(request)
                Settings.setTrafficServer(url: result.baseUrl, apiKey: result.apiKey)
                serverUrl = result.baseUrl
                apiKey = result.apiKey
            } catch {
                errorMessage = String(
                    format: NSLocalizedString("traffic_server_pair_failed", comment: ""),
                    error.localizedDescription
                )
            }
            isPairing = false
        }
    }
}
