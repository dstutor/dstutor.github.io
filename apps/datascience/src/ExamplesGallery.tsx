import { useState } from 'react';
import { examples, categories, type Example } from './examples';
import './ExamplesGallery.css';

interface ExamplesGalleryProps {
  onSelectExample: (example: Example) => void;
  /** Restore the starter notebook */
  onReset: () => void;
  onClose: () => void;
}

const CLOSE_MS = 140;

export default function ExamplesGallery({ onSelectExample, onReset, onClose }: ExamplesGalleryProps) {
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [closing, setClosing] = useState(false);

  /** Play the close animation, then unmount. `then` runs first so the notebook is ready behind the fade. */
  const requestClose = (then?: () => void) => {
    if (closing) return;
    then?.();
    setClosing(true);
    window.setTimeout(onClose, CLOSE_MS);
  };

  const filteredExamples = selectedCategory === 'all' 
    ? examples 
    : examples.filter(ex => ex.category === selectedCategory);

  return (
    <div className={`gallery-overlay ${closing ? 'is-closing' : ''}`}>
      <div className="gallery-modal">
        <div className="gallery-header">
          <div>
            <h1>Table Operation Examples</h1>
            <p>Select an example to see how Table operations transform data step-by-step</p>
            <p className="inspiration">Inspired by <a href="https://pandastutor.com/" target="_blank" rel="noopener noreferrer">PandasTutor</a></p>
          </div>
          <button className="close-button" onClick={() => requestClose()} aria-label="Close">×</button>
        </div>

        <div className="category-filter">
          <button
            className={selectedCategory === 'all' ? 'active' : ''}
            onClick={() => setSelectedCategory('all')}
          >
            All Examples
          </button>
          {categories.map(cat => (
            <button
              key={cat.id}
              className={selectedCategory === cat.id ? 'active' : ''}
              onClick={() => setSelectedCategory(cat.id)}
            >
              {cat.name}
            </button>
          ))}
        </div>

        <div className="examples-grid">
          {selectedCategory === 'all' && (
            <button
              type="button"
              className="example-card example-card-reset"
              onClick={() => requestClose(onReset)}
            >
              <div className="example-thumbnail">
                <div className="operation-badges">
                  <span className="operation-badge">start here</span>
                </div>
              </div>
              <div className="example-info">
                <h3>Blank notebook</h3>
                <p>The starter notebook you see on first visit, with instructions and a small table to edit.</p>
                <div className="example-category">Reset</div>
              </div>
            </button>
          )}
          {filteredExamples.map(example => (
            <button
              type="button"
              key={example.id}
              className="example-card"
              onClick={() => requestClose(() => onSelectExample(example))}
            >
              <div className="example-thumbnail">
                <div className="operation-badges">
                  {example.operations.map(op => (
                    <span key={op} className="operation-badge">{op}</span>
                  ))}
                </div>
              </div>
              <div className="example-info">
                <h3>{example.title}</h3>
                <p>{example.description}</p>
                <div className="example-category">{
                  categories.find(c => c.id === example.category)?.name
                }</div>
              </div>
            </button>
          ))}
        </div>

        <div className="gallery-footer">
          <button className="secondary-button" onClick={() => requestClose()}>
            Close Gallery
          </button>
        </div>
      </div>
    </div>
  );
}

