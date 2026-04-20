import SwiftUI
import WebKit
import MapKit
import CoreLocation

// MARK: - Viewport

nonisolated struct ExploreMapViewport: Sendable {
    let center: CLLocationCoordinate2D
    let visibleRadius: Double
    let northEast: CLLocationCoordinate2D
    let northWest: CLLocationCoordinate2D
    let southEast: CLLocationCoordinate2D
    let southWest: CLLocationCoordinate2D
    let mapRect: MKMapRect
    let cameraDistance: Double
}

nonisolated enum MapZoomTier: Sendable, Equatable {
    case street
    case district
    case metro

    init(cameraDistance: Double) {
        if cameraDistance < 5_000 { self = .street }
        else if cameraDistance < 15_000 { self = .district }
        else { self = .metro }
    }
}

// MARK: - ExploreMapView

struct ExploreMapView: UIViewRepresentable {
    let centerCoordinate: CLLocationCoordinate2D
    let userCoordinate: CLLocationCoordinate2D?
    let encounters: [ExploreEncounter]
    let districts: [ExploreDistrict]
    let zones: [ExploreZone]
    let routes: [ExploreRoute]
    let selectedEncounterID: String?
    let command: ExploreMapCommand?
    let onSelectEncounter: @MainActor (ExploreEncounter) -> Void
    let onRegionChanged: @MainActor (ExploreMapViewport) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        let cc = WKUserContentController()
        cc.add(context.coordinator, name: "viewportChanged")
        cc.add(context.coordinator, name: "markerTapped")
        cc.add(context.coordinator, name: "jsLog")
        cfg.userContentController = cc
        cfg.defaultWebpagePreferences.allowsContentJavaScript = true
        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.isOpaque = false
        wv.backgroundColor = UIColor(red: 6/255, green: 7/255, blue: 12/255, alpha: 1)
        wv.scrollView.bounces = false
        wv.scrollView.isScrollEnabled = false
        context.coordinator.webView = wv

