import Foundation
import Supabase

enum SideQuestSupabase {
    static let client: SupabaseClient = {
        guard let urlString = Config.value(for: "SUPABASE_URL"),
              let url = URL(string: urlString) else {
            fatalError("SUPABASE_URL not configured. Add it to Config.plist or set as environment variable.")
        }
        guard let anonKey = Config.value(for: "SUPABASE_ANON_KEY") else {
            fatalError("SUPABASE_ANON_KEY not configured. Add it to Config.plist or set as environment variable.")
        }
        return SupabaseClient(supabaseURL: url, supabaseKey: anonKey)
    }()

    static var isConfigured: Bool {
        Config.value(for: "SUPABASE_URL") != nil && Config.value(for: "SUPABASE_ANON_KEY") != nil
    }
}
