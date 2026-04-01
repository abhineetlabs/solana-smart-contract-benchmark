# Solana Smart Contract LLM Benchmark: Implementation Blueprint

## 1. Document Purpose

This document is the build handoff for a new LLM instance or engineer. It explains exactly what to build, why it exists, what to prioritize, what to avoid, what file layout to create, how the benchmark should behave, how scoring works, how tasks are authored, how model adapters are integrated, and how the system should be validated before any benchmark claims are made.

This blueprint is intentionally implementation-oriented rather than aspirational. It should be treated as the primary source of truth for the v1 repository.

The target outcome is a reproducible local benchmark tool that evaluates how well LLMs can create Solana smart contracts across multiple framework tracks while distinguishing:

- general Solana reasoning
- framework fluency
- security robustness
- ability to operate with and without documentation retrieval
- performance under realistic development constraints

This benchmark is not a generic code benchmark. It is a security-aware, task-based evaluation harness for Solana smart contract generation and modification.

## 2. Primary Goal

Build a repository that can:

- define tasks behaviorally in a framework-agnostic core spec
- expose framework-specific tracks for the same behavioral task
- prompt an LLM to produce code changes in a controlled output format
- apply those changes to a fresh isolated workspace
- run public, hidden, and adversarial tests
- compute structured scores
- save all artifacts needed for reproducibility
- compare multiple models across multiple tracks and execution conditions

## 3. What This Benchmark Should and Should Not Claim

### 3.1 Claims It Can Support

If built correctly, the benchmark can support claims like:

- under this pinned benchmark suite, model A outperformed model B on Anchor tasks
- model A has a higher security pass rate than model B on Native Rust tasks
- model A benefits more from retrieval than model B
- model A is better at first-pass secure generation on the tested Solana task families

### 3.2 Claims It Must Not Make

The benchmark must not claim:

- model A is universally better at smart contract programming in all settings
- model A is secure in production just because it scores highly
- benchmark scores imply formal verification or exploit-proofness
- differences from a single run prove true model superiority

### 3.3 Accuracy Philosophy

The benchmark should optimize for strong evidence, not false certainty. There is no such thing as 100 percent certainty that one LLM is better than another from a finite benchmark. The correct target is:

- high internal validity
- high reproducibility
- clear scope of claims
- statistically defensible comparisons

## 4. Core Benchmark Principles

The implementation must follow these principles:

1. Behavior over syntax.
The benchmark measures whether the model creates a correct, secure, idiomatic Solana program, not whether it merely emits compiling Rust.

2. Security is first-class.
Adversarial tests matter as much as or more than happy-path tests.

3. Shared core, separate tracks.
Anchor, Native, and Pinocchio are framework tracks built on the same behavioral task definitions.

4. Controlled execution modes.
Framework track and information-access mode are separate axes.

5. Reproducibility before breadth.
A smaller validated benchmark is better than a large unstable one.

6. Fairness over convenience.
Live internet access should not be used in benchmark scoring. Use a pinned retrieval corpus instead.

7. Complete artifact capture.
Every prompt, response, patch, log, score, and toolchain version must be saved.

8. Extension without over-abstraction.
The codebase should be easy to extend, but avoid premature generic frameworks.

## 5. Benchmark Axes

The benchmark must model several independent dimensions.

### 5.1 Framework Track

Required architecture support:

- `anchor`
- `native`
- `pinocchio`

V1 delivery requirement:

- `anchor`
- `native`

Pinocchio must be designed for from the start, but may be added after the harness is stable.

### 5.2 Information-Access Mode

This is an orthogonal axis, not a track:

- `offline`
- `retrieval`

Definitions:

- `offline`: no docs corpus, no search, no external help
- `retrieval`: model can use a pinned local documentation corpus provided through a benchmark-controlled retrieval interface

Important: do not use the live web for scored benchmark runs. Retrieval must be deterministic and versioned.

### 5.3 Interaction Mode

The architecture should support multiple interaction types even if v1 ships only one or two:

- `generate`: create implementation from starter scaffold
- `complete`: fill in stubs
- `repair`: fix a broken implementation after seeing feedback
- `modify`: update an existing codebase safely
- `migrate`: evolve versioned state or program interfaces

V1 requirement:

- `generate`

V1.5 target:

- `generate`
- `repair`

### 5.4 Attempt Policy

Support:

- `pass@1`
- `pass@k`

V1 only needs `pass@1`, but the result schema should already support multiple attempts.

## 6. Benchmark Scope

### 6.1 In Scope for V1

