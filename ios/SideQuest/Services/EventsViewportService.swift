import Foundation

@MainActor
final class EventsViewportService {
    static let shared = EventsViewportService()

    private let baseURL: URL
    private let session: URLSession
    private var currentTask: Task<Void, Never>?
    private var lastRequestedAt: Date = .distantPast
    private let minInterval: TimeInterval = 0.4

    // MARK: - Viewport response cache
    private struct CacheEntry {
        let response: ViewportResponse
        let fetchedAt: Date
    }
    private var viewportCache: [String: CacheEntry] = [:]
    private let cacheTTL: TimeInterval = 120 // 2 minutes
    private let maxCacheEntries: Int = 50

    var isConfigured: Bool {
        baseURL.absoluteString.contains("fly.dev") || Config.value(for: "SERVER_BASE_URL") != nil
    }

    private init() {
        let configured = Config.value(for: "SERVER_BASE_URL")
            ?? "https://sidequest-ingestion-worker.fly.dev"
        self.baseURL = URL(string: configured)!
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15
        self.session = URLSession(configuration: config)
    }

    struct Viewport: Sendable {
        let minLat: Double
        let maxLat: Double
        let minLng: Double
        let maxLng: Double
    }

    /// Debounced fetch: cancels any in-flight request and waits `debounce` before firing.
    func fetchViewport(
        _ viewport: Viewport,
        debounce: TimeInterval = 0.35,
        onResult: @escaping @MainActor (ViewportResponse) -> Void,
        onError: @escaping @MainActor (Error) -> Void
    ) {
        currentTask?.cancel()
        currentTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await Task.sleep(nanoseconds: UInt64(debounce * 1_000_000_000))
                if Task.isCancelled { return }
                let response = try await self.requestViewport(viewport)
                if Task.isCancelled { return }
                onResult(response)
            } catch is CancellationError {
                return
            } catch {
                if !Task.isCancelled {
                    onError(error)
                }
            }
        }
    }

    /// Fetch events for a search location from the server API.
    func fetchEvents(
        for searchLocation: ExternalEventSearchLocation,
        radiusDegrees: Double = 0.35
    ) async throws -> [ExternalEvent] {
        guard let lat = searchLocation.latitude, let lng = searchLocation.longitude else {
            return []
        }
        let viewport = Viewport(
            minLat: lat - radiusDegrees,
            maxLat: lat + radiusDegrees,
            minLng: lng - radiusDegrees,
            maxLng: lng + radiusDegrees
        )
        let response = try await requestViewport(viewport)
        let mapEvents = response.points ?? []
        return mapEvents.map { $0.toExternalEvent(city: searchLocation.city, state: searchLocation.state) }
    }

    func requestViewport(_ viewport: Viewport) async throws -> ViewportResponse {
        let key = cacheKey(for: viewport)

        // Return cached response if fresh
        if let entry = viewportCache[key], Date().timeIntervalSince(entry.fetchedAt) < cacheTTL {
            return entry.response
        }

        var components = URLComponents(
            url: baseURL.appendingPathComponent("events/viewport"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [
            URLQueryItem(name: "minLat", value: String(viewport.minLat)),
            URLQueryItem(name: "maxLat", value: String(viewport.maxLat)),
            URLQueryItem(name: "minLng", value: String(viewport.minLng)),
            URLQueryItem(name: "maxLng", value: String(viewport.maxLng)),
            URLQueryItem(name: "limit", value: "500"),
        ]
        guard let url = components.url else {
            throw URLError(.badURL)
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        let decoded = try JSONDecoder().decode(ViewportResponse.self, from: data)

        // Store in cache
        evictStaleCacheEntries()
        viewportCache[key] = CacheEntry(response: decoded, fetchedAt: Date())

        return decoded
    }

    // MARK: - Cache helpers

    /// Rounds viewport coordinates to a grid so nearby pans hit the same cache key.
    private func cacheKey(for viewport: Viewport) -> String {
        let precision: Double = 0.01
        let minLat = (viewport.minLat / precision).rounded() * precision
        let maxLat = (viewport.maxLat / precision).rounded() * precision
        let minLng = (viewport.minLng / precision).rounded() * precision
        let maxLng = (viewport.maxLng / precision).rounded() * precision
        return String(format: "%.3f|%.3f|%.3f|%.3f", minLat, maxLat, minLng, maxLng)
    }

    private func evictStaleCacheEntries() {
        let now = Date()
        viewportCache = viewportCache.filter { now.timeIntervalSince($0.value.fetchedAt) < cacheTTL }
        // If still over limit, drop oldest
        if viewportCache.count >= maxCacheEntries {
            let sorted = viewportCache.sorted { $0.value.fetchedAt < $1.value.fetchedAt }
            let dropCount = viewportCache.count - maxCacheEntries + 10
            for entry in sorted.prefix(dropCount) {
                viewportCache.removeValue(forKey: entry.key)
            }
        }
    }
}

// MARK: - MapEvent → ExternalEvent Conversion

extension MapEvent {
    func toExternalEvent(city: String? = nil, state: String? = nil) -> ExternalEvent {
        let eventSource = ExternalEventSource(rawValue: source) ?? .ticketmaster
        let eventType = Self.mapEventType(from: event_type, category: category)
        let parsedStart = Self.parseUTCDate(start_at_utc)

        return ExternalEvent(
            id: id,
            source: eventSource,
            sourceEventID: id,
            sourceURL: url,
            mergedSources: merged_sources.compactMap { ExternalEventSource(rawValue: $0) },
            title: title,
            category: category,
            subcategory: subcategory,
            eventType: eventType,
            startAtUTC: parsedStart,
            startLocal: start_local,
            timezone: timezone,
            venueName: venue_name,
            city: self.city ?? city,
            state: self.state ?? state,
            latitude: latitude,
            longitude: longitude,
            imageURL: image_url,
            fallbackThumbnailAsset: Self.fallbackAsset(for: eventType),
            status: .scheduled,
            availabilityStatus: .available,
            priceMin: price_min,
            priceMax: price_max,
            currency: currency,
            tags: [],
            ticketURL: url,
            rawSourcePayload: ""
        )
    }

    private static func mapEventType(from type: String, category: String?) -> ExternalEventType {
        let lower = type.lowercased()
        if lower.contains("concert") || lower.contains("music") { return .concert }
        if lower.contains("nightlife") || lower.contains("party") || lower.contains("club") { return .partyNightlife }
        if lower.contains("sport") { return .sportsEvent }
        if lower.contains("race") || lower.contains("run") || lower.contains("marathon") {
            if lower.contains("5k") { return .race5k }
            if lower.contains("10k") { return .race10k }
            if lower.contains("half") { return .raceHalfMarathon }
            if lower.contains("marathon") { return .raceMarathon }
            return .groupRun
        }
        if let cat = category?.lowercased() {
            if cat.contains("music") || cat.contains("concert") { return .concert }
            if cat.contains("sport") { return .sportsEvent }
            if cat.contains("nightlife") { return .partyNightlife }
        }
        return .otherLiveEvent
    }

    private static func fallbackAsset(for eventType: ExternalEventType) -> String {
        switch eventType {
        case .concert: return "music_fallback"
        case .partyNightlife: return "nightlife_fallback"
        case .sportsEvent: return "sports_fallback"
        case .groupRun, .race5k, .race10k, .raceHalfMarathon, .raceMarathon: return "running_fallback"
        default: return "event_fallback"
        }
    }

    private static func parseUTCDate(_ string: String?) -> Date? {
        guard let string else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: string) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: string)
    }
}
