import type {
  BatchContent,
  BatchRecord,
  BaselineIssue,
  BaselineLine,
  ProofBatch,
  ProjectState,
  ProofIssue,
  RuleSet,
} from './types';

export const BATCH_LIMIT = 10;
export const RECORD_LIMIT = 10;

const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** 问题在多次转录间 id 会重新生成，用内容指纹判断是不是同一个问题。 */
export function issueFingerprint(issue: Pick<ProofIssue, 'lineId' | 'ruleId' | 'code' | 'message'>): string {
  return [issue.lineId, issue.ruleId ?? '', issue.code, issue.message].join('|');
}

/** 捕获当前课文、规则集和未处理问题，作为批次起点或一条记录的内容。 */
export function captureBatchContent(state: ProjectState): BatchContent {
  return {
    lines: state.lines.map((line) => ({ id: line.id, source: line.source, status: line.status, note: line.note })),
    activeRuleSetId: state.activeRuleSetId,
    ruleSets: structuredClone(state.ruleSets),
    openIssues: state.issues
      .filter((issue) => !issue.resolved)
      .map((issue) => ({
        key: issueFingerprint(issue),
        lineId: issue.lineId,
        ruleId: issue.ruleId,
        code: issue.code,
        severity: issue.severity,
        message: issue.message,
      })),
  };
}

export function createBatch(name: string, state: ProjectState): ProofBatch {
  return {
    id: uid('batch'),
    name,
    createdAt: new Date().toISOString(),
    baseline: captureBatchContent(state),
    records: [],
  };
}

export function createRecord(action: string, state: ProjectState, restore?: { batchId: string; batchName: string }): BatchRecord {
  return {
    id: uid('record'),
    action,
    kind: restore ? 'restore' : 'record',
    createdAt: new Date().toISOString(),
    content: captureBatchContent(state),
    restoredBatchId: restore?.batchId,
    restoredBatchName: restore?.batchName,
  };
}

export interface LineDiffEntry {
  kind: 'added' | 'removed' | 'changed';
  lineId: string;
  before?: BaselineLine;
  after?: BaselineLine;
  beforeIndex: number;
  afterIndex: number;
  fields: string[];
}

export interface IssueDiffEntry {
  issue: BaselineIssue;
  lineNumber: number;
}

export interface BatchDiff {
  lines: LineDiffEntry[];
  addedCount: number;
  removedCount: number;
  changedCount: number;
  ruleChanges: string[];
  newIssues: IssueDiffEntry[];
  resolvedIssues: IssueDiffEntry[];
  hasChanges: boolean;
}

function lineNumberOf(content: BatchContent, lineId: string): number {
  const index = content.lines.findIndex((line) => line.id === lineId);
  return index >= 0 ? index + 1 : 0;
}

function ruleSetName(content: BatchContent, ruleSetId: string): string {
  return content.ruleSets.find((ruleSet) => ruleSet.id === ruleSetId)?.name ?? '未知规则集';
}

function hyphenLabel(mode: RuleSet['hyphenMode']): string {
  return mode === 'cross-line' ? '跨行连接' : '行内保留';
}

