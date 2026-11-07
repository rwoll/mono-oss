import Foundation

enum PracticeLibrary {
    private static let words = """
    the be to of and a in that have it for not on with he as you do at this but
    his by from they we say her she or an will my one all would there their what
    so up out if about who get which go me when make can like time no just him
    know take people into year your good some could them see other than then
    now look only come its over think also back after use two how our work
    first well way even new want because any these give day most us find long
    down little life world still hand high place small home read write great
    again help move play never next keep open light water sound right around
    learn each start every word speed calm slow focus rhythm type green cloud
    happy quiet bright friend flow practice grow space warm morning simple
    """.split(whereSeparator: \.isWhitespace).map(String.init)

    private static let sentences = [
        "Blobby brought a tiny keyboard, a warm cup of tea, and a very big goal.",
        "Take your time. Smooth, steady typing is faster than a frantic sprint.",
        "Is that a new personal best? Nice work! Let's keep the rhythm going.",
        "The little green robot watched the clouds drift past the open window.",
        "First, find a comfortable posture. Then, relax your hands and begin.",
        "One careful word at a time, your fingers learn where they need to go.",
        "A mistake isn't the end of a run; it's a chance to slow down and reset.",
        "Today we practice for progress, not perfection. Tomorrow we try again.",
        "Keep your eyes on the next word, and let your fingers follow the beat.",
        "Blobby says: \"You don't have to rush to get a little faster.\"",
        "The garden was quiet at 7:30, except for a bird singing near the gate.",
        "Small habits add up: five minutes today, five tomorrow, and a little joy."
    ]

    private static let code = [
        "let speed = 60; let accuracy = 0.98; print(\"Keep going!\")",
        "if words.count > 0 { let average = total / words.count }",
        "func greet(name: String) -> String { return \"Hello, \" + name }",
        "let scores = [42, 56, 61]; let best = scores.max() ?? 0",
        "for index in 0..<10 { print(\"Practice\", index + 1) }",
        "struct Blobby { var energy: Int = 100; var isHappy: Bool = true }",
        "guard let result = session.result else { return }",
        "let faster = runs.filter { $0.speed >= goal }.map { $0.id }",
        "while remaining > 0 { remaining -= 1; progress += 0.01 }",
        "Button(\"Try again\") { session.reset(); input.focus() }"
    ]

    static func makePrompt(for drill: Drill) -> String {
        switch drill {
        case .words:
            var selected: [String] = []
            for _ in 0..<65 {
                let choices = words.filter { $0 != selected.last }
                selected.append(choices.randomElement()!)
            }
            return selected.joined(separator: " ")
        case .sentences:
            return sentences.shuffled().prefix(5).joined(separator: " ")
        case .code:
            return code.shuffled().prefix(5).joined(separator: " ")
        }
    }
}
