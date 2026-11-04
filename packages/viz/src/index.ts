// StepSlideshow, DataTransformation and the frame model they play. Reads trace-schema only,
// with no knowledge of Python or any library.
export { default as StepSlideshow, StepCard, type StepCardProps } from './StepSlideshow';
export { default as DataTransformation, ArrayView, type AuxTable } from './DataTransformation';
export { formatValue, formatColumn, shownText, isNumericColumn, sizeText, type TableStyle } from './tableFormat';
export {
  flattenTrace,
  resultFrames,
  framesFor,
  firstFrameOfOperation,
  lastFrameOfOperation,
  stepTitle,
  type Frame,
  type DetailLevel,
} from './frames';
export { default as Cel } from './Cel';
export { celFor, type CelPose } from './celPlan';
export { renderStepCanvases, saveStepsPdf, stepsZip } from './exportSteps';
