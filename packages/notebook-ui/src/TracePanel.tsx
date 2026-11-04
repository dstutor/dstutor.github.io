import type { ReactNode, RefObject } from 'react';
import type { RunOutput } from '@dstutor/trace-schema';
import type { Frame, DetailLevel, TableStyle } from '@dstutor/viz';
import { StepSlideshow } from '@dstutor/viz';

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
}

export default function TracePanel({ output, dataNoun, tracedNote, tryThis, slideshowRef, version = 0, onPresent, onFrameChange, detail = 'all', onDetailChange, tableStyle }: TracePanelProps) {
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
                {tracedNote} Any printed output or errors appear under the code cell.
              </div>
            </div>
          ) : (
            <div className="empty-state">
              <h3>See what each {dataNoun} operation does, one step at a time.</h3>
              <p>Run the code cell and this panel walks through every operation, showing the table before and after. Pick something from Examples to start, or write your own.</p>
              <div className="example-hint">
                <strong>Try this</strong>
                <pre>{tryThis}</pre>
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

