import Foundation
import Supabase

enum SupabaseError: Error, LocalizedError {
    case notConfigured
    case encodingFailed
    case networkError(Error)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "Supabase is not properly configured. Check your URL and API key."
        case .encodingFailed:
            return "Failed to encode profile data"
        case .networkError(let error):
            return "Network error: \(error.localizedDescription)"
        case .invalidResponse:
            return "Invalid response from server"
        }
    }
}

nonisolated struct SupabasePlayerProfile: Codable, Sendable {
    let user_id: String
    var username: String
    var display_name: String
    var avatar_name: String
    var selected_character: String
    var level: Int
    var total_score: Int
    var gold: Int
    var diamonds: Int
    var current_streak: Int
    var verified_count: Int
    var warrior_rank: Int
    var explorer_rank: Int
    var mind_rank: Int
    var selected_skills: [String]
    var selected_interests: [String]
    var goals: [String]
    var equipment_state: String?
    var owned_items: [String]
    var owned_skin_pack_pieces: [String]
    var earned_badges: [String]
    var updated_at: String?
}

actor SupabaseProfileService {
    static let shared = SupabaseProfileService()

    var isConfigured: Bool {
        SideQuestSupabase.isConfigured
    }

    func upsertProfile(_ profile: SupabasePlayerProfile) async throws -> Bool {
        guard SideQuestSupabase.isConfigured else {
            throw SupabaseError.notConfigured
        }

        do {
            try await SideQuestSupabase.client
                .from("player_profiles")
                .upsert(profile, onConflict: "user_id")
                .execute()
            return true
        } catch {
            throw SupabaseError.networkError(error)
        }
    }

    func fetchProfile(userId: String) async -> SupabasePlayerProfile? {
        guard SideQuestSupabase.isConfigured else { return nil }

        do {
            let profiles: [SupabasePlayerProfile] = try await SideQuestSupabase.client
                .from("player_profiles")
                .select()
                .eq("user_id", value: userId)
                .limit(1)
                .execute()
                .value
            return profiles.first
        } catch {
            return nil
        }
    }

    func checkUsernameAvailable(_ username: String, excludingUserId: String?) async -> Bool {
        guard SideQuestSupabase.isConfigured else { return true }

        do {
            var query = SideQuestSupabase.client
                .from("player_profiles")
                .select("user_id")
                .eq("username", value: username.lowercased())

            if let excludeId = excludingUserId {
                query = query.neq("user_id", value: excludeId)
            }

            let results: [[String: String]] = try await query.limit(1).execute().value
            return results.isEmpty
        } catch {
            return true
        }
    }
}
