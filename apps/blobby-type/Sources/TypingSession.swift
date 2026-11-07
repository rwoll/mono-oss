import Foundation

enum Drill: String, CaseIterable, Codable {
    case words, sentences, code

    var title: String {
        switch self {
        case .words: "Everyday words"
        case .sentences: "Punctuation"
        case .code: "Code fingers"
        }
    }

    var subtitle: String {
        switch self {
        case .words: "Build rhythm with common lowercase words."
        case .sentences: "Practice capitals, commas, and punctuation."
        case .code: "Give your brackets and symbols a workout."
        }
    }

    var symbol: String {
        switch self {
        case .words: "textformat.abc"
        case .sentences: "quote.opening"
        case .code: "curlybraces"
        }
    }
}

enum TypingAction {
    case type(String)
    case backspace
}

struct SessionResult: Codable, Identifiable {
    let id: UUID
    let date: Date
    let duration: Int
    let drill: Drill
    let correctCharacters: Int
    let attempts: Int
    let mistakes: Int
    let backspaces: Int

    var wpm: Double { Double(correctCharacters) / 5 / (Double(duration) / 60) }
    var rawWPM: Double { Double(attempts) / 5 / (Double(duration) / 60) }
    var accuracy: Double {
        attempts == 0 ? 100 : Double(attempts - mistakes) / Double(attempts) * 100
    }
}

struct TypingSession {
    enum Phase { case ready, running, finished }

    let duration: Int
    let drill: Drill
    private(set) var prompt: [Character]
    private(set) var input: [Character] = []
    private(set) var phase: Phase = .ready
    private(set) var elapsed: Double = 0
    private(set) var attempts = 0
    private(set) var mistakes = 0
    private(set) var backspaces = 0
    private(set) var completedCorrectCharacters = 0
    private var startedAt: Double?

    init(duration: Int, drill: Drill, prompt: String) {
        precondition(duration > 0 && !prompt.isEmpty)
        self.duration = duration
        self.drill = drill
        self.prompt = Array(prompt)
    }

    var currentCorrectCharacters: Int {
        zip(input, prompt).filter { $0 == $1 }.count
    }

    var correctCharacters: Int { completedCorrectCharacters + currentCorrectCharacters }
    var remaining: Int { max(0, Int(ceil(Double(duration) - elapsed))) }
    var progress: Double { min(1, elapsed / Double(duration)) }
    var wpm: Double { elapsed > 0 ? Double(correctCharacters) / 5 / (elapsed / 60) : 0 }
    var accuracy: Double {
        attempts == 0 ? 100 : Double(attempts - mistakes) / Double(attempts) * 100
    }
    var pageIsFull: Bool { input.count == prompt.count }
    var activeWord: Int { prompt.prefix(input.count).filter { $0 == " " }.count }

    mutating func tick(at now: Double) {
        guard phase == .running, let startedAt else { return }
        elapsed = min(Double(duration), max(elapsed, now - startedAt))
        if elapsed >= Double(duration) { phase = .finished }
    }

    mutating func handle(_ action: TypingAction, at now: Double) {
        tick(at: now)
        guard phase != .finished else { return }

        switch action {
        case .backspace:
            guard !input.isEmpty else { return }
            input.removeLast()
            backspaces += 1
        case .type(let text):
            let characters = text.filter { !$0.isNewline && !$0.asString.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) }
            guard !characters.isEmpty, !pageIsFull else { return }
            if phase == .ready {
                startedAt = now
                phase = .running
            }
            for character in characters {
                guard input.count < prompt.count else { break }
                attempts += 1
                if character != prompt[input.count] { mistakes += 1 }
                input.append(character)
            }
        }
    }

    mutating func continueWith(_ nextPrompt: String) {
        precondition(!nextPrompt.isEmpty)
        guard pageIsFull, phase == .running else { return }
        completedCorrectCharacters += currentCorrectCharacters
        input = []
        prompt = Array(nextPrompt)
    }

    func result(date: Date = Date()) -> SessionResult? {
        guard phase == .finished else { return nil }
        return SessionResult(
            id: UUID(), date: date, duration: duration, drill: drill,
            correctCharacters: correctCharacters, attempts: attempts,
            mistakes: mistakes, backspaces: backspaces
        )
    }
}

private extension Character {
    var asString: String { String(self) }
}
