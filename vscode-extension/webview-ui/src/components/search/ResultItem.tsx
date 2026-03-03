import React from 'react';
import { getVsCodeApi } from '../../vscode';
import type { SearchResult } from '../../types/messages';

const TYPE_ABBREV: Record<string, string> = {
  function: 'fn',
  method: 'method',
  class: 'cls',
  interface: 'iface',
  type: 'type',
  enum: 'enum',
  module: 'mod',
  doc: 'doc',
  code: 'code',
};

function abbreviateType(type: string): string {
  return TYPE_ABBREV[type] ?? type;
}

function scoreClass(percent: number): string {
  if (percent >= 70) return 'high';
  if (percent >= 40) return 'medium';
  return 'low';
}

interface ResultItemProps {
  result: SearchResult;
}

export function ResultItem({ result }: ResultItemProps): React.JSX.Element {
  const scorePercent = Math.round(result.score * 100);
  const scoreTier = scoreClass(scorePercent);
  const lineRange = result.endLine > result.line
    ? `${result.line}\u2013${result.endLine}`
    : `${result.line}`;
  const displayName = result.name || 'module';

  const handleClick = () => {
    getVsCodeApi().postMessage({ type: 'openFile', filePath: result.file, line: result.line, endLine: result.endLine });
  };

  return (
    <div className={`result-item result-accent-${scoreTier}`} onClick={handleClick} role="button" tabIndex={0}>
      <div className="result-file-row">
        {result.file}:{lineRange}
      </div>
      <div className="result-symbol-row">
        <span className="result-name">{displayName}</span>
        <span className="result-type-abbrev">{abbreviateType(result.type)}</span>
        <span className={`result-score ${scoreTier}`} title={`Score: ${result.score.toFixed(4)}`}>
          {scorePercent}%
        </span>
      </div>
      {result.summary && (
        <div className="result-summary">{result.summary}</div>
      )}
    </div>
  );
}
