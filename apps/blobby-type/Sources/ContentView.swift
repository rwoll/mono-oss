import SwiftUI
import Combine

enum Theme {
    static let mint = Color(red: 0.47, green: 0.89, blue: 0.65)
    static let ink = Color(red: 0.06, green: 0.13, blue: 0.10)
    static let rose = Color(red: 0.96, green: 0.39, blue: 0.49)
}

struct BlobbySprite: View {
    let pose: String
    var scale: CGFloat = 1.5

    var body: some View {
        if let url = Bundle.main.url(forResource: "buddy-\(pose)-insiders-96", withExtension: "png"),
           let image = NSImage(contentsOf: url) {
            Image(nsImage: image)
                .interpolation(.none)
                .resizable()
                .frame(width: image.size.width * scale, height: image.size.height * scale)
                .accessibilityHidden(true)
        } else {
            Label("Blobby sprite missing", systemImage: "exclamationmark.triangle")
                .foregroundStyle(Theme.rose)
        }
    }
}

struct ContentView: View {
    @ObservedObject var store: PracticeStore
    @Environment(\.colorScheme) private var colorScheme
    @State private var capsLock = false
    private let timer = Timer.publish(every: 0.1, on: .main, in: .common).autoconnect()

    private var background: Color {
        colorScheme == .dark ? Color(red: 0.055, green: 0.075, blue: 0.065) : Color(red: 0.95, green: 0.97, blue: 0.94)
    }
    private var card: Color {
        colorScheme == .dark ? Color(red: 0.09, green: 0.12, blue: 0.10) : .white
    }
    private var accent: Color {
        colorScheme == .dark ? Theme.mint : Color(red: 0.12, green: 0.43, blue: 0.25)
    }

