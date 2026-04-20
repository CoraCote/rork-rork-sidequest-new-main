import Foundation

struct MapEvent: Codable, Identifiable, Sendable {
    let id: String
    let source: String
    let title: String
    let event_type: String
    let category: String?
    let subcategory: String?
    let image_url: String?
    let latitude: Double
    let longitude: Double
    let start_at_utc: String?
    let start_local: String?
    let timezone: String?
    let venue_name: String?
    let city: String?
    let state: String?
    let price_min: Double?
    let price_max: Double?
    let currency: String?
    let url: String?
    let merged_sources: [String]
}

struct MapCluster: Codable, Sendable {
    let geohash: String
    let count: Int
    let latitude: Double
    let longitude: Double
    let sample: MapEvent
}

struct ViewportResponse: Codable, Sendable {
    let mode: String
    let points: [MapEvent]?
    let clusters: [MapCluster]?
}
