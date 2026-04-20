import Foundation
import CoreLocation
import MapKit
import Supabase

actor SupabasePOIViewportTileService {
    static let shared = SupabasePOIViewportTileService()

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()
    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }()
    private let poiTileTable: String = "poi_viewport_tiles"

    nonisolated var isConfigured: Bool {
        SideQuestSupabase.isConfigured
    }

    func loadTiles(
        range: ExternalEventViewportTileRange,
        countryCode: String = "US"
    ) async -> POIViewportTileBundle? {
        guard SideQuestSupabase.isConfigured else { return nil }
        guard range.tileCount > 0, range.tileCount <= 256 else { return nil }
        guard let rows = await fetchPOITileRows(range: range, countryCode: countryCode) else { return nil }

        let tiles = decodeTiles(from: rows)
        return POIViewportTileBundle(range: range, tiles: tiles)
    }

    func seedTile(
        key: POIViewportTileKey,
        pois: [POIViewportTilePOI]
    ) async {
        guard SideQuestSupabase.isConfigured else { return }

        let now = Date()
        let expiresAt = now.addingTimeInterval(24 * 60 * 60)

        let snapshot = POIViewportTileSnapshot(
            tile: key,
            pois: pois,
            poiCount: pois.count,
            fetchedAt: now,
            expiresAt: expiresAt
        )

        guard let snapshotData = try? encoder.encode(snapshot),
              let snapshotObj = try? JSONSerialization.jsonObject(with: snapshotData) else { return }

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]

        let body: [String: AnyJSON] = [
            "country_code": .string(key.countryCode.uppercased()),
            "z": .integer(key.z),
            "x": .integer(key.x),
            "y": .integer(key.y),
            "snapshot": Self.anyJSON(from: snapshotObj),
            "poi_count": .integer(pois.count),
            "fetched_at": .string(formatter.string(from: now)),
            "expires_at": .string(formatter.string(from: expiresAt)),
        ]

        do {
            try await SideQuestSupabase.client
                .from(poiTileTable)
                .upsert(body, onConflict: "country_code,z,x,y")
                .execute()
        } catch {
            return
        }
    }

    // MARK: - Query

    private func fetchPOITileRows(
        range: ExternalEventViewportTileRange,
        countryCode: String
    ) async -> [[String: Any]]? {
        let cutoff: String = {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime]
            return formatter.string(from: Date().addingTimeInterval(-Self.staleDisplayWindow))
        }()

        do {
            let response = try await SideQuestSupabase.client
                .from(poiTileTable)
                .select("snapshot,country_code,z,x,y,poi_count,fetched_at,expires_at")
                .eq("country_code", value: countryCode.uppercased())
                .eq("z", value: range.z)
                .gte("x", value: range.minX)
                .lte("x", value: range.maxX)
                .gte("y", value: range.minY)
                .lte("y", value: range.maxY)
                .gte("expires_at", value: cutoff)
                .order("y", ascending: true)
                .order("x", ascending: true)
                .limit(range.tileCount)
                .execute()
            return try JSONSerialization.jsonObject(with: response.data) as? [[String: Any]]
        } catch {
            return nil
        }
    }

    // MARK: - Decoding

    private func decodeTiles(from rows: [[String: Any]]) -> [POIViewportTileSnapshot] {
        rows.compactMap { row in
            if let snapshotObject = row["snapshot"],
               let snapshotData = try? JSONSerialization.data(withJSONObject: snapshotObject),
               let snapshot = try? decoder.decode(POIViewportTileSnapshot.self, from: snapshotData) {
                return snapshot
            }
            return nil
        }
    }

    // MARK: - Helpers

    static let staleDisplayWindow: TimeInterval = 72 * 60 * 60

    nonisolated static func isTileStale(_ tile: POIViewportTileSnapshot) -> Bool {
        guard let expiresAt = tile.expiresAt else { return true }
        return expiresAt < Date()
    }

    nonisolated static func tileRange(
        for bounds: ExternalEventViewportBounds,
        zoom: Int
    ) -> ExternalEventViewportTileRange {
        let normalizedZoom = min(max(zoom, 0), 22)
        let westX = longitudeToTileX(bounds.westLongitude, zoom: normalizedZoom)
        let eastX = longitudeToTileX(bounds.eastLongitude, zoom: normalizedZoom)
        let northY = latitudeToTileY(bounds.northLatitude, zoom: normalizedZoom)
        let southY = latitudeToTileY(bounds.southLatitude, zoom: normalizedZoom)
        return ExternalEventViewportTileRange(
            z: normalizedZoom,
            minX: min(westX, eastX),
            maxX: max(westX, eastX),
            minY: min(northY, southY),
            maxY: max(northY, southY)
        )
    }

    nonisolated static func recommendedZoom(
        for bounds: ExternalEventViewportBounds
    ) -> Int {
        let span = max(bounds.latitudeSpan, bounds.longitudeSpan)
        switch span {
        case ..<0.02: return 14
        case ..<0.05: return 13
        case ..<0.12: return 12
        case ..<0.3: return 11
        case ..<0.75: return 10
        case ..<1.5: return 9
        case ..<3.0: return 8
        case ..<7.0: return 7
        case ..<14.0: return 6
        default: return 5
        }
    }

    nonisolated static func tileBounds(
        for key: POIViewportTileKey
    ) -> ExternalEventViewportBounds {
        let scale = pow(2.0, Double(key.z))
        let westLongitude = (Double(key.x) / scale) * 360.0 - 180.0
        let eastLongitude = (Double(key.x + 1) / scale) * 360.0 - 180.0
        let northLatitude = tileYToLatitude(key.y, zoom: key.z)
        let southLatitude = tileYToLatitude(key.y + 1, zoom: key.z)
        return ExternalEventViewportBounds(
            northLatitude: northLatitude,
            southLatitude: southLatitude,
            eastLongitude: eastLongitude,
            westLongitude: westLongitude
        )
    }

    nonisolated static func tileKey(
        for coordinate: CLLocationCoordinate2D,
        zoom: Int,
        countryCode: String = "US"
    ) -> POIViewportTileKey {
        let scale = pow(2.0, Double(zoom))
        let normalizedLon = min(max((coordinate.longitude + 180.0) / 360.0, 0.0), 0.999_999_999)
        let x = Int(floor(normalizedLon * scale))

        let clampedLat = min(max(coordinate.latitude, -85.051_128_78), 85.051_128_78)
        let radians = clampedLat * .pi / 180.0
        let mercator = log(tan(.pi / 4.0 + radians / 2.0))
        let normalizedLat = min(max((1.0 - mercator / .pi) / 2.0, 0.0), 0.999_999_999)
        let y = Int(floor(normalizedLat * scale))

        return POIViewportTileKey(countryCode: countryCode.uppercased(), z: zoom, x: x, y: y)
    }

    nonisolated private static func anyJSON(from value: Any) -> AnyJSON {
        if let dict = value as? [String: Any] {
            return .object(dict.mapValues { anyJSON(from: $0) })
        } else if let array = value as? [Any] {
            return .array(array.map { anyJSON(from: $0) })
        } else if let string = value as? String {
            return .string(string)
        } else if let number = value as? Double {
            return .double(number)
        } else if let number = value as? Int {
            return .integer(number)
        } else if let bool = value as? Bool {
            return .bool(bool)
        } else {
            return .null
        }
    }

    // MARK: - Tile Math Helpers

    nonisolated private static func longitudeToTileX(_ longitude: Double, zoom: Int) -> Int {
        let normalized = min(max((longitude + 180.0) / 360.0, 0.0), 0.999_999_999)
        let scale = pow(2.0, Double(zoom))
        return Int(floor(normalized * scale))
    }

    nonisolated private static func latitudeToTileY(_ latitude: Double, zoom: Int) -> Int {
        let clampedLatitude = min(max(latitude, -85.051_128_78), 85.051_128_78)
        let radians = clampedLatitude * .pi / 180.0
        let mercator = log(tan(.pi / 4.0 + radians / 2.0))
        let normalized = min(max((1.0 - mercator / .pi) / 2.0, 0.0), 0.999_999_999)
        let scale = pow(2.0, Double(zoom))
        return Int(floor(normalized * scale))
    }

    nonisolated private static func tileYToLatitude(_ y: Int, zoom: Int) -> Double {
        let scale = pow(2.0, Double(zoom))
        let mercator = .pi - (2.0 * .pi * Double(y) / scale)
        return atan(sinh(mercator)) * 180.0 / .pi
    }
}