- repo scaffold
- task schemas
- benchmark runner CLI
- model adapter interface
- at least one working model adapter
- isolated workspace execution
- public tests
- hidden tests injected at runtime
- adversarial tests for at least two tasks
- structured scoring
- JSON result persistence
- summary and compare commands
- reference solutions
- intentionally insecure implementations for validation
- documentation for tasks and adapters

### 6.2 Explicitly Out of Scope for V1

- hosted leaderboard
- web UI
- distributed execution
- cluster deployment benchmarking
- human preference scoring as a required metric
- advanced static analysis gates that are hard to make reliable
- live internet search during scored runs

## 7. Recommended Implementation Strategy

### 7.1 Preferred Stack

- Orchestration: Node.js + TypeScript
- Programs: Rust
- Tests: TypeScript and framework-native test tooling where needed
- Task/result schemas: JSON
- Docs: Markdown

### 7.2 Why TypeScript

TypeScript is a strong fit for:

- filesystem operations
- JSON schema validation
- CLI building
- adapter integration with model APIs
- prompt rendering
- result aggregation
- deterministic scripting

### 7.3 Non-Negotiable Toolchain Policy

Pin all critical versions:

- Node.js version
- package manager version
- Rust toolchain
- Solana CLI
- Anchor version
- cargo dependencies where practical
- TypeScript dependencies
- test tool versions

Record all resolved versions in results.

## 8. High-Level Repository Layout

Create the repository with this shape:

```text
solana-llm-benchmark/
  README.md
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  .gitignore
  .editorconfig
  .node-version
  rust-toolchain.toml
  configs/
    benchmark.default.json
    toolchains.json
    scoring.default.json
    retrieval-corpus.json
  docs/
    IMPLEMENTATION_BLUEPRINT.md
    benchmark-philosophy.md
    adding-a-task.md
    adding-a-model.md
    scoring.md
    prompt-protocol.md
    retrieval-mode.md
    validation.md
  schemas/
    task.schema.json
    run-config.schema.json
    model-output.schema.json
    result.schema.json
    score-breakdown.schema.json
  packages/
    cli/
      src/
    core/
      src/
    runner/
      src/
    scoring/
      src/
    model-adapters/
      src/
      adapters/
        mock/
        openai/
    retrieval/
      src/
    reporting/
      src/
    shared/
      src/
  tasks/
    counter_authority/
      core/
        spec.json
        prompt.md
        rubric.json
      anchor/
        starter/
        tests-public/
        tests-hidden/
        tests-adversarial/
        reference-solution/
        insecure-solution/
      native/
        starter/
        tests-public/
        tests-hidden/
        tests-adversarial/
        reference-solution/
        insecure-solution/
    escrow_basic/
      core/
      anchor/
      native/
    vault_basic/
      core/
      anchor/
      native/
  corpora/
    solana-docs/
      manifest.json
      docs/
  results/
    .gitkeep
  scripts/
    bootstrap.ts
    validate-tasks.ts
    validate-results.ts
    run-reference-baselines.ts
  templates/
    task/
    adapter/
```

Notes:

- `packages/core` contains types, schemas, and task-loading logic.
- `packages/runner` handles workspace prep, prompt rendering, adapter invocation, and command execution.
- `packages/model-adapters` contains provider implementations.
- `packages/retrieval` serves deterministic docs retrieval over the local corpus.
- `packages/scoring` computes per-task and aggregate scores.
- `packages/reporting` builds terminal and JSON reports.
- `packages/cli` exposes user commands and ties everything together.
- `packages/shared` contains utilities with no benchmark-specific policy.

## 9. V1 Deliverable Definition

V1 is complete when all of the following are true:

- the repo builds locally on a documented machine setup
- at least 3 tasks run end-to-end
- `anchor` and `native` tracks both work
- task specs are machine-readable and validated
- hidden tests are injected only during evaluation
- adversarial tests exist for at least 2 tasks
- results are saved as structured JSON with logs and prompt artifacts
- reference solutions pass near-perfectly
- insecure solutions fail security tests
- compare command produces aggregate summaries
- at least one real model adapter and one mock adapter are implemented

## 10. Initial Task Set and Prioritization

Do not start with 8 tasks. Start with 3.

### 10.1 Recommended V1 Tasks

1. `escrow_basic`
2. `vault_basic`
3. `counter_authority`

Reasons:

- `escrow_basic` exercises PDA logic, authority checks, SPL token validation, CPI flows, and state transitions
- `vault_basic` exercises deposits, withdrawals, authority-gated logic, and asset conservation
- `counter_authority` is smaller and useful for validating harness behavior and failure reporting

### 10.2 Post-V1 Expansion Candidates

- marketplace listing and purchase
- staking or reward accrual
- admin config update
- CPI token workflow
- account version migration
- multisig

