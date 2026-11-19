import AppKit

final class CounterElement: NSAccessibilityElement {
    var press: (() -> Void)?
    override func accessibilityPerformPress() -> Bool { press?(); return true }
}

final class EditableElement: NSAccessibilityElement {
    var text = "fixture-original"
    override func accessibilityValue() -> Any? { text }
    override func setAccessibilityValue(_ value: Any?) { text = value as? String ?? "" }
    override func isAccessibilitySelectorAllowed(_ selector: Selector) -> Bool {
        selector == NSSelectorFromString("setAccessibilityValue:") || super.isAccessibilitySelectorAllowed(selector)
    }
}

final class Fixture: NSObject, NSApplicationDelegate {
    let directory: URL
    let windows: [NSWindow]
    let button = NSButton(title: "Cognia Fixture Counter", target: nil, action: nil)
    let field = NSTextField(string: "fixture-original")
    let counterElement = CounterElement()
    let fieldElement = EditableElement()
    var counts = [0, 0]
    var sequence = 0
    var timer: Timer?

    init(directory: URL) {
        self.directory = directory
        self.windows = (0...1).map { index in
            let window = NSWindow(contentRect: NSRect(x: 90 + index * 360, y: 220, width: 320, height: 220),
                                  styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.title = "Cognia P0 \(directory.lastPathComponent) \(index == 0 ? "A" : "B")"
            window.isReleasedWhenClosed = false
            return window
        }
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        button.frame = NSRect(x: 35, y: 95, width: 250, height: 35)
        button.target = self
        button.action = #selector(pressed)
        button.setAccessibilityIdentifier("cognia-p0-counter")
        windows[0].contentView!.addSubview(button)
        field.frame = NSRect(x: 35, y: 45, width: 250, height: 25)
        field.setAccessibilityIdentifier("cognia-p0-field")
        windows[0].contentView!.addSubview(field)
        counterElement.setAccessibilityRole(.button)
        counterElement.setAccessibilityLabel("Cognia Fixture Counter")
        counterElement.setAccessibilityIdentifier("cognia-p0-counter")
        counterElement.press = { [weak self] in self?.pressed() }
        fieldElement.setAccessibilityRole(.textField)
        fieldElement.setAccessibilityLabel("Cognia Fixture Field")
        fieldElement.setAccessibilityIdentifier("cognia-p0-field")
        fieldElement.setAccessibilityValue("fixture-original")
        bindElements(to: 0)
        for window in windows { window.orderFrontRegardless() }
        publish()
        timer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { [weak self] _ in self?.poll() }
    }

    func bindElements(to index: Int) {
        for (i, window) in windows.enumerated() {
            window.contentView!.setAccessibilityChildren(i == index ? [counterElement, fieldElement] : [])
        }
        for element in [counterElement, fieldElement] {
            element.setAccessibilityElement(true)
            element.setAccessibilityEnabled(true)
            element.setAccessibilityParent(windows[index].contentView!)
            element.setAccessibilityWindow(windows[index])
            element.setAccessibilityTopLevelUIElement(windows[index])
            element.setAccessibilityFrame(windows[index].convertToScreen(NSRect(x: 35, y: 45, width: 250, height: 80)))
        }
    }

    @objc func pressed() {
        let index = button.window === windows[0] ? 0 : 1
        counts[index] += 1
        publish()
    }

    func publish() {
        let state: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier,
                                  "windows": windows.map { "w-\($0.windowNumber)" },
                                  "counts": counts,
                                  "owner": button.window === windows[0] ? 0 : 1,
                                  "sequence": sequence]
        let data = try! JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])
        try! data.write(to: directory.appendingPathComponent("state.json"), options: .atomic)
    }

    func poll() {
        let url = directory.appendingPathComponent("command.json")
        guard let data = try? Data(contentsOf: url),
              let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let next = command["sequence"] as? Int, next > sequence else { return }
        sequence = next
        switch command["action"] as? String {
        case "move":
            button.removeFromSuperview()
            field.removeFromSuperview()
            windows[1].contentView!.addSubview(button)
            windows[1].contentView!.addSubview(field)
            bindElements(to: 1)
        case "reset":
            button.removeFromSuperview()
            field.removeFromSuperview()
            windows[0].contentView!.addSubview(button)
            windows[0].contentView!.addSubview(field)
            field.stringValue = "fixture-original"
            fieldElement.setAccessibilityValue("fixture-original")
            bindElements(to: 0)
            counts = [0, 0]
        case "quit": NSApplication.shared.terminate(nil)
        default: break
        }
        publish()
    }
}

guard CommandLine.arguments.count >= 2 else { fatalError("Fixture directory required") }
let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let fixture = Fixture(directory: directory)
app.delegate = fixture
app.run()
