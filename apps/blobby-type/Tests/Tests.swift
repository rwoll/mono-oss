import AppKit
import Foundation

struct TestFailure: Error, CustomStringConvertible {
    let description: String
}

@main
struct TypingTests {
    static func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw TestFailure(description: message) }
    }

    static func close(_ actual: Double, _ expected: Double, _ message: String) throws {
        try check(abs(actual - expected) < 0.000001, "\(message): got \(actual), expected \(expected)")
    }

    @MainActor
    static func main() throws {
        var completed = 0
        func test(_ name: String, _ body: () throws -> Void) throws {
            try body()
            completed += 1
            print("PASS \(name)")
        }

        try test("clock starts only on printable input") {
            var session = TypingSession(duration: 30, drill: .words, prompt: "hello world")
            session.tick(at: 100)
            session.handle(.backspace, at: 100)
            session.handle(.type("\n\t"), at: 100)
            try check(session.phase == .ready && session.attempts == 0, "Non-typing must not start a workout")
            session.handle(.type("h"), at: 120)
            session.tick(at: 125)
            try check(session.remaining == 25, "Clock must begin at first keystroke")
            try close(session.elapsed, 5, "Elapsed time")
        }

        try test("WPM uses five correct characters including spaces") {
            var session = TypingSession(duration: 60, drill: .words, prompt: "hello world")
            session.handle(.type("hello "), at: 10)
            session.tick(at: 40)
            try close(session.wpm, 2.4, "Six correct characters in half a minute")
            try close(session.accuracy, 100, "Clean input")
        }

        try test("correction improves WPM but preserves mistake history") {
            var session = TypingSession(duration: 60, drill: .words, prompt: "cat")
            session.handle(.type("cx"), at: 10)
            session.handle(.backspace, at: 11)
            session.handle(.type("a"), at: 12)
            session.tick(at: 40)
            try check(session.input == Array("ca"), "Backspace replaces last input")
            try check(session.attempts == 3 && session.mistakes == 1 && session.backspaces == 1, "Attempt accounting")
            try close(session.wpm, 0.8, "Corrected WPM")
            try close(session.accuracy, 200.0 / 3, "Historical accuracy")
        }

        try test("deleting correct text cannot inflate the score") {
            var session = TypingSession(duration: 60, drill: .words, prompt: "cat")
            session.handle(.type("ca"), at: 0)
            session.handle(.backspace, at: 1)
            session.handle(.type("a"), at: 2)
            session.tick(at: 60)
            try check(session.correctCharacters == 2 && session.attempts == 3, "Only current correct characters score")
            try close(session.result()!.wpm, 0.4, "Repeated characters are not double counted")
        }

        try test("deadline rejects keystrokes and backspace without a timer callback") {
            var session = TypingSession(duration: 30, drill: .words, prompt: "cat")
            session.handle(.type("c"), at: 100)
            session.handle(.type("a"), at: 129.99)
            session.handle(.type("t"), at: 130)
            session.handle(.backspace, at: 131)
            try check(session.phase == .finished && String(session.input) == "ca", "Deadline enforced on input")
            try check(session.attempts == 2 && session.backspaces == 0, "Expired input ignored")
            try close(session.elapsed, 30, "Elapsed capped at selected duration")
        }

        try test("clock is monotonic and late ticks finish at the deadline") {
            var session = TypingSession(duration: 30, drill: .words, prompt: "cat")
            session.handle(.type("c"), at: 100)
            session.tick(at: 110)
            session.tick(at: 105)
            try close(session.elapsed, 10, "Clock never runs backwards")
            session.tick(at: 500)
            try check(session.remaining == 0 && session.progress == 1, "Late timer must finish")
            try close(session.result()!.wpm, 0.4, "Use workout duration, not late timer duration")
        }

        try test("completed pages continue without resetting time or stats") {
            var session = TypingSession(duration: 60, drill: .words, prompt: "ab")
            session.handle(.type("ax"), at: 100)
            session.continueWith("cd")
            session.handle(.type("c"), at: 110)
            session.tick(at: 130)
            try check(session.completedCorrectCharacters == 1 && session.correctCharacters == 2, "Carry only correct characters forward")
            try check(session.attempts == 3 && session.mistakes == 1, "Keep attempts across pages")
            try close(session.elapsed, 30, "Keep original clock")
            try close(session.wpm, 0.8, "Combined WPM")
            session.continueWith("ignored")
            try check(String(session.prompt) == "cd", "Cannot skip unfinished page")
        }

        try test("multi-character input is bounded and Unicode stays character-aligned") {
            var session = TypingSession(duration: 30, drill: .sentences, prompt: "é👋")
            session.handle(.type("e\u{301}👋extra"), at: 1)
            try check(session.correctCharacters == 2 && session.attempts == 2, "Count graphemes, bound to prompt")
            try check(session.pageIsFull, "Unicode prompt completed")
        }

        try test("all drills produce usable practice pages") {
            for drill in Drill.allCases {
                for _ in 0..<20 {
                    let prompt = PracticeLibrary.makePrompt(for: drill)
                    try check(prompt.count >= 200, "\(drill) prompt too short")
                    try check(!prompt.contains("\n") && !prompt.hasPrefix(" ") && !prompt.hasSuffix(" "), "Prompt formatting")
                    if drill == .words {
                        let words = prompt.split(separator: " ")
                        try check(words.count == 65, "Word workout size")
                        try check(zip(words, words.dropFirst()).allSatisfy { $0 != $1 }, "Avoid consecutive repeated words")
                    }
                }
            }
        }

        let suite = "dev.rwoll.BlobbyType.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.set(false, forKey: "soundEnabled")
        defer { defaults.removePersistentDomain(forName: suite) }

        try test("finished runs persist once with matching personal best and preferences") {
            let store = PracticeStore(defaults: defaults)
            store.reset(drill: .code, duration: 30)
            store.goal = 75
            store.handle(.type(String(store.session.prompt.prefix(5))), at: 100)
            store.tick(at: 130)
            store.tick(at: 140)
            try check(store.history.count == 1, "Save only once")
            try close(store.best, 2, "Personal best")
            let restored = PracticeStore(defaults: defaults)
            try check(restored.history.count == 1 && restored.goal == 75, "Restore history and goal")
            try check(restored.session.drill == .code && restored.session.duration == 30, "Restore workout preferences")
            restored.reset(drill: .words)
            try close(restored.best, 0, "Do not compare different drills")
            restored.reset(drill: .code, duration: 60)
            try close(restored.best, 0, "Do not compare different durations")
        }

        try test("reset discards unfinished results and re-arms focus") {
            let store = PracticeStore(defaults: defaults)
            let oldCount = store.history.count
            let oldFocus = store.focusID
            store.handle(.type("x"), at: 0)
            store.reset()
            store.tick(at: 100)
            try check(store.history.count == oldCount, "Do not save aborted runs")
            try check(store.session.phase == .ready && store.session.attempts == 0, "Clear run state")
            try check(store.focusID != oldFocus, "Refocus input after reset")
        }

        try test("completed store pages automatically renew") {
            let store = PracticeStore(defaults: defaults)
            let prompt = String(store.session.prompt)
            store.handle(.type(prompt), at: 0)
            try check(store.session.input.isEmpty && store.session.completedCorrectCharacters == prompt.count, "New page preserves scored text")
            try check(store.session.phase == .running, "Full page does not finish a timed workout")
            store.tick(at: Double(store.session.duration))
            try check(store.session.phase == .finished, "New page shares deadline")
        }

        try test("history is capped at 100") {
            let store = PracticeStore(defaults: defaults)
            for run in 0..<101 {
                store.reset(duration: 30)
                store.handle(.type(String(store.session.prompt.prefix(1))), at: Double(run * 100))
                store.tick(at: Double(run * 100 + 30))
            }
            try check(store.history.count == 100, "Bound stored history")
            try check(PracticeStore(defaults: defaults).history.count == 100, "Persist bounded history")
        }

        try test("bad saved data is surfaced explicitly") {
            defaults.set(Data("not json".utf8), forKey: "history")
            let store = PracticeStore(defaults: defaults)
            try check(store.notice != nil && store.history.isEmpty, "Corrupt history reports a notice")
            let invalid = SessionResult(
                id: UUID(), date: Date(), duration: 0, drill: .words,
                correctCharacters: 1, attempts: 1, mistakes: 0, backspaces: 0
            )
            defaults.set(try JSONEncoder().encode([invalid]), forKey: "history")
            try check(PracticeStore(defaults: defaults).notice != nil, "Reject invalid timing before computing WPM")
            defaults.removeObject(forKey: "history")
        }

        try test("native input intercepts insertion, deletion, and paste") {
            let view = PracticeTextView()
            view.isEditable = true
            var actions: [String] = []
            var pasteCount = 0
            view.onAction = {
                switch $0 {
                case .type(let text): actions.append(text)
                case .backspace: actions.append("BACKSPACE")
                }
            }
            view.onPaste = { pasteCount += 1 }
            view.insertText("a", replacementRange: NSRange(location: NSNotFound, length: 0))
            view.insertText(NSAttributedString(string: "b"), replacementRange: NSRange(location: 0, length: 0))
            view.deleteBackward(nil)
            view.paste(nil)
            view.pasteAsPlainText(nil)
            view.pasteAsRichText(nil)
            try check(actions == ["a", "b", "BACKSPACE"], "Route typing to scoring instead of mutating native text")
            try check(pasteCount == 3 && view.string.isEmpty, "No paste path changes input")
            view.isEditable = false
            view.insertText("c", replacementRange: NSRange(location: 0, length: 0))
            view.deleteBackward(nil)
            try check(actions.count == 3, "Finished input is inert")
        }

        try test("QWERTY letters, symbols, and opposite-hand Shift use the assigned fingers") {
            let mappings: [(String, Finger)] = [
                ("qaz1", .leftPinky), ("wsx2", .leftRing), ("edc3", .leftMiddle),
                ("rtfgvb45", .leftIndex), ("yuhjnm67", .rightIndex),
                ("ik,8", .rightMiddle), ("ol.9", .rightRing), ("p;/0", .rightPinky)
            ]
            for (keys, finger) in mappings {
                for key in keys {
                    try check(FingerKeyboard.guidance(for: key)?.finger == finger, "Wrong finger for \(key)")
                    try check(FingerKeyboard.guidance(for: key)?.shift == nil, "Unshifted key \(key)")
                }
            }
            try check(FingerKeyboard.guidance(for: "A")?.shift == .rightPinky, "Left-hand uppercase uses right Shift")
            try check(FingerKeyboard.guidance(for: "J")?.shift == .leftPinky, "Right-hand uppercase uses left Shift")
            try check(FingerKeyboard.guidance(for: "?")?.key == "/" && FingerKeyboard.guidance(for: "?")?.shift == .leftPinky, "Question mark guidance")
            try check(FingerKeyboard.guidance(for: "!")?.key == "1" && FingerKeyboard.guidance(for: "!")?.shift == .rightPinky, "Exclamation mark guidance")
            try check(FingerKeyboard.guidance(for: " ")?.finger == .thumbs, "Space uses either thumb")
            try check(FingerKeyboard.guidance(for: "é") == nil, "Do not invent guidance for unsupported layouts")
        }

        try test("wrong lesson keys don't advance, and correction preserves accuracy history") {
            var technique = TechniqueSession(lesson: FingerLesson.all[0])
            technique.handle(.type("x"))
            try check(technique.input.isEmpty && technique.nextCharacter == "f", "Mistake must leave target unchanged")
            try check(technique.lastMistake == "x" && technique.mistakes == 1, "Show specific wrong key")
            technique.handle(.type("f"))
            try check(technique.nextCharacter == "j" && technique.guidance?.finger == .rightIndex, "Advance guidance after correct key")
            try close(technique.accuracy, 50, "Keep mistaken attempt in accuracy")
            technique.handle(.backspace)
            try check(technique.nextCharacter == "f" && technique.mistakes == 1, "Backspace reopens previous target without erasing slips")
            technique.handle(.type("\t\n"))
            try check(technique.attempts == 2, "Ignore control characters")
        }

        try test("all lessons have complete finger guidance and finite completion") {
            for lesson in FingerLesson.all {
                try check(lesson.prompt.allSatisfy { FingerKeyboard.guidance(for: $0) != nil }, "Missing mapping in \(lesson.title)")
                var technique = TechniqueSession(lesson: lesson)
                technique.handle(.type(lesson.prompt + "extra"))
                try check(technique.isFinished && technique.progress == 1, "Finish \(lesson.title)")
                try check(technique.attempts == lesson.prompt.count && technique.mistakes == 0, "Stop scoring at lesson end")
                try check(technique.nextCharacter == nil && technique.guidance == nil, "No target after completion")
                technique.handle(.backspace)
                try check(technique.isFinished, "Completed lesson requires explicit restart")
            }
        }

        try test("untimed lessons persist practiced status without changing timed history") {
            let store = PracticeStore(defaults: defaults)
            let oldCount = store.history.count
            store.handle(.type("x"), at: 0)
            store.showTechnique()
            try check(store.session.phase == .ready, "Switching to technique discards unfinished timed run")
            store.selectLesson(FingerLesson.all[2])
            store.handleTechnique(.type(String(store.technique.lesson.prompt.prefix(1))))
            store.tick(at: 100_000)
            try check(!store.technique.isFinished && store.technique.input.count == 1, "Lessons have no deadline")
            store.restartCurrent()
            try check(store.showingTechnique && store.technique.input.isEmpty, "Command-R restarts current lesson")
            store.handleTechnique(.type(store.technique.lesson.prompt))
            try check(store.completedLessons.contains("upper"), "Persist practiced lesson")
            try check(store.history.count == oldCount, "Untimed lessons don't pollute WPM history")
            let restored = PracticeStore(defaults: defaults)
            try check(restored.showingTechnique && restored.technique.lesson.id == "upper", "Restore learning mode and lesson")
            try check(restored.completedLessons.contains("upper") && !restored.soundEnabled, "Restore lesson completion and mute")
            restored.showPractice()
            try check(!restored.showingTechnique && !PracticeStore(defaults: defaults).showingTechnique, "Leaving learning mode persists")
        }

        try test("generated sounds are valid, distinct, quiet PCM without clipping") {
            var encoded: [Data] = []
            for effect in FeedbackSound.allCases {
                let data = effect.waveData()
                try check(String(data: data.prefix(4), encoding: .utf8) == "RIFF", "WAV container")
                try check(data.count == 44 + Int(effect.duration * 22_050) * 2, "Exact PCM payload length")
                try check(data[22] == 1 && data[34] == 16, "Mono 16-bit format")
                let samples = stride(from: 44, to: data.count, by: 2).map { index in
                    Int16(bitPattern: UInt16(data[index]) | UInt16(data[index + 1]) << 8)
                }
                try check(samples.contains { $0 > 0 } && samples.contains { $0 < 0 }, "Non-silent waveform")
                try check(samples.allSatisfy { abs(Int($0)) < 16_384 }, "Low amplitude, no clipping")
                try check(abs(Int(samples.first!)) < 100 && abs(Int(samples.last!)) < 100, "Fade avoids sharp boundaries")
                guard let sound = NSSound(data: data) else {
                    throw TestFailure(description: "macOS cannot decode generated \(effect) sound")
                }
                try check(abs(sound.duration - effect.duration) < 1.0 / 22_050, "Decoded sound duration")
                encoded.append(data)
            }
            try check(Set(encoded).count == 3, "Correct, mistake, and complete cues must differ")
        }

        print("\n\(completed) tests passed.")
    }
}
