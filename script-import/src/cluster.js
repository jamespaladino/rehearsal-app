// One-dimensional clustering of x positions, so indents are learned from each document instead of
// hard-coded. Single-linkage: sorted positions closer than `tolerance` join the same cluster.

import { median } from './layout.js';

/**
 * values: [{ x, ref }]  ->  clusters: [{ center, min, max, count, members: ref[] }] sorted by center.
 */
export function clusterX(values, tolerance) {
  const sorted = [...values].sort((a, b) => a.x - b.x);
  const clusters = [];
  for (const v of sorted) {
    const c = clusters[clusters.length - 1];
    if (c && v.x - c.max <= tolerance) {
      c.xs.push(v.x);
      c.members.push(v.ref);
      c.max = v.x;
    } else {
      clusters.push({ xs: [v.x], members: [v.ref], min: v.x, max: v.x });
    }
  }
  return clusters.map((c) => ({ center: median(c.xs), min: c.min, max: c.max, count: c.xs.length, members: c.members }));
}
