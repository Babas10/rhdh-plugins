import '@testing-library/jest-dom';

// Recharts uses ResizeObserver — provide a no-op mock for jsdom
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
