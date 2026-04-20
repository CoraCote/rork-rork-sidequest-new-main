import { Injectable } from '@nestjs/common';
import { MetroRecord, TileCoordinate, LatLon } from '../utils';

@Injectable()
export class GeoHelper {
  tileFromLatLon(lat: number, lon: number, zoom: number): TileCoordinate {
    const scale = Math.pow(2, zoom);
    const normalizedLon = Math.min(Math.max((lon + 180) / 360, 0), 0.999999999);
    const x = Math.floor(normalizedLon * scale);
    const clampedLat = Math.min(Math.max(lat, -85.05112878), 85.05112878);
    const radians = (clampedLat * Math.PI) / 180;
    const mercator = Math.log(Math.tan(Math.PI / 4 + radians / 2));
    const normalizedLat = Math.min(
      Math.max((1 - mercator / Math.PI) / 2, 0),
      0.999999999,
    );
    const y = Math.floor(normalizedLat * scale);
    return { z: zoom, x, y };
  }

  tileCenter(z: number, x: number, y: number): LatLon {
    const scale = Math.pow(2, z);
    const lon = ((x + 0.5) / scale) * 360 - 180;
    const mercatorVal = Math.PI - (2 * Math.PI * (y + 0.5)) / scale;
    const lat = (Math.atan(Math.sinh(mercatorVal)) * 180) / Math.PI;
    return { lat, lon };
  }

  haversineMiles(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const toRadians = (value: number) => (value * Math.PI) / 180;
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRadians(lat1)) *
        Math.cos(toRadians(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  selectCoverageMetros(
    metros: MetroRecord[],
    latitude: number,
    longitude: number,
    maxMiles: number,
    maxCount: number,
  ): MetroRecord[] {
    return metros
      .map((metro) => ({
        metro,
        distanceMiles: this.haversineMiles(
          latitude,
          longitude,
          metro.latitude,
          metro.longitude,
        ),
      }))
      .filter((entry) => entry.distanceMiles <= maxMiles)
      .sort((a, b) => a.distanceMiles - b.distanceMiles)
      .slice(0, maxCount)
      .map((entry) => entry.metro);
  }

  tileYToLat(y: number, zoom: number): number {
    const scale = Math.pow(2, zoom);
    const mercator = Math.PI - (2 * Math.PI * y) / scale;
    return (Math.atan(Math.sinh(mercator)) * 180) / Math.PI;
  }
}
