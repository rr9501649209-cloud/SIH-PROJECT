// backend/lib/geo.ts
//
// Honest scope note: this is a greedy proximity-clustering heuristic, not a
// solved vehicle-routing problem. It groups pending applications that are
// geographically close enough for one officer to visit in a single trip.
// That's the actual bottleneck being addressed — too few officers against
// too many scattered instruments — not route-order optimality within a
// cluster, which a real deployment could layer on top later (e.g. calling
// a maps routing API for turn-by-turn order once a cluster is chosen).

export interface GeoPoint {
  id: string;
  lat: number;
  lng: number;
  [key: string]: unknown;
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function clusterByProximity<T extends GeoPoint>(points: T[], radiusKm: number, maxPerCluster: number): T[][] {
  const unclustered = [...points];
  const clusters: T[][] = [];

  while (unclustered.length) {
    const seed = unclustered.shift() as T;
    const cluster: T[] = [seed];

    for (let i = unclustered.length - 1; i >= 0 && cluster.length < maxPerCluster; i--) {
      const d = haversineKm(seed.lat, seed.lng, unclustered[i].lat, unclustered[i].lng);
      if (d <= radiusKm) {
        cluster.push(unclustered[i]);
        unclustered.splice(i, 1);
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}
