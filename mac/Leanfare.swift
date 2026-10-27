// Leanfare for the Mac.
//
// The menu bar shows what you spent today; its menu has the month, the budget,
// Pause and Start again, and a note pad for what annoys you. The window shows
// Leanfare's own screens. The app starts Leanfare's local server (with the Bun
// you installed) when it is not already running, and stops it when you quit.
// If you started Leanfare yourself in Terminal, the app uses that one and
// leaves it running.
//
// Built by mac/build.sh with Apple's Swift compiler; no other code is needed.
import AppKit
import ServiceManagement
import WebKit

// MARK: - Where things are

enum Place {
    static let home = FileManager.default.homeDirectoryForCurrentUser

    static var dataDir: URL {
        if let d = ProcessInfo.processInfo.environment["LEANFARE_DATA_DIR"], !d.isEmpty { return URL(fileURLWithPath: d) }
        return home.appendingPathComponent(".leanfare")
    }
    static var pidFile: URL { dataDir.appendingPathComponent("leanfare.pid") }
    static var tokenFile: URL { dataDir.appendingPathComponent("control.token") }
    static var logFile: URL { dataDir.appendingPathComponent("app.log") }

    // The Leanfare server inside this app (copied in by build.sh).
    static var serverScript: URL? {
        guard let res = Bundle.main.resourceURL else { return nil }
        let u = res.appendingPathComponent("leanfare/src/cli.ts")
        return FileManager.default.fileExists(atPath: u.path) ? u : nil
    }

    // Notes go to the file build.sh names (a notes folder next to this copy), or to ~/.leanfare/notes.md.
    static var notesFile: URL {
        if let p = Bundle.main.object(forInfoDictionaryKey: "LeanfareNotesFile") as? String, !p.isEmpty {
            return URL(fileURLWithPath: (p as NSString).expandingTildeInPath)
        }
        return dataDir.appendingPathComponent("notes.md")
    }

    // Bun: the one build.sh found when it built this app (any install: bun.sh,
    // Homebrew, mise, asdf, proto), then where its installer or Homebrew put it,
    // then wherever your login shell finds it.
    static func bun() -> URL? {
        var candidates: [String] = []
        if let b = ProcessInfo.processInfo.environment["LEANFARE_BUN"], !b.isEmpty { candidates.append(b) }
        if let b = Bundle.main.object(forInfoDictionaryKey: "LeanfareBun") as? String, !b.isEmpty {
            candidates.append((b as NSString).expandingTildeInPath)
        }
        candidates.append(home.appendingPathComponent(".bun/bin/bun").path)
        candidates.append("/opt/homebrew/bin/bun")
        candidates.append("/usr/local/bin/bun")
        for c in candidates where FileManager.default.isExecutableFile(atPath: c) { return URL(fileURLWithPath: c) }
        return shellBun()
    }

    // Asks your shell, the way Terminal starts it, where bun is (at most 4 seconds).
    static func shellBun() -> URL? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-ilc", "command -v bun"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        let until = Date().addingTimeInterval(4)
        while p.isRunning && Date() < until { Thread.sleep(forTimeInterval: 0.05) }
        if p.isRunning { p.terminate(); return nil }
        let text = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let path = text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.last { $0.hasPrefix("/") } ?? ""
        return FileManager.default.isExecutableFile(atPath: path) ? URL(fileURLWithPath: path) : nil
    }
}

// MARK: - Talking to the local server

struct Summary: Decodable {
    struct Budget: Decodable {
        let amount: Double
        let left: Double?
        let pct: Double?
        let warn: Bool
        let reached: Bool
    }
    // Your plans, in what they are measured in: the 5 hour and weekly windows (percent used) and the
    // month's tokens in Claude Code's and Codex's log files. value: at API prices, only when Settings shows it.
    struct PlanLine: Decodable {
        let plan: String
        let price: Double
        let tokens: Double
        let five: Double?
        let week: Double?
        let value: Double?
        let ratio: Double?
    }
    struct Plans: Decodable {
        let claude: PlanLine?
        let chatgpt: PlanLine?
    }
    let todayText: String
    let monthText: String
    let answers: Int
    let paused: Bool
    let locked: Bool
    let running: Int
    let budget: Budget?
    let plans: Plans?
}

