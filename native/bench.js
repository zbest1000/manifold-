// Reproduce the ingest benchmark. Build first: `cargo build --release` in this
// dir, then `cp target/release/libmanifold_native.so index.node`.
const { TopicStore } = require('./index.node');

const T = 1000;
const topics = Array.from({ length: T }, (_, i) => `factory/line/machine/sensor${i}`);
const bufs = Array.from({ length: T }, (_, i) => Buffer.from(JSON.stringify({ value: i })));
const now = Date.now();

// (1) Raw Rust store (Rust owns the loop, no per-message FFI)
const raw = new TopicStore();
const rawMs = raw.bench(T, 20_000_000);
console.log(`raw Rust store:        ${(20e6 / (rawMs / 1000) / 1e6).toFixed(2)} M/s`);

// (2) Per-message FFI (JS calls ingest per message)
const s = new TopicStore();
const N = 5_000_000;
let t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) { const k = i % T; s.ingest(topics[k], bufs[k], 0, false, now); }
let ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`per-message FFI:       ${(N / (ms / 1000) / 1e6).toFixed(2)} M/s`);

console.log('\nSee README.md for the full comparison and the recommendation.');