        let html = Self.html
            .replacingOccurrences(of: "{{LAT}}", with: String(centerCoordinate.latitude))
            .replacingOccurrences(of: "{{LNG}}", with: String(centerCoordinate.longitude))
        wv.loadHTMLString(html, baseURL: URL(string: "https://sidequest.local"))
        return wv
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        context.coordinator.parent = self
        // Defer to avoid "Modifying state during view update"
        DispatchQueue.main.async {
            context.coordinator.syncMarkers()
            context.coordinator.applyCommand()
            context.coordinator.updateUserLocation()
        }
    }

    // MARK: - Coordinator

    final class Coordinator: NSObject, WKScriptMessageHandler {
        var parent: ExploreMapView
        weak var webView: WKWebView?
        private var lastSig: String?
        private var lastCmdID: UUID?
        private var lastULat: Double?
        private var lastULng: Double?
        private var ready = false
        private var pending = false

        init(parent: ExploreMapView) { self.parent = parent }

        func userContentController(_ c: WKUserContentController, didReceive msg: WKScriptMessage) {
            switch msg.name {
            case "viewportChanged": onVP(msg.body)
            case "markerTapped": onTap(msg.body)
            case "jsLog":
                if let text = msg.body as? String { print("[MapJS] \(text)") }
            default: break
            }
        }

        private func onVP(_ body: Any) {
            guard let d = body as? [String: Any],
                  let s = d["minLat"] as? Double, let n = d["maxLat"] as? Double,
                  let w = d["minLng"] as? Double, let e = d["maxLng"] as? Double,
                  let z = d["zoom"] as? Double else { return }
            if !ready { ready = true; if pending { pending = false; syncMarkers(); updateUserLocation() } }
            let ne = CLLocationCoordinate2D(latitude: n, longitude: e)
            let nw = CLLocationCoordinate2D(latitude: n, longitude: w)
            let se = CLLocationCoordinate2D(latitude: s, longitude: e)
            let sw = CLLocationCoordinate2D(latitude: s, longitude: w)
            let ctr = CLLocationCoordinate2D(latitude: (s+n)/2, longitude: (w+e)/2)
            let diag = CLLocation(latitude: nw.latitude, longitude: nw.longitude)
                .distance(from: CLLocation(latitude: se.latitude, longitude: se.longitude))
            let nwP = MKMapPoint(nw); let seP = MKMapPoint(se)
            let vp = ExploreMapViewport(
                center: ctr, visibleRadius: max(diag/2, 800),
                northEast: ne, northWest: nw, southEast: se, southWest: sw,
                mapRect: MKMapRect(x: min(nwP.x,seP.x), y: min(nwP.y,seP.y),
                                   width: abs(seP.x-nwP.x), height: abs(seP.y-nwP.y)),
                cameraDistance: 591657550.5 / pow(2.0, z))
            Task { @MainActor in self.parent.onRegionChanged(vp) }
        }

        private func onTap(_ body: Any) {
            guard let d = body as? [String: Any], let id = d["id"] as? String else { return }
            Task { @MainActor in
                if let enc = self.parent.encounters.first(where: { $0.id == id }) {
                    self.parent.onSelectEncounter(enc)
                }
            }
        }

        func syncMarkers() {
            guard ready else { pending = true; return }
            let sig = parent.encounters.map {
                "\($0.id)|\($0.kind.rawValue)|\($0.coordinate.latitude)|\($0.coordinate.longitude)|\($0.countdownText ?? "")"
            }.joined(separator: "~")
            guard sig != lastSig else { return }
            lastSig = sig

            let arr = parent.encounters.map { enc -> [String: Any] in
                let isEvt = enc.kind == .limitedEvent || enc.externalEvent != nil
                let cat: String
                if let evt = enc.externalEvent {
                    cat = Self.jsCatKey(for: evt.eventType)
                } else {
                    cat = Self.jsCatKey(forPOI: enc.poi.category)
                }
                var m: [String: Any] = [
                    "id": enc.id, "lat": enc.coordinate.latitude, "lng": enc.coordinate.longitude,
                    "title": enc.title, "sub": enc.subtitle,
                    "cat": cat, "kind": enc.kind.rawValue,
                    "ev": isEvt, "vis": enc.kind == .visitedShrine,
                    "tp": enc.eventTimePriority.rawValue
                ]
                if let c = enc.countdownText { m["cd"] = c }
                if let g = enc.groupedEvents as [ExternalEvent]?, g.count > 1 { m["gc"] = g.count }
                if let e = enc.externalEvent {
                    if let imgURL = e.imageURL { m["img"] = imgURL }
                    if let v = e.venueName { m["ven"] = v }
                    if let p = e.priceMin { m["pr"] = p }
                    m["cur"] = e.currency ?? "USD"
                }
                return m
            }
            guard let data = try? JSONSerialization.data(withJSONObject: arr),
                  let json = String(data: data, encoding: .utf8) else { return }
            let esc = json.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "`", with: "\\`")
            webView?.evaluateJavaScript("window.S(`\(esc)`);", completionHandler: nil)
        }

        /// Maps ExternalEventType to JS CAT keys
        private static func jsCatKey(for eventType: ExternalEventType) -> String {
            switch eventType {
            case .concert: return "concert"
            case .partyNightlife: return "party_nightlife"
            case .sportsEvent: return "sports_event"
            case .groupRun, .race5k, .race10k, .raceHalfMarathon, .raceMarathon: return "race"
            case .weekendActivity, .socialCommunityEvent, .otherLiveEvent: return "other_live_event"
            }
        }

        /// Maps MapQuestCategory to JS CAT keys
        private static func jsCatKey(forPOI category: MapQuestCategory) -> String {
            switch category {
            case .park: return "park"
            case .gym, .rockClimbingGym, .martialArts: return "gym"
            case .library: return "library"
            case .cafe, .restaurant: return "cafe"
            case .trail, .bikePath: return "trail"
            case .museum, .artGallery: return "museum"
            case .bookstore: return "bookstore"
            case .yogaStudio, .danceStudio: return "yoga"
            case .pool, .beach, .lake: return "pool"
            default: return "other_live_event"
            }
        }

        func applyCommand() {
            guard let cmd = parent.command, cmd.id != lastCmdID else { return }
            lastCmdID = cmd.id
            let js: String
            switch cmd.action {
            case .recenter:
                let c = parent.userCoordinate ?? parent.centerCoordinate
                js = "window.RC(\(c.latitude),\(c.longitude));"
            case .zoomIn: js = "window.ZI();"
            case .zoomOut: js = "window.ZO();"
            case .focusObjectives:
                let hp = parent.encounters.filter { $0.kind.isHighPriority }
                guard !hp.isEmpty else { return }
                let b = hp.map { ["lat": $0.coordinate.latitude, "lng": $0.coordinate.longitude] }
                guard let d = try? JSONSerialization.data(withJSONObject: b),
                      let j = String(data: d, encoding: .utf8) else { return }
                js = "window.FT(\(j));"
            }
            webView?.evaluateJavaScript(js, completionHandler: nil)
        }

        func updateUserLocation() {
            guard ready else { return }
            if let c = parent.userCoordinate {
                guard c.latitude != lastULat || c.longitude != lastULng else { return }
                lastULat = c.latitude; lastULng = c.longitude
                webView?.evaluateJavaScript("window.UL(\(c.latitude),\(c.longitude));", completionHandler: nil)
            } else if lastULat != nil {
                lastULat = nil; lastULng = nil
                webView?.evaluateJavaScript("window.ULR();", completionHandler: nil)
            }
        }
    }

    // MARK: - HTML (MapLibre GL JS + 3D Buildings + Fog + Dark Vector Tiles)

    private static let html: String = ###"""
    <!DOCTYPE html><html><head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
    <link rel="stylesheet" href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css"/>
    <style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body,#map{height:100%;width:100%;overflow:hidden;
      background:#06070c;
      font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display",system-ui,sans-serif;
      -webkit-tap-highlight-color:transparent;-webkit-font-smoothing:antialiased}
    .maplibregl-ctrl-attrib{
      background:rgba(0,0,0,.4)!important;color:rgba(255,255,255,.18)!important;
      font-size:7px!important;padding:1px 4px!important;
      backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
    .maplibregl-ctrl-attrib a{color:rgba(255,255,255,.22)!important;text-decoration:none!important}
    .maplibregl-ctrl-group{display:none!important}
    .maplibregl-canvas{outline:none!important}

    /* Event pin markers */
    .pin-wrap{
      display:flex;flex-direction:column;align-items:center;
      cursor:pointer;-webkit-tap-highlight-color:transparent;
      transition:transform 0.15s ease;
    }
    .pin-wrap:active{transform:scale(0.92)}
    .pin-circle{
      width:48px;height:48px;border-radius:50%;
      border:3px solid #448aff;
      background:#0c0e18;
      overflow:hidden;
      display:flex;align-items:center;justify-content:center;
      box-shadow:0 0 12px rgba(68,138,255,0.4), 0 4px 12px rgba(0,0,0,0.5);
    }
    .pin-img{
      width:100%;height:100%;object-fit:cover;
      border-radius:50%;
      display:block;
    }
    .pin-emoji{
      font-size:24px;line-height:1;
      text-align:center;
    }
    .pin-pointer{
      width:0;height:0;
      border-left:6px solid transparent;
      border-right:6px solid transparent;
      border-top:8px solid #448aff;
      margin-top:-1px;
      filter:drop-shadow(0 2px 3px rgba(0,0,0,0.4));
    }

    /* User dot */
    .ud{
      width:16px;height:16px;border-radius:50%;
      background:linear-gradient(135deg,#5ba3ff,#1d6fff);
      border:3px solid #fff;
      box-shadow:0 0 0 6px rgba(29,111,255,.15),0 0 20px rgba(29,111,255,.4),0 2px 8px rgba(0,0,0,.4);
      animation:udp 3s ease-in-out infinite;
    }
    @keyframes udp{
      0%,100%{box-shadow:0 0 0 6px rgba(29,111,255,.15),0 0 20px rgba(29,111,255,.4),0 2px 8px rgba(0,0,0,.4)}
      50%{box-shadow:0 0 0 14px rgba(29,111,255,.04),0 0 32px rgba(29,111,255,.15),0 2px 8px rgba(0,0,0,.4)}
    }

    </style></head>
    <body><div id="map"></div>
    <script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
    <script>
    (function(){
    'use strict';

    var darkStyle = {
        version:8,
        name:'SideQuest Dark',
        sources:{
            openmaptiles:{
                type:'vector',
                url:'https://tiles.openfreemap.org/planet',
                attribution:'© OpenMapTiles © OpenStreetMap'
            }
        },
        glyphs:'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
        sprite:'https://tiles.openfreemap.org/sprites/ofm_f384/ofm',
        layers:[
            /* ── Base ── */
            {id:'bg',type:'background',paint:{'background-color':'#06070c'}},

            /* ── Land & Nature ── */
            {id:'earth',type:'fill',source:'openmaptiles','source-layer':'landcover',
             paint:{'fill-color':['match',['get','class'],
                 'grass','#0a1410','wood','#080f0c','ice','#0c1020',
                 '#0a0c14'],
                 'fill-opacity':0.6}},
            {id:'landuse',type:'fill',source:'openmaptiles','source-layer':'landuse',
             paint:{'fill-color':['match',['get','class'],
                 'park','#0c1a10','cemetery','#0e120e','grass','#0a1410',
                 'hospital','#140e10','school','#10100e','stadium','#12100e',
                 '#0a0c14'],
                 'fill-opacity':0.5}},

            /* ── Water with subtle glow ── */
            {id:'water-shadow',type:'fill',source:'openmaptiles','source-layer':'water',
             paint:{'fill-color':'#060c1e','fill-opacity':0.9}},
            {id:'water',type:'fill',source:'openmaptiles','source-layer':'water',
             paint:{'fill-color':'#081020'}},
            {id:'waterway',type:'line',source:'openmaptiles','source-layer':'waterway',
             paint:{'line-color':'#0a1428','line-width':['interpolate',['linear'],['zoom'],8,0.5,14,2.5]}},

            /* ── Tunnels ── */
            {id:'tunnel-casing',type:'line',source:'openmaptiles','source-layer':'transportation',
             filter:['==','brunnel','tunnel'],minzoom:13,
             paint:{'line-color':'#080a12','line-width':['interpolate',['linear'],['zoom'],13,3,16,10],
                    'line-dasharray':[0.5,0.25]}},
            {id:'tunnel',type:'line',source:'openmaptiles','source-layer':'transportation',
             filter:['==','brunnel','tunnel'],
             paint:{'line-color':'#0e1018','line-width':['interpolate',['linear'],['zoom'],12,0.5,16,5],
                    'line-dasharray':[3,3]}},

            /* ── Roads: casing first, then fill for depth ── */
            {id:'road-minor-casing',type:'line',source:'openmaptiles','source-layer':'transportation',
             filter:['all',['!has','brunnel'],['in','class','minor','service','track']],
             minzoom:14,
             paint:{'line-color':'#080a12','line-width':['interpolate',['linear'],['zoom'],14,2.5,16,6],
                    'line-opacity':0.5}},
            {id:'road-minor',type:'line',source:'openmaptiles','source-layer':'transportation',
             filter:['all',['!has','brunnel'],['in','class','minor','service','track']],
             minzoom:13,
             paint:{'line-color':'#12141f','line-width':['interpolate',['linear'],['zoom'],13,0.5,16,4]}},

            {id:'road-secondary-casing',type:'line',source:'openmaptiles','source-layer':'transportation',
             filter:['all',['!has','brunnel'],['in','class','secondary','tertiary']],
             minzoom:12,
             paint:{'line-color':'#080a12','line-width':['interpolate',['linear'],['zoom'],12,2,16,9]}},
            {id:'road-secondary',type:'line',source:'openmaptiles','source-layer':'transportation',
             filter:['all',['!has','brunnel'],['in','class','secondary','tertiary']],
             minzoom:11,
             paint:{'line-color':'#141624','line-width':['interpolate',['linear'],['zoom'],11,0.8,16,6]}},

            {id:'road-primary-casing',type:'line',source:'openmaptiles','source-layer':'transportation',
             filter:['all',['!has','brunnel'],['==','class','primary']],
             paint:{'line-color':'#080a14','line-width':['interpolate',['linear'],['zoom'],8,1.5,16,12]}},
            {id:'road-primary',type:'line',source:'openmaptiles','source-layer':'transportation',
             filter:['all',['!has','brunnel'],['==','class','primary']],
             paint:{'line-color':'#171a2c','line-width':['interpolate',['linear'],['zoom'],8,0.5,16,8]}},

            {id:'road-trunk-casing',type:'line',source:'openmaptiles','source-layer':'transportation',
             filter:['all',['!has','brunnel'],['in','class','trunk','motorway']],
             paint:{'line-color':'#0a0c16','line-width':['interpolate',['linear'],['zoom'],6,1,16,14]}},
            {id:'road-trunk',type:'line',source:'openmaptiles','source-layer':'transportation',
             filter:['all',['!has','brunnel'],['in','class','trunk','motorway']],
             paint:{'line-color':'#1c1e34','line-width':['interpolate',['linear'],['zoom'],6,0.5,16,10]}},

            /* ── Rail ── */
            {id:'rail',type:'line',source:'openmaptiles','source-layer':'transportation',
             filter:['==','class','rail'],minzoom:12,
             paint:{'line-color':'#141622','line-width':1.2,'line-dasharray':[4,3]}},

            /* ── Aeroway ── */
            {id:'aeroway',type:'line',source:'openmaptiles','source-layer':'aeroway',
             minzoom:11,filter:['in','class','runway','taxiway'],
             paint:{'line-color':'#141828','line-width':['match',['get','class'],'runway',3,'taxiway',1.5,1]}},

            /* ── Bridge ── */
            {id:'bridge-casing',type:'line',source:'openmaptiles','source-layer':'transportation',
             filter:['==','brunnel','bridge'],
             paint:{'line-color':'#0a0c16','line-width':['interpolate',['linear'],['zoom'],12,2,16,12]}},
            {id:'bridge',type:'line',source:'openmaptiles','source-layer':'transportation',
             filter:['==','brunnel','bridge'],
             paint:{'line-color':'#1a1c30','line-width':['interpolate',['linear'],['zoom'],12,1,16,8]}},

            /* ── Buildings (flat fill, replaced by 3D on load) ── */
            {id:'building',type:'fill',source:'openmaptiles','source-layer':'building',
             minzoom:13,
             paint:{'fill-color':'#10121e','fill-opacity':['interpolate',['linear'],['zoom'],13,0,14,0.6]}},

            /* ── Boundaries ── */
            {id:'boundary-state',type:'line',source:'openmaptiles','source-layer':'boundary',
             filter:['==','admin_level',4],
             paint:{'line-color':'#1a1c2e','line-width':0.8,'line-dasharray':[6,4],'line-opacity':0.35}},
            {id:'boundary-country',type:'line',source:'openmaptiles','source-layer':'boundary',
             filter:['==','admin_level',2],
             paint:{'line-color':'#1e2038','line-width':1.2,'line-opacity':0.45}},

            /* ── Labels ── */
            {id:'road-label',type:'symbol',source:'openmaptiles','source-layer':'transportation_name',
             minzoom:14,
             layout:{'text-field':'{name}','text-size':['interpolate',['linear'],['zoom'],14,9,18,13],
                     'symbol-placement':'line','text-anchor':'center','text-font':['Noto Sans Regular'],
                     'text-letter-spacing':0.02},
             paint:{'text-color':'rgba(255,255,255,0.2)','text-halo-color':'#06070c','text-halo-width':1.5}},
            {id:'place-label',type:'symbol',source:'openmaptiles','source-layer':'place',
             filter:['in','class','city','town','village','suburb','neighbourhood'],
             layout:{'text-field':'{name:latin}','text-font':['Noto Sans Regular'],
                     'text-size':['interpolate',['linear'],['zoom'],
                         10,['match',['get','class'],'city',14,'town',12,10],
                         16,['match',['get','class'],'city',22,'town',18,14]],
                     'text-anchor':'center','text-max-width':8,
                     'text-letter-spacing':['match',['get','class'],'city',0.06,'town',0.04,0.02]},
             paint:{'text-color':['match',['get','class'],
                        'city','rgba(255,255,255,0.38)',
                        'town','rgba(255,255,255,0.28)',
                        'suburb','rgba(255,255,255,0.2)',
                        'rgba(255,255,255,0.15)'],
                    'text-halo-color':'#06070c','text-halo-width':2}},
            {id:'poi-label',type:'symbol',source:'openmaptiles','source-layer':'poi',
             minzoom:15,filter:['<=','rank',2],
             layout:{'text-field':'{name:latin}','text-font':['Noto Sans Regular'],'text-size':10,
                     'text-anchor':'top','text-offset':[0,0.6]},
             paint:{'text-color':'rgba(255,255,255,0.15)','text-halo-color':'#06070c','text-halo-width':1}}
        ]
    };

    var map = new maplibregl.Map({
        container:'map',
        style:darkStyle,
        center:[{{LNG}},{{LAT}}],
        zoom:14,
        pitch:50,
        bearing:0,
        minZoom:11,
        maxZoom:18,
        antialias:true,
        attributionControl:true,
        dragRotate:true,
        touchPitch:true
    });

    map.addControl(new maplibregl.AttributionControl({compact:true}),'bottom-right');

    /* ── 3D Buildings + Atmosphere (after style loads) ── */
    map.on('load',function(){

        /* Directional light on 3D structures */
        try{
            map.setLight({
                anchor:'viewport',
                color:'#c8d0ff',
                intensity:0.35,
                position:[1.5,210,30]
            });
        }catch(e){}

        /* Remove flat building fill, replace with 3D extrusions */
        try{map.removeLayer('building')}catch(e){}

        map.addLayer({
            id:'buildings-3d',
            source:'openmaptiles',
            'source-layer':'building',
            type:'fill-extrusion',
            minzoom:13.5,
            paint:{
                'fill-extrusion-color':[
                    'interpolate',['linear'],['coalesce',['get','render_height'],10],
                    0,'#14172a',
                    30,'#1a1e35',
                    80,'#20253f',
                    200,'#262c4a'
                ],
                'fill-extrusion-height':[
                    'interpolate',['linear'],['zoom'],
                    13.5,0,
                    15.5,['coalesce',['get','render_height'],['*',['coalesce',['get','levels'],3],3.5]]
                ],
                'fill-extrusion-base':[
                    'interpolate',['linear'],['zoom'],
                    13.5,0,
                    15.5,['coalesce',['get','render_min_height'],0]
                ],
                'fill-extrusion-opacity':[
                    'interpolate',['linear'],['zoom'],
                    13.5,0,
                    14.5,0.55,
                    16,0.75,
                    18,0.85
                ],
                'fill-extrusion-vertical-gradient':true
            }
        });

        /* Subtle building edge highlight layer */
        map.addLayer({
            id:'buildings-edge',
            source:'openmaptiles',
            'source-layer':'building',
            type:'fill-extrusion',
            minzoom:15,
            paint:{
                'fill-extrusion-color':'#3040aa',
                'fill-extrusion-height':['coalesce',['get','render_height'],['*',['coalesce',['get','levels'],3],3.5]],
                'fill-extrusion-base':['coalesce',['get','render_min_height'],0],
                'fill-extrusion-opacity':[
                    'interpolate',['linear'],['zoom'],
                    15,0,
                    16,0.04,
                    18,0.08
                ],
                'fill-extrusion-vertical-gradient':true
            }
        });
    });

    /* ══════════════════════════════════════════════════════
       DOM MARKER PIN SYSTEM
       Dots (circle layer) at low zoom + HTML markers at high zoom.
       Event images loaded natively via <img> tags — no canvas, no RGBA.
       ══════════════════════════════════════════════════════ */

    var cz=14,um=null,srcReady=false;
    var pendingData=null;
    var emptyGeo={type:'FeatureCollection',features:[]};
    var markers={};    /* id → {marker, data} */
    var markerData=[];  /* raw data from Swift */

    /* ── Category config (emoji + color) ── */
    var CAT={
        park:{c:'#00e676',e:'\u{1F333}'},gym:{c:'#ff6e40',e:'\u{1F4AA}'},
        library:{c:'#b388ff',e:'\u{1F4DA}'},cafe:{c:'#ffab40',e:'\u{2615}'},
        trail:{c:'#69f0ae',e:'\u{1F97E}'},museum:{c:'#ffd740',e:'\u{1F3DB}'},
        bookstore:{c:'#ea80fc',e:'\u{1F4D6}'},yoga:{c:'#e040fb',e:'\u{1F9D8}'},
        pool:{c:'#40c4ff',e:'\u{1F3CA}'},garden:{c:'#76ff03',e:'\u{1F33F}'},
        concert:{c:'#d500f9',e:'\u{1F3B5}'},sports_event:{c:'#ffab00',e:'\u{1F3DF}'},
        party_nightlife:{c:'#ff1744',e:'\u{1F378}'},race:{c:'#00e676',e:'\u{1F3C3}'},
        festival:{c:'#ff6e40',e:'\u{1F3EA}'},other_live_event:{c:'#448aff',e:'\u{2728}'}
    };
    function gc(cat){return(CAT[cat]||CAT.other_live_event).c}
    function ge(cat){return(CAT[cat]||CAT.other_live_event).e}

    var dotColor='#448aff';

    /* JS → Swift log bridge */
    function LOG(s){try{window.webkit.messageHandlers.jsLog.postMessage(s)}catch(e){}}

    /* ── Create a DOM pin element (only for events with images) ── */
    function makePin(m){
        var wrap=document.createElement('div');
        wrap.className='pin-wrap';

        var circle=document.createElement('div');
        circle.className='pin-circle';

        var img=document.createElement('img');
        img.className='pin-img';
        img.src=m.img;
        img.loading='eager';
        img.onerror=function(){
            /* If image fails, remove the marker entirely — dot layer handles it */
            wrap.style.display='none';
        };
        circle.appendChild(img);

        var pointer=document.createElement('div');
        pointer.className='pin-pointer';

        wrap.appendChild(circle);
        wrap.appendChild(pointer);

        wrap.addEventListener('click',function(e){
            e.stopPropagation();
            try{window.webkit.messageHandlers.markerTapped.postMessage({id:m.id})}catch(err){}
            map.easeTo({center:[m.lng,m.lat],duration:400});
        });

        return wrap;
    }

    /* ── Sync DOM markers — only for events with images ── */
    function syncPins(){
        var show=cz>=12.5;
        var newIds={};

        if(show){
            for(var i=0;i<markerData.length;i++){
                var m=markerData[i];
                if(!m.img)continue; /* Only create pins for events with images */
                newIds[m.id]=true;
                if(!markers[m.id]){
                    var el=makePin(m);
                    var mk=new maplibregl.Marker({element:el,anchor:'bottom'})
                        .setLngLat([m.lng,m.lat])
                        .addTo(map);
                    markers[m.id]={marker:mk,data:m};
                }
            }
        }

        /* Remove markers no longer in data or if zoomed out */
        var toRemove=[];
        for(var id in markers){
            if(!newIds[id]){toRemove.push(id)}
        }
        for(var r=0;r<toRemove.length;r++){
            markers[toRemove[r]].marker.remove();
            delete markers[toRemove[r]];
        }
    }

    /* ── Map load: add source + layers ── */
    map.on('load',function(){
        map.addSource('events',{type:'geojson',data:emptyGeo});

        /* Glow layer */
        map.addLayer({
            id:'events-glow',type:'circle',source:'events',
            paint:{
                'circle-radius':['interpolate',['linear'],['zoom'],11,8,13,16,15,24],
                'circle-color':dotColor,
                'circle-opacity':['interpolate',['linear'],['zoom'],11,0.06,13,0.1,15,0.14],
                'circle-blur':1
            }
        });

        /* Dot layer — visible at all zoom levels */
        map.addLayer({
            id:'events-dot',type:'circle',source:'events',
            paint:{
                'circle-radius':['interpolate',['linear'],['zoom'],11,4,12,6,14,7,16,8],
                'circle-color':dotColor,
                'circle-opacity':0.85,
                'circle-stroke-width':['interpolate',['linear'],['zoom'],11,1.5,14,2],
                'circle-stroke-color':'#06070c'
            }
        });

        /* Title label layer */
        map.addLayer({
            id:'events-label',type:'symbol',source:'events',
            minzoom:14,
            layout:{
                'text-field':['step',['zoom'],
                    ['get','title'],
                    15,['concat',['get','title'],'\n',['get','sub']]
                ],
                'text-font':['Noto Sans Regular'],
                'text-size':['interpolate',['linear'],['zoom'],14,9.5,16,12],
                'text-anchor':'top',
                'text-offset':[0,2.5],
                'text-max-width':10,
                'text-allow-overlap':false,
                'text-optional':true
            },
            paint:{
                'text-color':'rgba(220,225,240,0.88)',
                'text-halo-color':'rgba(6,7,12,0.9)',
                'text-halo-width':1.8,
                'text-halo-blur':0.5,
                'text-opacity':['interpolate',['linear'],['zoom'],14,0,14.5,0.85]
            }
        });

        srcReady=true;

        /* Replay any data that arrived before load */
        if(pendingData){window.S(pendingData);pendingData=null}

        /* Fire a viewport report now so Swift knows we're ready and sends data */
        nvp();

        /* Click handler for dots */
        map.on('click','events-dot',function(e){
            if(!e.features||!e.features.length)return;
            var f=e.features[0];
            try{window.webkit.messageHandlers.markerTapped.postMessage({id:f.properties.id})}catch(err){}
            map.easeTo({center:f.geometry.coordinates,duration:400});
        });
    });

    /* ── Viewport reporting ── */
    var vt=null;
    function nvp(){
        if(vt)clearTimeout(vt);
        vt=setTimeout(function(){
            var b=map.getBounds();cz=map.getZoom();
            try{window.webkit.messageHandlers.viewportChanged.postMessage({
                minLat:b.getSouth(),maxLat:b.getNorth(),
                minLng:b.getWest(),maxLng:b.getEast(),
                zoom:cz
            })}catch(e){}
            syncPins();
        },160);
    }
    map.on('moveend',nvp);
    map.on('zoomend',function(){cz=map.getZoom();nvp()});
    setTimeout(nvp,400);

    /* ── Sync from Swift ── */
    window.S=function(j){
        if(!srcReady){pendingData=j;return}
        try{
            var d=JSON.parse(j);
            markerData=d;
            var features=d.map(function(m){
                var cat=m.cat||'other_live_event';
                return {
                    type:'Feature',
                    geometry:{type:'Point',coordinates:[m.lng,m.lat]},
                    properties:{
                        id:m.id,
                        cat:cat,
                        title:(m.title||'').substring(0,24),
                        sub:(m.sub||m.ven||'').substring(0,28),
                        vis:!!m.vis,
                        ev:!!m.ev,
                        tp:m.tp||'',
                        kind:m.kind||''
                    }
                };
            });
            var geo={type:'FeatureCollection',features:features};
            var src=map.getSource('events');
            if(src){src.setData(geo)}
            syncPins();
            LOG('S: F:'+features.length+' Z:'+Math.round(cz*10)/10);
        }catch(e){LOG('S-err: '+e.message)}
    };

    /* ── Commands ── */
    window.RC=function(a,o){map.flyTo({center:[o,a],zoom:Math.max(cz,14),pitch:50,duration:800})};
    window.ZI=function(){map.easeTo({zoom:cz+1,duration:300})};
    window.ZO=function(){if(cz<=map.getMinZoom())return;map.easeTo({zoom:cz-1,duration:300})};
    window.FT=function(c){
        if(!c||!c.length)return;
        var b=new maplibregl.LngLatBounds();
        c.forEach(function(p){b.extend([p.lng,p.lat])});
        map.fitBounds(b,{padding:80,maxZoom:16,pitch:50,duration:800});
    };

    /* ── User location (single DOM marker — only one, no perf hit) ── */
    window.UL=function(a,o){
        if(um){um.setLngLat([o,a])}
        else{
            var el=document.createElement('div');el.innerHTML='<div class="ud"></div>';
            um=new maplibregl.Marker({element:el,anchor:'center'}).setLngLat([o,a]).addTo(map);
        }
    };
    window.ULR=function(){if(um){um.remove();um=null}};

    })();
    </script></body></html>
    """###
}

