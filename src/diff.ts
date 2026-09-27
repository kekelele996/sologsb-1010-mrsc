import type {
  BatchSnapshot,
  IssueDiff,
  IssueDiffEntry,
  LineDiffEntry,
  LineStatus,
  ProjectState,
  ProofIssue,
  RuleDiffEntry,
  RuleSet,
  SnapshotDiff,
  TextbookLine,
} from './types';

/** 保留恢复和逐行比较所需的内容：课文、规则集和问题。 */
export function takeSnapshot(state: ProjectState): BatchSnapshot {
  return structuredClone({
    title: state.title,
    author: state.author,
    activeRuleSetId: state.activeRuleSetId,
    ruleSets: state.ruleSets,
    lines: state.lines,
    issues: state.issues,
  });
}

export const STATUS_LABELS: Record<LineStatus, string> = {
  unchecked: '未校对',
  reviewed: '已校对',
  questionable: '待核对',
  approved: '已批准',
};

/** 问题按所在行、类型和描述配对；分析后问题 id 会重建，不能直接拿 id 比较。 */
function issueFingerprint(issue: ProofIssue): string {
  return `${issue.lineId}|${issue.code}|${issue.message}`;
}

function diffLines(before: TextbookLine[], after: TextbookLine[]): LineDiffEntry[] {
  const afterMap = new Map(after.map((line, index) => [line.id, { line, index }]));
  const entries: LineDiffEntry[] = [];
  const seen = new Set<string>();

  before.forEach((line, beforeIndex) => {
    seen.add(line.id);
    const match = afterMap.get(line.id);
    if (!match) {
      entries.push({ lineId: line.id, kind: 'removed', before: line, beforeIndex, afterIndex: -1, changes: [] });
      return;
    }

    const other = match.line;
    const sourceChanged = line.source !== other.source;
    const changes: string[] = [];
    if (sourceChanged) changes.push('原文');
    if (line.status !== other.status) {
      changes.push(`状态：${STATUS_LABELS[line.status]} → ${STATUS_LABELS[other.status]}`);
    }
    if (line.note !== other.note) changes.push('备注已更新');

    entries.push({
      lineId: line.id,
      kind: changes.length > 0 ? 'changed' : 'unchanged',
      before: line,
      after: other,
      beforeIndex,
      afterIndex: match.index,
      changes,
    });
  });

  after.forEach((line, afterIndex) => {
    if (seen.has(line.id)) return;
    entries.push({ lineId: line.id, kind: 'added', after: line, beforeIndex: -1, afterIndex, changes: [] });
  });

  return entries;
}

function lineIndexOf(lines: TextbookLine[], lineId: string): number {
  return lines.findIndex((line) => line.id === lineId);
}

function diffIssues(before: BatchSnapshot, after: BatchSnapshot): IssueDiff {
  const openBefore = before.issues.filter((issue) => !issue.resolved);
  const openAfter = after.issues.filter((issue) => !issue.resolved);
  const beforePrints = new Set(openBefore.map(issueFingerprint));
  const afterPrints = new Set(openAfter.map(issueFingerprint));

  const toEntry = (snapshot: BatchSnapshot) => (issue: ProofIssue): IssueDiffEntry => ({
    issue,
    lineIndex: lineIndexOf(snapshot.lines, issue.lineId),
  });

  return {
    appeared: openAfter.filter((issue) => !beforePrints.has(issueFingerprint(issue))).map(toEntry(after)),
    resolved: openBefore.filter((issue) => !afterPrints.has(issueFingerprint(issue))).map(toEntry(before)),
    carried: openAfter.filter((issue) => beforePrints.has(issueFingerprint(issue))).map(toEntry(after)),
  };
}

function describeRuleChange(before: { source: string; output: string; enabled: boolean; suspicious: boolean }, after: typeof before): string {
  const parts: string[] = [];
  if (before.source !== after.source) parts.push(`原文 ${before.source} → ${after.source}`);
  if (before.output !== after.output) parts.push(`输出 ${before.output} → ${after.output}`);
  if (before.enabled !== after.enabled) parts.push(after.enabled ? '已重新启用' : '已停用');
  if (before.suspicious !== after.suspicious) parts.push(after.suspicious ? '标记为可疑' : '取消可疑标记');
  return parts.join('，');
}

function diffRuleSets(
  before: BatchSnapshot,
  after: BatchSnapshot,
): { rules: RuleDiffEntry[]; settingChanges: string[] } {
  const rules: RuleDiffEntry[] = [];
  const settingChanges: string[] = [];
  const beforeSets = new Map(before.ruleSets.map((set) => [set.id, set]));
  const afterSets = new Map(after.ruleSets.map((set) => [set.id, set]));

  if (before.activeRuleSetId !== after.activeRuleSetId) {
    const from = beforeSets.get(before.activeRuleSetId)?.name ?? before.activeRuleSetId;
    const to = afterSets.get(after.activeRuleSetId)?.name ?? after.activeRuleSetId;
    settingChanges.push(`当前规则集：${from} → ${to}`);
  }

  for (const [id, beforeSet] of beforeSets) {
    const afterSet = afterSets.get(id);
    if (!afterSet) {
      settingChanges.push(`规则集「${beforeSet.name}」已移除`);
      continue;
    }

    if (beforeSet.contractions !== afterSet.contractions) {
      settingChanges.push(`「${beforeSet.name}」缩写：${beforeSet.contractions ? '开' : '关'} → ${afterSet.contractions ? '开' : '关'}`);
    }
    if (beforeSet.hyphenMode !== afterSet.hyphenMode) {
      const hyphenLabel = (set: RuleSet) => (set.hyphenMode === 'cross-line' ? '跨行连接' : '行内处理');
      settingChanges.push(`「${beforeSet.name}」连字符：${hyphenLabel(beforeSet)} → ${hyphenLabel(afterSet)}`);
    }

    const afterRules = new Map(afterSet.rules.map((rule) => [rule.id, rule]));
    for (const rule of beforeSet.rules) {
      const next = afterRules.get(rule.id);
      if (!next) {
        rules.push({ ruleSetName: beforeSet.name, kind: 'removed', label: rule.source, detail: `移除规则「${rule.source} → ${rule.output}」` });
        continue;
      }
      const detail = describeRuleChange(rule, next);
      if (detail) {
        rules.push({ ruleSetName: beforeSet.name, kind: 'changed', label: next.source, detail });
      }
    }
    for (const rule of afterSet.rules) {
      if (!beforeSet.rules.some((existing) => existing.id === rule.id)) {
        rules.push({ ruleSetName: afterSet.name, kind: 'added', label: rule.source, detail: `新增规则「${rule.source} → ${rule.output}」` });
      }
    }
  }

  for (const [id, afterSet] of afterSets) {
    if (!beforeSets.has(id)) settingChanges.push(`新增规则集「${afterSet.name}」`);
  }

  return { rules, settingChanges };
}

/** 比较两个快照，按行给出新增、缺失和变化，并区分新出现与已处理的问题。 */
export function diffSnapshots(before: BatchSnapshot, after: BatchSnapshot): SnapshotDiff {
  const lines = diffLines(before.lines, after.lines);
  const { rules, settingChanges } = diffRuleSets(before, after);
  const issues: IssueDiff = diffIssues(before, after);

  const hasChanges =
    lines.some((entry) => entry.kind !== 'unchanged') ||
    rules.length > 0 ||
    settingChanges.length > 0 ||
    issues.appeared.length > 0 ||
    issues.resolved.length > 0;

  return { lines, rules, settingChanges, issues, hasChanges };
}
