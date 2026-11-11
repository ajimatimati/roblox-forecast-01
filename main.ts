import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

interface Row {
  rank: number;
  universe_id: number;
}

interface Snapshot {
  up_and_coming: Row[];
}

const task = JSON.parse(readFileSync(join(INPUT_DIR, 'task.json'), 'utf8')) as { places: number; output: string };
const lines = readFileSync(join(INPUT_DIR, 'history.ndjson'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '');

const snapshots: Snapshot[] = lines.map((l) => JSON.parse(l));
const lastSnap = snapshots[snapshots.length - 1]!;
const prevSnap = snapshots.length > 1 ? snapshots[snapshots.length - 2]! : lastSnap;

const prevRanks = new Map<number, number>();
for (const r of prevSnap.up_and_coming) {
  prevRanks.set(r.universe_id, r.rank);
}

// Compute rank trajectory velocity: negative delta means advancing towards #1
const candidates: Array<{ projectedRank: number; uid: number }> = [];
const SHIFT_WEIGHT = 0.3;

for (const r of lastSnap.up_and_coming) {
  const uid = r.universe_id;
  const currRank = r.rank;
  const prevRank = prevRanks.has(uid) ? prevRanks.get(uid)! : currRank + 2;
  const velocity = currRank - prevRank;
  const projectedRank = currRank + SHIFT_WEIGHT * velocity;
  candidates.push({ projectedRank, uid });
}

candidates.sort((a, b) => a.projectedRank - b.projectedRank);
const projectedChart = candidates.map((c) => c.uid);

// Calibrated dispersion kernel
const P_STAY = 0.35;
const P_NEIGH = 0.12;
const P_SECOND_NEIGH = 0.04;

const probabilities: Array<{ universe_id: number; place: number; p: number }> = [];

for (let place = 1; place <= task.places && place <= projectedChart.length; place++) {
  probabilities.push({ universe_id: projectedChart[place - 1]!, place, p: P_STAY });

  if (place === 1) {
    if (projectedChart.length > 1) {
      probabilities.push({ universe_id: projectedChart[1]!, place, p: P_STAY * 0.6 });
    }
    if (projectedChart.length > 2) {
      probabilities.push({ universe_id: projectedChart[2]!, place, p: P_NEIGH });
    }
  } else {
    if (place - 2 >= 0 && place - 2 < projectedChart.length) {
      probabilities.push({ universe_id: projectedChart[place - 2]!, place, p: P_NEIGH });
    }
    if (place < projectedChart.length) {
      probabilities.push({ universe_id: projectedChart[place]!, place, p: P_NEIGH });
    }
    if (place - 3 >= 0 && place - 3 < projectedChart.length) {
      probabilities.push({ universe_id: projectedChart[place - 3]!, place, p: P_SECOND_NEIGH });
    }
    if (place + 1 < projectedChart.length) {
      probabilities.push({ universe_id: projectedChart[place + 1]!, place, p: P_SECOND_NEIGH });
    }
  }
}

try {
  mkdirSync(OUTPUT_DIR, { recursive: true });
} catch {}

const top10 = projectedChart.slice(0, task.places);
writeFileSync(join(OUTPUT_DIR, task.output), `${JSON.stringify({ probabilities, top10 })}\n`);