## 11. Task Design Rules

Every task must be defined behaviorally at the core level and then implemented per track.

### 11.1 Core Task Requirements

Each task must specify:

- stable task id
- title
- category
- difficulty
- summary
- supported tracks
- supported modes
- instructions list
- account model
- invariants
- failure cases
- editable files
- evaluation settings
- scoring weights override if needed

### 11.2 Core Task Must Be Framework-Agnostic

The `core` spec must not mention Anchor macros, Native entrypoint details, or Pinocchio-specific APIs except inside explicitly marked track notes.

### 11.3 Each Track Adapter Must Be Thin

Track-specific folders should only contain:

- starter scaffold
- build/test commands
- public tests
- hidden tests
- adversarial tests
- reference solution
- insecure solution
- optional track-specific rubric additions

Avoid duplicating business logic in multiple places.

## 12. Task Schema

Create `schemas/task.schema.json` and corresponding TypeScript types.

Recommended schema shape:

```json
{
  "id": "escrow_basic",
  "title": "Basic SPL Token Escrow",
  "category": "escrow",
  "difficulty": "medium",
  "version": "1.0.0",
  "supportedTracks": ["anchor", "native", "pinocchio"],
  "supportedModes": ["generate"],
  "summary": "Implement a two-party SPL token escrow program.",
  "businessLogic": [
    "Maker initializes an escrow with offered tokens.",
    "Taker exchanges the requested asset to settle.",
    "Maker can cancel before settlement."
  ],
  "instructions": [
    {
      "name": "initialize",
      "description": "Create escrow state and move maker funds into a vault."
    },
    {
      "name": "exchange",
      "description": "Atomically exchange assets between maker and taker."
    },
    {
      "name": "cancel",
      "description": "Return maker funds if exchange has not happened."
    }
  ],
  "accounts": [
    {
      "name": "maker",
      "role": "authority",
      "constraints": ["signer"]
    }
  ],
  "invariants": [
    "Only the maker can cancel.",
    "Vault authority must be program-derived.",
    "Escrow state validates expected token mints."
  ],
  "failureConditions": [
    "Reject wrong token mint.",
    "Reject unauthorized signer.",
    "Reject invalid PDA derivation."
  ],
  "editableFiles": [
    "programs/escrow/src/lib.rs",
    "tests/escrow.ts"
  ],
  "promptAssets": {
    "includePublicTests": true,
    "includeStarterTree": true,
    "includeCommands": true
  },
  "evaluation": {
    "publicTests": true,
    "hiddenTests": true,
    "adversarialTests": true,
    "collectComputeUnits": true
  },
  "scoring": {
    "build": 0.15,
    "public": 0.2,
    "hidden": 0.25,
    "adversarial": 0.3,
    "efficiency": 0.1
  },
  "trackConfigs": {
    "anchor": {
      "entryFiles": ["programs/escrow/src/lib.rs"]
    },
    "native": {
      "entryFiles": ["src/lib.rs"]
    }
  }
}
```

### 12.1 Required Validation Rules

Validate:

- unique task ids
- difficulty in allowed enum
- tracks in allowed enum
- editable files exist in starter scaffold
- scoring weights sum to 1.0
- hidden tests and adversarial tests are not inside starter directories
- each supported track has required config and folders

## 13. Prompt Protocol

Create a deterministic prompt protocol and version it.

### 13.1 Prompt Protocol Versioning

Every run artifact must record:

- `promptProtocolVersion`
- `taskSpecVersion`
- `retrievalCorpusVersion`

### 13.2 V1 Prompt Mode

Use scaffold mode:

- include task summary
- include instructions
- include invariants
- include editable file list
- include starter file tree
- include selected starter file contents
- include public test contents
- include evaluation command list
- include output format requirements

### 13.3 Prompt Must Exclude

- hidden tests
- adversarial tests
- reference solutions
- insecure solutions
- benchmark-internal scoring logic

### 13.4 Required Output Contract

Require the model to return JSON of this shape:

```json
{
  "files": {
    "programs/escrow/src/lib.rs": "<full file content>",
    "tests/escrow.ts": "<full file content>"
  }
}
```

The runner must reject:

- invalid JSON
- modifications to non-editable files
- missing required files when task requires them
- binary data
- empty file maps

### 13.5 Optional Repair Protocol

Reserve room for a later repair loop:

- attempt 1 receives no feedback beyond prompt
- repair attempt may receive public build/test failures only

Do not implement repair in v1 unless time permits.

## 14. Retrieval Mode Design

### 14.1 Why Not Use the Live Internet

Live web access harms:

