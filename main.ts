// roblox-up-and-coming-forecast-01: Calibrated Bayesian Momentum & Turnover Forecaster
// Computes exponential recency weighted rank distributions, player momentum, and
// Gaussian dispersion kernels with calibrated safety-net floors to model fast-moving turnover.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

interface Row {
  rank: number;
  universe_id: number;
  playing?: number | null;
  name?: string;
}

interface Snapshot {
  at?: string;
  up_and_coming: Row[];
}

interface TaskConfig {
  places: number;
  output: string;
}

interface GameStats {
  ranks: number[];
  weights: number[];
  playing: number[];
  lastRank: number;
}

// 1. Read task configuration and chart history
const task = JSON.parse(readFileSync(join(INPUT_DIR, 'task.json'), 'utf8')) as TaskConfig;
const rawLines = readFileSync(join(INPUT_DIR, 'history.ndjson'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l.length > 0);

const snapshots: Snapshot[] = rawLines.map((l) => JSON.parse(l));
const numSnaps = snapshots.length;

// 2. Aggregate game statistics across snapshots with exponential recency weighting
const gameMap = new Map<number, GameStats>();

for (let i = 0; i < numSnaps; i++) {
  const snap = snapshots[i];
  if (!snap || !snap.up_and_coming) continue;

  // Recency weight with half-life ~10 snapshots
  const w = Math.exp((i - numSnaps + 1) / 10.0);

  for (const r of snap.up_and_coming) {
    let stats = gameMap.get(r.universe_id);
    if (!stats) {
      stats = { ranks: [], weights: [], playing: [], lastRank: 999 };
      gameMap.set(r.universe_id, stats);
    }
    stats.ranks.push(r.rank);
    stats.weights.push(w);
    stats.playing.push(r.playing ?? 0);
    if (i === numSnaps - 1) {
      stats.lastRank = r.rank;
    }
  }
}

// 3. Compute composite momentum score
interface Candidate {
  universe_id: number;
  score: number;
  lastRank: number;
  weightedRank: number;
}

const candidates: Candidate[] = [];

for (const [uid, stats] of gameMap.entries()) {
  const totalW = stats.weights.reduce((a, b) => a + b, 0);
  if (totalW === 0) continue;

  let wRankSum = 0;
  for (let j = 0; j < stats.ranks.length; j++) {
    wRankSum += (stats.ranks[j] ?? 99) * (stats.weights[j] ?? 0);
  }
  const weightedRank = wRankSum / totalW;
  const lastRk = stats.lastRank;

  // Bonus for being active in top ranks at cutoff
  const activeBonus = lastRk <= 20 ? -15 : (lastRk <= 50 ? 0 : 25);
  const compositeScore = weightedRank * 0.5 + lastRk * 0.5 + activeBonus;

  candidates.push({
    universe_id: uid,
    score: compositeScore,
    lastRank: lastRk,
    weightedRank
  });
}

// Sort candidates by lowest predicted rank score
candidates.sort((a, b) => a.score - b.score);

// Top point-guess list (exactly task.places distinct IDs)
const top10 = candidates.slice(0, task.places).map((c) => c.universe_id);

// 4. Construct calibrated Gaussian dispersion probability matrix
// Calibrated floor: unnamed mass = 0.50, named budget = 0.50
const UNNAMED_MASS = 0.50;
const NAMED_BUDGET = 1.0 - UNNAMED_MASS;
const SIGMA = 6.5;
const K_CANDIDATES = 16;
const topPool = candidates.slice(0, 35);

const probabilities: Array<{ universe_id: number; place: number; p: number }> = [];

for (let place = 1; place <= task.places; place++) {
  const scoredPool: Array<{ universe_id: number; kw: number }> = [];

  for (const c of topPool) {
    const dist = Math.abs(c.score - place);
    let kw = Math.exp(-0.5 * Math.pow(dist / SIGMA, 2));
    if (Math.abs(c.lastRank - place) <= 2) {
      kw *= 1.25;
    }
    scoredPool.push({ universe_id: c.universe_id, kw });
  }

  scoredPool.sort((a, b) => b.kw - a.kw);
  const topK = scoredPool.slice(0, K_CANDIDATES);
  const sumKw = topK.reduce((sum, item) => sum + item.kw, 0);

  if (sumKw > 0) {
    for (const item of topK) {
      const p = Math.round(((item.kw / sumKw) * NAMED_BUDGET) * 100000) / 100000;
      probabilities.push({ universe_id: item.universe_id, place, p });
    }
  }
}

// 5. Write output forecast
try {
  mkdirSync(OUTPUT_DIR, { recursive: true });
} catch {}

const outputPayload = {
  probabilities,
  top10
};

writeFileSync(join(OUTPUT_DIR, task.output), `${JSON.stringify(outputPayload)}\n`);
