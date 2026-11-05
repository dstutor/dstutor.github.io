import { useState } from 'react';
import type { Example, Gallery } from './gallery';
import './ExamplesGallery.css';

interface ExamplesGalleryProps {
  gallery: Gallery;
  /** What the examples operate on, e.g. 'Table' */
  dataNoun: string;
  onSelectExample: (example: Example) => void;
  /** A notebook with one empty cell */
  onBlank?: () => void;
  /** Restore the starter notebook */
  onReset: () => void;
  onClose: () => void;
}

const CLOSE_MS = 140;

export default function ExamplesGallery({ gallery, dataNoun, onSelectExample, onReset, onBlank, onClose }: ExamplesGalleryProps) {
  const { examples, categories } = gallery;
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
            <h1>{dataNoun} Operation Examples</h1>
            <p>Select an example to see how {dataNoun} operations transform data step-by-step</p>
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
                <h3>Starter notebook</h3>
                <p>The notebook you see on first visit: how to use it, and a small table to try things on.</p>
                <div className="example-category">New notebook</div>
              </div>
            </button>
          )}
          {selectedCategory === 'all' && onBlank && (
            <button
              type="button"
              className="example-card example-card-reset"
              onClick={() => requestClose(onBlank)}
            >
              <div className="example-thumbnail">
                <div className="operation-badges">
                  <span className="operation-badge">empty</span>
                </div>
              </div>
              <div className="example-info">
                <h3>Blank notebook</h3>
                <p>One empty cell and nothing else, to write your own from scratch.</p>
                <div className="example-category">New notebook</div>
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