final class Server {
    var port = 4747
    var token = ""
    var child: Process?
    var stopping = false
    var onExit: ((Int32) -> Void)?

    var base: String { "http://127.0.0.1:\(port)" }
    var startedHere: Bool { child != nil }

    func readFiles() {
        if let d = try? Data(contentsOf: Place.pidFile),
           let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
           let p = j["port"] as? Int {
            port = p
        }
        let t = (try? String(contentsOf: Place.tokenFile, encoding: .utf8)) ?? ""
        token = t.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) -> URLRequest {
        var r = URLRequest(url: URL(string: base + path)!, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 4)
        r.httpMethod = method
        r.setValue("1", forHTTPHeaderField: "x-leanfare")
        r.setValue(token, forHTTPHeaderField: "x-leanfare-token")
        if let body = body {
            r.setValue("application/json", forHTTPHeaderField: "content-type")
            r.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        return r
    }

    func healthy(_ done: @escaping (Bool) -> Void) {
        var r = URLRequest(url: URL(string: base + "/healthz")!, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 1.5)
        r.httpMethod = "GET"
        URLSession.shared.dataTask(with: r) { data, _, _ in
            let j = data.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }
            let ok = (j?["app"] as? String) == "leanfare"
            DispatchQueue.main.async { done(ok) }
        }.resume()
    }

    func summary(_ done: @escaping (Summary?) -> Void) {
        URLSession.shared.dataTask(with: request("/api/summary")) { data, response, _ in
            let fine = (response as? HTTPURLResponse)?.statusCode == 200
            let s: Summary? = fine ? data.flatMap { try? JSONDecoder().decode(Summary.self, from: $0) } : nil
            DispatchQueue.main.async { done(s) }
        }.resume()
    }

    func post(_ path: String, _ body: [String: Any], _ done: @escaping (Bool) -> Void) {
        URLSession.shared.dataTask(with: request(path, method: "POST", body: body)) { _, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { done(ok) }
        }.resume()
    }

    // Starts Leanfare with Bun; its output goes to ~/.leanfare/app.log.
    func start(bun: URL, script: URL) throws {
        try FileManager.default.createDirectory(at: Place.dataDir, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: Place.logFile.path) {
            _ = FileManager.default.createFile(atPath: Place.logFile.path, contents: nil)
        }
        let log = try FileHandle(forWritingTo: Place.logFile)
        log.seekToEndOfFile()
        let p = Process()
        p.executableURL = bun
        p.arguments = [script.path, "--no-open"]
        var env = ProcessInfo.processInfo.environment
        env["LEANFARE_NO_OPEN"] = "1"
        env["PATH"] = [bun.deletingLastPathComponent().path, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", env["PATH"] ?? ""].joined(separator: ":")
        p.environment = env
        p.standardOutput = log
        p.standardError = log
        p.standardInput = FileHandle.nullDevice
        p.terminationHandler = { [weak self] proc in
            let code = proc.terminationStatus
            DispatchQueue.main.async {
                // Only the Leanfare this app runs now (not one it stopped before starting another).
                guard let self = self, self.child === proc else { return }
                self.child = nil
                self.onExit?(code)
            }
        }
        try p.run()
        child = p
    }

    // Asks Leanfare to stop (running answers may finish), then waits for it.
    func stop(_ done: @escaping () -> Void) {
        guard let p = child else { done(); return }
        stopping = true
        post("/api/control/stop", [:]) { _ in }
        DispatchQueue.global().async {
            let until = Date().addingTimeInterval(12)
            while p.isRunning && Date() < until { Thread.sleep(forTimeInterval: 0.1) }
            if p.isRunning { p.terminate() }
            DispatchQueue.main.async { done() }
        }
    }
}

// MARK: - The window with Leanfare's screens

final class WebWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    let window: NSWindow
    let web: WKWebView
    var onClose: (() -> Void)?
    var onLocked: (() -> Void)?
    var lastUnlock = Date.distantPast

