import type { ReactNode, RefObject } from 'react';
import type { RunOutput } from '@dstutor/trace-schema';
import type { Frame, DetailLevel, TableStyle } from '@dstutor/viz';
import { Cel, StepSlideshow } from '@dstutor/viz';
import HighlightedCode from './HighlightedCode';
import type { CellLanguage } from './NotebookCells';

interface TracePanelProps {
  output: RunOutput;
  /** What the tracer visualizes, e.g. 'Table' */
  dataNoun: string;
  /** Which calls are visualized, shown when code ran but produced no steps */
  tracedNote: ReactNode;
  /** Starter code shown in the empty panel */
  tryThis: string;
  slideshowRef?: RefObject<HTMLDivElement>;
  /** Changes with each new visualization; keys the view so it fades in fresh */
  version?: number;
  /** When set, shows a Present button that opens the full-window view */
  onPresent?: () => void;
  /** Reports the frame being shown, so the notebook can highlight its source line */
  onFrameChange?: (frame: Frame) => void;
  detail?: DetailLevel;
  onDetailChange?: (detail: DetailLevel) => void;
  /** How step tables print, as the tutor's library prints them */
  tableStyle?: TableStyle;
  /** What a code cell is called: "code cell", or "SQL cell" in the SQL tutor */
  cellName?: string;
  /** What the cells are written in, to colour "Try this" */
  language?: CellLanguage;
  /** The library, as the header names it */
  library?: string;
  /** The empty panel's ways to start: run everything, open the gallery, or add "Try this" and run it */
  onRunAll?: () => void;
  onOpenExamples?: () => void;
  onTryThis?: () => void;
  /** A run is in progress */
  running?: boolean;
}

export default function TracePanel({ output, dataNoun, tracedNote, tryThis, slideshowRef, version = 0, onPresent, onFrameChange, detail = 'all', onDetailChange, tableStyle, cellName = 'code cell', language = 'python', library, onRunAll, onOpenExamples, onTryThis, running = false }: TracePanelProps) {
  const hasTrace = output.trace && output.trace.length > 0;
  const hasOutput = output.stdout || output.stderr || output.error;

  return (
    <div className="trace-panel">
      <div className="panel-tabs">
        <div className="tab active">Visualization</div>
        <div className="panel-actions">
        {onDetailChange && hasTrace && (
          <div className="detail-toggle" role="group" aria-label="Detail level" title="Show every walkthrough frame, or only each operation's result">
            <button type="button" className={detail === 'all' ? 'active' : ''} onClick={() => onDetailChange('all')} aria-pressed={detail === 'all'}>Every step</button>
            <button type="button" className={detail === 'results' ? 'active' : ''} onClick={() => onDetailChange('results')} aria-pressed={detail === 'results'}>Results only</button>
          </div>
        )}
        {onPresent && (
          <button type="button" className="present-button" onClick={onPresent} title="Show the visualization full window, for lecturing (Esc to leave)">
            <span className="btn-icon" aria-hidden="true">▣</span>
            Present
          </button>
        )}
        </div>
      </div>

      <div className="panel-content">
        {/* Trace View FIRST */}
        <div className="trace-view fade-in" key={version}>
          {hasTrace ? (
            <StepSlideshow ref={slideshowRef} trace={output.trace!} onFrameChange={onFrameChange} detail={detail} tableStyle={tableStyle} />
          ) : hasOutput ? (
            <div className="empty-state">
              <h3>No {dataNoun.toLowerCase()} operations to show.</h3>
              <div className="trace-note">
                <strong>The code ran, but nothing was traced</strong>
                {tracedNote} Any printed output or errors appear under the {cellName}.
              </div>
            </div>
          ) : (
            <div className="empty-state start-state">
              <div className="start-head">
                <Cel state="brand" className="start-cel" />
                <div>
                  <h3>Run your cells to see their steps here</h3>
                  <p>
                    Each {dataNoun} operation they use shows up here in stages, from the table it starts with to the
                    result, one stage at a time.
                  </p>
                </div>
              </div>
              <div className="start-actions">
                {onRunAll && (
                  <button type="button" className="start-run" onClick={onRunAll} disabled={running}>
                    <span className="btn-icon" aria-hidden="true">▶▶</span> Run all &amp; visualize
                  </button>
                )}
                {onOpenExamples && (
                  <button type="button" className="start-examples" onClick={onOpenExamples}>
                    Browse examples
                  </button>
                )}
              </div>
              <div className="example-hint">
                <div className="example-hint-head">
                  <strong>Or try this</strong>
                  {library && <code className="example-hint-lang">{library}</code>}
                </div>
                <HighlightedCode code={tryThis} language={language} />
                {onTryThis && (
                  <button type="button" className="example-hint-add" onClick={onTryThis} disabled={running}>
                    + Add it as a {cellName} and run it
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

