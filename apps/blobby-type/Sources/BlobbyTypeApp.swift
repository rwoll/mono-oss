import AppKit
import SwiftUI

@main
struct BlobbyTypeApp: App {
    @StateObject private var store = PracticeStore()

    var body: some Scene {
        Window("Blobby Type", id: "practice") {
            ContentView(store: store)
        }
        .defaultSize(width: 1120, height: 800)
        .windowResizability(.contentMinSize)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("Restart Workout or Lesson") { store.restartCurrent() }
                    .keyboardShortcut("r", modifiers: .command)
                Button("Learn Fingers") { store.showTechnique() }
                    .keyboardShortcut("l", modifiers: .command)
                Button("Your Progress") { store.showingHistory = true }
                    .keyboardShortcut("h", modifiers: [.command, .shift])
            }
        }
    }
}
