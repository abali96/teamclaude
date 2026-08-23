import AppKit
import Foundation

private struct StatusPayload: Decodable {
    let currentAccount: String?
    let accounts: [Account]
}

private struct Account: Decodable {
    let name: String
    let orgName: String?
    let disabled: Bool?
    let status: String?
    let sessions: Int?
    let quota: Quota?
}

private struct Quota: Decodable {
    let unified5h: Double?
    let unified5hReset: FlexibleDate?
    let unified7d: Double?
    let unified7dReset: FlexibleDate?
    let unified7dSonnet: Double?
    let unified7dSonnetReset: FlexibleDate?
    let unified7dFable: Double?
    let unified7dFableReset: FlexibleDate?
}

private struct SwitchPayload: Decodable {
    let ok: Bool?
    let account: String?
    let eligible: Bool?
    let reason: String?
    let error: String?
}

/// Status timestamps are ISO strings today, but older state can contain epoch
/// milliseconds. Accept both so installing the UI never makes a saved window
/// unreadable.
private struct FlexibleDate: Decodable {
    let value: Date?

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let number = try? container.decode(Double.self) {
            value = Date(timeIntervalSince1970: number > 10_000_000_000 ? number / 1000 : number)
            return
        }
        if let string = try? container.decode(String.self) {
            value = ISO8601DateFormatter.withFractionalSeconds.date(from: string)
                ?? ISO8601DateFormatter.internetDateTime.date(from: string)
            return
        }
        value = nil
    }
}

private extension ISO8601DateFormatter {
    static let internetDateTime = ISO8601DateFormatter()
    static let withFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

private final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private let baseURL: URL
    private let proxyLog: URL
    private let session: URLSession
    private var timer: Timer?
    private var status: StatusPayload?
    private var lastError: String?
    private var switchMessage: String?
    private var switchingAccount: String?

    init(port: Int, proxyLog: String) {
        baseURL = URL(string: "http://127.0.0.1:\(port)")!
        self.proxyLog = URL(fileURLWithPath: proxyLog)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 4
        configuration.timeoutIntervalForResource = 5
        session = URLSession(configuration: configuration)
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        menu.delegate = self
        statusItem.menu = menu
        statusItem.button?.title = "TC …"
        statusItem.button?.toolTip = "TeamClaude: connecting"
        rebuildMenu()
        refresh()
        timer = Timer.scheduledTimer(timeInterval: 10, target: self,
                                     selector: #selector(refresh), userInfo: nil, repeats: true)
        RunLoop.main.add(timer!, forMode: .common)
    }

    func menuWillOpen(_ menu: NSMenu) {
        refresh()
    }

    @objc private func refresh() {
        var request = URLRequest(url: baseURL.appendingPathComponent("teamclaude/status"))
        request.cachePolicy = .reloadIgnoringLocalCacheData
        session.dataTask(with: request) { [weak self] data, response, error in
            guard let self else { return }
            let result: Result<StatusPayload, Error>
            do {
                if let error { throw error }
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                    throw MenuError.message("unexpected HTTP response")
                }
                guard let data else { throw MenuError.message("empty response") }
                result = .success(try JSONDecoder().decode(StatusPayload.self, from: data))
            } catch {
                result = .failure(error)
            }
            DispatchQueue.main.async { self.apply(result) }
        }.resume()
    }

    private func apply(_ result: Result<StatusPayload, Error>) {
        switch result {
        case .success(let payload):
            status = payload
            lastError = nil
        case .failure(let error):
            status = nil
            lastError = readable(error)
        }
        switchingAccount = nil
        updateStatusItem()
        rebuildMenu()
    }

    private func updateStatusItem() {
        guard let payload = status else {
            statusItem.button?.title = "TC —"
            statusItem.button?.toolTip = "TeamClaude: proxy disconnected"
            return
        }
        let current = payload.accounts.first { $0.name == payload.currentAccount }
        if let used = current?.quota?.unified5h {
            let remaining = max(0, min(100, Int(((1 - used) * 100).rounded())))
            statusItem.button?.title = "TC \(remaining)%"
            statusItem.button?.toolTip = "TeamClaude: \(current?.name ?? "no active account"), \(remaining)% session quota remaining"
        } else {
            statusItem.button?.title = "TC"
            statusItem.button?.toolTip = "TeamClaude: \(current?.name ?? "no active account")"
        }
    }

