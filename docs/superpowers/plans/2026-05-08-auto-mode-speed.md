# Auto Mode Speed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Auto mode return BPM results faster without removing existing candidate sources or changing the final decision rules.

**Architecture:** Keep the current `decideJudgeBpm` quality gate. Start Groove candidate collection and Essentia candidate collection at the same time, then merge whichever candidates are available with the existing fallback behavior.

**Tech Stack:** React, TypeScript, Vite, Node test runner.

---

### Task 1: Guard Auto Parallelization

**Files:**
- Create: `tests/autoModeSpeed.test.mjs`
- Modify: `src/App.tsx`

- [ ] **Step 1: Write the failing test**

Create a source-level regression test that asserts `analyzeJudge` starts both candidate promises before awaiting settlement and uses `Promise.allSettled`.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test tests/autoModeSpeed.test.mjs`
Expected: FAIL because current `analyzeJudge` awaits Groove before starting Essentia.

- [ ] **Step 3: Write minimal implementation**

In `analyzeJudge`, create `grooveCandidatesPromise` and `ejsCandidatesPromise` before the first await, then await them together with `Promise.allSettled`. Preserve the existing Essentia failure fallback and error message behavior.

- [ ] **Step 4: Run focused test to verify it passes**

Run: `node --test tests/autoModeSpeed.test.mjs`
Expected: PASS.

### Task 2: Verify Quality And Runtime

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Run existing tests**

Run: `npm test`
Expected: all existing tests pass.

- [ ] **Step 2: Run production build**

Run: `npm run build`
Expected: TypeScript and Vite build complete successfully.

- [ ] **Step 3: Benchmark audio samples**

Use the audio samples in `1/audio` as before/after reference. Record Auto-mode BPM output and elapsed time for each file; confirm the decision algorithm and candidate sources remain unchanged by this patch.