- fairness
- reproducibility
- comparability across dates
- debugging of benchmark regressions

Therefore the benchmark must not use external live internet content in scored runs.

### 14.2 Retrieval Corpus

Build a pinned local docs corpus containing:

- Solana docs
- SPL Token docs
- Anchor docs
- Pinocchio docs when supported
- a small vetted set of example snippets if desired

Each document should have:

- stable id
- title
- source URL
- version label
- local path
- chunked text

### 14.3 Retrieval Interface

The retrieval package should expose:

- list available docs
- keyword search
- top-k chunk retrieval
- deterministic ranking given the same query

### 14.4 Retrieval Fairness

When `mode = retrieval`:

- every model gets the same retrieval budget
- every model gets access to the same corpus
- queries and retrieved chunks are logged
- corpus version is saved

## 15. Model Adapter Interface

Create a common adapter contract in `packages/model-adapters/src/types.ts`.

Recommended interface:

```ts
export type ModelInvocationMode = "offline" | "retrieval";

export interface ModelRequest {
  modelId: string;
  prompt: string;
  systemPrompt?: string;
  temperature: number;
  maxOutputTokens?: number;
  responseFormat: "file-map-json";
  mode: ModelInvocationMode;
  retrievalContext?: RetrievedChunk[];
  attemptIndex: number;
  metadata: Record<string, string | number | boolean>;
}

export interface ModelResponse {
  rawText: string;
  parsedOutput?: {
    files: Record<string, string>;
  };
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    estimatedCostUsd?: number;
  };
  latencyMs: number;
  finishReason?: string;
  providerMetadata?: Record<string, unknown>;
}

export interface ModelAdapter {
  id: string;
  invoke(request: ModelRequest): Promise<ModelResponse>;
}
```

### 15.1 Required Adapters

Implement:

- `mock` adapter for testing harness behavior
- one real provider adapter

The mock adapter should support fixture-driven outputs so the benchmark can be tested without API calls.

### 15.2 Adapter Rules

Adapters must not:

- mutate task files directly
- know about task internals beyond the request payload
- hide retries unless retry behavior is explicitly configured and logged

### 15.3 Generation Parameter Logging

Always save:

- model id
- provider
- temperature
- max tokens
- seed if available
- retry policy
- timeout settings

## 16. Execution Harness

The execution harness is the core of the system.

### 16.1 Attempt Lifecycle

For each model-task-track-mode attempt:

1. load task spec
2. validate task config
3. prepare temp workspace
4. copy starter scaffold into temp workspace
5. render prompt
6. if retrieval mode, fetch retrieval context
7. call model adapter
8. validate model output
9. apply file updates to temp workspace
10. run build command
11. run public tests
12. inject hidden tests
13. run hidden tests
14. inject adversarial tests
15. run adversarial tests
16. collect logs, timings, optional compute metrics
17. compute score breakdown
18. persist all artifacts
19. return attempt result

### 16.2 Workspace Isolation

Each attempt must execute in a fresh temp directory.

Requirements:

- no shared mutable task workspace
- no reuse of previous generated files
- all injected tests live only inside the temp workspace during evaluation
- cleanup policy should be configurable for debugging

### 16.3 Command Execution Requirements

Capture for every build/test command:

- exact command
- working directory
- start time
- end time
- duration
- exit code
- stdout
- stderr

### 16.4 Sandbox Expectations

V1 can run locally without OS-level sandboxing if necessary, but the code structure should preserve a future path to stricter isolation. Avoid designs that require shared global mutable state.

## 17. Hidden and Adversarial Test Injection

### 17.1 Separation Requirement

Hidden and adversarial tests must not be visible in starter scaffolds.

Correct structure:

- `starter/` contains only model-visible files and public tests
- `tests-hidden/` and `tests-adversarial/` live outside the starter
- runner copies them into the temp workspace only after generation

### 17.2 Injection Strategy

For each track, define:

- where public tests live
- where hidden tests should be injected
- where adversarial tests should be injected
- any test runner filters or naming conventions

### 17.3 Leakage Prevention

Add validation that starter trees do not accidentally include:

- filenames matching hidden/adversarial naming patterns
- symlinks to hidden files
- copied reference solution material

## 18. Security Test Philosophy

This benchmark is only useful if security testing is meaningful.

### 18.1 Shared Adversarial Pattern Library

Build reusable adversarial patterns where possible:

- missing signer check
- missing ownership check
- incorrect PDA validation
- wrong bump or seed handling
- token mint mismatch
- token authority mismatch
- duplicate mutable accounts
- account substitution
- unauthorized CPI
- close-account authorization failure
- arithmetic overflow or underflow
- stale or reinitialization logic errors
- unchecked remaining accounts

