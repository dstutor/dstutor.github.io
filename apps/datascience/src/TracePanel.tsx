import type { RefObject } from 'react';
import type { RunOutput } from '@dstutor/trace-schema';
import type { Frame, DetailLevel } from '@dstutor/viz';
import { StepSlideshow } from '@dstutor/viz';

interface TracePanelProps {
  output: RunOutput;
  slideshowRef?: RefObject<HTMLDivElement>;
  /** Changes with each new visualization; keys the view so it fades in fresh */
  version?: number;
  /** When set, shows a Present button that opens the full-window view */
  onPresent?: () => void;
  /** Reports the frame being shown, so the notebook can highlight its source line */
  onFrameChange?: (frame: Frame) => void;
  detail?: DetailLevel;
  onDetailChange?: (detail: DetailLevel) => void;
}

export default function TracePanel({ output, slideshowRef, version = 0, onPresent, onFrameChange, detail = 'all', onDetailChange }: TracePanelProps) {
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
            <StepSlideshow ref={slideshowRef} trace={output.trace!} onFrameChange={onFrameChange} detail={detail} />
          ) : hasOutput ? (
            <div className="empty-state">
              <h3>No table operations to show.</h3>
              <div className="trace-note">
                <strong>The code ran, but nothing was traced</strong>
                Only <code>datascience.Table</code> methods are visualized. Any printed output or errors appear under the code cell.
              </div>
            </div>
          ) : (
            <div className="empty-state">
              <h3>See what each Table operation does, one step at a time.</h3>
              <p>Run the code cell and this panel walks through every operation, showing the table before and after. Pick something from Examples to start, or write your own.</p>
              <div className="example-hint">
                <strong>Try this</strong>
                <pre>{`from datascience import *

cones = Table().with_columns(
    'Flavor', make_array('strawberry', 'chocolate', 'vanilla'),
    'Price', make_array(3.55, 4.75, 4.25)
)

cones.where('Flavor', 'chocolate')`}</pre>
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