    private func rebuildMenu() {
        menu.removeAllItems()

        guard let payload = status else {
            addHeading("Proxy disconnected")
            let detail = NSMenuItem(title: lastError ?? "Cannot reach \(baseURL.host ?? "localhost")", action: nil, keyEquivalent: "")
            detail.isEnabled = false
            menu.addItem(detail)
            menu.addItem(.separator())
            addFooterItems()
            return
        }

        let active = payload.currentAccount ?? "None"
        addHeading("Active: \(active)")
        if let switchMessage {
            let notice = NSMenuItem(title: switchMessage, action: nil, keyEquivalent: "")
            notice.isEnabled = false
            menu.addItem(notice)
            menu.addItem(.separator())
        }
        if payload.accounts.isEmpty {
            let empty = NSMenuItem(title: "No accounts configured", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
        }

        for account in payload.accounts {
            let isCurrent = account.name == payload.currentAccount
            let accountItem = NSMenuItem(title: accountTitle(account),
                                         action: #selector(switchAccount(_:)), keyEquivalent: "")
            accountItem.target = self
            accountItem.representedObject = account.name
            accountItem.state = isCurrent ? .on : .off
            accountItem.isEnabled = switchingAccount == nil
            menu.addItem(accountItem)

            for detail in quotaDetails(account) {
                let item = NSMenuItem(title: "    \(detail)", action: nil, keyEquivalent: "")
                item.isEnabled = false
                item.indentationLevel = 1
                menu.addItem(item)
            }
        }

        menu.addItem(.separator())
        addFooterItems()
    }

    private func addHeading(_ title: String) {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        menu.addItem(item)
        menu.addItem(.separator())
    }

    private func addFooterItems() {
        let refreshItem = NSMenuItem(title: "Refresh", action: #selector(refresh), keyEquivalent: "r")
        refreshItem.target = self
        menu.addItem(refreshItem)

        let logsItem = NSMenuItem(title: "Open Proxy Log", action: #selector(openLogs), keyEquivalent: "")
        logsItem.target = self
        menu.addItem(logsItem)

        menu.addItem(.separator())
        let quitItem = NSMenuItem(title: "Quit TeamClaude Menu Bar", action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)
    }

    private func accountTitle(_ account: Account) -> String {
        var pieces = [account.name]
        if let org = account.orgName, !org.isEmpty { pieces.append("(\(org))") }
        if account.disabled == true { pieces.append("— disabled") }
        else if let state = account.status, state != "active" { pieces.append("— \(state)") }
        if let sessions = account.sessions, sessions > 0 { pieces.append("· \(sessions) session\(sessions == 1 ? "" : "s")") }
        if switchingAccount == account.name { pieces.append("· switching…") }
        return pieces.joined(separator: " ")
    }

    private func quotaDetails(_ account: Account) -> [String] {
        guard let quota = account.quota else { return ["Quota unknown"] }
        var rows: [String] = []
        appendQuota(&rows, label: "Session", used: quota.unified5h, reset: quota.unified5hReset?.value)
        appendQuota(&rows, label: "Weekly", used: quota.unified7d, reset: quota.unified7dReset?.value)
        appendQuota(&rows, label: "Sonnet", used: quota.unified7dSonnet, reset: quota.unified7dSonnetReset?.value)
        appendQuota(&rows, label: "Fable", used: quota.unified7dFable, reset: quota.unified7dFableReset?.value)
        return rows.isEmpty ? ["Quota unknown"] : rows
    }

    private func appendQuota(_ rows: inout [String], label: String, used: Double?, reset: Date?) {
        guard let used else { return }
        let percent = max(0, min(100, Int((used * 100).rounded())))
        var text = "\(label): \(percent)% used"
        if let reset, reset > Date() { text += " · resets \(relative(reset))" }
        rows.append(text)
    }

    @objc private func switchAccount(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        switchingAccount = name
        switchMessage = nil
        rebuildMenu()

        var request = URLRequest(url: baseURL.appendingPathComponent("teamclaude/switch"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["account": name])
        session.dataTask(with: request) { [weak self] data, response, error in
            guard let self else { return }
            var failure: String?
            if let error {
                failure = readable(error)
            } else if let data, let reply = try? JSONDecoder().decode(SwitchPayload.self, from: data) {
                if reply.ok != true { failure = reply.error ?? "Switch failed" }
                else if reply.eligible == false { failure = reply.reason ?? "Account is not currently eligible" }
            } else if let http = response as? HTTPURLResponse {
                failure = (200..<300).contains(http.statusCode)
                    ? "Switch failed: unexpected response"
                    : "Switch failed (HTTP \(http.statusCode))"
            } else {
                failure = "Switch failed: no response"
            }
            DispatchQueue.main.async {
                self.switchingAccount = nil
                self.switchMessage = failure
                self.refresh()
            }
        }.resume()
    }

    @objc private func openLogs() {
        if FileManager.default.fileExists(atPath: proxyLog.path) {
            NSWorkspace.shared.open(proxyLog)
        } else {
            NSWorkspace.shared.open(proxyLog.deletingLastPathComponent())
        }
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    private func relative(_ date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    private func readable(_ error: Error) -> String {
        if let urlError = error as? URLError {
            switch urlError.code {
            case .cannotConnectToHost, .networkConnectionLost, .notConnectedToInternet, .timedOut:
                return "Proxy is not running at 127.0.0.1:\(baseURL.port ?? 3456)"
            default: break
            }
        }
        return error.localizedDescription
    }
}

private enum MenuError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        if case .message(let value) = self { return value }
        return nil
    }
}

@main
private enum TeamClaudeMenuBar {
    static func main() {
        let arguments = CommandLine.arguments
        let port = Int(value(after: "--port", in: arguments) ?? "3456") ?? 3456
        let defaultLog = NSString(string: "~/Library/Logs/teamclaude.log").expandingTildeInPath
        let proxyLog = value(after: "--proxy-log", in: arguments) ?? defaultLog

        let app = NSApplication.shared
        let delegate = AppDelegate(port: port, proxyLog: proxyLog)
        app.delegate = delegate
        app.run()
    }

    private static func value(after flag: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else { return nil }
        return arguments[index + 1]
    }
}
