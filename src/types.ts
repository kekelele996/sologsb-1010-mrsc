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

export interface BaselineLine {
  id: string;
  source: string;
  status: LineStatus;
  note: string;
}

export interface BaselineIssue {
  key: string;
  lineId: string;
  ruleId?: string;
  code: string;
  severity: IssueSeverity;
  message: string;
}

/** 批次开始或记录时刻捕获的内容：课文、规则集和未处理问题。 */
export interface BatchContent {
  lines: BaselineLine[];
  activeRuleSetId: string;
  ruleSets: RuleSet[];
  openIssues: BaselineIssue[];
}

export interface BatchRecord {
  id: string;
  action: string;
  kind: 'record' | 'restore';
  createdAt: string;
  content: BatchContent;
  restoredBatchId?: string;
  restoredBatchName?: string;
}

export interface ProofBatch {
  id: string;
  name: string;
  createdAt: string;
  baseline: BatchContent;
  records: BatchRecord[];
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
  batches: ProofBatch[];
  lastCheckedAt: string;
  updatedAt: string;
}

export interface HistoryState {
  past: ProjectState[];
  present: ProjectState;
  future: ProjectState[];
  lastAction: string;
}
