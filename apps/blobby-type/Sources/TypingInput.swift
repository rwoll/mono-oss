import AppKit
import SwiftUI

struct TypingInput: NSViewRepresentable {
    let text: String
    let enabled: Bool
    let focusID: UUID
    let onAction: (TypingAction) -> Void
    let onPaste: () -> Void

    func makeNSView(context: Context) -> PracticeTextView {
        let view = PracticeTextView()
        view.isRichText = false
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.isAutomaticDashSubstitutionEnabled = false
        view.isAutomaticTextReplacementEnabled = false
        view.isAutomaticSpellingCorrectionEnabled = false
        view.isContinuousSpellCheckingEnabled = false
        view.isGrammarCheckingEnabled = false
        view.allowsUndo = false
        view.drawsBackground = false
        view.font = .monospacedSystemFont(ofSize: 19, weight: .medium)
        view.textColor = .labelColor
        view.insertionPointColor = NSColor(srgbRed: 0.30, green: 0.78, blue: 0.51, alpha: 1)
        view.textContainerInset = NSSize(width: 0, height: 9)
        view.textContainer?.lineFragmentPadding = 0
        view.textContainer?.maximumNumberOfLines = 1
        view.textContainer?.lineBreakMode = .byTruncatingHead
        view.isHorizontallyResizable = false
        return view
    }

    func updateNSView(_ view: PracticeTextView, context: Context) {
        view.onAction = onAction
        view.onPaste = onPaste
        view.isEditable = enabled
        view.isSelectable = enabled
        view.setAccessibilityLabel("Typing practice input")
        view.setAccessibilityHelp("Type the prompt above. Backspace corrects the last character. Pasting is disabled.")
        if view.string != text {
            view.string = text
            view.setSelectedRange(NSRange(location: view.string.utf16.count, length: 0))
        }
        if view.focusID != focusID {
            view.focusID = focusID
            DispatchQueue.main.async { [weak view] in
                guard let view, view.isEditable else { return }
                view.window?.makeFirstResponder(view)
            }
        }
    }
}

final class PracticeTextView: NSTextView {
    var onAction: ((TypingAction) -> Void)?
    var onPaste: (() -> Void)?
    var focusID: UUID?

    override func insertText(_ insertString: Any, replacementRange: NSRange) {
        guard isEditable else { return }
        if let text = insertString as? String {
            onAction?(.type(text))
        } else if let text = insertString as? NSAttributedString {
            onAction?(.type(text.string))
        }
    }

    override func deleteBackward(_ sender: Any?) {
        guard isEditable else { return }
        onAction?(.backspace)
    }

    override func paste(_ sender: Any?) { onPaste?() }
    override func pasteAsPlainText(_ sender: Any?) { onPaste?() }
    override func pasteAsRichText(_ sender: Any?) { onPaste?() }
    override func menu(for event: NSEvent) -> NSMenu? { nil }

    override func doCommand(by selector: Selector) {
        if selector == #selector(deleteBackward(_:)) { deleteBackward(nil) }
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        setSelectedRange(NSRange(location: string.utf16.count, length: 0))
    }

    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation { [] }
    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool { false }
}