function diffRuleSets(before: BatchContent, after: BatchContent): string[] {
  const changes: string[] = [];

  if (before.activeRuleSetId !== after.activeRuleSetId) {
    changes.push(`切换规则集：${ruleSetName(before, before.activeRuleSetId)} → ${ruleSetName(after, after.activeRuleSetId)}`);
  }

  for (const afterSet of after.ruleSets) {
    const beforeSet = before.ruleSets.find((ruleSet) => ruleSet.id === afterSet.id);
    if (!beforeSet) {
      changes.push(`新增规则集「${afterSet.name}」`);
      continue;
    }
    if (beforeSet.contractions !== afterSet.contractions) {
      changes.push(`${afterSet.name}：${afterSet.contractions ? '启用' : '关闭'}缩写`);
    }
    if (beforeSet.hyphenMode !== afterSet.hyphenMode) {
      changes.push(`${afterSet.name}：连字符 ${hyphenLabel(beforeSet.hyphenMode)} → ${hyphenLabel(afterSet.hyphenMode)}`);
    }
    const beforeRules = new Map(beforeSet.rules.map((rule) => [rule.id, rule]));
    for (const rule of afterSet.rules) {
      const previous = beforeRules.get(rule.id);
      if (!previous) {
        changes.push(`${afterSet.name}：新增规则 “${rule.source}” → ${rule.output}`);
        continue;
      }
      const parts: string[] = [];
      if (previous.source !== rule.source) parts.push(`原文 “${previous.source}” → “${rule.source}”`);
      if (previous.output !== rule.output) parts.push(`输出 ${previous.output} → ${rule.output}`);
      if (previous.enabled !== rule.enabled) parts.push(rule.enabled ? '启用' : '停用');
      if (previous.suspicious !== rule.suspicious) parts.push(rule.suspicious ? '标记可疑' : '取消可疑');
      if (parts.length > 0) changes.push(`${afterSet.name} · “${rule.source}”：${parts.join('，')}`);
    }
    for (const rule of beforeSet.rules) {
      if (!afterSet.rules.some((item) => item.id === rule.id)) {
        changes.push(`${afterSet.name}：删除规则 “${rule.source}”`);
      }
    }
  }

  for (const beforeSet of before.ruleSets) {
    if (!after.ruleSets.some((ruleSet) => ruleSet.id === beforeSet.id)) {
      changes.push(`移除规则集「${beforeSet.name}」`);
    }
  }

  return changes;
}

/** 逐行比较两份内容：before 通常是批次起点，after 是某次记录或当前稿。 */
export function diffBatchContent(before: BatchContent, after: BatchContent): BatchDiff {
  const lines: LineDiffEntry[] = [];
  const afterById = new Map(after.lines.map((line, index) => [line.id, { line, index }]));
  const beforeIds = new Set(before.lines.map((line) => line.id));

  before.lines.forEach((line, beforeIndex) => {
    const match = afterById.get(line.id);
    if (!match) {
      lines.push({ kind: 'removed', lineId: line.id, before: line, beforeIndex, afterIndex: -1, fields: [] });
      return;
    }
    const fields: string[] = [];
    if (match.line.source !== line.source) fields.push('原文');
    if (match.line.status !== line.status) fields.push('状态');
    if (match.line.note !== line.note) fields.push('备注');
    if (fields.length > 0) {
      lines.push({ kind: 'changed', lineId: line.id, before: line, after: match.line, beforeIndex, afterIndex: match.index, fields });
    }
  });

  after.lines.forEach((line, afterIndex) => {
    if (!beforeIds.has(line.id)) {
      lines.push({ kind: 'added', lineId: line.id, after: line, beforeIndex: -1, afterIndex, fields: [] });
    }
  });

  lines.sort((a, b) => Math.max(a.beforeIndex, a.afterIndex) - Math.max(b.beforeIndex, b.afterIndex));

  const beforeIssueKeys = new Set(before.openIssues.map((issue) => issue.key));
  const afterIssueKeys = new Set(after.openIssues.map((issue) => issue.key));
  const newIssues = after.openIssues
    .filter((issue) => !beforeIssueKeys.has(issue.key))
    .map((issue) => ({ issue, lineNumber: lineNumberOf(after, issue.lineId) }));
  const resolvedIssues = before.openIssues
    .filter((issue) => !afterIssueKeys.has(issue.key))
    .map((issue) => ({ issue, lineNumber: lineNumberOf(before, issue.lineId) }));

  const ruleChanges = diffRuleSets(before, after);
  const addedCount = lines.filter((entry) => entry.kind === 'added').length;
  const removedCount = lines.filter((entry) => entry.kind === 'removed').length;
  const changedCount = lines.filter((entry) => entry.kind === 'changed').length;

  return {
    lines,
    addedCount,
    removedCount,
    changedCount,
    ruleChanges,
    newIssues,
    resolvedIssues,
    hasChanges: lines.length > 0 || ruleChanges.length > 0 || newIssues.length > 0 || resolvedIssues.length > 0,
  };
}
