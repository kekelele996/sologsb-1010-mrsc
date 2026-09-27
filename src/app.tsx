import { useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { analyzeProject, brailleCellCount, makeRule, outputText, updateRuleInSet } from './braille';
import {
  BATCH_LIMIT,
  RECORD_LIMIT,
  captureBatchContent,
  createBatch,
  createRecord,
  diffBatchContent,
  issueFingerprint,
} from './batches';
import type { BatchDiff, LineDiffEntry } from './batches';
import { createInitialProject } from './sample';
import type { HistoryState, ProofBatch, ProofIssue, ProjectState, TextbookLine } from './types';

const STORAGE_KEY = 'sologsb-1010-braille-project-v1';
const HISTORY_LIMIT = 60;

type HistoryAction =
  | { type: 'commit'; label: string; update: (state: ProjectState) => ProjectState }
  | { type: 'undo' }
  | { type: 'redo' };

function cloneState(state: ProjectState): ProjectState {
  return structuredClone(state);
}

function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  if (action.type === 'undo') {
    const previous = state.past.at(-1);
    if (!previous) return state;
    return {
      past: state.past.slice(0, -1),
      present: previous,
      future: [state.present, ...state.future].slice(0, HISTORY_LIMIT),
      lastAction: '撤销',
    };
  }

  if (action.type === 'redo') {
    const next = state.future[0];
    if (!next) return state;
    return {
      past: [...state.past, state.present].slice(-HISTORY_LIMIT),
      present: next,
      future: state.future.slice(1),
      lastAction: '重做',
    };
  }

  const next = action.update(cloneState(state.present));
  if (next === state.present) return state;
  return {
    past: [...state.past, state.present].slice(-HISTORY_LIMIT),
    present: next,
    future: [],
    lastAction: action.label,
  };
}

/** 兼容旧版整份快照：把每个旧快照转成只含起点的批次。 */
function migrateProject(parsed: any): ProjectState {
  if (Array.isArray(parsed?.batches)) return parsed as ProjectState;
  const legacyVersions: any[] = Array.isArray(parsed?.versions) ? parsed.versions : [];
  const batches: ProofBatch[] = legacyVersions
    .filter((version) => Array.isArray(version?.snapshot?.lines))
    .map((version) => ({
      id: typeof version.id === 'string' ? version.id : `batch-${Math.random().toString(36).slice(2, 8)}`,
      name: typeof version.name === 'string' ? version.name : '迁移的旧快照',
      createdAt: typeof version.createdAt === 'string' ? version.createdAt : new Date().toISOString(),
      baseline: captureBatchContent(version.snapshot as ProjectState),
      records: [],
    }));
  const { versions: _legacyVersions, ...rest } = parsed ?? {};
  return { ...rest, batches } as ProjectState;
}

function loadInitialState(): ProjectState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return analyzeProject(migrateProject(parsed));
    }
  } catch {
    // 清除损坏草稿并使用内置示例。
  }
  return createInitialProject();
}

function useProject() {
  const [history, dispatch] = useReducer(historyReducer, undefined, () => ({
    past: [],
    present: loadInitialState(),
    future: [],
    lastAction: '已恢复本地草稿',
  }));

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history.present));
  }, [history.present]);

  const commit = (label: string, update: (state: ProjectState) => ProjectState) => dispatch({ type: 'commit', label, update });
  const undo = () => dispatch({ type: 'undo' });
  const redo = () => dispatch({ type: 'redo' });

  return { state: history.present, history, commit, undo, redo };
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

function issueLabel(issue: ProofIssue): string {
  if (issue.severity === 'error') return '阻断';
  if (issue.severity === 'warning') return '可疑';
  return '建议';
}