### 18.2 Task-Specific Security Tests

Each task should also have task-local exploits and edge cases. Shared utilities should help, but not replace task-specific coverage.

### 18.3 Scoring Intent

A solution that passes public tests but fails adversarial tests must score materially worse than a secure solution.

## 19. Scoring System

### 19.1 Scoring Goals

Scoring should:

- reward secure correctness over shallow success
- remain understandable
- be deterministic
- produce both per-task and aggregate metrics

### 19.2 Recommended V1 Weighting

Use these default weights:

- build success: 0.15
- public tests: 0.20
- hidden tests: 0.25
- adversarial tests: 0.30
- efficiency: 0.10

Do not include automated code-quality scoring in v1 unless a reliable measurement emerges. If needed later, add it as a separate reported dimension rather than baking it into the main score immediately.

### 19.3 Build Score

Simple binary:

- 1.0 if build succeeds
- 0.0 if build fails

If build fails, subsequent test buckets score zero.

### 19.4 Test Bucket Score

Within each test bucket:

- score = passed / total

### 19.5 Efficiency Score

V1 efficiency can be simple and low-stakes:

- record wall-clock time
- optionally parse compute units from logs if practical
- optionally record account count or space inflation

Suggested v1 efficiency scoring:

- full efficiency score if build+tests pass and compute/time stay under reference-based threshold
- otherwise partial score on a simple bounded scale

If efficiency is too noisy, record it but set the weight to zero until stable.

### 19.6 Failure Class Annotations

In addition to numeric score, every failed attempt should try to classify failures by bucket:

- build_error
- interface_mismatch
- functional_logic
- signer_validation
- ownership_validation
- pda_validation
- token_validation
- cpi_authorization
- arithmetic_safety
- account_substitution
- duplicate_mutability
- close_authorization

This classification can start rule-based from failing test names.

## 20. Result Schema

Create `schemas/result.schema.json`.

Each attempt result should include:

```json
{
  "runId": "2026-04-02T12-00-00Z_local",
  "attemptId": "escrow_basic_anchor_offline_attempt1",
  "taskId": "escrow_basic",
  "taskVersion": "1.0.0",
  "track": "anchor",
  "mode": "offline",
  "interactionMode": "generate",
  "model": {
    "provider": "openai",
    "modelId": "example-model",
    "temperature": 0,
    "maxOutputTokens": 16000
  },
  "prompt": {
    "protocolVersion": "1.0.0",
    "path": "artifacts/prompt.txt"
  },
  "retrieval": {
    "enabled": false
  },
  "artifacts": {
    "rawModelOutputPath": "artifacts/raw-output.txt",
    "parsedFileMapPath": "artifacts/file-map.json",
    "workspaceSnapshotPath": "artifacts/workspace/"
  },
  "build": {
    "success": true,
    "durationMs": 4500,
    "commandLogsPath": "logs/build.json"
  },
  "tests": {
    "public": {
      "passed": 4,
      "total": 5
    },
    "hidden": {
      "passed": 6,
      "total": 8
    },
    "adversarial": {
      "passed": 5,
      "total": 9
    }
  },
  "score": {
    "total": 0.71,
    "breakdown": {
      "build": 0.15,
      "public": 0.16,
      "hidden": 0.1875,
      "adversarial": 0.1667,
      "efficiency": 0.05
    }
  },
  "usage": {
    "promptTokens": 5000,
    "completionTokens": 2200,
    "estimatedCostUsd": 0.19,
    "latencyMs": 9200
  },
  "failureClasses": ["token_validation", "pda_validation"],
  "toolchain": {
    "node": "22.x",
    "rust": "1.x",
    "solana": "x.y.z",
    "anchor": "x.y.z"
  }
}
```

## 21. Aggregate Reporting

The reporting layer should compute:

- average score
- median score
- pass@1
- pass@k when available
- compile success rate
- public test pass rate
- hidden test pass rate
- adversarial pass rate
- solve rate by difficulty
- average cost
- average latency
- average score by track
- average score by mode
- average score by task category
- stability metrics across repeated runs

### 21.1 Four Main Views

Report:

- overall cross-track comparable score
- Anchor score
- Native score
- Pinocchio score when supported

Also report:

- offline score
- retrieval score

### 21.2 Aggregation Rules

Only include tasks in the overall score when the behavioral core is comparable across tracks.

Do not mix unrelated track-only tasks into the overall headline score.

## 22. Statistical Comparison Guidance

The benchmark should not only print averages. It should also support defensible comparisons.

### 22.1 Repeated Runs

For serious comparisons, run each model-task-track-mode pair multiple times.

