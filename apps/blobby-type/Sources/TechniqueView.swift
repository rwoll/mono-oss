import SwiftUI

struct TechniqueView: View {
    @ObservedObject var store: PracticeStore
    let card: Color
    let background: Color
    let accent: Color
    let capsLock: Bool

    var body: some View {
        VStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text(store.technique.lesson.title)
                        .font(.system(.headline, design: .rounded))
                    Spacer()
                    Text("NO TIMER • ACCURACY FIRST")
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                        .foregroundStyle(accent)
                }
                Text(store.technique.lesson.instruction)
                    .font(.subheadline).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if store.technique.isFinished {
                    completion
                } else {
                    Text(highlightedPrompt)
                        .font(.system(size: 19, weight: .medium, design: .monospaced))
                        .lineSpacing(7)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityLabel("Lesson text: \(store.technique.lesson.prompt)")
                    ProgressView(value: store.technique.progress).tint(accent)
                        .accessibilityLabel("Lesson completion")
                    HStack(spacing: 12) {
                        Image(systemName: "keyboard").foregroundStyle(accent)
                        ZStack(alignment: .leading) {
                            if store.technique.input.isEmpty {
                                Text("Type slowly, using the shown finger…")
                                    .font(.system(size: 14, design: .monospaced))
                                    .foregroundStyle(.secondary).allowsHitTesting(false)
                            }
                            TypingInput(
                                text: String(store.technique.input.suffix(60)),
                                enabled: true, focusID: store.focusID,
                                onAction: { store.handleTechnique($0) },
                                onPaste: { store.pasteBlocked() }
                            )
                            .frame(height: 42)
                        }
                        Button { store.restartCurrent() } label: {
                            Image(systemName: "arrow.counterclockwise")
                        }
                        .buttonStyle(.plain).help("Restart this lesson (Command-R)")
                        .accessibilityLabel("Restart lesson")
                    }
                    .padding(.horizontal, 12)
                    .background(background, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(accent.opacity(0.4)))
                }
            }
            .padding(18)
            .background(card, in: RoundedRectangle(cornerRadius: 18))

            if let guidance = store.technique.guidance, let target = store.technique.nextCharacter {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(alignment: .center, spacing: 16) {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: 12) {
                                Text(target == " " ? "Space" : String(target))
                                    .font(.system(size: 28, weight: .bold, design: .monospaced))
                                    .padding(.horizontal, 12).padding(.vertical, 6)
                                    .background(guidance.finger.color, in: RoundedRectangle(cornerRadius: 9))
                                    .foregroundStyle(Theme.ink)
                                Text(guidance.finger.title)
                                    .font(.system(.headline, design: .rounded))
                            }
                            Text(guidance.instruction)
                                .font(.caption).foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        HStack(spacing: 16) {
                            hand(left: true, guidance: guidance)
                            hand(left: false, guidance: guidance)
                        }
                    }
                    Divider().opacity(0.5)
                    keyboard(guidance: guidance)
                    HStack {
                        if capsLock {
                            Label("Caps Lock is on. Switch it off and practice opposite-hand Shift.", systemImage: "capslock.fill")
                                .foregroundStyle(Theme.rose)
                        } else if let mistake = store.technique.lastMistake {
                            Label("Not \(mistake == " " ? "Space" : String(mistake)). Try the highlighted key; mistakes don't advance.", systemImage: "arrow.uturn.backward")
                                .foregroundStyle(Theme.rose)
                        } else {
                            Label("Small reach → home row. Find F and J by touch.", systemImage: "hand.raised")
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text("\(Int(store.technique.accuracy.rounded()))% accuracy")
                            .foregroundStyle(accent)
                    }
                    .font(.caption)
                    .frame(minHeight: 24)
                    Text("US QWERTY • Colors match the fingers. The app cannot detect your physical finger use.")
                        .font(.system(size: 10)).foregroundStyle(.secondary)
                }
                .padding(18)
                .background(card, in: RoundedRectangle(cornerRadius: 18))
            }
        }
    }

    private var completion: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Lesson practiced. Nice and steady!", systemImage: "checkmark.circle.fill")
                .font(.system(.title3, design: .rounded, weight: .semibold))
                .foregroundStyle(accent)
            Text("\(Int(store.technique.accuracy.rounded()))% accuracy. Repeat until you can use the shown fingers without looking down. A completed lesson isn't proof of correct finger use.")
                .font(.subheadline).foregroundStyle(.secondary)
            HStack {
                Button("Repeat lesson") { store.restartCurrent() }.buttonStyle(.bordered)
                if let index = FingerLesson.all.firstIndex(where: { $0.id == store.technique.lesson.id }),
                   index + 1 < FingerLesson.all.count {
                    Button("Next lesson", systemImage: "arrow.right") { store.selectLesson(FingerLesson.all[index + 1]) }
                        .buttonStyle(.borderedProminent).keyboardShortcut(.return, modifiers: [])
                } else {
                    Button("Try a timed workout", systemImage: "arrow.right") { store.reset(drill: .words) }
                        .buttonStyle(.borderedProminent).keyboardShortcut(.return, modifiers: [])
                }
            }
            .controlSize(.large)
        }
        .padding(.vertical, 10)
    }

    private var highlightedPrompt: AttributedString {
        var result = AttributedString()
        for (index, character) in store.technique.lesson.prompt.enumerated() {
            var letter = AttributedString(character == " " ? "·" : String(character))
            if index < store.technique.input.count { letter.foregroundColor = accent }
            else if index == store.technique.input.count {
                letter.foregroundColor = Theme.ink
                letter.backgroundColor = store.technique.lastMistake == nil ? Theme.mint : Theme.rose
            } else { letter.foregroundColor = .secondary }
            result.append(letter)
        }
        return result
    }

    private func keyboard(guidance: KeyGuidance) -> some View {
        VStack(spacing: 5) {
            ForEach(Array(FingerKeyboard.rows.enumerated()), id: \.offset) { index, row in
                HStack(spacing: 5) {
                    if index == 3 {
                        keycap("L Shift", finger: .leftPinky, active: guidance.shift == .leftPinky, width: 72)
                    }
                    ForEach(Array(row), id: \.self) { key in
                        if let finger = FingerKeyboard.guidance(for: key)?.finger {
                            keycap(String(key).uppercased(), finger: finger, active: guidance.key == key, home: "asdfjkl;".contains(key))
                        }
                    }
                    if index == 0 {
                        keycap("Delete", finger: .rightPinky, active: false, width: 60)
                    }
                    if index == 3 {
                        keycap("R Shift", finger: .rightPinky, active: guidance.shift == .rightPinky, width: 72)
                    }
                }
                .padding(.leading, index == 1 ? 12 : index == 2 ? 24 : 0)
            }
            keycap("Space · either thumb", finger: .thumbs, active: guidance.key == " ", width: 280)
        }
        .frame(maxWidth: .infinity)
    }

    private func keycap(_ label: String, finger: Finger, active: Bool, home: Bool = false, width: CGFloat = 36) -> some View {
        VStack(spacing: 2) {
            Text(label).font(.system(size: label.count > 1 ? 10 : 13, weight: .semibold, design: .monospaced))
            if home {
                Rectangle().frame(width: label == "F" || label == "J" ? 12 : 4, height: 2)
            }
        }
        .frame(width: width, height: 29)
        .foregroundStyle(active ? Theme.ink : .primary)
        .background(finger.color.opacity(active ? 1 : 0.14), in: RoundedRectangle(cornerRadius: 5))
        .overlay(RoundedRectangle(cornerRadius: 5).stroke(active ? finger.color : finger.color.opacity(0.25), lineWidth: active ? 2 : 1))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label), \(finger.title)\(active ? ", use this key" : "")")
    }

    private func hand(left: Bool, guidance: KeyGuidance) -> some View {
        let fingers: [Finger] = left
            ? [.leftPinky, .leftRing, .leftMiddle, .leftIndex, .thumbs]
            : [.thumbs, .rightIndex, .rightMiddle, .rightRing, .rightPinky]
        let heights: [CGFloat] = left ? [32, 44, 50, 40, 22] : [22, 40, 50, 44, 32]
        return VStack(spacing: 3) {
            HStack(alignment: .bottom, spacing: 3) {
                ForEach(Array(fingers.enumerated()), id: \.offset) { index, finger in
                    let active = guidance.finger == finger || guidance.shift == finger
                    Text(finger == .thumbs ? "␣" : finger.home)
                        .font(.system(size: 11, weight: .bold, design: .monospaced))
                        .frame(width: 20, height: heights[index], alignment: .bottom)
                        .padding(.bottom, 4)
                        .foregroundStyle(active ? Theme.ink : .primary)
                        .background(finger.color.opacity(active ? 1 : 0.18), in: UnevenRoundedRectangle(topLeadingRadius: 10, topTrailingRadius: 10))
                        .overlay(UnevenRoundedRectangle(topLeadingRadius: 10, topTrailingRadius: 10).stroke(finger.color.opacity(active ? 1 : 0.3), lineWidth: active ? 2 : 1))
                        .accessibilityLabel("\(finger.title), home \(finger.home)\(active ? ", active" : "")")
                }
            }
            RoundedRectangle(cornerRadius: 6).fill(.primary.opacity(0.05)).frame(width: 110, height: 14)
            Text(left ? "LEFT HAND" : "RIGHT HAND")
                .font(.system(size: 8, weight: .semibold, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }
}

private extension Finger {
    var color: Color {
        switch self {
        case .leftPinky: Color(red: 0.96, green: 0.62, blue: 0.65)
        case .leftRing: Color(red: 0.95, green: 0.78, blue: 0.40)
        case .leftMiddle: Color(red: 0.53, green: 0.74, blue: 0.96)
        case .leftIndex: Color(red: 0.49, green: 0.85, blue: 0.59)
        case .rightIndex: Color(red: 0.41, green: 0.81, blue: 0.76)
        case .rightMiddle: Color(red: 0.73, green: 0.66, blue: 0.95)
        case .rightRing: Color(red: 0.96, green: 0.67, blue: 0.43)
        case .rightPinky: Color(red: 0.89, green: 0.61, blue: 0.81)
        case .thumbs: Color(red: 0.73, green: 0.78, blue: 0.75)
        }
    }
}
