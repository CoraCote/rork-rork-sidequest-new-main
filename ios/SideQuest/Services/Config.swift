import Foundation

struct Config {
    private static let plistValues: [String: String] = {
        guard let path = Bundle.main.path(forResource: "Config", ofType: "plist"),
              let plist = NSDictionary(contentsOfFile: path) as? [String: String] else {
            return [:]
        }
        return plist
    }()

    static func value(for key: String) -> String? {
        if let plistValue = nonEmpty(plistValues[key]) {
            return plistValue
        }
        if let envValue = nonEmpty(ProcessInfo.processInfo.environment[key]) {
            return envValue
        }
        return nil
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return value
    }
}