Suggested defaults:

- development mode: 1 run
- benchmark mode: 3 runs
- publishable comparison mode: 5 or more runs if cost permits

### 22.2 Stability Metrics

Compute:

- mean
- median
- standard deviation
- min and max
- confidence interval if sample count supports it

### 22.3 Benchmark Claims

Comparison output should say:

- model A scored higher than model B by X on this suite
- variance across runs was Y
- difference appears stable or unstable

Avoid language implying absolute certainty.

## 23. CLI Design

Implement a CLI package that exposes simple commands.

### 23.1 Required Commands

```bash
benchmark validate
benchmark list tasks
benchmark list models
benchmark run --model mock/basic --track anchor --task escrow_basic
benchmark run --model openai/gpt-x --track native --suite v1
benchmark run --model openai/gpt-x --track anchor --task escrow_basic --mode retrieval
benchmark compare --results ./results/run-123
benchmark baseline reference --task escrow_basic --track anchor
benchmark baseline insecure --task escrow_basic --track anchor
```

### 23.2 Useful Optional Commands

```bash
benchmark inspect run --run-id <id>
benchmark inspect attempt --attempt-id <id>
benchmark corpus build
benchmark task new --id new_task
benchmark adapter new --id provider_name
```

## 24. Package Responsibilities

### 24.1 `packages/core`

Owns:

- domain types
- schema loading and validation
- task discovery
- track definitions
- config parsing

### 24.2 `packages/runner`

Owns:

- workspace preparation
- prompt rendering
- adapter invocation
- output validation
- file application
- command execution
- artifact persistence

### 24.3 `packages/scoring`

Owns:

- score calculation
- failure class mapping
- aggregate metric computation

### 24.4 `packages/model-adapters`

Owns:

- model adapter interfaces
- provider implementations
- mock adapter

### 24.5 `packages/retrieval`

Owns:

- local docs corpus manifest
- chunk loading
- deterministic retrieval

### 24.6 `packages/reporting`

Owns:

- JSON summaries
- CLI table rendering
- compare reports

### 24.7 `packages/cli`

Owns:

- command definitions
- glue code
- user-facing error handling

## 25. File and Directory Semantics for Tasks

Each task track folder must follow strict conventions.

Example for `tasks/escrow_basic/anchor/`:

```text
tasks/escrow_basic/anchor/
  starter/
    Anchor.toml
    Cargo.toml
    programs/
      escrow/
        src/
          lib.rs
    tests/
      escrow.public.spec.ts
  tests-public/
    escrow.public.spec.ts
  tests-hidden/
    escrow.hidden.spec.ts
  tests-adversarial/
    escrow.adversarial.spec.ts
  reference-solution/
    programs/
      escrow/
        src/
          lib.rs
  insecure-solution/
    programs/
      escrow/
        src/
          lib.rs
  track.config.json
```

### 25.1 `starter/`

Contains only model-visible files.

### 25.2 `tests-public/`

Canonical public tests. These may also be copied into `starter/` if public tests should be visible in the workspace.

### 25.3 `tests-hidden/`

Only injected during evaluation.

### 25.4 `tests-adversarial/`

Only injected during evaluation.

### 25.5 `reference-solution/`

Ground-truth implementation used to validate the benchmark itself.

### 25.6 `insecure-solution/`

Deliberately vulnerable implementation that should pass some visible behavior but fail security tests.

## 26. Track Config

Each track folder should include `track.config.json`.

Recommended contents:

```json
{
  "buildCommand": "anchor build",
  "publicTestCommand": "anchor test --skip-build --run tests/escrow.public.spec.ts",
  "hiddenTestCommand": "anchor test --skip-build --run tests/escrow.hidden.spec.ts",
  "adversarialTestCommand": "anchor test --skip-build --run tests/escrow.adversarial.spec.ts",
  "workspaceRoot": ".",
  "publicTestInjectionTarget": "tests/",
  "hiddenTestInjectionTarget": "tests/",
  "adversarialTestInjectionTarget": "tests/",
  "editableFiles": [
    "programs/escrow/src/lib.rs"
  ]
}
```

The runner should rely on this track config rather than hardcoding command conventions.

## 27. Validation of the Benchmark Itself

Do not trust benchmark results until the benchmark is validated.

### 27.1 Mandatory Validation Checks

For every implemented task-track pair:

1. reference solution builds and passes public, hidden, and adversarial tests
2. insecure solution fails expected adversarial tests
3. a trivial broken solution fails obvious tests
4. task validation script confirms no hidden-file leakage

### 27.2 Repeatability Check

Run at least one stable baseline multiple times to confirm:

