import AppKit
import SwiftUI

@main
struct Preview {
    @MainActor
    static func main() throws {
        let application = NSApplication.shared
        application.setActivationPolicy(.prohibited)
        let suite = "dev.rwoll.BlobbyType.preview.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.set(false, forKey: "soundEnabled")
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = PracticeStore(defaults: defaults)
        let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

        let variants = CommandLine.arguments.contains("--fingers")
            ? ["fingers-light", "fingers-dark", "fingers-shift", "fingers-shift-left", "fingers-space", "fingers-error", "fingers-done", "fingers-minimum"]
            : ["light", "dark", "running", "result", "history", "minimum", "code", "punctuation"]
        for variant in variants {
            store.reset(drill: .words, duration: 60)
            store.showingHistory = false
            if variant == "code" { store.reset(drill: .code) }
            if variant == "punctuation" { store.reset(drill: .sentences) }
            if variant == "running" || variant == "result" {
                let now = ProcessInfo.processInfo.systemUptime
                let prompt = String(store.session.prompt.prefix(65))
                store.handle(.type(prompt), at: now - 12)
                store.handle(.type("~"), at: now - 1)
                store.tick(at: variant == "running" ? now : now + 48)
            }
            if variant == "history" { store.showingHistory = true }
            if variant.hasPrefix("fingers") {
                store.selectLesson(FingerLesson.all[variant.hasPrefix("fingers-shift") ? 5 : 0])
                if variant == "fingers-shift-left" { store.handleTechnique(.type(String(store.technique.lesson.prompt.prefix(12)))) }
                if variant == "fingers-space" { store.handleTechnique(.type("fj")) }
                if variant == "fingers-error" { store.handleTechnique(.type("x")) }
                if variant == "fingers-done" { store.handleTechnique(.type(store.technique.lesson.prompt)) }
            }
            let size = variant.hasSuffix("minimum") ? NSSize(width: 1020, height: 760) : NSSize(width: 1120, height: 800)
            let hosting = NSHostingView(rootView: ContentView(store: store).environment(
                \.colorScheme, variant.hasSuffix("dark") || variant == "running" ? .dark : .light
            ))
            let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
            window.contentView = hosting
            window.setContentSize(size)
            hosting.frame = NSRect(origin: .zero, size: size)
            hosting.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.2))
            guard let bitmap = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else {
                throw NSError(domain: "Preview", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not allocate native preview bitmap"])
            }
            hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
            guard let png = bitmap.representation(using: .png, properties: [:]) else {
                throw NSError(domain: "Preview", code: 2, userInfo: [NSLocalizedDescriptionKey: "Could not encode native preview"])
            }
            try png.write(to: output.appendingPathComponent("\(variant).png"))
            print("Rendered \(variant): \(Int(hosting.bounds.width)) x \(Int(hosting.bounds.height))")
            if variant == "light" {
                let inputs = descendants(of: hosting).compactMap { $0 as? PracticeTextView }
                guard inputs.count == 1, let input = inputs.first else {
                    throw NSError(domain: "Preview", code: 3, userInfo: [NSLocalizedDescriptionKey: "Expected exactly one native input"])
                }
                window.makeFirstResponder(input)
                let character = String(store.session.prompt.prefix(1))
                guard let key = NSEvent.keyEvent(
                    with: .keyDown, location: .zero, modifierFlags: [],
                    timestamp: ProcessInfo.processInfo.systemUptime,
                    windowNumber: window.windowNumber, context: nil,
                    characters: character, charactersIgnoringModifiers: character,
                    isARepeat: false, keyCode: 0
                ) else {
                    throw NSError(domain: "Preview", code: 4, userInfo: [NSLocalizedDescriptionKey: "Could not create native key event"])
                }
                input.keyDown(with: key)
                guard store.session.attempts == 1 && store.session.phase == .running else {
                    throw NSError(domain: "Preview", code: 4, userInfo: [NSLocalizedDescriptionKey: "Native input failed to start scoring"])
                }
                RunLoop.main.run(until: Date().addingTimeInterval(0.1))
                guard input.string == character else {
                    throw NSError(domain: "Preview", code: 5, userInfo: [NSLocalizedDescriptionKey: "Scored input didn't update native text"])
                }
                guard let backspace = NSEvent.keyEvent(
                    with: .keyDown, location: .zero, modifierFlags: [],
                    timestamp: ProcessInfo.processInfo.systemUptime,
                    windowNumber: window.windowNumber, context: nil,
                    characters: "\u{7f}", charactersIgnoringModifiers: "\u{7f}",
                    isARepeat: false, keyCode: 51
                ) else {
                    throw NSError(domain: "Preview", code: 5, userInfo: [NSLocalizedDescriptionKey: "Could not create native Backspace event"])
                }
                input.keyDown(with: backspace)
                guard store.session.input.isEmpty && store.session.backspaces == 1 else {
                    throw NSError(domain: "Preview", code: 5, userInfo: [NSLocalizedDescriptionKey: "Native Backspace failed"])
                }
                print("PASS native keyboard events, scoring, text synchronization, and Backspace")
            }
            if variant == "fingers-light" {
                guard let input = descendants(of: hosting).compactMap({ $0 as? PracticeTextView }).first,
                      let key = NSEvent.keyEvent(
                        with: .keyDown, location: .zero, modifierFlags: [],
                        timestamp: ProcessInfo.processInfo.systemUptime,
                        windowNumber: window.windowNumber, context: nil,
                        characters: "f", charactersIgnoringModifiers: "f", isARepeat: false, keyCode: 3
                      ) else {
                    throw NSError(domain: "Preview", code: 6, userInfo: [NSLocalizedDescriptionKey: "Missing guided native input"])
                }
                input.keyDown(with: key)
                RunLoop.main.run(until: Date().addingTimeInterval(0.1))
                guard input.string == "f" && store.technique.nextCharacter == "j" && store.technique.guidance?.finger == .rightIndex else {
                    throw NSError(domain: "Preview", code: 7, userInfo: [NSLocalizedDescriptionKey: "Guided key event didn't update text and finger guidance"])
                }
                input.insertText("x", replacementRange: NSRange(location: NSNotFound, length: 0))
                guard store.technique.nextCharacter == "j" && store.technique.lastMistake == "x" else {
                    throw NSError(domain: "Preview", code: 8, userInfo: [NSLocalizedDescriptionKey: "Wrong lesson key advanced the target"])
                }
                print("PASS guided keyboard event, native text, next-finger mapping, and wrong-key gating")
            }
            window.close()
        }
        if CommandLine.arguments.contains("--sound-check") {
            let sounds = try SoundEffects()
            for effect in FeedbackSound.allCases {
                try sounds.play(effect)
                RunLoop.main.run(until: Date().addingTimeInterval(effect.duration + 0.05))
            }
            print("PASS macOS playback of all three generated sound effects")
        }
    }

    @MainActor
    static func descendants(of view: NSView) -> [NSView] {
        view.subviews.flatMap { [$0] + descendants(of: $0) }
    }
}
