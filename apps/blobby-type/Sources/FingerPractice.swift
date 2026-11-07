import Foundation

enum Finger: String, CaseIterable {
    case leftPinky, leftRing, leftMiddle, leftIndex
    case rightIndex, rightMiddle, rightRing, rightPinky
    case thumbs

    var title: String {
        switch self {
        case .leftPinky: "Left pinky"
        case .leftRing: "Left ring finger"
        case .leftMiddle: "Left middle finger"
        case .leftIndex: "Left index finger"
        case .rightIndex: "Right index finger"
        case .rightMiddle: "Right middle finger"
        case .rightRing: "Right ring finger"
        case .rightPinky: "Right pinky"
        case .thumbs: "Either thumb"
        }
    }

    var home: String {
        switch self {
        case .leftPinky: "A"
        case .leftRing: "S"
        case .leftMiddle: "D"
        case .leftIndex: "F"
        case .rightIndex: "J"
        case .rightMiddle: "K"
        case .rightRing: "L"
        case .rightPinky: ";"
        case .thumbs: "Space"
        }
    }

    var isLeft: Bool {
        switch self {
        case .leftPinky, .leftRing, .leftMiddle, .leftIndex: true
        default: false
        }
    }
}

struct KeyGuidance {
    let key: Character
    let finger: Finger
    let shift: Finger?

    var keyLabel: String { key == " " ? "Space" : String(key).uppercased() }
    var instruction: String {
        if finger == .thumbs {
            return "Tap Space with either thumb. Keep your other fingers near the home row."
        }
        let reach = String(key).uppercased() == finger.home
            ? "Tap your home key gently."
            : "Make a small reach, then return this finger to \(finger.home)."
        if let shift {
            return "Hold \(shift.isLeft ? "left" : "right") Shift with your \(shift.title.lowercased()), tap \(keyLabel), then release Shift. \(reach)"
        }
        return reach
    }
}

enum FingerKeyboard {
    static let rows = ["`1234567890-=", "qwertyuiop[]\\", "asdfghjkl;'", "zxcvbnm,./"]

    private static let groups: [(Finger, String)] = [
        (.leftPinky, "`1qaz"), (.leftRing, "2wsx"), (.leftMiddle, "3edc"),
        (.leftIndex, "45rtfgvb"), (.rightIndex, "67yuhjnm"),
        (.rightMiddle, "8ik,"), (.rightRing, "9ol."), (.rightPinky, "0p[]\\;'=-/")
    ]

    private static let shifted: [Character: Character] = [
        "~": "`", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5",
        "^": "6", "&": "7", "*": "8", "(": "9", ")": "0", "_": "-", "+": "=",
        "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/"
    ]

    static func guidance(for character: Character) -> KeyGuidance? {
        if character == " " { return KeyGuidance(key: " ", finger: .thumbs, shift: nil) }
        let lower = Character(String(character).lowercased())
        let base = shifted[character] ?? lower
        guard let finger = groups.first(where: { $0.1.contains(base) })?.0 else { return nil }
        let needsShift = shifted[character] != nil || (character != lower && character.isLetter)
        return KeyGuidance(
            key: base, finger: finger,
            shift: needsShift ? (finger.isLeft ? .rightPinky : .leftPinky) : nil
        )
    }
}

struct FingerLesson: Identifiable {
    let id: String
    let title: String
    let shortTitle: String
    let instruction: String
    let prompt: String

    static let all: [FingerLesson] = [
        FingerLesson(
            id: "anchors", title: "1. Find F and J", shortTitle: "1. F + J anchors",
            instruction: "Find the bumps on F and J without looking. Rest your left index on F and your right index on J. These are your anchors; come back to them after a reach.",
            prompt: "fj jf ff jj fj jf f j f j fj jf ff jj fj jf"
        ),
        FingerLesson(
            id: "home", title: "2. Home row", shortTitle: "2. Home row",
            instruction: "Left hand: pinky A, ring S, middle D, index F. Right hand: index J, middle K, ring L, pinky ;. Thumbs hover over Space. Use the shown finger, not the nearest finger.",
            prompt: "asdf jkl; asdf jkl; aa ss dd ff jj kk ll ;; ask dad fall flask salad lass"
        ),
        FingerLesson(
            id: "upper", title: "3. Reach up, return", shortTitle: "3. Upper row",
            instruction: "Start at home row. Reach to the highlighted top-row key with its assigned finger, then return. Index fingers cover two columns: F reaches R/T; J reaches Y/U.",
            prompt: "aqa sws ded frf ftf jyj juj kik lol ;p; qwer tyui op quiet write type"
        ),
        FingerLesson(
            id: "lower", title: "4. Reach down, return", shortTitle: "4. Lower row",
            instruction: "Keep your hand near home row while a finger reaches down. Left index covers V/B; right index covers N/M. Pause rather than forcing an uncomfortable stretch.",
            prompt: "aza sxs dcd fvf fbf jnj jmj k,k l.l ;/; zxcv bnm, ./ calm mix move"
        ),
        FingerLesson(
            id: "numbers", title: "5. Numbers and symbols", shortTitle: "5. Numbers",
            instruction: "Reach up to the number row, then return home. Left index covers 4/5; right index covers 6/7. These lessons use the conventional US QWERTY mapping.",
            prompt: "a1a s2s d3d f4f f5f j6j j7j k8k l9l ;0; ;-; ;=; 12345 67890"
        ),
        FingerLesson(
            id: "shift", title: "6. Opposite-hand Shift", shortTitle: "6. Shift",
            instruction: "Use Shift with the opposite hand from the character: right Shift for left-hand letters, left Shift for right-hand letters. Release Shift after the character. Don't use Caps Lock.",
            prompt: "Aa Ss Dd Ff Jj Kk Ll Zz Xx Cc Vv Bb Nn Mm ! ? : \" () {}"
        )
    ]
}

struct TechniqueSession {
    let lesson: FingerLesson
    private(set) var input: [Character] = []
    private(set) var attempts = 0
    private(set) var mistakes = 0
    private(set) var lastMistake: Character?
    private let prompt: [Character]

    init(lesson: FingerLesson) {
        precondition(!lesson.prompt.isEmpty)
        self.lesson = lesson
        prompt = Array(lesson.prompt)
    }

    var isFinished: Bool { input.count == prompt.count }
    var nextCharacter: Character? { isFinished ? nil : prompt[input.count] }
    var guidance: KeyGuidance? { nextCharacter.flatMap(FingerKeyboard.guidance) }
    var progress: Double { Double(input.count) / Double(prompt.count) }
    var accuracy: Double { attempts == 0 ? 100 : Double(attempts - mistakes) / Double(attempts) * 100 }

    mutating func handle(_ action: TypingAction) {
        guard !isFinished else { return }
        switch action {
        case .backspace:
            if !input.isEmpty { input.removeLast() }
            lastMistake = nil
        case .type(let text):
            for character in text {
                guard !isFinished else { break }
                guard !character.isNewline, !String(character).unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { continue }
                attempts += 1
                if character == nextCharacter {
                    input.append(character)
                    lastMistake = nil
                } else {
                    mistakes += 1
                    lastMistake = character
                }
            }
        }
    }
}
