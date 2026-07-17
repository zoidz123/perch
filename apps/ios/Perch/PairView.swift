import AVFoundation
import SwiftUI

// Pairing sheet: live QR scan on device, paste fallback everywhere (and the
// only path on the simulator, which has no camera).
struct PairView: View {
    @EnvironmentObject private var store: PerchStore
    @Environment(\.dismiss) private var dismiss

    @State private var pastedOffer = ""
    @State private var isPairing = false
    @State private var pairError: String?
    @State private var cameraAuthorized = false
    @State private var scanResetToken = 0

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                if cameraAuthorized {
                    QRScannerView(resetToken: scanResetToken) { code in
                        Task { await pair(with: code) }
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .stroke(Style.hairline)
                    }
                    .frame(maxHeight: 340)

                    Text("Point at the QR from `perch pair`")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Style.textSecondary)
                } else {
                    VStack(spacing: 10) {
                        Image(systemName: "qrcode.viewfinder")
                            .font(.system(size: 44, weight: .light))
                            .foregroundStyle(Style.textSecondary)
                        Text("Run `perch pair` on your Mac, then scan the QR or paste the offer link below.")
                            .font(.system(size: 14))
                            .foregroundStyle(Style.textSecondary)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 36)
                    .background(Style.panel)
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                }

                HStack(spacing: 8) {
                    TextField("perch://pair#offer=...", text: $pastedOffer)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.system(size: 13, design: .monospaced))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                        .background(Style.panel)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

                    Button {
                        Task { await pair(with: pastedOffer) }
                    } label: {
                        if isPairing {
                            ProgressView()
                        } else {
                            Text("Pair")
                                .fontWeight(.semibold)
                        }
                    }
                    .buttonStyle(.glassProminent)
                    .disabled(pastedOffer.trimmingCharacters(in: .whitespaces).isEmpty || isPairing)
                }

                if let pairError {
                    Text(pairError)
                        .font(.system(size: 13))
                        .foregroundStyle(Style.errorText)
                        .multilineTextAlignment(.center)
                }

                Spacer()
            }
            .padding(16)
            .navigationTitle("Pair with your Mac")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
            .task { await requestCamera() }
        }
        .preferredColorScheme(.dark)
    }

    private func requestCamera() async {
        #if targetEnvironment(simulator)
        cameraAuthorized = false
        #else
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            cameraAuthorized = true
        case .notDetermined:
            cameraAuthorized = await AVCaptureDevice.requestAccess(for: .video)
        default:
            cameraAuthorized = false
        }
        #endif
    }

    private func pair(with text: String) async {
        guard !isPairing else { return }
        isPairing = true
        pairError = nil
        defer { isPairing = false }

        do {
            try await store.pair(offerText: text)
            dismiss()
        } catch {
            pairError = error.localizedDescription
            // Let the scanner report the same QR again on the next attempt.
            scanResetToken += 1
        }
    }
}

// Thin AVFoundation wrapper that reports each decoded QR payload once.
// Bumping resetToken clears the dedupe so the same QR can be scanned again
// (e.g. retry after a failed pairing attempt).
struct QRScannerView: UIViewControllerRepresentable {
    var resetToken = 0
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> QRScannerController {
        let controller = QRScannerController()
        controller.onCode = onCode
        controller.appliedResetToken = resetToken
        return controller
    }

    func updateUIViewController(_ controller: QRScannerController, context: Context) {
        if controller.appliedResetToken != resetToken {
            controller.appliedResetToken = resetToken
            controller.lastCode = nil
        }
    }
}

// Metadata callbacks are dispatched on .main (see setMetadataObjectsDelegate),
// so the @preconcurrency conformance is safe under strict concurrency.
final class QRScannerController: UIViewController, @preconcurrency AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?
    var appliedResetToken = 0
    var lastCode: String?

    private let session = AVCaptureSession()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        guard
            let device = AVCaptureDevice.default(for: .video),
            let input = try? AVCaptureDeviceInput(device: device),
            session.canAddInput(input)
        else {
            return
        }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.addSublayer(preview)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        view.layer.sublayers?.first { $0 is AVCaptureVideoPreviewLayer }?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        if !session.isRunning {
            DispatchQueue.global(qos: .userInitiated).async { [session] in
                session.startRunning()
            }
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if session.isRunning {
            session.stopRunning()
        }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard
            let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
            object.type == .qr,
            let code = object.stringValue,
            code != lastCode
        else {
            return
        }
        lastCode = code
        onCode?(code)
    }
}
