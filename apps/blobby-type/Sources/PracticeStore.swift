import SwiftUI

@MainActor
final class PracticeStore: ObservableObject {
    @Published private(set) var session: TypingSession
    @Published private(set) var history: [SessionResult] = []
    @Published var notice: String?
    @Published var focusID = UUID()
    @Published var showingHistory = false
    @Published private(set) var showingTechnique = false
    @Published private(set) var technique: TechniqueSession
    @Published private(set) var completedLessons: Set<String> = []
    @Published var soundEnabled: Bool {
        didSet {
            defaults.set(soundEnabled, forKey: "soundEnabled")
            if !soundEnabled { soundEffects?.stop() }
        }
    }
    @Published var goal: Int { didSet { defaults.set(goal, forKey: "goal") } }

    private let defaults: UserDefaults
    private var savedCurrentRun = false
    private var soundEffects: SoundEffects?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        soundEnabled = defaults.object(forKey: "soundEnabled") == nil || defaults.bool(forKey: "soundEnabled")
        let lesson = FingerLesson.all.first { $0.id == defaults.string(forKey: "fingerLesson") } ?? FingerLesson.all[0]
        technique = TechniqueSession(lesson: lesson)
        completedLessons = Set(defaults.stringArray(forKey: "completedLessons") ?? []).intersection(FingerLesson.all.map(\.id))
        showingTechnique = defaults.bool(forKey: "learnFingers")
        let storedDuration = defaults.integer(forKey: "duration")
        let duration = [30, 60, 120].contains(storedDuration) ? storedDuration : 60
        let drill = Drill(rawValue: defaults.string(forKey: "drill") ?? "") ?? .words
        let storedGoal = defaults.integer(forKey: "goal")
        goal = (20...150).contains(storedGoal) ? storedGoal : 60
        session = TypingSession(duration: duration, drill: drill, prompt: PracticeLibrary.makePrompt(for: drill))
        if let data = defaults.data(forKey: "history") {
            do {
                let decoded = try JSONDecoder().decode([SessionResult].self, from: data)
                guard decoded.allSatisfy({
                    [30, 60, 120].contains($0.duration) && $0.correctCharacters >= 0 &&
                    $0.attempts >= $0.correctCharacters && $0.mistakes >= 0 &&
                    $0.mistakes <= $0.attempts && $0.backspaces >= 0
                }) else {
                    notice = "Saved practice history contains invalid results. New results will replace it."
                    return
                }
                history = Array(decoded.prefix(100))
            } catch {
                notice = "Saved practice history couldn't be read: \(error.localizedDescription)"
            }
        }
    }

    var best: Double {
        matchingHistory.map(\.wpm).max() ?? 0
    }

    var matchingHistory: [SessionResult] {
        history.filter { $0.drill == session.drill && $0.duration == session.duration }
    }

    func reset(drill: Drill? = nil, duration: Int? = nil) {
        let nextDrill = drill ?? session.drill
        let nextDuration = duration ?? session.duration
        session = TypingSession(
            duration: nextDuration, drill: nextDrill,
            prompt: PracticeLibrary.makePrompt(for: nextDrill)
        )
        defaults.set(nextDrill.rawValue, forKey: "drill")
        defaults.set(nextDuration, forKey: "duration")
        savedCurrentRun = false
        showingHistory = false
        showingTechnique = false
        defaults.set(false, forKey: "learnFingers")
        focusID = UUID()
    }

    func showPractice() {
        showingTechnique = false
        showingHistory = false
        defaults.set(false, forKey: "learnFingers")
        focusID = UUID()
    }

    func showTechnique() {
        if session.phase == .running { reset() }
        showingHistory = false
        showingTechnique = true
        defaults.set(true, forKey: "learnFingers")
        focusID = UUID()
    }

    func selectLesson(_ lesson: FingerLesson) {
        technique = TechniqueSession(lesson: lesson)
        defaults.set(lesson.id, forKey: "fingerLesson")
        showTechnique()
    }

    func restartCurrent() {
        if showingTechnique { selectLesson(technique.lesson) }
        else { reset() }
    }

    func handleTechnique(_ action: TypingAction) {
        let before = technique
        technique.handle(action)
        if !before.isFinished && technique.isFinished {
            completedLessons.insert(technique.lesson.id)
            defaults.set(completedLessons.sorted(), forKey: "completedLessons")
            playSound(.complete)
        } else if technique.mistakes > before.mistakes {
            playSound(.mistake)
        } else if technique.attempts > before.attempts || technique.input.count < before.input.count {
            playSound(.key)
        }
    }

    func handle(_ action: TypingAction, at now: Double = ProcessInfo.processInfo.systemUptime) {
        let before = session
        session.handle(action, at: now)
        if session.pageIsFull && session.phase == .running {
            session.continueWith(PracticeLibrary.makePrompt(for: session.drill))
        }
        saveIfFinished()
        if session.phase != .finished {
            if session.mistakes > before.mistakes { playSound(.mistake) }
            else if session.attempts > before.attempts || session.backspaces > before.backspaces { playSound(.key) }
        }
    }

    func tick(at now: Double = ProcessInfo.processInfo.systemUptime) {
        guard !showingTechnique else { return }
        session.tick(at: now)
        saveIfFinished()
    }

    func pasteBlocked() {
        notice = "This is a typing workout. Paste is disabled; type the highlighted text instead."
    }

    private func saveIfFinished() {
        guard !savedCurrentRun, let result = session.result() else { return }
        savedCurrentRun = true
        history.insert(result, at: 0)
        history = Array(history.prefix(100))
        do {
            defaults.set(try JSONEncoder().encode(history), forKey: "history")
        } catch {
            notice = "Your result couldn't be saved: \(error.localizedDescription)"
        }
        playSound(.complete)
    }

    private func playSound(_ effect: FeedbackSound) {
        guard soundEnabled else { return }
        do {
            let sounds: SoundEffects
            if let soundEffects { sounds = soundEffects }
            else {
                sounds = try SoundEffects()
                soundEffects = sounds
            }
            try sounds.play(effect)
        } catch {
            soundEnabled = false
            notice = "Sound effects were muted: \(error.localizedDescription) You can retry using the sound toggle."
        }
    }
}
