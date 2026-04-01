export type TrackId = "anchor" | "native" | "pinocchio";

export type InvocationMode = "offline" | "retrieval";

export type InteractionMode =
  | "generate"
  | "complete"
  | "repair"
  | "modify"
  | "migrate";

export type Difficulty = "easy" | "medium" | "hard";

export interface TaskInstruction {
  name: string;
  description: string;
}

export interface TaskAccount {
  name: string;
  role: string;
  constraints: string[];
}

export interface PromptAssets {
  includePublicTests: boolean;
  includeStarterTree: boolean;
  includeCommands: boolean;
  includeEditableFileContents?: boolean;
}

export interface EvaluationSettings {
  publicTests: boolean;
  hiddenTests: boolean;
  adversarialTests: boolean;
  collectComputeUnits: boolean;
}

export interface ScoreWeights {
  build: number;
  public: number;
  hidden: number;
  adversarial: number;
  efficiency: number;
}

export interface TrackEntryConfig {
  entryFiles: string[];
}

export interface TaskSpec {
  id: string;
  title: string;
  category: string;
  difficulty: Difficulty;
  version: string;
  supportedTracks: TrackId[];
  supportedModes: InteractionMode[];
  summary: string;
  businessLogic?: string[];
  instructions: TaskInstruction[];
  accounts: TaskAccount[];
  invariants: string[];
  failureConditions: string[];
  editableFiles: string[];
  promptAssets: PromptAssets;
  evaluation: EvaluationSettings;
  scoring: ScoreWeights;
  trackConfigs?: Partial<Record<TrackId, TrackEntryConfig>>;
}

export interface TrackConfig {
  buildCommand: string;
  publicTestCommand?: string;
  hiddenTestCommand?: string;
  adversarialTestCommand?: string;
  workspaceRoot: string;
  publicTestInjectionTarget?: string;
  hiddenTestInjectionTarget?: string;
  adversarialTestInjectionTarget?: string;
  editableFiles: string[];
}

export interface TaskTrackDescriptor {
  track: TrackId;
  rootDir: string;
  starterDir: string;
  trackConfigPath: string;
  publicTestsDir: string;
  hiddenTestsDir: string;
  adversarialTestsDir: string;
  referenceSolutionDir: string;
  insecureSolutionDir: string;
  config: TrackConfig;
}

export interface TaskDescriptor {
  id: string;
  rootDir: string;
  coreDir: string;
  specPath: string;
  promptPath: string;
  rubricPath: string;
  spec: TaskSpec;
  tracks: Partial<Record<TrackId, TaskTrackDescriptor>>;
}

export interface ValidationResult {
  ok: boolean;
  tasks: TaskDescriptor[];
  issues: string[];
}
