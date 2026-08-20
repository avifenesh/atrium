import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CrmApp } from './CrmApp';
import '../styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CrmApp />
  </StrictMode>,
);
