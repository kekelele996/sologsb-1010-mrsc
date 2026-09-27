import { useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { analyzeProject, brailleCellCount, makeRule, outputText, uid, updateRuleInSet } from './braille';
import { diffSnapshots, takeSnapshot } from './diff';
import { createInitialProject } from './sample';
import type {
  BatchEvent,
  BatchSnapshot,
  HistoryState,
  ProofIssue,
  ProofreadingBatch,
  ProjectState,
  SnapshotDiff,
  TextbookLine,
} from './types';

const STORAGE_KEY = 'sologsb-1010-braille-project-v1';
const HISTORY_LIMIT = 60;
const MAX_BATCHES = 20;
const MAX_EVENTS_PER_BATCH = 30;

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

interface LegacyVersionSnapshot {
  id?: string;
  name?: string;
  createdAt?: string;
  action?: string;
  snapshot?: Record<string, unknown>;
}

/** 从旧版本（或当前状态）中挑出批次快照需要的字段。 */
function pickBatchSnapshot(source?: Record<string, unknown>): BatchSnapshot {
  const value = source ?? {};
  return {
    title: typeof value.title === 'string' ? value.title : '',
    author: typeof value.author === 'string' ? value.author : '',
    activeRuleSetId: typeof value.activeRuleSetId === 'string' ? value.activeRuleSetId : '',
    ruleSets: Array.isArray(value.ruleSets) ? value.ruleSets : [],
    lines: Array.isArray(value.lines) ? value.lines : [],
    issues: Array.isArray(value.issues) ? value.issues : [],
  } as BatchSnapshot;
}

/** 旧的“版本快照”迁移成一个名为“迁移的历史版本”的校对批次，最旧快照作为基线。 */
function migrateProject(parsed: unknown): ProjectState {
  const candidate = parsed as Partial<ProjectState> & { versions?: LegacyVersionSnapshot[] } | null;
  if (candidate && Array.isArray(candidate.batches) && typeof candidate.activeBatchId === 'string') {
    return candidate as ProjectState;
  }

  const { versions, ...rest } = candidate ?? {};
  const ordered = [...(Array.isArray(versions) ? versions : [])].reverse();
  const batches: ProofreadingBatch[] = [];
  if (ordered.length > 0) {
    batches.push({
      id: uid('batch-legacy'),
      name: '迁移的历史版本',
      createdAt: ordered[0].createdAt ?? new Date().toISOString(),
      baseline: pickBatchSnapshot(ordered[0].snapshot),
      events: ordered.map((version, index) => ({
        id: version.id ?? `legacy-event-${index}`,
        name: version.name ?? `历史版本 ${index + 1}`,
        kind: 'record',
        createdAt: version.createdAt ?? new Date().toISOString(),
        action: version.action ?? '历史版本',
        note: '',
        snapshot: pickBatchSnapshot(version.snapshot),
      })),
    });
  }

  return { ...(rest as ProjectState), batches, activeBatchId: batches[0]?.id ?? '' };
}

function loadInitialState(): ProjectState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ProjectState;
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
      {grouped.length === 0 && <div class="empty-state"><span>✓</span><strong>没有未处理问题</strong><p>可以记录校对批次或导出打印稿。</p></div>}
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

function DiffBlock({
  diff,
  heading,
  emptyText,
  appearedLabel = '新出现',
  resolvedLabel = '已处理',
}: {
  diff: SnapshotDiff;
  heading: string;
  emptyText: string;
  appearedLabel?: string;
  resolvedLabel?: string;
}) {
  const lineChanges = diff.lines.filter((entry) => entry.kind !== 'unchanged');
  const { appeared, resolved, carried } = diff.issues;
  const lineSource = (line?: TextbookLine) => (line && line.source.trim() ? line.source : '（空行）');

  return (
    <div class="diff-block">
      <strong class="diff-heading">{heading}</strong>
      {!diff.hasChanges && <p class="diff-empty">{emptyText}</p>}

      {lineChanges.length > 0 && (
        <div class="diff-group">
          <span class="diff-group-title">课文行 · {lineChanges.length}</span>
          {lineChanges.map((entry) => (
            <div class={`diff-line ${entry.kind}`} key={entry.lineId}>
              <span class="diff-tag">{entry.kind === 'added' ? '新增' : entry.kind === 'removed' ? '缺失' : '变化'}</span>
              <div class="diff-line-body">
                {entry.kind === 'added' && <p>第 {entry.afterIndex + 1} 行 · {lineSource(entry.after)}</p>}
                {entry.kind === 'removed' && <p>第 {entry.beforeIndex + 1} 行 · {lineSource(entry.before)}</p>}
                {entry.kind === 'changed' && entry.before!.source !== entry.after!.source ? (
                  <>
                    <p><s>第 {entry.beforeIndex + 1} 行 · {lineSource(entry.before)}</s></p>
                    <p>第 {entry.afterIndex + 1} 行 · {lineSource(entry.after)}</p>
                  </>
                ) : entry.kind === 'changed' ? (
                  <p>第 {entry.afterIndex + 1} 行 · {lineSource(entry.after)}</p>
                ) : null}
                {entry.changes.filter((change) => change !== '原文').length > 0 && (
                  <small>{entry.changes.filter((change) => change !== '原文').join('；')}</small>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {(diff.rules.length > 0 || diff.settingChanges.length > 0) && (
        <div class="diff-group">
          <span class="diff-group-title">规则集与规则 · {diff.rules.length + diff.settingChanges.length}</span>
          {diff.settingChanges.map((text) => <p class="diff-setting" key={text}>{text}</p>)}
          {diff.rules.map((entry, index) => (
            <p class="diff-setting" key={`${entry.ruleSetName}-${entry.label}-${index}`}>「{entry.ruleSetName}」{entry.detail}</p>
          ))}
        </div>
      )}

      {(appeared.length > 0 || resolved.length > 0 || carried.length > 0) && (
        <div class="diff-group">
          <span class="diff-group-title">问题</span>
          {appeared.map(({ issue, lineIndex }) => (
            <p class="diff-issue appeared" key={`appeared-${issue.id}`}>
              <span class={`severity-dot ${issue.severity}`} />{appearedLabel} · 第 {lineIndex + 1} 行 · {issue.message}
            </p>
          ))}
          {resolved.map(({ issue, lineIndex }) => (
            <p class="diff-issue resolved" key={`resolved-${issue.id}`}>
              <span class={`severity-dot ${issue.severity}`} />{resolvedLabel} · 第 {lineIndex + 1} 行 · {issue.message}
            </p>
          ))}
          {carried.length > 0 && <p class="diff-carried">仍待处理 {carried.length} 个，与基线一致</p>}
        </div>
      )}
    </div>
  );
}

interface RestoreTarget {
  batchId: string;
  eventId: string;
}

function BatchEventItem({
  batch,
  event,
  expanded,
  restoring,
  currentSnapshot,
  onToggle,
  onPreviewRestore,
  onCancelRestore,
  onApplyRestore,
}: {
  batch: ProofreadingBatch;
  event: BatchEvent;
  expanded: boolean;
  restoring: boolean;
  currentSnapshot: BatchSnapshot;
  onToggle: () => void;
  onPreviewRestore: () => void;
  onCancelRestore: () => void;
  onApplyRestore: () => void;
}) {
  const baselineDiff = useMemo(
    () => (expanded ? diffSnapshots(batch.baseline, event.snapshot) : null),
    [expanded, batch.baseline, event.snapshot],
  );
  const restoreDiff = useMemo(
    () => (restoring ? diffSnapshots(currentSnapshot, event.snapshot) : null),
    [restoring, currentSnapshot, event.snapshot],
  );
  const openCount = event.snapshot.issues.filter((issue) => !issue.resolved).length;

  return (
    <div class={`batch-event ${event.kind}`}>
      <div class="batch-event-head">
        <span class={`event-kind ${event.kind}`}>{event.kind === 'restore' ? '恢复' : '记录'}</span>
        <div class="batch-event-info">
          <strong>{event.name}</strong>
          <p>{event.action} · {formatTime(event.createdAt)}</p>
          <p>{event.snapshot.lines.length} 行 · {openCount} 个未处理问题</p>
          {event.restoredFrom && (
            <p class="restore-ref">内容恢复自「{event.restoredFrom.batchName} · {event.restoredFrom.eventName}」；此处保留恢复前的稿件。</p>
          )}
        </div>
        <div class="batch-event-actions">
          <md-text-button onClick={onToggle}>{expanded ? '收起' : '对比'}</md-text-button>
          <md-text-button onClick={onPreviewRestore}>恢复</md-text-button>
        </div>
      </div>

      {baselineDiff && (
        <DiffBlock
          diff={baselineDiff}
          heading="相对批次起点的变化"
          emptyText="与批次起点相比，原文、规则和问题都没有变化。"
          appearedLabel="新出现"
          resolvedLabel="已处理"
        />
      )}

      {restoreDiff && (
        <div class="restore-preview">
          <strong class="diff-heading">恢复预览 · 应用后当前稿将回到「{event.name}」的内容</strong>
          <DiffBlock
            diff={restoreDiff}
            heading="相对当前稿，将受影响的内容"
            emptyText="当前稿与该记录一致，恢复不会改变任何内容。"
            appearedLabel="恢复后出现"
            resolvedLabel="恢复后不再出现"
          />
          <div class="restore-actions">
            <md-text-button onClick={onCancelRestore}>取消</md-text-button>
            <md-filled-button onClick={onApplyRestore}>应用恢复</md-filled-button>
          </div>
        </div>
      )}
    </div>
  );
}

function BatchCard({
  batch,
  active,
  currentSnapshot,
  restoreTarget,
  expandedEventId,
  onToggleEvent,
  onPreviewRestore,
  onCancelRestore,
  onApplyRestore,
  onRename,
  onDelete,
  onRecord,
}: {
  batch: ProofreadingBatch;
  active: boolean;
  currentSnapshot: BatchSnapshot;
  restoreTarget: RestoreTarget | null;
  expandedEventId: string | null;
  onToggleEvent: (eventId: string) => void;
  onPreviewRestore: (target: RestoreTarget) => void;
  onCancelRestore: () => void;
  onApplyRestore: (target: RestoreTarget) => void;
  onRename: (batchId: string, name: string) => void;
  onDelete: (batchId: string) => void;
  onRecord: () => void;
}) {
  const baselineOpen = batch.baseline.issues.filter((issue) => !issue.resolved).length;

  return (
    <div class={`batch-card ${active ? 'active' : ''}`}>
      <div class="batch-card-head">
        <input
          class="batch-name"
          value={batch.name}
          aria-label="批次名称"
          onInput={(event) => onRename(batch.id, (event.currentTarget as HTMLInputElement).value)}
        />
        {active && <span class="batch-active-tag">当前批次</span>}
        <md-icon-button aria-label="删除批次" title="删除批次" onClick={() => onDelete(batch.id)}>×</md-icon-button>
      </div>
      <p class="batch-meta">
        开始于 {formatTime(batch.createdAt)} · 起点 {batch.baseline.lines.length} 行 / {baselineOpen} 个未处理问题 · {batch.events.length} 条记录
      </p>
      {active && (
        <md-filled-tonal-button class="record-button" onClick={onRecord}>记录校对（与起点对比）</md-filled-tonal-button>
      )}

      <div class="batch-events">
        {batch.events.length === 0 && (
          <p class="batch-empty">还没有记录。完成一段校对后点击“记录校对”，即可看到相对起点的逐行变化。</p>
        )}
        {batch.events.map((event) => (
          <BatchEventItem
            key={event.id}
            batch={batch}
            event={event}
            expanded={expandedEventId === event.id}
            restoring={restoreTarget?.batchId === batch.id && restoreTarget.eventId === event.id}
            currentSnapshot={currentSnapshot}
            onToggle={() => onToggleEvent(event.id)}
            onPreviewRestore={() => onPreviewRestore({ batchId: batch.id, eventId: event.id })}
            onCancelRestore={onCancelRestore}
            onApplyRestore={() => onApplyRestore({ batchId: batch.id, eventId: event.id })}
          />
        ))}
      </div>
    </div>
  );
}

function BatchesPanel({
  state,
  currentSnapshot,
  onStartBatch,
  onRecord,
  onRenameBatch,
  onDeleteBatch,
  onApplyRestore,
}: {
  state: ProjectState;
  currentSnapshot: BatchSnapshot;
  onStartBatch: () => void;
  onRecord: () => void;
  onRenameBatch: (batchId: string, name: string) => void;
  onDeleteBatch: (batchId: string) => void;
  onApplyRestore: (target: RestoreTarget) => void;
}) {
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<RestoreTarget | null>(null);

  return (
    <div class="inspector-body">
      <div class="snapshot-callout">
        <div>
          <strong>校对批次</strong>
          <p>开始批次时保留当时的课文、规则集和未处理问题；之后每次记录都与批次起点逐行对比，分清新出现与已处理的问题。</p>
        </div>
        <md-filled-button onClick={onStartBatch}>开始新批次</md-filled-button>
      </div>

      {state.batches.length === 0 && (
        <div class="empty-state compact">
          <strong>还没有校对批次</strong>
          <p>开始一个可命名的批次后，每次记录都能看清这轮动了哪些原文、规则和问题。</p>
        </div>
      )}

      {state.batches.map((batch) => (
        <BatchCard
          key={batch.id}
          batch={batch}
          active={batch.id === state.activeBatchId}
          currentSnapshot={currentSnapshot}
          restoreTarget={restoreTarget}
          expandedEventId={expandedEventId}
          onToggleEvent={(eventId) => setExpandedEventId((current) => (current === eventId ? null : eventId))}
          onPreviewRestore={setRestoreTarget}
          onCancelRestore={() => setRestoreTarget(null)}
          onApplyRestore={(target) => {
            onApplyRestore(target);
            setRestoreTarget(null);
          }}
          onRename={onRenameBatch}
          onDelete={onDeleteBatch}
          onRecord={onRecord}
        />
      ))}
    </div>
  );
}

export default function App() {
  const { state, history, commit, undo, redo } = useProject();
  const [inspectorTab, setInspectorTab] = useState<'issues' | 'rules' | 'batches'>('issues');
  const selectedLineRef = useRef(state.selectedLineId);
  selectedLineRef.current = state.selectedLineId;

  const currentSnapshot = useMemo(() => takeSnapshot(state), [state]);

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
        recordProofing('快捷保存');
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

  /** 超出上限时优先丢弃最旧的非保留批次。 */
  function trimBatches(batches: ProofreadingBatch[], keepId: string): ProofreadingBatch[] {
    const next = [...batches];
    while (next.length > MAX_BATCHES) {
      let dropIndex = -1;
      for (let i = next.length - 1; i >= 0; i -= 1) {
        if (next[i].id !== keepId) {
          dropIndex = i;
          break;
        }
      }
      if (dropIndex === -1) break;
      next.splice(dropIndex, 1);
    }
    return next;
  }

  const startBatch = () => {
    commit('开始校对批次', (current) => {
      const batch: ProofreadingBatch = {
        id: uid('batch'),
        name: `批次 ${current.batches.length + 1}`,
        createdAt: new Date().toISOString(),
        baseline: takeSnapshot(current),
        events: [],
      };
      const batches = trimBatches([batch, ...current.batches], batch.id);
      return { ...current, batches, activeBatchId: batch.id, updatedAt: new Date().toISOString() };
    });
  };

  const recordProofing = (action = '手动记录') => {
    commit('记录校对', (current) => {
      let batches = current.batches;
      let activeId = current.activeBatchId;

      // 没有进行中的批次时，自动开始一个，保证快捷键随时可用。
      if (!activeId || !batches.some((batch) => batch.id === activeId)) {
        const batch: ProofreadingBatch = {
          id: uid('batch'),
          name: `批次 ${batches.length + 1}`,
          createdAt: new Date().toISOString(),
          baseline: takeSnapshot(current),
          events: [],
        };
        batches = trimBatches([batch, ...batches], batch.id);
        activeId = batch.id;
      }

      const record: BatchEvent = {
        id: uid('event'),
        name: '',
        kind: 'record',
        createdAt: new Date().toISOString(),
        action,
        note: '',
        snapshot: takeSnapshot(current),
      };

      batches = batches.map((batch) => {
        if (batch.id !== activeId) return batch;
        record.name = `记录 ${batch.events.length + 1}`;
        return { ...batch, events: [...batch.events, record].slice(-MAX_EVENTS_PER_BATCH) };
      });

      return { ...current, batches, activeBatchId: activeId, updatedAt: new Date().toISOString() };
    });
  };

  const renameBatch = (batchId: string, name: string) => {
    commit('重命名校对批次', (current) => ({
      ...current,
      batches: current.batches.map((batch) => (batch.id === batchId ? { ...batch, name } : batch)),
    }));
  };

  const deleteBatch = (batchId: string) => {
    commit('删除校对批次', (current) => ({
      ...current,
      batches: current.batches.filter((batch) => batch.id !== batchId),
      activeBatchId: current.activeBatchId === batchId ? '' : current.activeBatchId,
      updatedAt: new Date().toISOString(),
    }));
  };

  /** 恢复旧批次记录：当前稿回到当时内容，原批次保留，并把这次恢复行动留在该批次记录里。 */
  const applyRestore = (target: { batchId: string; eventId: string }) => {
    commit('恢复批次内容', (current) => {
      const batch = current.batches.find((item) => item.id === target.batchId);
      const targetEvent = batch?.events.find((event) => event.id === target.eventId);
      if (!batch || !targetEvent) return current;

      const content = structuredClone(targetEvent.snapshot);
      const restoreEvent: BatchEvent = {
        id: uid('event'),
        name: `恢复自「${targetEvent.name}」`,
        kind: 'restore',
        createdAt: new Date().toISOString(),
        action: '恢复批次内容',
        note: '',
        snapshot: takeSnapshot(current),
        restoredFrom: {
          batchId: batch.id,
          batchName: batch.name,
          eventId: targetEvent.id,
          eventName: targetEvent.name,
        },
      };

      return {
        ...current,
        title: content.title,
        author: content.author,
        activeRuleSetId: content.activeRuleSetId,
        ruleSets: content.ruleSets,
        lines: content.lines,
        issues: content.issues,
        batches: current.batches.map((item) => (
          item.id === batch.id
            ? { ...item, events: [...item.events, restoreEvent].slice(-MAX_EVENTS_PER_BATCH) }
            : item
        )),
        activeBatchId: batch.id,
        selectedLineId: content.lines.some((line) => line.id === current.selectedLineId)
          ? current.selectedLineId
          : content.lines[0]?.id ?? '',
        updatedAt: new Date().toISOString(),
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
          {inspectorTab === 'batches' && (
            <BatchesPanel
              state={state}
              currentSnapshot={currentSnapshot}
              onStartBatch={startBatch}
              onRecord={() => recordProofing()}
              onRenameBatch={renameBatch}
              onDeleteBatch={deleteBatch}
              onApplyRestore={applyRestore}
            />
          )}
        </aside>
      </div>
    </div>
  );
}
