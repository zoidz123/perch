import XCTest
@testable import PerchRecovery

final class RecoveryPresentationTests: XCTestCase {
    func testRuntimeSnapshotDecodesPersistedIdentityWithoutLiveSession() throws {
        let runtime = try JSONDecoder().decode(RuntimeSnapshotModel.self, from: Data(#"""
        {
          "id":"runtime:1","workerId":"task:1","generation":2,"state":"recoverable",
          "provider":"codex","providerSessionId":"thread:trusted","agent":"codex",
          "workerName":"Alder","ptySessionId":"pty:gone","recoveryAvailable":true,
          "createdAt":"2026-07-14T00:00:00Z","updatedAt":"2026-07-14T00:01:00Z"
        }
        """#.utf8))

        XCTAssertEqual(runtime.workerName, "Alder")
        XCTAssertEqual(RecoveryIdentity.provider(runtime: runtime, sessionAgent: nil), "Codex")
        XCTAssertEqual(RuntimePresentation.make(runtime: runtime, action: nil).label, "Recoverable")
    }

    func testLegacyRuntimeStaysNamedAndExplainsUnavailableRecovery() throws {
        let runtime = try JSONDecoder().decode(RuntimeSnapshotModel.self, from: Data(#"""
        {
          "id":"runtime:old","workerId":"task:old","generation":0,"state":"recoverable",
          "agent":"unknown","workerName":"Wren","recoveryAvailable":false,
          "recoveryUnavailableReason":"provider_session_unknown",
          "createdAt":"2026-07-14T00:00:00Z","updatedAt":"2026-07-14T00:01:00Z"
        }
        """#.utf8))

        XCTAssertEqual(RecoveryIdentity.workerName(taskName: nil, runtimeName: runtime.workerName, sessionName: nil, title: "Old work"), "Wren")
        let presentation = RuntimePresentation.make(runtime: runtime, action: nil)
        XCTAssertEqual(presentation.label, "Interrupted")
        XCTAssertEqual(presentation.detail, "Recovery unavailable - provider identity was not recorded")
        XCTAssertFalse(presentation.canRecover)
        XCTAssertNil(RecoveryIdentity.provider(runtime: runtime, sessionAgent: nil))
    }

    func testRuntimePresentationDoesNotDeriveTaskMeaningFromSessionAbsence() {
        let runtime = fixture(state: "live", recoveryAvailable: false)
        let presentation = RuntimePresentation.make(runtime: runtime, action: nil)
        XCTAssertEqual(presentation.label, "Live")
        XCTAssertFalse(presentation.canRecover)
    }

    func testRecoveryActionStatesPreventDuplicateTapAndStayDistinct() {
        XCTAssertTrue(RecoveryActionState.inProgress.preventsDuplicateRequest)
        XCTAssertTrue(RecoveryActionState.success.preventsDuplicateRequest)
        XCTAssertTrue(RecoveryActionState.conflict("Already recovering").preventsDuplicateRequest)
        XCTAssertFalse(RecoveryActionState.failure("Try again").preventsDuplicateRequest)
        XCTAssertEqual(RuntimePresentation.make(runtime: fixture(), action: .inProgress).label, "Recovering")
        XCTAssertEqual(RuntimePresentation.make(runtime: fixture(), action: .conflict("Already recovering")).detail, "Already recovering")
        XCTAssertEqual(RuntimePresentation.make(runtime: fixture(), action: .unavailable("Recovery unavailable")).label, "Interrupted")
    }

    func testClientStatusClassification() {
        XCTAssertEqual(RecoveryRequestDisposition.classify(httpStatus: 409), .conflict)
        XCTAssertEqual(RecoveryRequestDisposition.classify(httpStatus: 404), .unavailable)
        XCTAssertEqual(RecoveryRequestDisposition.classify(httpStatus: 422), .unavailable)
        XCTAssertEqual(RecoveryRequestDisposition.classify(httpStatus: 500), .failure)
    }

    private func fixture(state: String = "recoverable", recoveryAvailable: Bool = true) -> RuntimeSnapshotModel {
        RuntimeSnapshotModel(
            id: "runtime:1", workerId: "task:1", generation: 1, state: state,
            provider: "claude", providerSessionId: "session:1", agent: "claude", model: nil,
            workerName: "Alder", parentSessionId: nil, worktreeId: nil, worktreePath: nil,
            leaseId: nil, ptySessionId: "pty:1", recoveryAvailable: recoveryAvailable,
            recoveryUnavailableReason: nil, createdAt: "t", updatedAt: "t", endedAt: nil
        )
    }
}
