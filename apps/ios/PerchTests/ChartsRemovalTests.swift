import XCTest
@testable import Perch

@MainActor
final class ChartsRemovalTests: XCTestCase {
    func testDeprecatedChartEventStillDecodes() throws {
        let data = Data(
            """
            {
              "type": "chart",
              "sessionId": "pty:worker",
              "chartId": "deprecated-chart",
              "name": "Old review",
              "reason": "updated",
              "at": "2026-08-07T18:00:00.000Z"
            }
            """.utf8
        )

        let event = try JSONDecoder().decode(AgentEvent.self, from: data)

        guard case let .chart(sessionId, chartId, name, reason, _) = event else {
            return XCTFail("Expected the deprecated chart event to decode")
        }
        XCTAssertEqual(sessionId, "pty:worker")
        XCTAssertEqual(chartId, "deprecated-chart")
        XCTAssertEqual(name, "Old review")
        XCTAssertEqual(reason, "updated")
    }

    func testPlanDestinationRemainsAvailableWithoutChartState() {
        let store = PerchStore()
        let plan = PlanDocument(
            path: "/workspace/docs/plans/remove-charts.md",
            relativePath: "docs/plans/remove-charts.md",
            title: "Remove Charts",
            date: "2026-08-07"
        )

        XCTAssertNil(store.openPlan)
        store.openPlan = plan
        XCTAssertEqual(store.openPlan, plan)
    }

    func testPlansHubIgnoresDeprecatedChartFields() throws {
        let data = Data(
            """
            {
              "projects": [
                {
                  "rootPath": "/workspace/perch",
                  "name": "Perch",
                  "charts": [{"id": "deprecated-chart"}],
                  "plans": [
                    {
                      "path": "/workspace/perch/docs/plans/remove-charts.md",
                      "relativePath": "docs/plans/remove-charts.md",
                      "title": "Remove Charts",
                      "date": "2026-08-07"
                    }
                  ]
                }
              ],
              "ungrouped": [{"id": "deprecated-chart"}]
            }
            """.utf8
        )

        let hub = try JSONDecoder().decode(PlansHubResponse.self, from: data)

        XCTAssertEqual(hub.projects.count, 1)
        XCTAssertEqual(hub.projects[0].plans.map(\.title), ["Remove Charts"])
    }
}
