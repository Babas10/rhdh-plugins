// Re-export the community todo-backend plugin for RHDH dynamic loading.
// RHDH requires a BackendFeature as the default export for backend plugins.
// @backstage-community/plugin-todo-backend exports todoPlugin as its default. 
export { default } from '@backstage-community/plugin-todo-backend';
export * from '@backstage-community/plugin-todo-backend';
