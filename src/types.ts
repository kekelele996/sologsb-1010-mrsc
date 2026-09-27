export type RuleKind = 'letter' | 'number' | 'punctuation' | 'contraction' | 'special';
export type LineStatus = 'unchecked' | 'reviewed' | 'questionable' | 'approved';
export type IssueSeverity = 'error' | 'warning' | 'info';

export interface TranscriptionRule {
  id: string;
  source: string;
  output: string;
  kind: RuleKind;
  enabled: boolean;
  suspicious: boolean;
  description: string;
}

export interface RuleSet {
  id: string;
  name: string;
  description: string;
  contractions: boolean;
  hyphenMode: 'cross-line' | 'inline';
  rules: TranscriptionRule[];
}

export interface BrailleToken {
  id: string;
  text: string;
  braille: string;
  kind: RuleKind;
  ruleId?: string;
  suspicious: boolean;
  offset: number;
}

export interface TextbookLine {
  id: string;
  source: string;
  tokens: BrailleToken[];
  status: LineStatus;
  note: string;
  continuesPrevious: boolean;
  continuesNext: boolean;
}

export interface ProofIssue {
  id: string;
  lineId: string;
  tokenId?: string;
  ruleId?: string;
  severity: IssueSeverity;
  code: string;
  message: string;
  resolved: boolean;
}

/** 批次开始或某次记录时保留的课文、规则集与问题快照。 */
export interface BatchSnapshot {
  title: string;
  author: string;
  activeRuleSetId: string;
  ruleSets: RuleSet[];
  lines: TextbookLine[];
  issues: ProofIssue[];
}

/** 恢复事件里指向被恢复记录的引用。 */
export interface RestoreRef {
  batchId: string;
  batchName: string;
  eventId: string;
  eventName: string;
}

/** 批次内的一次行动：校对记录，或一次批次内容恢复（恢复前稿件也完整留存）。 */
export interface BatchEvent {
  id: string;
  name: string;
  kind: 'record' | 'restore';
  createdAt: string;
  action: string;
  note: string;
  snapshot: BatchSnapshot;
  restoredFrom?: RestoreRef;
}

/** 可命名的校对批次：开始时的基线 + 之后每次记录。 */
export interface ProofreadingBatch {
  id: string;
  name: string;
  createdAt: string;
  baseline: BatchSnapshot;
  events: BatchEvent[];
}

export interface LineDiffEntry {
  lineId: string;
  kind: 'added' | 'removed' | 'changed' | 'unchanged';
  before?: TextbookLine;
  after?: TextbookLine;
  beforeIndex: number;
  afterIndex: number;
  changes: string[];
}

export interface RuleDiffEntry {
  ruleSetName: string;
  kind: 'added' | 'removed' | 'changed';
  label: string;
  detail: string;
}

export interface IssueDiffEntry {
  issue: ProofIssue;
  lineIndex: number;
}

export interface IssueDiff {
  appeared: IssueDiffEntry[];
  resolved: IssueDiffEntry[];
  carried: IssueDiffEntry[];
}

export interface SnapshotDiff {
  lines: LineDiffEntry[];
  rules: RuleDiffEntry[];
  settingChanges: string[];
  issues: IssueDiff;
  hasChanges: boolean;
}

export interface ProjectState {
  id: string;
  title: string;
  author: string;
  activeRuleSetId: string;
  ruleSets: RuleSet[];
  lines: TextbookLine[];
  selectedLineId: string;
  issues: ProofIssue[];
  batches: ProofreadingBatch[];
  activeBatchId: string;
  lastCheckedAt: string;
  updatedAt: string;
}

export interface HistoryState {
  past: ProjectState[];
  present: ProjectState;
  future: ProjectState[];
  lastAction: string;
}