    override init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = WKWebsiteDataStore.default()
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1200, height: 780), configuration: config)
        web.allowsBackForwardNavigationGestures = false
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 780),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        super.init()
        // The page saves files (an exported chat) through this, into your Downloads folder,
        // and says when it shows the lock screen (the app then opens it again, unlocked).
        config.userContentController.add(self, name: "leanfareSave")
        config.userContentController.add(self, name: "leanfareLocked")
        window.title = "Leanfare"
        window.minSize = NSSize(width: 760, height: 520)
        window.contentView = web
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        window.setFrameAutosaveName("LeanfareMain")
        web.navigationDelegate = self
        web.uiDelegate = self
    }

    func load(_ server: Server) {
        // The unlock link opens a locked Leanfare unlocked (the control token only you can read).
        let t = server.token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        if let u = URL(string: "\(server.base)/unlock?t=\(t)") { web.load(URLRequest(url: u)) }
    }

    func windowWillClose(_ notification: Notification) { onClose?() }

    // A file from the page: { name, text } saved in Downloads, then shown in Finder.
    // The lock screen: opened again through the unlock link, at most every 10 seconds
    // (so a lock the link cannot open stays on screen instead of reloading forever).
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "leanfareLocked" {
            if Date().timeIntervalSince(lastUnlock) > 10 {
                lastUnlock = Date()
                onLocked?()
            }
            return
        }
        guard message.name == "leanfareSave", let body = message.body as? [String: Any],
              let name = body["name"] as? String, let text = body["text"] as? String else { return }
        let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first ?? Place.home
        let clean = name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
        var target = folder.appendingPathComponent(clean.isEmpty ? "leanfare.txt" : clean)
        let stem = target.deletingPathExtension().lastPathComponent
        let ext = target.pathExtension
        var n = 2
        while FileManager.default.fileExists(atPath: target.path) {
            target = folder.appendingPathComponent(ext.isEmpty ? "\(stem) \(n)" : "\(stem) \(n).\(ext)")
            n += 1
        }
        do {
            try text.write(to: target, atomically: true, encoding: .utf8)
            NSWorkspace.shared.activateFileViewerSelecting([target])
        } catch {
            let a = NSAlert()
            a.messageText = "The file was not saved"
            a.informativeText = error.localizedDescription
            _ = a.runModal()
        }
    }

    // <input type="file">: the usual Open panel.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo) async -> [URL]? {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        let result = await panel.beginSheetModal(for: window)
        return result == .OK ? panel.urls : nil
    }

    // Links to other sites (they open in a new tab) go to your browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { showProblem(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { showProblem(error) }

    private func showProblem(_ error: Error) {
        let html = "<html><body style=\"font: 14px -apple-system; color: #62676b; display: grid; place-items: center; height: 90vh; text-align: center\"><div><h3 style=\"color:#16181a\">Leanfare is not answering yet</h3><p>\(error.localizedDescription)</p><p>It usually starts in a second. Choose Reload in the View menu.</p></div></body></html>"
        web.loadHTMLString(html, baseURL: nil)
    }
}

