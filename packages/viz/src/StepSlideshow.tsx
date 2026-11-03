import { useState, useEffect, useCallback, useMemo, useRef, forwardRef } from 'react';
import type { TraceRecord } from '@dstutor/trace-schema';
import { framesFor, firstFrameOfOperation, lastFrameOfOperation, type Frame, type DetailLevel } from './frames';
import DataTransformation from './DataTransformation';
import './StepSlideshow.css';

export interface StepCardProps {
  frame: Frame;
}

/** Single-frame content (header, explanation, DataTransformation). Used for display and PDF export. */
export function StepCard({ frame }: StepCardProps) {
  const { record, subStep, opIndex, opTotal, subIndex, subTotal } = frame;
  const hasValidData = record.input && record.output;
  const baseExplanation =
    record.input?.num_rows === 0 &&
    record.output?.num_rows > 0 &&
    (record.operation === 'with_columns' || record.operation === 'with_column')
      ? `Created table with ${record.output.num_columns} columns and ${record.output.num_rows} rows`
      : record.explanation;
  const explanation = subStep?.message ?? baseExplanation;
  const showSubProgress = subTotal !== undefined && subTotal > 1;

  return (
    <div className="step-slideshow step-card">
      <div className="slideshow-header">
        <div className="step-indicator">
          <span className="step-badge">
            Step {opIndex + 1} of {opTotal}
            {showSubProgress && (
              <span className="sub-progress"> · part {(subIndex ?? 0) + 1} of {subTotal}</span>
            )}
          </span>
        </div>
        <div className="step-operation-title">
          <code>
            {record.assigns && <span className="step-assigns">{record.assigns} = </span>}
            {record.operation}()
          </code>
        </div>
      </div>
      <div className="slideshow-explanation">
        <div className="explanation-body">
          <span className="explanation-text">{explanation}</span>
          {subStep?.detail && <code className="explanation-detail">{subStep.detail}</code>}
        </div>
      </div>
      {hasValidData && (
        <div className="slideshow-visualization">
          <DataTransformation
            before={record.input}
            after={record.output}
            operation={record.operation}
            inputHighlights={subStep?.input_highlights}
            outputHighlights={subStep?.output_highlights}
            outputOverride={subStep?.output_state}
            auxTable={subStep?.aux_table}
            auxOutput={subStep?.aux_output}
            outputLabel={subStep?.output_label}
            isSubStep={Boolean(subStep)}
          />
        </div>
      )}
    </div>
  );
}

interface StepSlideshowProps {
  trace: TraceRecord[];
  /** Called whenever the shown frame changes (used to highlight the source line in the notebook) */
  onFrameChange?: (frame: Frame) => void;
  /** Every walkthrough frame, or one result frame per operation */
  detail?: DetailLevel;
  /** Presentation: offer autoplay (Space) with a speed control */
  autoplay?: boolean;
}

const AUTOPLAY_SPEEDS = [1, 2, 3, 5] as const;

