import SwiftUI
import WebKit

/// Full OSM map view backed by WKWebView + Leaflet. No MapKit.
/// The web map reports its viewport back to Swift via a JS message handler;
/// Swift debounces + calls the /events/viewport endpoint and injects markers.
struct OSMEventsMapView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let contentController = WKUserContentController()
        contentController.add(context.coordinator, name: "viewportChanged")
        contentController.add(context.coordinator, name: "markerTapped")
        config.userContentController = contentController
        config.defaultWebpagePreferences.allowsContentJavaScript = true

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.bounces = false
        webView.scrollView.isScrollEnabled = false
        context.coordinator.webView = webView

        webView.loadHTMLString(Self.html, baseURL: URL(string: "https://sidequest.local"))
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKScriptMessageHandler {
        weak var webView: WKWebView?

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            switch message.name {
            case "viewportChanged":
                handleViewport(message.body)
            case "markerTapped":
                handleTap(message.body)
            default:
                break
            }
        }

        private func handleViewport(_ body: Any) {
            guard
                let dict = body as? [String: Any],
                let minLat = dict["minLat"] as? Double,
                let maxLat = dict["maxLat"] as? Double,
                let minLng = dict["minLng"] as? Double,
                let maxLng = dict["maxLng"] as? Double
            else { return }

            let viewport = EventsViewportService.Viewport(
                minLat: minLat,
                maxLat: maxLat,
                minLng: minLng,
                maxLng: maxLng
            )

            Task { @MainActor in
                EventsViewportService.shared.fetchViewport(
                    viewport,
                    onResult: { [weak self] response in
                        self?.injectResponse(response)
                    },
                    onError: { error in
                        print("viewport fetch failed: \(error)")
                    }
                )
            }
        }

        private func handleTap(_ body: Any) {
            guard let dict = body as? [String: Any],
                  let urlString = dict["url"] as? String,
                  let url = URL(string: urlString)
            else { return }
            #if canImport(UIKit)
            UIApplication.shared.open(url)
            #endif
        }

        private func injectResponse(_ response: ViewportResponse) {
            guard let webView else { return }
            do {
                let data = try JSONEncoder().encode(response)
                guard let json = String(data: data, encoding: .utf8) else { return }
                let escaped = json
                    .replacingOccurrences(of: "\\", with: "\\\\")
                    .replacingOccurrences(of: "`", with: "\\`")
                let js = "window.__renderEvents(`\(escaped)`);"
                webView.evaluateJavaScript(js) { _, error in
                    if let error {
                        print("evaluateJavaScript render error: \(error)")
                    }
                }
            } catch {
                print("encode response failed: \(error)")
            }
        }
    }

    private static let html: String = """
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
        <title>Events Map</title>
        <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
        <style>
            :root {
                --bg: #0e1116;
                --card: #181c24;
                --card-2: #20242e;
                --text: #f5f6f8;
                --text-dim: #a0a6b4;
                --accent: #ff2d87;
                --stroke: rgba(255,255,255,.10);
            }
            html, body, #map {
                margin: 0; padding: 0; height: 100%; width: 100%;
                background: var(--bg);
                font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
                -webkit-tap-highlight-color: transparent;
                -webkit-font-smoothing: antialiased;
                color: var(--text);
            }
            /* Darken default OSM tiles to look Snap-ish without 3rd-party tile deps */
            .leaflet-tile-pane { filter: invert(0.92) hue-rotate(180deg) brightness(0.95) contrast(0.85) saturate(0.75); }
            .leaflet-container { background: var(--bg); }
            .leaflet-control-attribution {
                background: rgba(0,0,0,.4) !important;
                color: #999 !important;
                font-size: 9px !important;
                padding: 2px 6px !important;
            }
            .leaflet-control-attribution a { color: #bbb !important; }
            .leaflet-control-zoom { display: none; }

            /* === Pin base === */
            .pin-wrap { display: flex; align-items: center; justify-content: center; }
            .pin {
                position: relative;
                width: 44px; height: 44px;
                border-radius: 50%;
                display: flex; align-items: center; justify-content: center;
                background: var(--card);
                box-shadow: 0 4px 14px rgba(0,0,0,.55), 0 0 0 3px var(--pin-color, var(--accent));
                transition: transform .18s ease;
                transform: translateY(0);
            }
            .pin:active { transform: scale(1.08); }
            .pin-img {
                width: 38px; height: 38px; border-radius: 50%;
                object-fit: cover;
                background: var(--card-2);
            }
            .pin-emoji {
                font-size: 22px;
                line-height: 1;
                filter: drop-shadow(0 1px 2px rgba(0,0,0,.4));
            }
            .pin-tail {
                position: absolute; bottom: -6px; left: 50%;
                width: 10px; height: 10px;
                background: var(--pin-color, var(--accent));
                transform: translateX(-50%) rotate(45deg);
                border-bottom-right-radius: 2px;
                box-shadow: 2px 2px 4px rgba(0,0,0,.35);
            }
            /* tiny price chip hovering above the pin */
            .pin-price {
                position: absolute; top: -8px; right: -10px;
                background: var(--accent); color: white;
                font: 700 10px/1 -apple-system, system-ui;
                padding: 4px 7px; border-radius: 10px;
                border: 2px solid var(--bg);
                white-space: nowrap;
            }

            /* === Cluster === */
            .cluster {
                position: relative;
                display: flex; align-items: center; justify-content: center;
                color: white; font: 800 15px -apple-system, system-ui;
                border-radius: 50%;
                background: radial-gradient(circle at 30% 30%, #ff6aa9, #ff2d87 55%, #b5005a);
                box-shadow:
                    0 0 0 6px rgba(255,45,135,0.18),
                    0 0 0 14px rgba(255,45,135,0.09),
                    0 6px 18px rgba(0,0,0,.55);
                animation: cluster-pulse 2.2s ease-in-out infinite;
            }
            .cluster-sm { width: 38px; height: 38px; font-size: 13px; }
            .cluster-md { width: 48px; height: 48px; font-size: 15px; }
            .cluster-lg { width: 58px; height: 58px; font-size: 17px; }
            @keyframes cluster-pulse {
                0%, 100% { box-shadow: 0 0 0 6px rgba(255,45,135,.18), 0 0 0 14px rgba(255,45,135,.09), 0 6px 18px rgba(0,0,0,.55); }
                50%      { box-shadow: 0 0 0 10px rgba(255,45,135,.10), 0 0 0 22px rgba(255,45,135,.04), 0 6px 18px rgba(0,0,0,.55); }
            }

            /* === Bottom sheet === */
            .sheet {
                position: fixed; left: 12px; right: 12px; bottom: 14px;
                background: var(--card);
                border: 1px solid var(--stroke);
                border-radius: 22px;
                padding: 14px;
                box-shadow: 0 18px 50px rgba(0,0,0,.6);
                transform: translateY(120%);
                opacity: 0;
                transition: transform .32s cubic-bezier(.2,.9,.3,1.2), opacity .25s;
                z-index: 1000;
                pointer-events: none;
            }
            .sheet.open { transform: translateY(0); opacity: 1; pointer-events: auto; }
            .sheet-row { display: flex; gap: 12px; align-items: center; }
            .sheet-img {
                width: 72px; height: 72px; border-radius: 16px;
                background: var(--card-2); flex-shrink: 0;
                object-fit: cover;
                box-shadow: inset 0 0 0 1px var(--stroke);
            }
            .sheet-title {
                font: 700 16px/1.25 -apple-system, system-ui;
                margin: 0; color: var(--text);
                display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
                overflow: hidden;
            }
            .sheet-meta {
                font: 500 12px/1.4 -apple-system, system-ui;
                color: var(--text-dim); margin-top: 3px;
            }
            .sheet-chips { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
            .chip {
                background: var(--card-2);
                border: 1px solid var(--stroke);
                color: var(--text);
                font: 600 11px/1 -apple-system, system-ui;
                padding: 6px 9px; border-radius: 99px;
            }
            .chip.accent { background: var(--accent); color: white; border-color: transparent; }
            .sheet-close {
                position: absolute; top: 10px; right: 10px;
                width: 28px; height: 28px; border-radius: 50%;
                background: var(--card-2); color: var(--text-dim);
                display: flex; align-items: center; justify-content: center;
                font-size: 16px; cursor: pointer;
                border: 1px solid var(--stroke);
            }
            .sheet-action {
                display: block; margin-top: 12px;
                background: var(--accent); color: white;
                text-align: center; text-decoration: none;
                font: 700 14px -apple-system, system-ui;
                padding: 12px; border-radius: 14px;
                box-shadow: 0 6px 20px rgba(255,45,135,.35);
            }
            .sheet-action:active { transform: scale(.98); }

            /* === Recenter button === */
            .recenter {
                position: fixed; right: 14px; top: 14px;
                width: 42px; height: 42px; border-radius: 14px;
                background: var(--card); color: var(--text);
                display: flex; align-items: center; justify-content: center;
                font-size: 20px;
                border: 1px solid var(--stroke);
                box-shadow: 0 4px 14px rgba(0,0,0,.45);
                z-index: 900;
            }
            .recenter:active { transform: scale(.94); }
        </style>
    </head>
    <body>
        <div id="map"></div>
        <div class="recenter" onclick="window.__recenter()">◎</div>
        <div class="sheet" id="sheet">
            <div class="sheet-close" onclick="window.__closeSheet()">×</div>
            <div class="sheet-row">
                <img id="sheet-img" class="sheet-img" />
                <div style="flex:1; min-width:0;">
                    <div id="sheet-title" class="sheet-title">Event</div>
                    <div id="sheet-meta" class="sheet-meta"></div>
                    <div id="sheet-chips" class="sheet-chips"></div>
                </div>
            </div>
            <a id="sheet-action" class="sheet-action" href="#" onclick="window.__openCurrent();return false;">View details</a>
        </div>
        <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
        <script>
            const map = L.map('map', {
                zoomControl: false,
                preferCanvas: true,
                zoomSnap: 0.5,
                wheelPxPerZoomLevel: 80,
                attributionControl: true,
                inertia: true
            }).setView([34.0522, -118.2437], 12);

            L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '&copy; OpenStreetMap'
            }).addTo(map);

            const markerLayer = L.layerGroup().addTo(map);
            let currentEvent = null;

            const categoryStyle = {
                concert:         { color: '#c56bff', emoji: '🎵' },
                sports_event:    { color: '#ffb020', emoji: '🏟️' },
                theatre:         { color: '#f5c542', emoji: '🎭' },
                race:            { color: '#35d07a', emoji: '🏃' },
                nightlife:       { color: '#ff2d87', emoji: '🍸' },
                festival:        { color: '#ff7043', emoji: '🎪' },
                other_live_event:{ color: '#4aa3ff', emoji: '✨' }
            };
            function styleFor(eventType) {
                return categoryStyle[eventType] || categoryStyle.other_live_event;
            }

            function currentViewportPayload() {
                const b = map.getBounds();
                return {
                    minLat: b.getSouth(),
                    maxLat: b.getNorth(),
                    minLng: b.getWest(),
                    maxLng: b.getEast(),
                    zoom: map.getZoom()
                };
            }

            let viewportTimer = null;
            function notifyViewport() {
                if (viewportTimer) clearTimeout(viewportTimer);
                viewportTimer = setTimeout(() => {
                    const payload = currentViewportPayload();
                    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.viewportChanged) {
                        window.webkit.messageHandlers.viewportChanged.postMessage(payload);
                    }
                }, 250);
            }

            map.on('moveend', notifyViewport);
            map.on('zoomend', notifyViewport);
            setTimeout(notifyViewport, 300);

            function escapeHtml(s) {
                if (s == null) return '';
                return String(s).replace(/[&<>"']/g, function (c) {
                    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
                });
            }

            function formatPrice(p) {
                if (p.price_min == null) return null;
                const sym = p.currency === 'USD' || !p.currency ? '$' : p.currency + ' ';
                return sym + Math.round(p.price_min);
            }

            function formatWhen(p) {
                const raw = p.start_local || p.start_at_utc;
                if (!raw) return null;
                try {
                    const d = new Date(raw);
                    if (isNaN(d.getTime())) return raw;
                    const opts = { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' };
                    return d.toLocaleString(undefined, opts);
                } catch (e) { return raw; }
            }

            function buildPinIcon(point) {
                const style = styleFor(point.event_type);
                const price = formatPrice(point);
                const hasImage = !!point.image_url;
                const inner = hasImage
                    ? '<img class="pin-img" src="' + escapeHtml(point.image_url) + '" onerror="this.outerHTML=\\'<span class=\\\\\\'pin-emoji\\\\\\'>' + style.emoji + '</span>\\'" />'
                    : '<span class="pin-emoji">' + style.emoji + '</span>';
                const priceChip = price ? '<div class="pin-price">' + escapeHtml(price) + '</div>' : '';
                return L.divIcon({
                    html:
                        '<div class="pin" style="--pin-color:' + style.color + '">' +
                            inner +
                            '<div class="pin-tail"></div>' +
                            priceChip +
                        '</div>',
                    className: 'pin-wrap',
                    iconSize: [44, 50],
                    iconAnchor: [22, 50]
                });
            }

            function buildClusterIcon(count) {
                const size = count >= 25 ? 'cluster-lg' : count >= 8 ? 'cluster-md' : 'cluster-sm';
                const label = count >= 100 ? '99+' : String(count);
                return L.divIcon({
                    html: '<div class="cluster ' + size + '">' + label + '</div>',
                    className: 'pin-wrap',
                    iconSize: [58, 58]
                });
            }

            // === Bottom sheet ===
            const sheet = document.getElementById('sheet');
            const sheetImg = document.getElementById('sheet-img');
            const sheetTitle = document.getElementById('sheet-title');
            const sheetMeta = document.getElementById('sheet-meta');
            const sheetChips = document.getElementById('sheet-chips');

            function showSheet(point) {
                currentEvent = point;
                if (point.image_url) {
                    sheetImg.src = point.image_url;
                    sheetImg.style.display = 'block';
                } else {
                    sheetImg.style.display = 'none';
                }
                sheetTitle.textContent = point.title || 'Event';
                const parts = [];
                if (point.venue_name) parts.push(point.venue_name);
                if (point.city) parts.push(point.city);
                const when = formatWhen(point);
                if (when) parts.push(when);
                sheetMeta.textContent = parts.join(' · ');

                sheetChips.innerHTML = '';
                const price = formatPrice(point);
                if (price) {
                    const c = document.createElement('div');
                    c.className = 'chip accent';
                    c.textContent = 'from ' + price;
                    sheetChips.appendChild(c);
                }
                if (point.category) {
                    const c = document.createElement('div');
                    c.className = 'chip';
                    c.textContent = point.category;
                    sheetChips.appendChild(c);
                }
                if (Array.isArray(point.merged_sources) && point.merged_sources.length) {
                    const c = document.createElement('div');
                    c.className = 'chip';
                    c.textContent = '+' + point.merged_sources.length + ' source' + (point.merged_sources.length > 1 ? 's' : '');
                    sheetChips.appendChild(c);
                }

                sheet.classList.add('open');
            }

            window.__closeSheet = function() {
                sheet.classList.remove('open');
                currentEvent = null;
            };

            window.__openCurrent = function() {
                if (currentEvent && currentEvent.url) {
                    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.markerTapped) {
                        window.webkit.messageHandlers.markerTapped.postMessage({ url: currentEvent.url });
                    }
                }
            };

            window.__recenter = function() {
                map.flyTo([34.0522, -118.2437], 12, { duration: 0.8 });
            };

            map.on('click', function() { window.__closeSheet(); });

            function addPointMarker(point) {
                const marker = L.marker([point.latitude, point.longitude], {
                    icon: buildPinIcon(point),
                    riseOnHover: true
                });
                marker.on('click', function(e) {
                    L.DomEvent.stopPropagation(e);
                    showSheet(point);
                    map.panTo([point.latitude, point.longitude], { animate: true, duration: 0.4 });
                });
                marker.addTo(markerLayer);
            }

            window.__renderEvents = function(json) {
                try {
                    const data = JSON.parse(json);
                    markerLayer.clearLayers();

                    if (data.mode === 'clusters' && Array.isArray(data.clusters)) {
                        data.clusters.forEach(function(cluster) {
                            if (cluster.count > 1) {
                                L.marker([cluster.latitude, cluster.longitude], {
                                    icon: buildClusterIcon(cluster.count)
                                })
                                .on('click', function() {
                                    map.flyTo([cluster.latitude, cluster.longitude], Math.min(map.getZoom() + 2, 16), { duration: 0.6 });
                                })
                                .addTo(markerLayer);
                            } else if (cluster.sample) {
                                addPointMarker(cluster.sample);
                            }
                        });
                    } else if (Array.isArray(data.points)) {
                        data.points.forEach(addPointMarker);
                    }
                } catch (err) {
                    console.error('renderEvents failed', err);
                }
            };
        </script>
    </body>
    </html>
    """
}

struct OSMEventsMapScreen: View {
    var body: some View {
        OSMEventsMapView()
            .edgesIgnoringSafeArea(.all)
    }
}
