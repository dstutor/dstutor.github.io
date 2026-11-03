import React from 'react';
import ReactDOM from 'react-dom/client';
import '@dstutor/brand/cel.css';
import { ensureMonaco } from '@dstutor/notebook-ui';
import { registerServiceWorker } from '@dstutor/runtime-pyodide';
import App from './App';
import './index.css';

registerServiceWorker({ base: import.meta.env.BASE_URL, buildId: __BUILD_ID__ });

// Start fetching the editor chunk right away; cells show a plain editor until it is ready
void ensureMonaco();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
