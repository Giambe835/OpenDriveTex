/**
 * @fileoverview Application entry point for OpenDriveTeX.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Failed to locate #root mount element in index.html');
}

createRoot(rootElement).render(<App />);