const StepSlideshow = forwardRef<HTMLDivElement, StepSlideshowProps>(function StepSlideshow({ trace, onFrameChange, detail = 'all', autoplay = false }, ref) {
  const frames = useMemo(() => framesFor(trace, detail), [trace, detail]);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [secondsPerFrame, setSecondsPerFrame] = useState<number>(2);

  const goToPrevious = useCallback(() => {
    setCurrentFrame(prev => Math.max(0, prev - 1));
  }, []);

  const goToNext = useCallback(() => {
    setCurrentFrame(prev => Math.min(frames.length - 1, prev + 1));
  }, [frames.length]);

  /** Skip to the result of the current operation, or of the next one if already there */
  const goToResult = useCallback(() => {
    setCurrentFrame(prev => {
      const op = frames[Math.min(prev, frames.length - 1)]?.opIndex ?? 0;
      const end = lastFrameOfOperation(frames, op);
      if (prev < end) return end;
      const nextOp = Math.min(op + 1, (frames[frames.length - 1]?.opIndex ?? 0));
      return lastFrameOfOperation(frames, nextOp);
    });
  }, [frames]);

  /** Back to the start of the current operation, or of the previous one if already there */
  const goToStart = useCallback(() => {
    setCurrentFrame(prev => {
      const op = frames[Math.min(prev, frames.length - 1)]?.opIndex ?? 0;
      const start = firstFrameOfOperation(frames, op);
      if (prev > start) return start;
      return firstFrameOfOperation(frames, Math.max(0, op - 1));
    });
  }, [frames]);

  // Reset to first frame when the trace changes; keep the operation when only the detail level changes
  useEffect(() => {
    setCurrentFrame(0);
    setPlaying(false);
  }, [trace]);
  const lastDetailRef = useRef(detail);
  useEffect(() => {
    if (lastDetailRef.current === detail) return;
    lastDetailRef.current = detail;
    setCurrentFrame(prev => {
      // prev indexes the old frame list; map through the operation it was on
      const oldFrames = framesFor(trace, detail === 'all' ? 'results' : 'all');
      const op = oldFrames[Math.min(prev, oldFrames.length - 1)]?.opIndex ?? 0;
      return firstFrameOfOperation(frames, op);
    });
  }, [detail, trace, frames]);

  // Autoplay (presentation only): advance on a timer, stop at the end
  useEffect(() => {
    if (!playing) return;
    if (currentFrame >= frames.length - 1) {
      setPlaying(false);
      return;
    }
    const id = setTimeout(() => setCurrentFrame(f => Math.min(frames.length - 1, f + 1)), secondsPerFrame * 1000);
    return () => clearTimeout(id);
  }, [playing, currentFrame, frames.length, secondsPerFrame]);

  useEffect(() => {
    const frame = frames[Math.min(currentFrame, frames.length - 1)];
    if (frame) onFrameChange?.(frame);
  }, [currentFrame, frames, onFrameChange]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.closest('.monaco-editor'))) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        setPlaying(false);
        if (e.shiftKey) goToStart(); else goToPrevious();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        setPlaying(false);
        if (e.shiftKey) goToResult(); else goToNext();
      } else if (autoplay && e.key === ' ') {
        e.preventDefault();
        setPlaying(p => !p);
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [goToNext, goToPrevious, goToStart, goToResult, autoplay]);

  if (!trace || trace.length === 0 || frames.length === 0) {
    return null;
  }

  const frame = frames[Math.min(currentFrame, frames.length - 1)];
  const isFirst = currentFrame === 0;
  const isLast = currentFrame === frames.length - 1;

  return (
    <div className="step-slideshow" ref={ref}>
      <div className="step-frame fade-in" key={currentFrame}>
        <StepCard frame={frame} />
      </div>

      {/* Navigation Controls */}
      <div className="slideshow-controls">
        <div className="nav-group">
          <button
            type="button"
            className="skip-button"
            onClick={goToStart}
            disabled={isFirst}
            title="Back to the start of this operation (Shift+←)"
            aria-label="Back to start of operation"
          >
            <span className="arrow">«</span>
          </button>
          <button
            className="nav-button prev"
            onClick={goToPrevious}
            disabled={isFirst}
            title="Previous step (←)"
          >
            <span className="arrow">‹</span>
            <span className="nav-text">Previous</span>
          </button>
        </div>

        {/* One dot per operation; the active operation shows sub-progress */}
        <div className="step-dots">
          {trace.map((record, opIndex) => {
            const isActive = opIndex === frame.opIndex;
            const subCount = isActive ? (frame.subTotal ?? 0) : 0;
            return (
              <button
                key={opIndex}
                className={`dot ${isActive ? 'active' : ''}`}
                onClick={() => setCurrentFrame(isActive ? lastFrameOfOperation(frames, opIndex) : firstFrameOfOperation(frames, opIndex))}
                title={isActive ? `Skip to the result of ${record.operation}()` : `Go to step ${opIndex + 1}: ${record.operation}()`}
              >
                {isActive && subCount > 1 && (
                  <span className="dot-sub-label">{(frame.subIndex ?? 0) + 1}/{subCount}</span>
                )}
              </button>
            );
          })}
        </div>

        <div className="nav-group">
          <button
            className="nav-button next"
            onClick={goToNext}
            disabled={isLast}
            title="Next step (→)"
          >
            <span className="nav-text">Next</span>
            <span className="arrow">›</span>
          </button>
          <button
            type="button"
            className="skip-button"
            onClick={goToResult}
            disabled={isLast}
            title="Skip to the result of this operation (Shift+→)"
            aria-label="Skip to result"
          >
            <span className="arrow">»</span>
          </button>
        </div>
      </div>

      {autoplay && (
        <div className="autoplay-controls">
          <button type="button" className={`autoplay-toggle ${playing ? 'is-playing' : ''}`} onClick={() => setPlaying(p => !p)} disabled={isLast && !playing} title="Play or pause (Space)">
            {playing ? 'Pause' : 'Play'}
          </button>
          <label className="autoplay-speed">
            <span>every</span>
            <select value={secondsPerFrame} onChange={(e) => setSecondsPerFrame(Number(e.target.value))}>
              {AUTOPLAY_SPEEDS.map(sec => <option key={sec} value={sec}>{sec} s</option>)}
            </select>
          </label>
        </div>
      )}

      {/* Keyboard Hint */}
      <div className="keyboard-hint">
        Arrow keys step{autoplay ? ', Space plays' : ''}; Shift+arrows jump to the result or start of an operation
      </div>
    </div>
  );
});

export default StepSlideshow;
