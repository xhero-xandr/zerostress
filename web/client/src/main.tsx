import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import './index.css';
import { Home } from './pages/home.tsx';
import { NotFound, Task } from './pages/task.tsx';
import { initTheme } from './theme.ts';

initTheme();

const router = createBrowserRouter([
  { path: '/', Component: Home },
  { path: '/r/:id/:tab?', Component: Task },
  { path: '*', Component: NotFound },
]);

const queries = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queries}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
