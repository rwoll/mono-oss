import AppKit

enum FeedbackSound: CaseIterable {
    case key, mistake, complete

    var duration: Double {
        switch self {
        case .key: 0.035
        case .mistake: 0.09
        case .complete: 0.42
        }
    }

    func waveData() -> Data {
        let rate = 22_050
        let samples = Int(duration * Double(rate))
        var pcm = Data(capacity: samples * 2)
        for index in 0..<samples {
            let time = Double(index) / Double(rate)
            let fadeIn = min(1, time / 0.003)
            let fadeOut = min(1, (duration - time) / 0.012)
            let value: Double
            switch self {
            case .key:
                value = sin(2 * .pi * 1150 * time) * exp(-time * 150) * 0.35
                    + sin(2 * .pi * 2300 * time) * exp(-time * 220) * 0.08
            case .mistake:
                value = sin(2 * .pi * 220 * time) * exp(-time * 35) * 0.3
            case .complete:
                value = [523.25, 659.25, 783.99].enumerated().reduce(0) { total, note in
                    let local = time - Double(note.offset) * 0.08
                    guard local >= 0 else { return total }
                    return total + sin(2 * .pi * note.element * local) * min(1, local / 0.006) * exp(-local * 12) * 0.18
                }
            }
            pcm.appendLittleEndian(Int16((value * fadeIn * fadeOut * Double(Int16.max)).rounded()))
        }
        var data = Data("RIFF".utf8)
        data.appendLittleEndian(UInt32(36 + pcm.count))
        data.append(contentsOf: "WAVEfmt ".utf8)
        data.appendLittleEndian(UInt32(16))
        data.appendLittleEndian(UInt16(1))
        data.appendLittleEndian(UInt16(1))
        data.appendLittleEndian(UInt32(rate))
        data.appendLittleEndian(UInt32(rate * 2))
        data.appendLittleEndian(UInt16(2))
        data.appendLittleEndian(UInt16(16))
        data.append(contentsOf: "data".utf8)
        data.appendLittleEndian(UInt32(pcm.count))
        data.append(pcm)
        return data
    }
}

@MainActor
final class SoundEffects {
    private var voices: [FeedbackSound: [NSSound]] = [:]

    init() throws {
        for effect in FeedbackSound.allCases {
            let data = effect.waveData()
            voices[effect] = try (0..<4).map { _ in
                guard let sound = NSSound(data: data) else {
                    throw NSError(domain: "BlobbySound", code: 1, userInfo: [
                        NSLocalizedDescriptionKey: "macOS couldn't load the generated \(effect) sound."
                    ])
                }
                sound.volume = 0.3
                return sound
            }
        }
    }

    func play(_ effect: FeedbackSound) throws {
        guard let pool = voices[effect], let sound = pool.first(where: { !$0.isPlaying }) ?? pool.first else {
            throw NSError(domain: "BlobbySound", code: 2, userInfo: [NSLocalizedDescriptionKey: "No sound voice is available."])
        }
        if sound.isPlaying { sound.stop() }
        guard sound.play() else {
            throw NSError(domain: "BlobbySound", code: 3, userInfo: [NSLocalizedDescriptionKey: "macOS couldn't play a sound effect."])
        }
    }

    func stop() {
        for pool in voices.values {
            for sound in pool where sound.isPlaying { sound.stop() }
        }
    }
}

private extension Data {
    mutating func appendLittleEndian<T: FixedWidthInteger>(_ value: T) {
        var value = value.littleEndian
        Swift.withUnsafeBytes(of: &value) { append(contentsOf: $0) }
    }
}