    var body: some View {
        HStack(spacing: 0) {
            sidebar
                .frame(width: 218)
            Rectangle().fill(.primary.opacity(0.08)).frame(width: 1)
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    header
                    if store.showingHistory {
                        historyView
                    } else if store.showingTechnique {
                        TechniqueView(store: store, card: card, background: background, accent: accent, capsLock: capsLock)
                    } else {
                        practiceView
                    }
                    footer
                }
                .padding(24)
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 1020, minHeight: 760)
        .background(background)
        .tint(accent)
        .onReceive(timer) { _ in
            store.tick()
            capsLock = NSEvent.modifierFlags.contains(.capsLock)
        }
        .alert("A note from Blobby", isPresented: Binding(
            get: { store.notice != nil },
            set: { if !$0 { store.notice = nil; store.focusID = UUID() } }
        )) {
            Button("Got it") { store.notice = nil; store.focusID = UUID() }
        } message: {
            Text(store.notice ?? "")
        }
    }

    private var sidebar: some View {
        ScrollView {
        VStack(alignment: .leading, spacing: 22) {
            HStack(spacing: 10) {
                Image(systemName: "keyboard").font(.title2).foregroundStyle(accent)
                Text("blobby type").font(.system(size: 20, weight: .bold, design: .rounded))
            }
            VStack(alignment: .leading, spacing: 8) {
                sectionLabel("YOUR WORKOUT")
                navButton("Practice", symbol: "bolt.fill", selected: !store.showingHistory && !store.showingTechnique) {
                    store.showPractice()
                }
                navButton("Learn fingers", symbol: "hand.raised.fingers.spread", selected: store.showingTechnique && !store.showingHistory) {
                    store.showTechnique()
                }
                navButton("Your progress", symbol: "chart.bar.fill", selected: store.showingHistory) {
                    store.showingHistory = true
                }
            }
            if store.showingTechnique {
                VStack(alignment: .leading, spacing: 8) {
                    sectionLabel("BUILD THE HABIT")
                    ForEach(FingerLesson.all) { lesson in
                        navButton(lesson.shortTitle, symbol: store.completedLessons.contains(lesson.id) ? "checkmark.circle.fill" : "circle",
                                  selected: store.technique.lesson.id == lesson.id, compact: true) {
                            store.selectLesson(lesson)
                        }
                    }
                    Text("\(store.completedLessons.count) of \(FingerLesson.all.count) lessons practiced")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Text("Relax your shoulders. Keep wrists neutral. Rest lightly; don't force a stretch.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
            VStack(alignment: .leading, spacing: 10) {
                sectionLabel("PRACTICE MIX")
                ForEach(Drill.allCases, id: \.self) { drill in
                    navButton(drill.title, symbol: drill.symbol, selected: store.session.drill == drill) {
                        store.reset(drill: drill)
                    }
                    .disabled(store.session.phase == .running)
                }
                if store.session.phase == .running {
                    Text("Restart to change your workout.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            VStack(alignment: .leading, spacing: 12) {
                sectionLabel("A LITTLE STRETCH GOAL")
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Text("\(store.goal)").font(.system(size: 30, weight: .semibold, design: .rounded))
                    Text("wpm").font(.subheadline).foregroundStyle(.secondary)
                    Spacer()
                    Stepper("Goal", value: $store.goal, in: 20...150, step: 5).labelsHidden()
                        .accessibilityLabel("Typing speed goal")
                }
                Text("Accuracy first. Speed will follow.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            }
            Spacer(minLength: 12)
            VStack(alignment: .leading, spacing: 10) {
                BlobbySprite(pose: "idle")
                    .frame(maxWidth: .infinity)
                Text("Small steps. Fast fingers.")
                    .font(.system(.subheadline, design: .rounded, weight: .semibold))
                Text("A quiet corner to get a little better.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(22)
        }
        .scrollIndicators(.hidden)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(card.opacity(0.55))
    }

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 7) {
                sectionLabel(store.showingHistory ? "ONE RUN AT A TIME" : store.showingTechnique ? "LESS TRAVEL, MORE CONTROL" : "FIND YOUR FLOW")
                Text(store.showingHistory ? "Look how far you've come." : store.showingTechnique ? "Give every finger a home." : "A little faster. A little happier.")
                    .font(.system(size: 28, weight: .bold, design: .rounded))
                Text(store.showingHistory ? "Your last 100 finished workouts, saved on this Mac." : store.showingTechnique ? "Untimed US QWERTY lessons. No speed pressure." : store.session.drill.subtitle)
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            Spacer(minLength: 12)
            Label("OFFLINE & YOURS", systemImage: "leaf")
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .foregroundStyle(accent)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(accent.opacity(0.09), in: Capsule())
        }
    }

    private var practiceView: some View {
        VStack(spacing: 18) {
            HStack(spacing: 12) {
                metric("SPEED", value: "\(Int(store.session.wpm.rounded()))", unit: "wpm", symbol: "speedometer")
                metric("ACCURACY", value: "\(Int(store.session.accuracy.rounded()))", unit: "%", symbol: "scope")
                metric("TIME LEFT", value: "\(store.session.remaining)", unit: "sec", symbol: "timer")
                metric("PERSONAL BEST", value: "\(Int(store.best.rounded()))", unit: "wpm", symbol: "trophy")
            }
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    HStack(spacing: 7) {
                        Circle().fill(accent).frame(width: 6, height: 6)
                        Text(statusLabel)
                            .font(.system(size: 11, weight: .semibold, design: .monospaced))
                            .foregroundStyle(accent)
                    }
                    Spacer()
                    Picker("Workout length", selection: Binding(
                        get: { store.session.duration },
                        set: { store.reset(duration: $0) }
                    )) {
                        Text("30s").tag(30)
                        Text("60s").tag(60)
                        Text("120s").tag(120)
                    }
                    .pickerStyle(.segmented).labelsHidden().frame(width: 170)
                    .disabled(store.session.phase == .running)
                }
                if store.session.phase == .finished {
                    resultView
                        .frame(height: 225)
                } else {
                    promptView
                        .frame(height: 170)
                }
                ProgressView(value: store.session.progress)
                    .tint(accent)
                    .accessibilityLabel("Workout elapsed time")
                if store.session.phase != .finished {
                    inputView
                }
            }
            .padding(20)
            .background(card, in: RoundedRectangle(cornerRadius: 20))
            .overlay(RoundedRectangle(cornerRadius: 20).stroke(.primary.opacity(0.07)))
            HStack(alignment: .center, spacing: 20) {
                BlobbySprite(pose: store.session.phase == .running ? "typing" : "cool")
                    .frame(width: 252, height: 144)
                VStack(alignment: .leading, spacing: 8) {
                    Text(coachingTitle)
                        .font(.system(size: 18, weight: .semibold, design: .rounded))
                    Text(coachingDetail)
                        .font(.subheadline).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
        }
    }

    private var statusLabel: String {
        switch store.session.phase {
        case .ready: "READY WHEN YOU ARE"
        case .running: "IN THE FLOW"
        case .finished: "WORKOUT COMPLETE"
        }
    }

    private var coachingTitle: String {
        if store.session.phase == .finished { return "Good practice is never wasted." }
        if store.session.phase == .running && store.session.accuracy < 90 { return "Take a breath. You've got this." }
        if store.session.phase == .running { return "Blobby is cheering for you." }
        return "Your first keystroke starts the clock."
    }

    private var coachingDetail: String {
        if store.session.phase == .finished { return "Try another round, or visit Your progress to see your recent runs." }
        if store.session.phase == .running && store.session.accuracy < 90 { return "Slow down a little and aim for clean keystrokes. Use Backspace to fix a slip." }
        return "Keep a steady rhythm. Five correct characters count as one word; corrected mistakes still count toward accuracy."
    }

    private var promptView: some View {
        ScrollViewReader { proxy in
            ScrollView {
                WordFlow(spacing: 12) {
                    ForEach(Array(promptWords.enumerated()), id: \.offset) { index, word in
                        Text(highlighted(word))
                            .font(.system(size: 21, weight: .medium, design: .monospaced))
                            .padding(.vertical, 5)
                            .id(index)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 4)
            }
            .scrollIndicators(.hidden)
            .onChange(of: store.session.activeWord) { _, word in
                withAnimation(.easeOut(duration: 0.12)) { proxy.scrollTo(word, anchor: .center) }
            }
            .onChange(of: String(store.session.prompt)) { _, _ in proxy.scrollTo(0, anchor: .top) }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Text to type")
        .accessibilityValue(String(store.session.prompt))
    }

    private var promptWords: [Range<Int>] {
        var ranges: [Range<Int>] = []
        var start = 0
        for index in store.session.prompt.indices where store.session.prompt[index] == " " {
            ranges.append(start..<(index + 1))
            start = index + 1
        }
        if start < store.session.prompt.count { ranges.append(start..<store.session.prompt.count) }
        return ranges
    }

    private func highlighted(_ range: Range<Int>) -> AttributedString {
        var result = AttributedString()
        for index in range {
            let character = store.session.prompt[index]
            var letter = AttributedString(String(character == " " ? "·" : character))
            if index < store.session.input.count {
                let correct = store.session.input[index] == character
                letter.foregroundColor = correct ? accent : Theme.rose
                if !correct {
                    letter.backgroundColor = Theme.rose.opacity(0.13)
                    letter.underlineStyle = .single
                }
            } else if index == store.session.input.count {
                letter.foregroundColor = Theme.ink
                letter.backgroundColor = Theme.mint
            } else {
                letter.foregroundColor = character == " " ? .secondary.opacity(0.3) : .secondary
            }
            result.append(letter)
        }
        return result
    }

    private var inputView: some View {
        HStack(spacing: 12) {
            Image(systemName: "keyboard").foregroundStyle(accent)
            ZStack(alignment: .leading) {
                if store.session.input.isEmpty {
                    Text("Click here and start typing…")
                        .font(.system(size: 16, design: .monospaced))
                        .foregroundStyle(.secondary).allowsHitTesting(false)
                }
                TypingInput(
                    text: String(store.session.input.suffix(65)),
                    enabled: !store.showingHistory,
                    focusID: store.focusID,
                    onAction: { store.handle($0) }, onPaste: { store.pasteBlocked() }
                )
                .frame(height: 42)
            }
            if capsLock {
                Label("Caps Lock", systemImage: "capslock.fill")
                    .font(.caption).foregroundStyle(Theme.rose)
            }
            Button { store.reset() } label: {
                Image(systemName: "arrow.counterclockwise")
            }
            .buttonStyle(.plain).help("Restart workout (Command-R)")
            .accessibilityLabel("Restart workout")
        }
        .padding(.horizontal, 15).padding(.vertical, 5)
        .background(background, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(accent.opacity(0.4)))
    }

    private var resultView: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("\(Int(store.session.wpm.rounded()))")
                    .font(.system(size: 60, weight: .bold, design: .rounded))
                    .foregroundStyle(accent)
                Text("words per minute").font(.title3).foregroundStyle(.secondary)
            }
            Text(store.session.wpm >= Double(store.goal)
                 ? "Stretch goal reached. High five, tiny robot!"
                 : "One more run in the bank. That's how progress happens.")
                .font(.system(.headline, design: .rounded))
            HStack(spacing: 22) {
                Label("\(store.session.mistakes) \(store.session.mistakes == 1 ? "slip" : "slips")", systemImage: "circle.dotted")
                Label("\(store.session.backspaces) backspaces", systemImage: "delete.left")
            }
            .font(.subheadline).foregroundStyle(.secondary)
            Button("Another round", systemImage: "arrow.right") { store.reset() }
                .buttonStyle(.borderedProminent).controlSize(.large)
                .keyboardShortcut(.return, modifiers: [])
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var historyView: some View {
        VStack(alignment: .leading, spacing: 24) {
            if store.history.isEmpty {
                VStack(spacing: 16) {
                    BlobbySprite(pose: "cool", scale: 2)
                    Text("Your story starts with one run.")
                        .font(.system(.title2, design: .rounded, weight: .bold))
                    Text("Finish a workout and your WPM, accuracy, and progress will appear here.")
                        .foregroundStyle(.secondary)
                    Button("Let's practice") { store.reset() }
                        .buttonStyle(.borderedProminent).controlSize(.large)
                }
                .frame(maxWidth: .infinity, minHeight: 450)
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Recent rhythm").font(.headline)
                    Text("\(store.session.drill.title) · \(store.session.duration)s · last 12 matching runs")
                        .font(.caption).foregroundStyle(.secondary)
                    HStack(alignment: .bottom, spacing: 12) {
                        ForEach(Array(store.matchingHistory.prefix(12).reversed())) { result in
                            VStack(spacing: 6) {
                                Text("\(Int(result.wpm.rounded()))").font(.system(.caption, design: .monospaced))
                                RoundedRectangle(cornerRadius: 5)
                                    .fill(accent.opacity(0.8))
                                    .frame(height: max(4, result.wpm / max(store.best, 1) * 80))
                            }
                            .frame(maxWidth: .infinity)
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel("\(result.date.formatted()), \(Int(result.wpm.rounded())) words per minute")
                        }
                        if store.matchingHistory.isEmpty {
                            Text("No runs for this mix yet. Choose another mix, or start a workout.")
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                    .frame(height: 110, alignment: .bottom)
                }
                .padding(22).background(card, in: RoundedRectangle(cornerRadius: 16))
                HStack {
                    Text("Finished workouts").font(.headline)
                    Spacer()
                    Text("\(store.history.count) saved").font(.caption).foregroundStyle(.secondary)
                }
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(store.history) { result in
                            HStack(spacing: 16) {
                                Image(systemName: result.drill.symbol).foregroundStyle(accent).frame(width: 24)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(result.drill.title).font(.subheadline.weight(.medium))
                                    Text(result.date.formatted(date: .abbreviated, time: .shortened))
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text("\(result.duration)s").foregroundStyle(.secondary).frame(width: 40)
                                Text("\(Int(result.accuracy.rounded()))%").frame(width: 50)
                                Text("\(Int(result.wpm.rounded())) wpm")
                                    .fontWeight(.semibold).foregroundStyle(accent).frame(width: 85, alignment: .trailing)
                            }
                            .font(.system(.subheadline, design: .monospaced))
                            .padding(.vertical, 16)
                            Divider().opacity(0.4)
                        }
                    }
                }
                .frame(height: 300)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var footer: some View {
        HStack {
            Text("⌘R restart").font(.system(size: 11, design: .monospaced))
            Button {
                store.soundEnabled.toggle()
                store.focusID = UUID()
            } label: {
                Label(store.soundEnabled ? "Sound on" : "Muted", systemImage: store.soundEnabled ? "speaker.wave.2" : "speaker.slash")
                    .font(.caption)
            }
            .buttonStyle(.plain)
            .help("Toggle quiet key taps, mistake sounds, and completion chimes")
            Spacer()
            Text("No accounts. No network. Just you + Blobby.")
                .font(.caption)
        }
        .foregroundStyle(.secondary)
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text).font(.system(size: 10, weight: .semibold, design: .monospaced))
            .tracking(1.2).foregroundStyle(.secondary)
    }

    private func navButton(_ title: String, symbol: String, selected: Bool, compact: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: symbol).frame(width: 20)
                Text(title).font(.system(size: 13, weight: selected ? .semibold : .regular))
                Spacer(minLength: 0)
            }
            .foregroundStyle(selected ? accent : .primary)
            .padding(.horizontal, 10).padding(.vertical, compact ? 7 : 11)
            .background(selected ? accent.opacity(0.1) : .clear, in: RoundedRectangle(cornerRadius: 9))
        }
        .buttonStyle(.plain)
    }

    private func metric(_ title: String, value: String, unit: String, symbol: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(title).font(.system(size: 9, weight: .semibold, design: .monospaced)).tracking(0.6)
                Spacer(minLength: 2)
                Image(systemName: symbol).font(.caption)
            }
            .foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(value).font(.system(size: 32, weight: .semibold, design: .rounded)).monospacedDigit()
                Text(unit).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(card, in: RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title), \(value) \(unit)")
    }
}

private struct WordFlow: Layout {
    let spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(width: proposal.width ?? 700, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let layout = arrange(width: bounds.width, subviews: subviews)
        for (index, point) in layout.points.enumerated() {
            subviews[index].place(
                at: CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y),
                proposal: .unspecified
            )
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> (size: CGSize, points: [CGPoint]) {
        var x: CGFloat = 0
        var y: CGFloat = 0
        var lineHeight: CGFloat = 0
        var points: [CGPoint] = []
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width {
                x = 0
                y += lineHeight + spacing
                lineHeight = 0
            }
            points.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
        return (CGSize(width: width, height: y + lineHeight), points)
    }
}