- consistent harness behavior
- non-flaky tests
- stable scoring

### 27.3 Discrimination Check

Confirm the benchmark can distinguish between:

- reference implementation
- insecure implementation
- incomplete implementation
- wrong-interface implementation

If these do not separate clearly, the task or scoring is not ready.

## 28. Baselines

Implement three classes of baselines.

### 28.1 Reference Baselines

Hand-written secure implementations for every task and track.

Purpose:

- benchmark correctness validation
- upper-bound sanity check

### 28.2 Insecure Baselines

Deliberately vulnerable implementations.

Purpose:

- adversarial test validation

### 28.3 Mock Model Baselines

Fixture-driven outputs from the mock adapter.

Purpose:

- harness and reporting tests without API dependency

## 29. Logging and Artifacts

Save everything needed to rerun or audit a result.

### 29.1 Required Artifacts per Attempt

- resolved task spec copy
- track config copy
- rendered prompt
- retrieval queries and retrieved chunks if applicable
- raw model response
- parsed file-map JSON
- file diff or generated files snapshot
- build logs
- public test logs
- hidden test logs
- adversarial test logs
- command metadata
- score JSON
- final attempt result JSON

### 29.2 Result Folder Layout

Use a deterministic path shape like:

```text
results/
  2026-04-02_run-001/
    manifest.json
    attempts/
      escrow_basic_anchor_offline_attempt1/
        prompt.txt
        retrieval.json
        raw-output.txt
        file-map.json
        logs/
          build.json
          public.json
          hidden.json
          adversarial.json
        score.json
        result.json
```

## 30. Determinism and Reproducibility Requirements

### 30.1 Must Record

- prompt protocol version
- task version
- track config version or hash
- retrieval corpus version
- model identifier
- provider name
- adapter version
- generation parameters
- toolchain versions
- benchmark package version or git commit when repo becomes a git repo

### 30.2 Must Avoid

- random temp behavior without logging
- silent retries
- mutable external dependencies where avoidable
- live internet content in scored runs

## 31. Evaluation Fairness Rules

### 31.1 Same Prompt Policy

For the same task-track-mode, all models must receive:

- the same task prompt content
- the same starter scaffold
- the same editable file list
- the same retrieval budget if retrieval is enabled

### 31.2 Model-Specific Prompting

Minimize provider-specific prompt customization. If unavoidable, log it and document it. The benchmark should compare models, not prompt-engineering tricks.

### 31.3 Retry Policy

If retries exist, they must be:

- configurable
- logged
- consistent across providers where possible

## 32. Failure Modes to Expect and Design For

The runner should gracefully handle:

- invalid JSON outputs
- truncated outputs
- model timeout
- output modifying forbidden files
- missing required files
- syntax errors
- failing build
- hanging tests
- missing toolchain commands
- corrupted starter workspace

These should produce structured failure results, not crashes.

## 33. Recommended Implementation Order

Follow this order strictly to avoid overbuilding.

### Phase 0: Repo Bootstrap

Build:

- package workspace
- core package
- CLI skeleton
- schemas
- docs
- validation script stubs

Done when:

- `benchmark validate` can discover tasks and configs

### Phase 1: Single Task, Single Track, Mock Model

Build:

- one task: `counter_authority`
- one track: `anchor`
- mock adapter
- prompt renderer
- file-map parser
- workspace creation
- build and public test execution
- JSON artifact writing

Done when:

- end-to-end run succeeds with mock adapter

### Phase 2: Hidden and Adversarial Tests

Add:

- hidden test injection
- adversarial test injection
- scoring
- failure-class tagging

Done when:

- reference solution passes
- insecure solution fails adversarial tests

### Phase 3: Second Track

Add:

- `native` track support
- shared abstractions refined only as necessary

Done when:

- one task works across `anchor` and `native`

### Phase 4: V1 Task Set

Add:

- `escrow_basic`
- `vault_basic`
- compare command
- result aggregation
- real model adapter

Done when:

- 3 tasks run end-to-end across 2 tracks

### Phase 5: Retrieval Mode

Add:

- local docs corpus
- retrieval package
- retrieval mode plumbing

Done when:

- same task can run in `offline` and `retrieval` modes with pinned corpus logs

### Phase 6: Pinocchio

Add:

- Pinocchio track
- track-specific docs corpus content
- task implementations where practical

## 34. What the New LLM Instance Should Build First

When a new LLM begins implementation, it should:

1. create the Node/TypeScript monorepo scaffold
2. define shared benchmark types and JSON schemas
3. implement the CLI with `validate`, `list`, and `run`
4. implement a mock adapter
5. implement task discovery and validation
6. create `counter_authority` Anchor starter and public test
7. implement temp workspace execution
8. persist artifacts and result JSON