function Section({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function RuleSetPanel({
  state,
  onSelect,
  onUpdateRule,
  onToggleContractions,
  onAddRule,
  onRecheck,
}: {
  state: ProjectState;
  onSelect: (id: string) => void;
  onUpdateRule: (ruleId: string, patch: Record<string, unknown>) => void;
  onToggleContractions: () => void;
  onAddRule: (source: string, output: string, suspicious: boolean) => void;
  onRecheck: () => void;
}) {
  const active = state.ruleSets.find((ruleSet) => ruleSet.id === state.activeRuleSetId) ?? state.ruleSets[0];
  const [showAllRules, setShowAllRules] = useState(false);
  const [newSource, setNewSource] = useState('');
  const [newOutput, setNewOutput] = useState('');
  const [suspicious, setSuspicious] = useState(true);
  const visibleRules = showAllRules ? active.rules : active.rules.filter((rule) => rule.kind === 'contraction' || rule.suspicious);

  return (
    <aside class="left-panel scroll-pane" aria-label="规则集与规则编辑">
      <Section title="规则集" subtitle="切换后会自动重转录全部行">
        <div class="stack-sm">
          {state.ruleSets.map((ruleSet) => (
            <button class={`rule-set-card ${ruleSet.id === active.id ? 'active' : ''}`} key={ruleSet.id} onClick={() => onSelect(ruleSet.id)}>
              <span>
                <strong>{ruleSet.name}</strong>
                <small>{ruleSet.rules.filter((rule) => rule.enabled).length} 条启用规则</small>
              </span>
              <span class="radio-dot" aria-hidden="true" />
            </button>
          ))}
        </div>
      </Section>

      <Section
        title="当前规则"
        subtitle={active.description}
        action={<md-text-button onClick={onRecheck}>重新检查</md-text-button>}
      >
        <div class="inline-controls">
          <md-checkbox checked={active.contractions} onInput={onToggleContractions} label="启用缩写" />
          <md-filled-tonal-button onClick={() => setShowAllRules((value) => !value)}>
            {showAllRules ? '只看常用规则' : '查看全部规则'}
          </md-filled-tonal-button>
        </div>
      </Section>

      <Section title="缩写与标点" subtitle="可疑规则会在校对区生成提醒">
        <div class="rule-list">
          {visibleRules.map((rule) => (
            <div class={`rule-row ${rule.suspicious ? 'suspicious' : ''}`} key={rule.id}>
              <md-checkbox checked={rule.enabled} onInput={() => onUpdateRule(rule.id, { enabled: !rule.enabled })} aria-label={`启用 ${rule.source}`} />
              <md-outlined-text-field
                class="rule-source"
                value={rule.source}
                label="原文"
                onInput={(event: any) => onUpdateRule(rule.id, { source: event.currentTarget.value })}
              />
              <md-outlined-text-field
                class="rule-output"
                value={rule.output}
                label="盲文"
                onInput={(event: any) => onUpdateRule(rule.id, { output: event.currentTarget.value })}
              />
              <md-icon-button
                class={rule.suspicious ? 'warning-button active' : 'warning-button'}
                aria-label={rule.suspicious ? '取消可疑标记' : '标记为可疑'}
                title={rule.suspicious ? '取消可疑标记' : '标记为可疑'}
                onClick={() => onUpdateRule(rule.id, { suspicious: !rule.suspicious })}
              >
                {rule.suspicious ? '!' : '○'}
              </md-icon-button>
            </div>
          ))}
        </div>
      </Section>

      <Section title="新增规则" subtitle="可添加缩写、字母组合或自定义符号">
        <div class="stack-sm">
          <md-outlined-text-field value={newSource} label="原文或组合" onInput={(event: any) => setNewSource(event.currentTarget.value)} />
          <md-outlined-text-field value={newOutput} label="盲文单元" onInput={(event: any) => setNewOutput(event.currentTarget.value)} />
          <md-checkbox checked={suspicious} onInput={() => setSuspicious((value) => !value)} label="标记为可疑规则" />
          <md-filled-button
            disabled={!newSource.trim() || !newOutput.trim()}
            onClick={() => {
              onAddRule(newSource.trim(), newOutput.trim(), suspicious);
              setNewSource('');
              setNewOutput('');
            }}
          >
            添加并检查
          </md-filled-button>
        </div>
      </Section>
    </aside>
  );
}

function LineCard({
  line,
  index,
  selected,
  issues,
  onSelect,
  onChange,
  onNote,
  onStatus,
  onDelete,
}: {
  line: TextbookLine;
  index: number;
  selected: boolean;
  issues: ProofIssue[];
  onSelect: () => void;
  onChange: (source: string) => void;
  onNote: (note: string) => void;
  onStatus: (status: TextbookLine['status']) => void;
  onDelete: () => void;
}) {
  const unresolved = issues.filter((issue) => !issue.resolved);
  const lineIssues = unresolved.filter((issue) => issue.lineId === line.id);

  return (
    <article class={`line-card ${selected ? 'selected' : ''}`} id={`line-card-${line.id}`} onClick={onSelect}>
      <div class="line-gutter">
        <span>{String(index + 1).padStart(2, '0')}</span>
        <span class={`line-status ${line.status}`} title={`状态：${line.status}`} />
      </div>
      <div class="line-body">
        <div class="line-source">
          <textarea
            aria-label={`第 ${index + 1} 行原文`}
            value={line.source}
            rows={Math.max(1, Math.ceil(line.source.length / 52))}
            onFocus={onSelect}
            onInput={(event) => onChange((event.currentTarget as HTMLTextAreaElement).value)}
          />
          <div class="line-actions">
            <md-icon-button aria-label="标记待核对" title="标记待核对" onClick={(event: MouseEvent) => { event.stopPropagation(); onStatus('questionable'); }}>?</md-icon-button>
            <md-icon-button aria-label="标记已校对" title="标记已校对" onClick={(event: MouseEvent) => { event.stopPropagation(); onStatus('reviewed'); }}>✓</md-icon-button>
            <md-icon-button aria-label="批准此行" title="批准此行" onClick={(event: MouseEvent) => { event.stopPropagation(); onStatus('approved'); }}>★</md-icon-button>
            <md-icon-button aria-label="删除此行" title="删除此行" onClick={(event: MouseEvent) => { event.stopPropagation(); onDelete(); }}>×</md-icon-button>
          </div>
        </div>
        <div class="braille-preview" aria-label={`第 ${index + 1} 行盲文预览`}>
          {line.tokens.length === 0 && <span class="empty-preview">空行</span>}
          {line.tokens.map((token) => (
            token.text === ' ' ? <span class="space-token" title="分词空格" /> : (
              <span
                class={`braille-token ${token.suspicious ? 'suspicious' : ''} ${token.braille.includes('⟦') ? 'error' : ''}`}
                title={`${token.text || '标记'} → ${token.braille}`}
              >
                <b>{token.text || '标记'}</b>
                <span>{token.braille}</span>
              </span>
            )
          ))}
        </div>
        {lineIssues.length > 0 && (
          <div class="line-warnings">
            {lineIssues.slice(0, 3).map((item) => (
              <span class={`issue-chip ${item.severity}`} key={item.id}>{issueLabel(item)} · {item.message}</span>
            ))}
          </div>
        )}
        {selected && (
          <md-outlined-text-field
            class="note-field"
            value={line.note}
            label="校对备注"
            onInput={(event: any) => onNote(event.currentTarget.value)}
          />
        )}
      </div>
    </article>
  );
}

function EditorPanel({
  state,
  onSelectLine,
  onChangeLine,
  onNote,
  onStatus,
  onDelete,
  onAddLine,
  onSplitLongLines,
  onImport,
}: {
  state: ProjectState;
  onSelectLine: (id: string) => void;
  onChangeLine: (id: string, source: string) => void;
  onNote: (id: string, note: string) => void;
  onStatus: (id: string, status: TextbookLine['status']) => void;
  onDelete: (id: string) => void;
  onAddLine: () => void;
  onSplitLongLines: () => void;
  onImport: (text: string) => void;
}) {
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');

  return (
    <main class="editor-panel" aria-label="逐行转录校对区">
      <div class="editor-toolbar">
        <div>
          <span class="eyebrow">逐行校对</span>
          <h1>{state.title}</h1>
          <p>{state.author} · {state.lines.length} 行 · {brailleCellCount(state)} 格</p>
        </div>
        <div class="toolbar-actions">
          <md-outlined-button onClick={() => setShowImport((value) => !value)}>导入课文</md-outlined-button>
          <md-outlined-button onClick={onSplitLongLines}>按句拆分</md-outlined-button>
          <md-filled-button onClick={onAddLine}>新增行</md-filled-button>
        </div>
      </div>

      {showImport && (
        <div class="import-strip">
          <md-outlined-text-field
            type="textarea"
            rows={5}
            value={importText}
            label="粘贴课文；换行或句末标点将被拆成行"
            onInput={(event: any) => setImportText(event.currentTarget.value)}
          />
          <div>
            <md-text-button onClick={() => { setImportText(''); setShowImport(false); }}>取消</md-text-button>
            <md-filled-button
              disabled={!importText.trim()}
              onClick={() => {
                onImport(importText);
                setImportText('');
                setShowImport(false);
              }}
            >
              替换并重新转录
            </md-filled-button>
          </div>
        </div>
      )}

      <div class="line-list scroll-pane">
        {state.lines.map((line, index) => (
          <LineCard
            key={line.id}
            line={line}
            index={index}
            selected={state.selectedLineId === line.id}
            issues={state.issues}
            onSelect={() => onSelectLine(line.id)}
            onChange={(source) => onChangeLine(line.id, source)}
            onNote={(note) => onNote(line.id, note)}
            onStatus={(status) => onStatus(line.id, status)}
            onDelete={() => onDelete(line.id)}
          />
        ))}
      </div>
    </main>
  );
}

function IssuesPanel({
  issues,
  lines,
  onJump,
  onResolve,
  onBatchFix,
}: {
  issues: ProofIssue[];
  lines: TextbookLine[];
  onJump: (lineId: string) => void;
  onResolve: (issueId: string) => void;
  onBatchFix: (ruleId: string) => void;
}) {
  const unresolved = issues.filter((issue) => !issue.resolved);
  const grouped = useMemo(() => {
    const map = new Map<string, ProofIssue[]>();
    unresolved.forEach((item) => {
      const key = item.ruleId ? `rule:${item.ruleId}` : `code:${item.code}`;
      map.set(key, [...(map.get(key) ?? []), item]);
    });
    return [...map.entries()];
  }, [unresolved]);

  return (
    <div class="inspector-body">
      {grouped.length === 0 && <div class="empty-state"><span>✓</span><strong>没有未处理问题</strong><p>可以记录版本或导出打印稿。</p></div>}
      {grouped.map(([key, group]) => {
        const lineNumbers = group.map((item) => lines.findIndex((line) => line.id === item.lineId) + 1).join('、');
        return (
          <div class="issue-group" key={key}>
            <div class="issue-group-head">
              <span class={`severity-dot ${group[0].severity}`} />
              <div>
                <strong>{group[0].message}</strong>
                <p>影响第 {lineNumbers} 行 · 共 {group.length} 处</p>
              </div>
            </div>
            <div class="issue-actions">
              <md-text-button onClick={() => onJump(group[0].lineId)}>定位首处</md-text-button>
              {group[0].ruleId && group.length > 1 && (
                <md-filled-tonal-button onClick={() => onBatchFix(group[0].ruleId!)}>停用规则并修正同类</md-filled-tonal-button>
              )}
              {!group[0].ruleId && group.length > 1 && (
                <md-filled-tonal-button onClick={() => group.forEach((item) => onResolve(item.id))}>全部标记已处理</md-filled-tonal-button>
              )}
              <md-icon-button aria-label="标记此项已处理" title="标记已处理" onClick={() => onResolve(group[0].id)}>✓</md-icon-button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RuleDetailPanel({ state, onUpdateRule, onDeleteRule }: { state: ProjectState; onUpdateRule: (id: string, patch: Record<string, unknown>) => void; onDeleteRule: (id: string) => void }) {
  const active = state.ruleSets.find((ruleSet) => ruleSet.id === state.activeRuleSetId) ?? state.ruleSets[0];
  return (
    <div class="inspector-body">
      <div class="rule-summary">
        <strong>{active.name}</strong>
        <p>{active.description}</p>
        <div class="metric-row"><span>{active.rules.filter((rule) => rule.enabled).length} 条启用</span><span>{active.rules.filter((rule) => rule.suspicious).length} 条可疑</span></div>
      </div>
      {active.rules.map((rule) => (
        <div class="rule-detail-card" key={rule.id}>
          <div>
            <strong>{rule.source || '数字符'}</strong>
            <span>{rule.output} · {rule.kind}</span>
            {rule.description && <p>{rule.description}</p>}
          </div>
          <div class="rule-detail-actions">
            <md-checkbox checked={rule.suspicious} onInput={() => onUpdateRule(rule.id, { suspicious: !rule.suspicious })} label="可疑" />
            <md-icon-button aria-label="删除规则" title="删除规则" onClick={() => onDeleteRule(rule.id)}>×</md-icon-button>
          </div>
        </div>
      ))}
    </div>
  );
}

function DiffDetails({
  diff,
  beforeLabel,
  afterLabel,
  newIssuesLabel = '新出现的问题',
  resolvedIssuesLabel = '已处理的问题',
}: {
  diff: BatchDiff;
  beforeLabel: string;
  afterLabel: string;
  newIssuesLabel?: string;
  resolvedIssuesLabel?: string;
}) {
  if (!diff.hasChanges) return <p class="diff-empty">两边内容一致，没有差异。</p>;

  const tagFor = (kind: LineDiffEntry['kind']) => (kind === 'added' ? '新增' : kind === 'removed' ? '缺失' : '变化');
  const lineNoFor = (entry: LineDiffEntry) =>
    entry.kind === 'removed' ? `${beforeLabel}第 ${entry.beforeIndex + 1} 行` : `${afterLabel}第 ${entry.afterIndex + 1} 行`;

  const issueList = (entries: BatchDiff['newIssues'], className: string) => (
    <ul>
      {entries.slice(0, 8).map(({ issue, lineNumber }) => (
        <li class={`diff-issue ${className}`} key={issue.key}>
          <span class={`severity-dot ${issue.severity}`} />
          <span>{lineNumber > 0 ? `第 ${lineNumber} 行` : '已缺失的行'} · {issue.message}</span>
        </li>
      ))}
      {entries.length > 8 && <li class="diff-more">…其余 {entries.length - 8} 条从略</li>}
    </ul>
  );

  return (
    <div class="diff-details">
      {diff.lines.length > 0 && (
        <div class="diff-block">
          <strong>课文行 · 新增 {diff.addedCount} · 缺失 {diff.removedCount} · 变化 {diff.changedCount}</strong>
          <ul>
            {diff.lines.slice(0, 10).map((entry) => (
              <li class={`diff-line ${entry.kind}`} key={entry.lineId}>
                <span class="diff-tag">{tagFor(entry.kind)}</span>
                <div class="diff-line-body">
                  <span class="diff-line-no">
                    {lineNoFor(entry)}
                    {entry.fields.length > 0 && ` · 改了${entry.fields.join('、')}`}
                  </span>
                  {entry.kind !== 'added' && <span class="diff-source">{entry.before?.source.trim() || '（空行）'}</span>}
                  {entry.kind === 'changed' && entry.before?.source !== entry.after?.source && <span class="diff-arrow">→</span>}
                  {entry.kind !== 'removed' && (entry.kind === 'added' || entry.before?.source !== entry.after?.source) && (
                    <span class="diff-source after">{entry.after?.source.trim() || '（空行）'}</span>
                  )}
                </div>
              </li>
            ))}
            {diff.lines.length > 10 && <li class="diff-more">…其余 {diff.lines.length - 10} 行从略</li>}
          </ul>
        </div>
      )}
      {diff.ruleChanges.length > 0 && (
        <div class="diff-block">
          <strong>规则变化（{diff.ruleChanges.length}）</strong>
          <ul>
            {diff.ruleChanges.slice(0, 8).map((change, index) => <li class="diff-rule" key={index}>{change}</li>)}
            {diff.ruleChanges.length > 8 && <li class="diff-more">…其余 {diff.ruleChanges.length - 8} 项从略</li>}
          </ul>
        </div>
      )}
      {diff.newIssues.length > 0 && (
        <div class="diff-block">
          <strong>{newIssuesLabel}（{diff.newIssues.length}）</strong>
          {issueList(diff.newIssues, 'new')}
        </div>
      )}
      {diff.resolvedIssues.length > 0 && (
        <div class="diff-block">
          <strong>{resolvedIssuesLabel}（{diff.resolvedIssues.length}）</strong>
          {issueList(diff.resolvedIssues, 'resolved')}
        </div>
      )}
    </div>
  );
}

function BatchesPanel({
  state,
  onStartBatch,
  onRecord,
  onRestore,
}: {
  state: ProjectState;
  onStartBatch: (name: string) => void;
  onRecord: () => void;
  onRestore: (batch: ProofBatch) => void;
}) {
  const [batchName, setBatchName] = useState('');
  const [previewBatchId, setPreviewBatchId] = useState<string | null>(null);
  const [expandedRecordId, setExpandedRecordId] = useState<string | null>(null);
  const currentContent = useMemo(() => captureBatchContent(state), [state]);
  const latestBatch = state.batches[0];

  return (
    <div class="inspector-body">
      <div class="snapshot-callout batch-start">
        <div>
          <strong>可命名校对批次</strong>
          <p>开始批次时保留当时的课文、规则集和未处理问题；之后每次记录都会与批次起点逐行比较。</p>
        </div>
        <div class="batch-start-form">
          <md-outlined-text-field
            value={batchName}
            label={`批次名称（留空：第 ${state.batches.length + 1} 轮校对）`}
            onInput={(event: any) => setBatchName(event.currentTarget.value)}
          />
          <div class="batch-start-actions">
            <md-filled-button onClick={() => { onStartBatch(batchName); setBatchName(''); }}>开始批次</md-filled-button>
            <md-filled-tonal-button disabled={!latestBatch} title={latestBatch ? `记录到「${latestBatch.name}」` : '先开始一个批次'} onClick={onRecord}>
              记录到当前批次
            </md-filled-tonal-button>
          </div>
          {latestBatch && <p class="batch-current">当前批次：「{latestBatch.name}」 · 已记录 {latestBatch.records.length} 次</p>}
        </div>
      </div>

      {state.batches.length === 0 && (
        <div class="empty-state compact"><strong>还没有校对批次</strong><p>命名并开始一个批次，之后每次记录都会按行给出新增、缺失和变化，并分清新出现与已处理的问题。</p></div>
      )}

      {state.batches.map((batch) => {
        const activeSet = batch.baseline.ruleSets.find((ruleSet) => ruleSet.id === batch.baseline.activeRuleSetId) ?? batch.baseline.ruleSets[0];
        const previewing = previewBatchId === batch.id;
        const previewDiff = previewing ? diffBatchContent(currentContent, batch.baseline) : null;
        return (
          <div class="batch-card" key={batch.id}>
            <div class="batch-head">
              <div>
                <strong>{batch.name}</strong>
                <p>
                  开始于 {formatTime(batch.createdAt)} · {batch.baseline.lines.length} 行 · {batch.baseline.openIssues.length} 个未处理问题
                  {activeSet && ` · ${activeSet.name}（${activeSet.rules.filter((rule) => rule.enabled).length} 条启用）`}
                </p>
              </div>
              <md-text-button onClick={() => setPreviewBatchId(previewing ? null : batch.id)}>
                {previewing ? '收起预览' : '恢复此批次'}
              </md-text-button>
            </div>

            {previewing && previewDiff && (
              <div class="restore-preview">
                <strong>恢复预览：当前稿 → 「{batch.name}」起点</strong>
                {!previewDiff.hasChanges ? (
                  <p class="diff-empty">当前稿与批次起点一致，无需恢复。</p>
                ) : (
                  <>
                    <p class="restore-summary">
                      将影响 {previewDiff.lines.length} 行（补回 {previewDiff.addedCount} · 移除 {previewDiff.removedCount} · 改回 {previewDiff.changedCount}）
                      {previewDiff.ruleChanges.length > 0 && ` · 规则变化 ${previewDiff.ruleChanges.length} 项`}
                      {previewDiff.newIssues.length + previewDiff.resolvedIssues.length > 0 && ` · 问题变化 ${previewDiff.newIssues.length + previewDiff.resolvedIssues.length} 条`}
                    </p>
                    <DiffDetails
                      diff={previewDiff}
                      beforeLabel="当前稿"
                      afterLabel="批次"
                      newIssuesLabel="恢复后重新出现的问题"
                      resolvedIssuesLabel="恢复后不再出现的问题"
                    />
                  </>
                )}
                <div class="restore-actions">
                  <md-text-button onClick={() => setPreviewBatchId(null)}>取消</md-text-button>
                  <md-filled-button disabled={!previewDiff.hasChanges} onClick={() => { onRestore(batch); setPreviewBatchId(null); }}>
                    应用恢复
                  </md-filled-button>
                </div>
              </div>
            )}

            {batch.records.length === 0 && <p class="batch-empty">还没有记录。用上方“记录到当前批次”留下第一条对比。</p>}
            {batch.records.length > 0 && (
              <div class="record-list">
                {batch.records.map((record) => {
                  const diff = diffBatchContent(batch.baseline, record.content);
                  const expanded = expandedRecordId === record.id;
                  return (
                    <div class={`record-item ${record.kind}`} key={record.id}>
                      <div class="record-head">
                        <div>
                          <strong>
                            {record.kind === 'restore' && <span class="restore-badge">恢复</span>}
                            {record.action}
                          </strong>
                          <p>{formatTime(record.createdAt)} · {record.content.lines.length} 行 · {record.content.openIssues.length} 个未处理问题</p>
                        </div>
                        <md-text-button onClick={() => setExpandedRecordId(expanded ? null : record.id)}>
                          {expanded ? '收起' : '查看差异'}
                        </md-text-button>
                      </div>
                      <div class="diff-chips">
                        {!diff.hasChanges && <span class="diff-chip same">与批次起点一致</span>}
                        {diff.addedCount > 0 && <span class="diff-chip added">+{diff.addedCount} 新增行</span>}
                        {diff.removedCount > 0 && <span class="diff-chip removed">−{diff.removedCount} 缺失行</span>}
                        {diff.changedCount > 0 && <span class="diff-chip changed">~{diff.changedCount} 变化行</span>}
                        {diff.newIssues.length > 0 && <span class="diff-chip issue-new">{diff.newIssues.length} 个新出现问题</span>}
                        {diff.resolvedIssues.length > 0 && <span class="diff-chip issue-done">{diff.resolvedIssues.length} 个已处理问题</span>}
                        {diff.ruleChanges.length > 0 && <span class="diff-chip rule">{diff.ruleChanges.length} 项规则变化</span>}
                      </div>
                      {expanded && <DiffDetails diff={diff} beforeLabel="批次" afterLabel="记录" />}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function App() {
  const { state, history, commit, undo, redo } = useProject();
  const [inspectorTab, setInspectorTab] = useState<'issues' | 'rules' | 'batches'>('issues');
  const selectedLineRef = useRef(state.selectedLineId);
  selectedLineRef.current = state.selectedLineId;

  const activeRuleSet = state.ruleSets.find((ruleSet) => ruleSet.id === state.activeRuleSetId) ?? state.ruleSets[0];
  const unresolvedCount = state.issues.filter((issue) => !issue.resolved).length;
  const approvedCount = state.lines.filter((line) => line.status === 'approved').length;
  const progress = state.lines.length ? Math.round((approvedCount / state.lines.length) * 100) : 0;

  const selectLine = (lineId: string, scroll = false) => {
    commit('切换当前行', (current) => ({ ...current, selectedLineId: lineId }));
    if (scroll) requestAnimationFrame(() => document.querySelector(`#line-card-${lineId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  };

  const changeLine = (lineId: string, source: string) => {
    commit('修改课文原文', (current) => analyzeProject({ ...current, lines: current.lines.map((line) => line.id === lineId ? { ...line, source } : line) }));
  };

  const changeStatus = (lineId: string, status: TextbookLine['status']) => {
    commit('更新校对状态', (current) => {
      const lines = current.lines.map((line) => line.id === lineId ? { ...line, status } : line);
      const issues = current.issues.map((item) => item.lineId === lineId && status === 'approved' ? { ...item, resolved: true } : item);
      return { ...current, lines, issues, updatedAt: new Date().toISOString() };
    });
  };

  const navigateLine = (direction: number) => {
    const index = state.lines.findIndex((line) => line.id === selectedLineRef.current);
    const next = state.lines[Math.max(0, Math.min(state.lines.length - 1, index + direction))];
    if (next && next.id !== selectedLineRef.current) selectLine(next.id, true);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      const target = event.target as HTMLElement;
      const editing = /INPUT|TEXTAREA/.test(target.tagName) || target.isContentEditable;
      if (modifier && event.key.toLocaleLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if (modifier && event.key.toLocaleLowerCase() === 's') {
        event.preventDefault();
        recordToBatch('快捷保存');
        return;
      }
      if (modifier && event.key === 'Enter') {
        event.preventDefault();
        changeStatus(selectedLineRef.current, 'approved');
        const index = state.lines.findIndex((line) => line.id === selectedLineRef.current);
        if (state.lines[index + 1]) selectLine(state.lines[index + 1].id, true);
        return;
      }
      if (!editing && (event.key === 'ArrowDown' || event.key === 'j')) {
        event.preventDefault();
        navigateLine(1);
      }
      if (!editing && (event.key === 'ArrowUp' || event.key === 'k')) {
        event.preventDefault();
        navigateLine(-1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const startBatch = (name: string) => {
    commit('开始新批次', (current) => ({
      ...current,
      batches: [createBatch(name.trim() || `第 ${current.batches.length + 1} 轮校对`, current), ...current.batches].slice(0, BATCH_LIMIT),
      updatedAt: new Date().toISOString(),
    }));
  };

  const recordToBatch = (action = '手动记录') => {
    if (state.batches.length === 0) {
      startBatch(action);
      return;
    }
    commit('记录批次进度', (current) => {
      const [latest, ...rest] = current.batches;
      const record = createRecord(action, current);
      return {
        ...current,
        batches: [{ ...latest, records: [record, ...latest.records].slice(0, RECORD_LIMIT) }, ...rest],
        updatedAt: new Date().toISOString(),
      };
    });
  };

  const applyRestore = (batch: ProofBatch) => {
    commit(`恢复批次「${batch.name}」`, (current) => {
      const baseline = batch.baseline;
      const restoredLines: TextbookLine[] = baseline.lines.map((line) => ({
        id: line.id,
        source: line.source,
        tokens: [],
        status: line.status,
        note: line.note,
        continuesPrevious: false,
        continuesNext: false,
      }));
      const analyzed = analyzeProject({
        ...current,
        activeRuleSetId: baseline.activeRuleSetId,
        ruleSets: structuredClone(baseline.ruleSets),
        lines: restoredLines,
        selectedLineId: baseline.lines[0]?.id ?? '',
      });
      // 重新分析会生成全新问题，按批次起点把当时已处理的问题重新标记为已处理。
      const openKeys = new Set(baseline.openIssues.map((issue) => issue.key));
      const issues = analyzed.issues.map((item) => ({ ...item, resolved: !openKeys.has(issueFingerprint(item)) }));
      const restored: ProjectState = { ...analyzed, issues };
      // 恢复行动本身也留痕：作为一条恢复记录追加到原批次下，原批次保留。
      const record = createRecord(`恢复批次「${batch.name}」`, restored, { batchId: batch.id, batchName: batch.name });
      return {
        ...restored,
        batches: restored.batches.map((item) =>
          item.id === batch.id ? { ...item, records: [record, ...item.records].slice(0, RECORD_LIMIT) } : item,
        ),
      };
    });
  };

  const exportText = () => {
    const blob = new Blob([`${state.title}\n规则集：${activeRuleSet.name}\n\n${outputText(state)}\n`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${state.title.replace(/[^\p{L}\p{N}-]+/gu, '-')}-盲文.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const exportPrint = () => {
    const printWindow = window.open('', '_blank', 'width=900,height=1100');
    if (!printWindow) return;
    const rows = state.lines.map((line, index) => `
      <tr><td>${index + 1}</td><td>${line.source.replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[char] ?? char))}</td><td class="braille">${line.tokens.map((token) => token.braille).join('')}</td></tr>
    `).join('');
    printWindow.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${state.title}</title><style>body{font-family:Georgia,serif;color:#111;margin:36px}h1{font-size:22px}table{width:100%;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid #bbb;text-align:left;vertical-align:top}td:first-child{width:36px;color:#666}.braille{font-family:"Apple Braille",sans-serif;font-size:24px}@media print{body{margin:16mm}}</style></head><body><h1>${state.title}</h1><p>${state.author} · ${activeRuleSet.name} · ${new Date().toLocaleDateString('zh-CN')}</p><table><thead><tr><th>#</th><th>原文</th><th>盲文校对稿</th></tr></thead><tbody>${rows}</tbody></table><script>window.onload=()=>setTimeout(()=>window.print(),150)</script></body></html>`);
    printWindow.document.close();
  };

  const updateRule = (ruleId: string, patch: Record<string, unknown>) => {
    commit('修改转录规则', (current) => {
      const ruleSet = current.ruleSets.find((set) => set.id === current.activeRuleSetId) ?? current.ruleSets[0];
      const nextSet = updateRuleInSet(ruleSet, ruleId, patch);
      return analyzeProject({ ...current, ruleSets: current.ruleSets.map((set) => set.id === nextSet.id ? nextSet : set) });
    });
  };

  const batchFixRule = (ruleId: string) => {
    commit('批量修正同类问题', (current) => {
      const ruleSet = current.ruleSets.find((set) => set.id === current.activeRuleSetId) ?? current.ruleSets[0];
      const nextSet = updateRuleInSet(ruleSet, ruleId, { enabled: false });
      return analyzeProject({ ...current, ruleSets: current.ruleSets.map((set) => set.id === nextSet.id ? nextSet : set) });
    });
  };

  const importCourse = (text: string) => {
    const sourceLines = text
      .replace(/\r/g, '')
      .split(/\n+|(?<=[.!?。！？])\s+/)
      .map((line) => line.trim())
      .filter(Boolean);
    commit('导入课文', (current) => analyzeProject({
      ...current,
      lines: sourceLines.map((source, index) => ({ id: `line-import-${Date.now()}-${index}`, source, tokens: [], status: index === 0 ? 'questionable' : 'unchecked', note: index === 0 ? '导入后待确认规则集。' : '', continuesPrevious: false, continuesNext: false })),
      selectedLineId: '',
      issues: [],
    }));
  };

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true">⠿</div>
          <div><strong>BrailleAtelier</strong><span>盲文教材转录与校对工具</span></div>
        </div>
        <div class="topbar-center">
          <span class={`connection-dot ${navigator.onLine ? 'online' : ''}`} />
          {navigator.onLine ? '浏览器本地保存' : '离线模式 · 本地保存可继续'}
          <small>上次自动保存 {formatTime(state.updatedAt)}</small>
        </div>
        <div class="topbar-actions">
          <md-icon-button onClick={undo} disabled={history.past.length === 0} aria-label="撤销" title="撤销 ⌘Z">↶</md-icon-button>
          <md-icon-button onClick={redo} disabled={history.future.length === 0} aria-label="重做" title="重做 ⇧⌘Z">↷</md-icon-button>
          <md-outlined-button onClick={exportText}>导出文本</md-outlined-button>
          <md-filled-button onClick={exportPrint}>打印版导出</md-filled-button>
        </div>
      </header>

      <div class="status-ribbon">
        <div class="progress-block">
          <div><strong>{progress}%</strong><span>已批准 {approvedCount}/{state.lines.length} 行</span></div>
          <md-linear-progress value={progress / 100} aria-label="校对进度" />
        </div>
        <div class="status-stat warning"><strong>{unresolvedCount}</strong><span>未处理问题</span></div>
        <div class="status-stat"><strong>{state.lines.filter((line) => line.status === 'questionable').length}</strong><span>待核对行</span></div>
        <div class="status-stat"><strong>{activeRuleSet.rules.filter((rule) => rule.enabled).length}</strong><span>启用规则</span></div>
        <div class="shortcut-hint">快捷键：⌘/Ctrl Z 撤销 · ⇧⌘/Ctrl Z 重做 · ⌘/Ctrl Enter 批准并下一行 · J/K 切换行</div>
      </div>

      <div class="workspace-grid">
        <RuleSetPanel
          state={state}
          onSelect={(id) => commit('切换规则集并重新检查', (current) => analyzeProject({ ...current, activeRuleSetId: id, issues: [] }))}
          onUpdateRule={updateRule}
          onToggleContractions={() => {
            const ruleSet = activeRuleSet;
            commit('切换缩写规则', (current) => analyzeProject({ ...current, ruleSets: current.ruleSets.map((set) => set.id === ruleSet.id ? { ...set, contractions: !set.contractions } : set) }));
          }}
          onAddRule={(source, output, suspicious) => {
            commit('新增转写规则', (current) => analyzeProject({
              ...current,
              ruleSets: current.ruleSets.map((set) => set.id === current.activeRuleSetId ? { ...set, rules: [...set.rules, makeRule(source, output, suspicious)] } : set),
            }));
          }}
          onRecheck={() => commit('重新检查全部内容', analyzeProject)}
        />

        <EditorPanel
          state={state}
          onSelectLine={selectLine}
          onChangeLine={changeLine}
          onNote={(lineId, note) => commit('添加校对备注', (current) => ({ ...current, lines: current.lines.map((line) => line.id === lineId ? { ...line, note } : line) }))}
          onStatus={changeStatus}
          onDelete={(lineId) => commit('删除课文行', (current) => {
            const lines = current.lines.filter((line) => line.id !== lineId);
            return analyzeProject({ ...current, lines: lines.length ? lines : [{ id: `line-${Date.now()}`, source: '', tokens: [], status: 'unchecked', note: '', continuesPrevious: false, continuesNext: false }], selectedLineId: lines[0]?.id ?? '' });
          })}
          onAddLine={() => commit('新增课文行', (current) => {
            const line: TextbookLine = { id: `line-${Date.now()}`, source: '', tokens: [], status: 'unchecked', note: '', continuesPrevious: false, continuesNext: false };
            return analyzeProject({ ...current, lines: [...current.lines, line], selectedLineId: line.id });
          })}
          onSplitLongLines={() => commit('按句拆分长行', (current) => {
            const lines = current.lines.flatMap((line) => line.source
              .split(/(?<=[.!?。！？])\s+|;\s*/)
              .filter((part) => part.trim())
              .map((source, index) => ({ ...line, id: index === 0 ? line.id : `line-split-${Date.now()}-${index}`, source: source.trim(), tokens: [], note: index === 0 ? line.note : '' })));
            return analyzeProject({ ...current, lines });
          })}
          onImport={importCourse}
        />

        <aside class="right-panel">
          <div class="inspector-tabs" role="tablist">
            <button class={inspectorTab === 'issues' ? 'active' : ''} onClick={() => setInspectorTab('issues')}>问题 {unresolvedCount > 0 && <span>{unresolvedCount}</span>}</button>
            <button class={inspectorTab === 'rules' ? 'active' : ''} onClick={() => setInspectorTab('rules')}>规则详情</button>
            <button class={inspectorTab === 'batches' ? 'active' : ''} onClick={() => setInspectorTab('batches')}>批次 {state.batches.length > 0 && <span>{state.batches.length}</span>}</button>
          </div>
          {inspectorTab === 'issues' && (
            <IssuesPanel
              issues={state.issues}
              lines={state.lines}
              onJump={(lineId) => selectLine(lineId, true)}
              onResolve={(issueId) => commit('标记问题已处理', (current) => ({ ...current, issues: current.issues.map((item) => item.id === issueId ? { ...item, resolved: true } : item) }))}
              onBatchFix={batchFixRule}
            />
          )}
          {inspectorTab === 'rules' && <RuleDetailPanel state={state} onUpdateRule={updateRule} onDeleteRule={(ruleId) => {
            commit('删除转录规则', (current) => analyzeProject({
              ...current,
              ruleSets: current.ruleSets.map((set) => set.id === current.activeRuleSetId ? { ...set, rules: set.rules.filter((rule) => rule.id !== ruleId) } : set),
            }));
          }} />}
          {inspectorTab === 'batches' && <BatchesPanel state={state} onStartBatch={startBatch} onRecord={() => recordToBatch()} onRestore={applyRestore} />}
        </aside>
      </div>
    </div>
  );
}
