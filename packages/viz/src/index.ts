// StepSlideshow, DataTransformation and the frame model they play. Reads trace-schema only,
// with no knowledge of Python or any library.
export { default as StepSlideshow, StepCard, type StepCardProps } from './StepSlideshow';
export { default as DataTransformation, ArrayView, formatValue, isNumericColumn, type AuxTable } from './DataTransformation';
export {
  flattenTrace,
  resultFrames,
  framesFor,
  firstFrameOfOperation,
  lastFrameOfOperation,
  type Frame,
  type DetailLevel,
} from './frames';
export { renderStepCanvases, saveStepsPdf, stepsZip } from './exportSteps';