Only after that should it add hidden tests, adversarial tests, Native track support, and additional tasks.

## 35. Concrete First Milestone

The first milestone should be:

"Run one Anchor task end-to-end with a mock adapter and save a result JSON."

Do not skip directly to multiple tracks or real API adapters.

## 36. Minimal Initial Commands Expected to Work

After the first milestone, these commands should work:

```bash
benchmark validate
benchmark list tasks
benchmark list models
benchmark run --model mock/reference --track anchor --task counter_authority
```

## 37. Coding Standards for the Implementation

The benchmark codebase should favor:

- explicit types
- small modules
- plain data objects
- boring file-based configuration
- predictable command execution
- explicit error messages

Avoid:

- plugin systems too early
- clever dependency injection
- hidden global state
- magic path conventions not encoded in config

## 38. Documentation Files to Create

The new LLM should create these docs early:

- `README.md`
- `docs/adding-a-task.md`
- `docs/adding-a-model.md`
- `docs/scoring.md`
- `docs/prompt-protocol.md`
- `docs/validation.md`

These do not need to be perfect initially, but the architecture and conventions should be documented while the code is being built.

## 39. Suggested README Structure

The README should contain:

- what the benchmark is
- what it measures
- current supported tracks and modes
- quickstart setup
- example commands
- current limitations
- development roadmap

## 40. Testing the Benchmark Codebase

Separate benchmark-target tests from benchmark-tool tests.

### 40.1 Tooling Tests

Write tests for:

- schema validation
- task discovery
- prompt rendering
- output validation
- score calculation
- artifact persistence
- compare aggregation

### 40.2 Integration Tests

Write integration tests for:

- mock adapter end-to-end run
- hidden test injection path
- rejection of forbidden file edits
- structured failure on invalid model output

## 41. Security of the Benchmark Tool Itself

The benchmark tool should avoid obvious local risks:

- do not execute arbitrary model-supplied shell commands
- do not let model output change files outside editable allowlists
- do not run in-place on the canonical task directories
- do not assume all generated code is trustworthy

Always run generated code only in isolated workspaces.

## 42. Practical Accuracy Improvements Beyond the Initial Brief

To maximize evaluation quality, incorporate these ideas after the base harness works:

- repeated runs for variance
- repair mode after public failure output
- modify-existing-code tasks
- minimal-spec tasks with fewer public hints
- failure-family dashboards
- retrieval mode with pinned corpus

These improve validity more than adding many more tasks too early.

## 43. What Most Improves Benchmark Accuracy

The following choices improve real benchmark accuracy:

- hidden tests
- adversarial tests
- reference and insecure baselines
- repeated runs
- strict prompt protocol
- controlled retrieval
- separate reporting by track and by mode
- separate reporting of security pass rate

The following choices can reduce accuracy if misused:

- too many public tests
- live internet access
- poorly specified tasks
- one-number-only scoreboards
- broad code-quality heuristics
- too much task scaffolding that leaks implementation details

## 44. Things to Avoid While Building

Do not:

- start with all 8 tasks
- add Pinocchio before the core harness is stable
- introduce live web search into scored runs
- rely on compile success as the main metric
- expose hidden tests in starter trees
- skip insecure baseline validation
- over-generalize the code before two tracks actually exist

## 45. Final Build Priorities

If tradeoffs arise, choose in this order:

1. reproducibility
2. security-aware evaluation
3. harness reliability
4. fairness across models
5. ease of adding tasks
6. breadth of supported tracks and task count

## 46. Immediate Action Plan for the Next LLM

The next LLM instance should begin by doing the following:

1. initialize the repository as a TypeScript workspace
2. create `packages/core`, `packages/cli`, `packages/runner`, `packages/model-adapters`, `packages/scoring`, and `packages/shared`
3. add the JSON schemas and matching TypeScript types
4. implement task discovery and schema validation
5. add the mock adapter
6. implement the `benchmark validate`, `benchmark list tasks`, and `benchmark run` CLI commands
7. create the first task `counter_authority` for Anchor
8. make one complete end-to-end run succeed and save results

After that, it should add hidden tests, adversarial tests, Native support, then the escrow and vault tasks.

## 47. Definition of Success for This Blueprint

This document is successful if a new LLM can read it and immediately know:

- what repository structure to create
- what packages and files to implement
- what the runner lifecycle is
- how tasks are represented
- how model outputs are constrained
- how scoring works
- how to validate benchmark integrity
- what order to build things in
- what not to build yet

If ambiguity remains, prefer the simplest reliable implementation that preserves the principles in this document.