// MARK: - The app

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let server = Server()
    var statusItem: NSStatusItem!
    let menu = NSMenu()
    var webWindow: WebWindow?
    var timer: Timer?
    var last: Summary?
    var problem: String?
    var quitting = false
    var starting = false // waiting for the Leanfare this app started to answer
    var windowWanted = false // open the window once Leanfare answers

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        buildMainMenu()
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.image = AppDelegate.markImage()
            button.imagePosition = .imageLeading
            button.font = NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
            button.title = " …"
            button.toolTip = "Leanfare: what you spent on AI today"
        }
        menu.delegate = self
        statusItem.menu = menu
        server.onExit = { [weak self] code in self?.serverExited(code) }
        connect(openWindow: true)
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    // Use a Leanfare that is already running, or start the one inside this app.
    func connect(openWindow: Bool) {
        if openWindow { windowWanted = true }
        server.readFiles()
        server.healthy { [weak self] ok in
            guard let self = self else { return }
            if ok {
                self.problem = nil
                self.refresh()
                return
            }
            guard let bun = Place.bun() else { self.needBun(); return }
            guard let script = Place.serverScript else { self.setProblem("This copy of the app has no Leanfare inside it. Build it again with mac/build.sh."); return }
            do { try self.server.start(bun: bun, script: script) } catch {
                self.setProblem("Leanfare could not start: \(error.localizedDescription)")
                return
            }
            self.starting = true
            self.waitUntilUp(tries: 0)
        }
    }

    // Waits up to 15 seconds for it to answer. After that it says so, and the next
    // refresh that gets an answer clears the problem and opens the window after all.
    func waitUntilUp(tries: Int) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            guard let self = self else { return }
            self.server.readFiles()
            self.server.healthy { ok in
                if ok && !self.server.token.isEmpty {
                    self.starting = false
                    self.problem = nil
                    self.refresh()
                } else if tries < 60 && self.server.child != nil {
                    self.waitUntilUp(tries: tries + 1)
                } else {
                    self.starting = false
                    if self.server.child != nil { self.setProblem("Leanfare is taking long to start. Its log is in ~/.leanfare/app.log.") }
                }
            }
        }
    }

    func serverExited(_ code: Int32) {
        if quitting || server.stopping { return }
        if code == 4 { setProblem("Port \(server.port) is used by another program, so Leanfare could not start. Start it in Terminal on another port: leanfare --port 4748") }
        else { setProblem("Leanfare stopped (code \(code)). Its log is in ~/.leanfare/app.log. Choose Start Leanfare Again in the menu.") }
    }

    func setProblem(_ text: String) {
        problem = text
        statusItem.button?.title = " !"
        statusItem.button?.toolTip = text
    }

    func needBun() {
        setProblem("Leanfare needs Bun.")
        let a = NSAlert()
        a.messageText = "Leanfare needs Bun"
        a.informativeText = "Leanfare runs on Bun, a free JavaScript runtime. Install it once in Terminal with:\n\ncurl -fsSL https://bun.sh/install | bash\n\nthen open Leanfare again."
        a.addButton(withTitle: "Copy the Command")
        a.addButton(withTitle: "Open bun.sh")
        a.addButton(withTitle: "Later")
        NSApp.activate(ignoringOtherApps: true)
        let r = a.runModal()
        if r == .alertFirstButtonReturn {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString("curl -fsSL https://bun.sh/install | bash", forType: .string)
        } else if r == .alertSecondButtonReturn, let u = URL(string: "https://bun.sh") {
            NSWorkspace.shared.open(u)
        }
    }

    // The menu bar: today's spend, coloured when the budget is close or used up.
    // An answer clears any problem shown (Leanfare is up after all, or up again).
    func refresh() {
        server.summary { [weak self] s in
            guard let self = self, let button = self.statusItem.button else { return }
            guard let s = s else { self.notAnswering(); return }
            self.last = s
            self.problem = nil
            if self.windowWanted {
                self.windowWanted = false
                self.showWindow()
            }
            var color = NSColor.labelColor
            if let b = s.budget { color = b.reached ? NSColor.systemRed : b.warn ? NSColor.systemOrange : NSColor.labelColor }
            let text = (s.paused ? " ⏸ " : " ") + s.todayText
            button.attributedTitle = NSAttributedString(string: text, attributes: [
                .foregroundColor: color,
                .font: NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .regular),
            ])
            button.toolTip = "Leanfare: \(s.todayText) today, \(s.monthText) this month"
        }
    }

    // No summary: Leanfare stopped, or was started again in Terminal (a new port or
    // control token, read again here). A problem already shown stays as it is.
    func notAnswering() {
        server.readFiles() // so a Leanfare started in Terminal is found on the next refresh
        if starting || quitting || problem != nil { return }
        server.healthy { [weak self] ok in
            guard let self = self, !ok, !self.starting, !self.quitting, self.problem == nil else { return }
            self.last = nil
            if self.server.startedHere {
                self.setProblem("Leanfare is not answering. Its log is in ~/.leanfare/app.log. Choose Start Leanfare Again in the menu.")
            } else {
                self.setProblem("Leanfare is not running any more (it was started outside this app). Choose Start Leanfare Again in the menu.")
            }
        }
    }

    // The menu is built each time it opens, from the latest numbers.
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        if let p = problem {
            menu.addItem(info(p))
            menu.addItem(item("Start Leanfare Again", #selector(startAgainServer)))
            menu.addItem(.separator())
        } else if let s = last {
            menu.addItem(info("Today \(s.todayText) · This month \(s.monthText)"))
            if let b = s.budget {
                let left = b.left.map { String(format: "$%.2f", max(0, $0)) } ?? "?"
                menu.addItem(info("Budget: \(left) left of \(String(format: "$%.2f", b.amount)) (\(Int(b.pct ?? 0))% used)"))
            }
            menu.addItem(info("\(s.answers) answers this month\(s.running > 0 ? " · \(s.running) running" : "")"))
            // One line per plan you entered: how much of its windows is used, and the month's tokens.
            for line in [s.plans?.claude, s.plans?.chatgpt].compactMap({ $0 }) {
                var parts: [String] = []
                if let f = line.five { parts.append("5 hours \(Int(f.rounded()))%") }
                if let w = line.week { parts.append("week \(Int(w.rounded()))%") }
                if line.tokens > 0 { parts.append("\(tokensText(line.tokens)) tokens this month") }
                if let v = line.value { parts.append("about \(String(format: "$%.0f", v)) at API prices" + (line.ratio.map { String(format: " (%.1f× the $%.0f)", $0, line.price) } ?? "")) }
                menu.addItem(info("\(line.plan): " + (parts.isEmpty ? "no numbers yet" : parts.joined(separator: " · "))))
            }
            menu.addItem(.separator())
        }
        menu.addItem(item("Open Leanfare", #selector(openWindowAction), "o"))
        menu.addItem(item("Open in Browser", #selector(openInBrowser)))
        if let s = last, problem == nil {
            menu.addItem(item(s.paused ? "Start Again" : "Pause New Requests", #selector(togglePause)))
        }
        menu.addItem(item("Copy the API Address", #selector(copyAddress)))
        menu.addItem(.separator())
        menu.addItem(item("Jot Down a Note…", #selector(jotNote)))
        let login = item("Open at Login", #selector(toggleLogin))
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        menu.addItem(login)
        menu.addItem(.separator())
        menu.addItem(item("Quit Leanfare", #selector(quit), "q"))
    }

    // 1.2B, 412M, 35k: tokens in a few characters.
    func tokensText(_ n: Double) -> String {
        if n >= 1e9 { return String(format: "%.1fB", n / 1e9) }
        if n >= 1e6 { return String(format: "%.1fM", n / 1e6) }
        if n >= 1e3 { return String(format: "%.0fk", n / 1e3) }
        return String(format: "%.0f", n)
    }

    func info(_ title: String) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        i.isEnabled = false
        return i
    }

    func item(_ title: String, _ action: Selector, _ key: String = "") -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.target = self
        return i
    }

    @objc func openWindowAction() { showWindow() }

    func showWindow() {
        if webWindow == nil {
            let w = WebWindow()
            w.onClose = { [weak self] in self?.windowClosed() }
            w.onLocked = { [weak self] in self?.reloadPage() }
            w.load(server)
            webWindow = w
        }
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        webWindow?.window.makeKeyAndOrderFront(nil)
    }

    func windowClosed() {
        // Back to the menu bar only: no Dock icon while the window is closed.
        DispatchQueue.main.async { NSApp.setActivationPolicy(.accessory) }
    }

    @objc func openInBrowser() {
        let t = server.token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        let link = (last?.locked ?? false) ? "\(server.base)/unlock?t=\(t)" : server.base
        if let u = URL(string: link) { NSWorkspace.shared.open(u) }
    }

    @objc func togglePause() {
        guard let s = last else { return }
        server.post("/api/pause", ["paused": !s.paused]) { [weak self] _ in self?.refresh() }
    }

    @objc func copyAddress() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString("\(server.base)/v1", forType: .string)
    }

    @objc func startAgainServer() {
        problem = nil
        last = nil
        statusItem.button?.title = " …"
        // A Leanfare of this app's that stopped answering is stopped first.
        if server.child != nil {
            server.stop { [weak self] in
                guard let self = self else { return }
                self.server.child = nil // it stopped because it was asked to: not a problem to show
                self.server.stopping = false
                self.connect(openWindow: false)
            }
            return
        }
        connect(openWindow: false)
    }

    // A note for later: one line in the notes file, with the date.
    @objc func jotNote() {
        let a = NSAlert()
        a.messageText = "Jot down a note"
        a.informativeText = "What annoyed you, or what you wished Leanfare did. It goes to \(Place.notesFile.path)."
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 64))
        field.placeholderString = "For example: the estimate jumps around while I type"
        field.lineBreakMode = .byWordWrapping
        field.usesSingleLineMode = false
        field.cell?.wraps = true
        field.cell?.isScrollable = false
        a.accessoryView = field
        a.addButton(withTitle: "Save")
        a.addButton(withTitle: "Cancel")
        a.window.initialFirstResponder = field
        NSApp.activate(ignoringOtherApps: true)
        guard a.runModal() == .alertFirstButtonReturn else { return }
        let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\n", with: " ")
        guard !text.isEmpty else { return }
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm"
        let line = "- \(f.string(from: Date())): \(text)\n"
        let url = Place.notesFile
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            if !FileManager.default.fileExists(atPath: url.path) {
                try ("# Notes from using Leanfare\n\n" + line).write(to: url, atomically: true, encoding: .utf8)
            } else {
                let h = try FileHandle(forWritingTo: url)
                h.seekToEndOfFile()
                h.write(line.data(using: .utf8)!)
                h.closeFile()
            }
        } catch {
            let e = NSAlert()
            e.messageText = "The note was not saved"
            e.informativeText = error.localizedDescription
            _ = e.runModal()
        }
    }

    @objc func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            else { try SMAppService.mainApp.register() }
        } catch {
            let e = NSAlert()
            e.messageText = "Open at Login could not be changed"
            e.informativeText = "\(error.localizedDescription)\n\nYou can also add Leanfare in System Settings, General, Login Items."
            _ = e.runModal()
        }
    }

    @objc func quit() { NSApp.terminate(nil) }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard server.startedHere, !quitting else { return .terminateNow }
        quitting = true
        statusItem.button?.title = " Stopping…"
        server.stop { NSApp.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showWindow() }
        return true
    }

    // MARK: menus for the window (copy and paste need the Edit menu)

    func buildMainMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Leanfare", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Leanfare", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Leanfare", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem()
        main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let view = NSMenu(title: "View")
        let reload = NSMenuItem(title: "Reload", action: #selector(reloadPage), keyEquivalent: "r")
        reload.target = self
        view.addItem(reload)
        viewItem.submenu = view

        let windowItem = NSMenuItem()
        main.addItem(windowItem)
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = win
        NSApp.windowsMenu = win

        NSApp.mainMenu = main
    }

    @objc func reloadPage() {
        guard let w = webWindow else { return }
        server.readFiles()
        w.load(server)
    }

    // The Leanfare mark, drawn as a menu bar template image (it follows light and dark).
    static func markImage() -> NSImage {
        let img = NSImage(size: NSSize(width: 16, height: 16), flipped: true) { _ in
            let path = NSBezierPath()
            path.move(to: NSPoint(x: 1.5, y: 4))
            path.line(to: NSPoint(x: 6.5, y: 9))
            path.line(to: NSPoint(x: 9.5, y: 6.5))
            path.line(to: NSPoint(x: 13.5, y: 12))
            path.lineWidth = 1.8
            path.lineCapStyle = .round
            path.lineJoinStyle = .round
            NSColor.black.setStroke()
            path.stroke()
            NSColor.black.setFill()
            NSBezierPath(ovalIn: NSRect(x: 11.6, y: 10.1, width: 3.8, height: 3.8)).fill()
            return true
        }
        img.isTemplate = true
        return img
    }
}

@main
struct LeanfareApp {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
